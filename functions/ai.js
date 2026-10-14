// AI（Claude）の入口（11章 7-3）
// - APIキーは Cloud Functions の secret（ANTHROPIC_API_KEY）。持ち主が自分のパソコンのターミナルで入れる。
//   ページ・GitHub・チャットには出さない。このプログラムも、キーを画面や記録に出さない
// - 呼べるのは事務所の端末だけ（lib.js の requireOffice）
// - 1日の回数の上限（AI_DAILY_LIMIT）。使った回数とトークンは /config/ai/days/{日付}（だれも読めない場所）に書き、画面にはこのプログラムが返す
// - モデル：品名の当て（7-4）は Claude Sonnet 5.5（10/13 持ち主が Haiku・Sonnet・Opus をくらべて決めた。商品名をそのまま残し、ゆれもなかった）。
//   つながるかのためしは Claude Opus 5.5。納品書の読み取り（7-5a）は Claude Haiku 5.5（下の SLIP_MODEL）
// - Claude が断った（refusal）ときは、Claude のサーバーがほかのモデルでやりなおす（fallbacks: "default"）
// - task: "ping"＝つながるかのためし、"usage"＝今日使った回数、"match"＝LINE の品名を品物一覧に当てる（7-4）、
//   "slip"＝納品書のスキャン（JPEG）を読む（7-5a）。答えはどちらも構造化出力の JSON
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import Anthropic from "@anthropic-ai/sdk";
import { db, requireOffice } from "./lib.js";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODEL = "claude-opus-5-5";          // つながるかのためし
const MATCH_MODEL = "claude-sonnet-5-5";   // 品名の当て（7-4）
const AI_DAILY_LIMIT = 100;   // 1日に AI を呼べる回数（事務所ぜんぶで）。Claude Console の月の上限（$10）とは別の、こちらの安全柵
const JST = 9 * 60 * 60 * 1000;
const today = () => new Date(Date.now() + JST).toISOString().slice(0, 10);
const dayRef = () => db().ref(`config/ai/days/${today()}`);

/** 今日の回数を1つふやす。上限になっていたら止める。ふやしたあとの回数を返す */
async function countUp() {
  const r = await dayRef().child("count").transaction(c => ((c || 0) >= AI_DAILY_LIMIT ? undefined : (c || 0) + 1));
  if (!r.committed) throw new HttpsError("resource-exhausted", `今日の AI の回数の上限（${AI_DAILY_LIMIT}回）になりました。あしたまた使えます`);
  return r.snapshot.val();
}

/** 使ったトークン（文字の量）を、今日の分に足す */
async function addTokens(usage = {}) {
  await Promise.all([
    dayRef().child("in").transaction(v => (v || 0) + (usage.input_tokens || 0)),
    dayRef().child("out").transaction(v => (v || 0) + (usage.output_tokens || 0)),
  ]);
}

async function usageNow() {
  const d = (await dayRef().get()).val() || {};
  return { used: d.count || 0, limit: AI_DAILY_LIMIT, tokensIn: d.in || 0, tokensOut: d.out || 0, model: MODEL, matchModel: MATCH_MODEL, slipModel: SLIP_MODEL, key: keyShape() };
}

/** キーの「形」だけ（中身は返さない）：sk-ant- ではじまるか・長さ・空白や改行が入っていないか。貼りつけのずれを見つけるため */
function keyShape() {
  const k = String(ANTHROPIC_API_KEY.value() || "");
  // 同じキーが何回かつながっていないか（貼りつけが重なったとき）。くり返しの回数だけを返す
  const repeat = [4, 3, 2].find(n => k.length % n === 0 && k === k.slice(0, k.length / n).repeat(n)) || 1;
  return { prefix: k.startsWith("sk-ant-"), length: k.length, space: /\s/.test(k), repeat };
}

/** Claude のまちがいを、やさしい言葉にする（くわしい中身はサーバーの記録にだけ出す） */
function aiError(err) {
  if (err instanceof HttpsError) return err;
  // 記録には、番号と種類と短い説明だけ（キーは入らない）
  const type = err && err.error && err.error.error && err.error.error.type;
  console.error(`AI のまちがい status=${err && err.status} type=${type || "-"} ${String((err && err.message) || "").slice(0, 200)}`);
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpsError("failed-precondition", "AI の APIキーがちがうか、消されています（401）。持ち主に知らせてください");
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new HttpsError("failed-precondition", "この APIキーでは、この AI を使えないようです（403）。持ち主に知らせてください");
  }
  if (err instanceof Anthropic.RateLimitError) return new HttpsError("resource-exhausted", "AI が混んでいます。少したってから、もう一度ためしてください");
  if (err instanceof Anthropic.BadRequestError) {
    return new HttpsError("failed-precondition", "AI に断られました。Claude Console のクレジットと月の上限をたしかめてください");
  }
  if (err instanceof Anthropic.APIConnectionError) return new HttpsError("unavailable", "AI につながりませんでした。少したってから、もう一度ためしてください");
  if (err instanceof Anthropic.APIError) return new HttpsError("unavailable", `AI がうまく動きませんでした（${err.status || "?"}）。少したってから、もう一度ためしてください`);
  return new HttpsError("internal", "AI がうまく動きませんでした");
}

/* ---------- 7-4：LINE の品名を品物一覧に当てる（試作の matchPrompt・cleanMatch と同じ考え方） ---------- */
const arr = v => (Array.isArray(v) ? v : Object.values(v || {})).filter(x => x != null);
const MATCH_MAX_LINES = 60;

/** データベースの品物一覧 → Map(キー → {name, tpl, opts:[[名前, [値]]], unit})（「自由に書く」と、⚙ 設定でかくした品物はのぞく） */
async function catalogItems() {
  const raw = (await db().ref("zairyo/master/catalog").get()).val() || {};
  const item = new Map();
  for (const c of arr(raw.cats)) {
    for (const it of arr(c.items)) {
      if (it.free || it.hidden) continue;
      item.set(`${c.id}:${it.id}`, { name: it.name, tpl: it.tpl || "", unit: it.unit || "", opts: arr(it.opts).map(o => [o[0], arr(o[1])]) });
    }
  }
  return item;
}

function matchPrompt(item, list) {
  const cat = [...item].map(([k, it]) => `${k}｜${it.name}｜${it.tpl}｜${it.opts.map(([n, v]) => `${n}=${v.join("/")}`).join("；")}｜単位 ${it.unit}`).join("\n");
  return "あなたは鉄工所の事務員を手伝います。現場の人が LINE に書いた材料の注文を、会社の「品物一覧」に当てはめてください。\n\n" +
    "# 品物一覧（1行に1品物。キー｜名前｜書き方のひな形｜えらべる値｜単位）\n" + cat + "\n\n" +
    "# LINE の品名の行（番号: 文）\n" + list.map(x => `${x.i}: ${x.text}`).join("\n") + "\n\n" +
    "# 決まり\n" +
    "- 品物1つにつき答えを1つ。見出しの行（例「SS400 PL」）は、その下の行にかかる。見出しだけの行は品物にしない。\n" +
    "- lines には、その品物に使った行の番号をすべて入れる（見出しの行も入れる）。\n" +
    "- 品物ではない行（例：ミルシートお願いします、届け先の住所、↑、使い道のメモ）は rows に入れず、notes に行番号を入れる。どの行も rows か notes のどちらかに入れる。\n" +
    "- key は品物一覧のキー。当てはまる品物がないときは null（そのときも、品物の行なら rows に入れる）。\n" +
    "- vals は、ひな形の {} の名前と値の組。えらべる値にあるときは、その書き方にそろえる（例：25A10s → 呼び径 25A・厚さ 10s／6000 → 定尺6m／t3.2 は 厚さ t3.2）。えらべる値にないサイズは、同じ書き方で書く。\n" +
    "- LINE に書いていない値（例：材質がない）は、いちばんありそうな値を vals に入れ、その名前を guess に入れる。書いてある値は guess に入れない。\n" +
    "- qty は数（数字だけ）、unit は単位（本・枚・個 など）。書いていなければ null。";
}

// 答えの形（構造化出力）。vals は名前がいろいろなので、名前と値の組の並びにする
const nullable = t => ({ anyOf: [{ type: t }, { type: "null" }] });
const MATCH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["rows", "notes"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["lines", "key", "vals", "guess", "qty", "unit"],
        properties: {
          lines: { type: "array", items: { type: "integer" } },
          key: nullable("string"),
          vals: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
          guess: { type: "array", items: { type: "string" } },
          qty: nullable("number"),
          unit: nullable("string"),
        },
      },
    },
    notes: { type: "array", items: { type: "integer" } },
  },
};

/** AI の答えを、品物一覧にある形だけにする（ない品物・ない名前は落とす。同じ行を2回使わない） */
function cleanMatch(res, item, allowed) {
  const rows = [], used = new Set();
  for (const r of arr(res && res.rows)) {
    const ls0 = arr(r.lines).map(Number).filter(i => allowed.has(i));
    const ls = ls0.filter(i => !used.has(i));
    if (!ls.length) continue;
    ls.forEach(i => used.add(i));
    const it = r.key && item.get(r.key) ? item.get(r.key) : null;
    const vals = {};
    if (it) {
      for (const v of arr(r.vals)) {
        const name = String(v.name || ""), val = String(v.value ?? "").trim().slice(0, 100);
        if (val && it.opts.some(o => o[0] === name)) vals[name] = val;
      }
    }
    const guess = it ? arr(r.guess).map(String).filter(k => it.opts.some(o => o[0] === k)) : [];
    const q = r.qty == null || r.qty === "" ? null : Number(r.qty);
    rows.push({
      lines: ls.sort((a, b) => a - b), key: it ? r.key : null, vals, guess,
      qty: Number.isFinite(q) && q > 0 && q < 100000 ? q : null, unit: r.unit ? String(r.unit).trim().slice(0, 10) : "",
    });
  }
  const notes = arr(res && res.notes).map(Number).filter(i => allowed.has(i) && !used.has(i));
  return { rows, notes: [...new Set(notes)] };
}

// モデルをくらべるページ（ai-kurabe.html）だけが、えらべるモデル。fallbacks（断られたときのやりなおし）は Haiku にはない
const COMPARE_MODELS = {
  "claude-haiku-5-5": { fallback: false },
  "claude-sonnet-5-5": { fallback: true },
  "claude-opus-5-5": { fallback: true },
};

/** data.lines = [{i: 行の番号, text: LINE の行}]、data.model（くらべるときだけ）→ { rows, notes, run: {model, ms, in, out} } */
async function matchItems(client, data) {
  const list = arr(data.lines).slice(0, MATCH_MAX_LINES)
    .map(x => ({ i: Number(x.i), text: String(x.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300) }))
    .filter(x => Number.isInteger(x.i) && x.i >= 0 && x.text);
  if (!list.length) throw new HttpsError("invalid-argument", "当てる品名がありません");
  const item = await catalogItems();
  if (!item.size) throw new HttpsError("failed-precondition", "品物一覧が、まだ入っていません");
  const model = COMPARE_MODELS[data.model] ? data.model : MATCH_MODEL;
  const t0 = Date.now();
  let res;
  try {
    res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: MATCH_SCHEMA } },
      ...(COMPARE_MODELS[model] && !COMPARE_MODELS[model].fallback ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      messages: [{ role: "user", content: matchPrompt(item, list) }],
    });
  } catch (err) {
    throw aiError(err);
  }
  await addTokens(res.usage);
  const run = { model: res.model, ms: Date.now() - t0, in: (res.usage && res.usage.input_tokens) || 0, out: (res.usage && res.usage.output_tokens) || 0 };
  if (res.stop_reason === "refusal") throw new HttpsError("failed-precondition", "AI に断られました。品名は文のまま入れてください");
  if (res.stop_reason === "max_tokens") throw new HttpsError("resource-exhausted", "品名が多すぎて、AI が答えきれませんでした。何回かに分けてください");
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  let json;
  try { json = JSON.parse(text); } catch (err) { throw new HttpsError("internal", "AI の答えを読めませんでした。もう一度ためしてください"); }
  return { ...cleanMatch(json, item, new Set(list.map(x => x.i))), run };
}

/* ---------- 7-5a：納品書のスキャンを読む（試作の SLIP_PROMPT と同じ決まり） ---------- */
// 納品書は Claude Haiku 5.5（10/13：本物の納品書10枚で Haiku と Sonnet をくらべた。お金のある納品書は Haiku も合計が全部合い、
// 修理の行がまじった材料の納品書も読めた（Sonnet は修理の納品書として止めた）。持ち主の「Haiku でも合計が合えば Haiku」で決めた）
const SLIP_MODEL = "claude-haiku-5-5";
const SLIP_MAX_IMAGES = 4;                 // 1回に送る絵（1ページを上下に分けると2枚）
const SLIP_MAX_B64 = 3 * 1024 * 1024;      // 絵1枚の大きさ（base64 の字数）

function slipPrompt(force, parts) {
  return [
    "あなたは、鉄工所「よつば建設工業」の事務員さんの手伝いです。",
    parts > 1
      ? `画像は、紙の書類をスキャンしたものです。画像が ${parts} 枚あるのは、1枚の紙を上から順に分けたものです。上から順につなげて1枚として読み、重なっている行は1回だけ数えてください。`
      : "画像は、紙の書類をスキャンしたものです。",
    "",
    force
      ? "1. この書類は、納品書として扱うと決まりました（修理・工賃の納品書や、材料屋以外の納品書でも）。isSlip は必ず true にしてください。"
      : "1. まず、これが材料屋から「よつば建設工業」あての、材料（品物）の納品書かどうかを決めてください。請求書・見積書・注文書・図面・写真・白紙などは納品書ではありません。修理・工賃の納品書（電動工具の修理など）も、材料の納品書ではないので isSlip は false にして、kind に「修理・工賃の納品書」と書いてください。",
    "2. 納品書なら、書いてある内容をそのまま写してください。推測で埋めず、読めない欄は null にします。",
    "",
    "決まり：",
    "- 数字は数だけ（円・カンマは付けない）。",
    "- total は税抜の合計（小計）。消費税の行と合計の行は rows に入れない。送料・運賃の行は rows に入れる。",
    "- 手書きで直してある数字は、直したあとの数を使い、doubt に書く。",
    "- doubt には、注番・材料屋・品名・数・単価・金額のうち、読みにくかった所だけを短く（1つ20字くらい、3つまで）。ほかのこと（容器番号・受領印・担当者など）は書かない。",
    "- 単価や金額が書いていない納品書（ガスの仮納品書など）は、price と amount を null にする。",
    "- 日付は YYYY-MM-DD。和暦なら西暦にする（令和8年＝2026年）。",
    "- 注番は英字2文字＋数字5けた（例 AB26123）。chuban には注番だけを書く（担当者の名前や工事名は入れない）。",
    "- 注文番号の欄が空でも、品名・備考・欄外に注番が書いてあれば、それを使う。",
    "- 1枚に注番が2つ以上あるときは、chuban に全部を「,」で区切って書き、rows のそれぞれの chuban に、その行の注番を入れる。注番が1つなら rows の chuban は null でよい。",
    "- 納品書でないときは isSlip を false、kind に書類の種類を書き、ほかは null か空にする。",
  ].join("\n");
}

const SLIP_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["isSlip", "kind", "supplier", "slipNo", "date", "chuban", "rows", "total", "doubt"],
  properties: {
    isSlip: { type: "boolean" },
    kind: { type: "string" },
    supplier: nullable("string"),
    slipNo: nullable("string"),
    date: nullable("string"),
    chuban: nullable("string"),
    rows: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["chuban", "name", "qty", "unit", "price", "amount"],
        properties: {
          chuban: nullable("string"), name: { type: "string" }, qty: nullable("number"), unit: nullable("string"),
          price: nullable("number"), amount: nullable("number"),
        },
      },
    },
    total: nullable("number"),
    doubt: { type: "array", items: { type: "string" } },
  },
};

/** data.images = [JPEG の base64]（1ページ。上下に分けたときは上から順）、data.force（納品書として読む）、data.model（くらべるときだけ）
 *  → { slip: 読んだもの, run: {model, ms, in, out} } */
async function readSlip(client, data) {
  const images = arr(data.images).map(String).filter(Boolean).slice(0, SLIP_MAX_IMAGES);
  if (!images.length) throw new HttpsError("invalid-argument", "納品書の絵がありません");
  if (images.some(b => b.length > SLIP_MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(b))) throw new HttpsError("invalid-argument", "納品書の絵が大きすぎるか、こわれています");
  const model = COMPARE_MODELS[data.model] ? data.model : SLIP_MODEL;
  const t0 = Date.now();
  let res;
  try {
    res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SLIP_SCHEMA } },
      ...(COMPARE_MODELS[model] && !COMPARE_MODELS[model].fallback ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      messages: [{
        role: "user",
        content: [
          ...images.map(b => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } })),
          { type: "text", text: slipPrompt(!!data.force, images.length) },
        ],
      }],
    });
  } catch (err) {
    throw aiError(err);
  }
  await addTokens(res.usage);
  const run = { model: res.model, ms: Date.now() - t0, in: (res.usage && res.usage.input_tokens) || 0, out: (res.usage && res.usage.output_tokens) || 0 };
  if (res.stop_reason === "refusal") throw new HttpsError("failed-precondition", "AI に読み取りを断られました。手で入れてください");
  if (res.stop_reason === "max_tokens") throw new HttpsError("resource-exhausted", "納品書の行が多すぎて、AI が読みきれませんでした");
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  try { return { slip: JSON.parse(text), run }; } catch (err) { throw new HttpsError("internal", "AI の答えを読めませんでした。もう一度ためしてください"); }
}

/** data = { task: "ping" | "usage" | "match" | "slip", lines?, images?, force?, model?（くらべるときだけ） } */
export const zairyoAi = onCall({
  region: "asia-southeast1", invoker: "public", secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 300, memory: "512MiB", maxInstances: 3,   // AI は60行で1分ほどかかることがある
}, async request => {
  await requireOffice(request);
  const task = String((request.data || {}).task || "");
  if (task === "usage") return usageNow();
  if (task !== "ping" && task !== "match" && task !== "slip") throw new HttpsError("invalid-argument", "AI にたのむことが、わかりません");

  await countUp();
  // まえうしろの空白・改行はとる（クリップボードからわたすと、最後に改行がつくことがある）
  const client = new Anthropic({ apiKey: String(ANTHROPIC_API_KEY.value() || "").trim(), maxRetries: 1, timeout: 280 * 1000 });
  if (task === "match") return { ...(await matchItems(client, request.data || {})), ...(await usageNow()) };
  if (task === "slip") return { ...(await readSlip(client, request.data || {})), ...(await usageNow()) };
  const t0 = Date.now();
  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: "これは、つながるかのためしです。「OK」とだけ答えてください。" }],
    });
  } catch (err) {
    throw aiError(err);
  }
  await addTokens(res.usage);
  const reply = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  return { ...(await usageNow()), ok: res.stop_reason !== "refusal", servedBy: res.model, ms: Date.now() - t0, reply: reply.slice(0, 40) };
});
