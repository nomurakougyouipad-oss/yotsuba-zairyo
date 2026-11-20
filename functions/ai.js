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

/** データベースの品物一覧 → Map(キー → {name, tpl, opts:[[名前, [値], えらばなくてもよいか]], unit})（「自由に書く」と、⚙ 設定でかくした品物はのぞく） */
async function catalogItems() {
  const raw = (await db().ref("zairyo/master/catalog").get()).val() || {};
  const item = new Map();
  for (const c of arr(raw.cats)) {
    for (const it of arr(c.items)) {
      if (it.free || it.hidden) continue;
      item.set(`${c.id}:${it.id}`, { name: it.name, tpl: it.tpl || "", unit: it.unit || "", opts: arr(it.opts).map(o => [o[0], arr(o[1]), !!o[2]]) });
    }
  }
  return item;
}

// 11/19（事務員さん）：「キャッチクリップTL-11F（栃木屋）」が「タキゲン キャッチクリップ TL-11F(栃木屋)」になった。
// 「えらばなくてもよい」行（金物のメーカーなど）まで「いちばんありそうな値」を入れていた。→ その行は、LINE に書いてあるときだけ入れる。
// ボタンにないメーカーは、ほかのメーカーをえらばずに、書いてあるまま入れる
function matchPrompt(item, list) {
  const cat = [...item].map(([k, it]) => `${k}｜${it.name}｜${it.tpl}｜${it.opts.map(([n, v, opt]) => `${n}${opt ? "（えらばなくてもよい）" : ""}=${v.join("/")}`).join("；")}｜単位 ${it.unit}`).join("\n");
  return "あなたは鉄工所の事務員を手伝います。現場の人が LINE に書いた材料の注文を、会社の「品物一覧」に当てはめてください。\n\n" +
    "# 品物一覧（1行に1品物。キー｜名前｜書き方のひな形｜えらべる値｜単位）\n" + cat + "\n\n" +
    "# LINE の品名の行（番号: 文）\n" + list.map(x => `${x.i}: ${x.text}`).join("\n") + "\n\n" +
    "# 決まり\n" +
    "- 品物1つにつき答えを1つ。見出しの行（例「SS400 PL」）は、その下の行にかかる。見出しだけの行は品物にしない。\n" +
    "- lines には、その品物に使った行の番号をすべて入れる（見出しの行も入れる）。\n" +
    "- 品物ではない行（例：ミルシートお願いします、届け先の住所、↑、使い道のメモ）は rows に入れず、notes に行番号を入れる。どの行も rows か notes のどちらかに入れる。\n" +
    "- key は品物一覧のキー。当てはまる品物がないときは null（そのときも、品物の行なら rows に入れる）。\n" +
    "- vals は、ひな形の {} の名前と値の組。えらべる値にあるときは、その書き方にそろえる（例：25A10s → 呼び径 25A・厚さ 10s／6000 → 定尺6m／t3.2 は 厚さ t3.2）。えらべる値にないサイズは、同じ書き方で書く。" +
    "えらべる値にない種類・規格なども、合う名前の行があれば、その行に書いてあるまま入れる（例：WN フランジ → 種類 WN／30K → 規格 30K）。\n" +
    "- LINE に書いていない値（例：材質がない）は、いちばんありそうな値を vals に入れ、その名前を guess に入れる。書いてある値は guess に入れない。\n" +
    "- ただし「（えらばなくてもよい）」の行（メーカー・異径の枝のサイズ など）は、LINE に書いてあるときだけ vals に入れる。書いていなければ vals にも guess にも入れない（ありそうな値を入れない）。\n" +
    "- メーカーは、LINE に書いてあるメーカーだけを入れる。えらべる値にないメーカーは、ほかのメーカーをえらばずに、メーカーの行に書いてあるまま入れる" +
    "（例：取手 A-100（スガツネ）→ 品名 取手・メーカー スガツネ・extra A-100）。メーカー名は extra に入れない。\n" +
    "- extra には、LINE に書いてあるのに vals のどの値にも入らない、品物を決める大事な言葉を、書いてあるまま入れる（例：SOH、ハブ付、WN、片ねじ、JIS、ステンレス用）。" +
    "品物一覧の名前・ひな形・えらべる値と同じ意味の言葉（平鋼＝フラットバー、同径チーズ＝溶接チーズ、ﾌﾗﾝｼﾞ＝フランジ、6000＝定尺6m など）、数・単位、材料屋へのお願いの言葉は入れない。なければ空の字。key が null のときも空の字。\n" +
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
        type: "object", additionalProperties: false, required: ["lines", "key", "vals", "guess", "extra", "qty", "unit"],
        properties: {
          lines: { type: "array", items: { type: "integer" } },
          key: nullable("string"),
          vals: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
          guess: { type: "array", items: { type: "string" } },
          extra: { type: "string" },   // どの値にも入らない大事な言葉（SOH・WN など。品名のおわりに残す。11/9）
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
    // 「えらばなくてもよい」行の guess の値を入れるかどうかは、アプリ（line-match.js）が LINE の文とくらべて決める（11/19）
    const guess = it ? arr(r.guess).map(String).filter(k => it.opts.some(o => o[0] === k)) : [];
    const q = r.qty == null || r.qty === "" ? null : Number(r.qty);
    rows.push({
      lines: ls.sort((a, b) => a - b), key: it ? r.key : null, vals, guess,
      extra: it ? String(r.extra ?? "").replace(/\s+/g, " ").trim().slice(0, 60) : "",
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
      : "1. まず、これが材料屋から「よつば建設工業」あての、材料（品物）の納品書かどうかを決めてください。請求書・見積書・注文書・図面・写真・白紙などは納品書ではありません。" +
        "月ごとにまとめた請求書（請求明細書・合計請求書など）も納品書ではありません。" +
        "ただし、書類のいちばん上の題に「納品書」が入っているもの（「納品書兼請求書」「納品書（兼）請求書」など）は、支払い条件や請求の欄があっても納品書です（1回の納品ごとにこの形で来る材料屋がある）。isSlip を true にして読んでください。" +
        "修理・工賃の納品書（電動工具の修理など）も、材料の納品書ではないので isSlip は false にして、kind に「修理・工賃の納品書」と書いてください。",
    "2. 納品書なら、書いてある内容をそのまま写してください。推測で埋めず、読めない欄は null にします。",
    "",
    "決まり：",
    "- 数字は数だけ（円・カンマは付けない）。",
    "- 出精値引・値引きなど、合計から引く行は、単価と金額をマイナスの数で書く（▲・△・－・（ ）のついた数もマイナス。例 ▲8,462 → -8462）。",
    "- 返品・交換の行（数がマイナス・赤字・「返品」と書いてある行）は、数と金額をマイナスの数で書く（例 ソケット 10A ×−5 −3,335 → qty -5・amount -3335）。単価はプラスのまま。返品・交換が入った納品書（赤伝・返品伝票をふくむ）も納品書として読む。",
    "- total は税抜の合計（小計）。消費税の行と合計の行は rows に入れない。送料・運賃の行は rows に入れる。",
    "- 手書きで直してある数字は、直したあとの数を使い、doubt に書く。",
    "- doubt には、注番・材料屋・品名・数・単価・金額のうち、読みにくかった所だけを短く（1つ20字くらい、3つまで）。ほかのこと（容器番号・受領印・担当者など）は書かない。",
    "- 単価や金額が書いていない納品書（ガスの仮納品書など）は、price と amount を null にする。",
    "- 日付は YYYY-MM-DD。和暦なら西暦にする（令和8年＝2026年）。",
    "- 注番は英字2文字＋数字5けた（例 AB26123）。chuban には注番だけを書く（担当者の名前や工事名は入れない）。",
    "- 注文番号の欄が空でも、品名・摘要・備考・欄外（合計の近くなど）に注番が書いてあれば、それを使う。「ND26113 / 渡部」「ND26113渡部/西動力」のように、注番のうしろに担当者の名前や工事の名前がついていても、chuban には注番（ND26113）だけを書く。",
    "- remarks には、摘要・備考・欄外に書いてある字を、そのまま写す（100字まで。なければ空の字）。注番が書いてあるかどうかに関係なく写す。",
    "- 1枚に注番が2つ以上あるときは、chuban に全部を「,」で区切って書き、rows のそれぞれの chuban に、その行の注番を入れる。注番が1つなら rows の chuban は null でよい。",
    "- 2枚つづきの納品書などで、紙に「1/2」「2/2」「1頁」「(2/3)」のような何枚目の印があれば、page に何枚目、pages に何枚中かを数字で書く（「2/2」なら page 2・pages 2）。印がなければ、どちらも null。",
    "- 何枚かつづきの納品書で、その紙に合計（小計）が書いていなければ total は null にする（ほかの紙の合計を推測で入れない）。",
    "- 納品書でないときは isSlip を false、kind に書類の種類を書き、ほかは null か空にする。",
  ].join("\n");
}

const SLIP_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["isSlip", "kind", "supplier", "slipNo", "date", "chuban", "page", "pages", "rows", "total", "doubt", "remarks"],
  properties: {
    isSlip: { type: "boolean" },
    kind: { type: "string" },
    supplier: nullable("string"),
    slipNo: nullable("string"),
    date: nullable("string"),
    chuban: nullable("string"),
    page: nullable("number"),    // 2枚つづきの何枚目（11/4 OS26315）
    pages: nullable("number"),   // 何枚中
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
    remarks: nullable("string"),   // 摘要・備考・欄外の字（そこに注番を書く材料屋がある。11/5 小野建）
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

/* ---------- 月の請求書を読む（11/20 持ち主：材料屋ごとの請求書で「まとめて請求」をする） ----------
   - 1回に2ページまで（縦長のページは上下2枚に分けるので、絵は4枚まで）。何ページもある請求書は、アプリが前から順に何回かに分けてたのむ
   - 前の回の最後の伝票（番号・日付・注番）をわたす（つづきのページの頭に番号がない材料屋がある：えひめファスナー）
   - 明細の行を1行ずつ、種類（品物・小計・税・入金・繰越・合計・メモ）をつけて返す。足し算と合わせはアプリでする（AI に足させない）
   - モデルは、見本の請求書で Haiku と Sonnet をくらべて決める（seikyu-kurabe.html）。決まるまでは Sonnet */
const INVOICE_MODEL = "claude-sonnet-5-5";
const INV_MAX_IMAGES = 4;
const INV_KINDS = ["item", "subtotal", "tax", "payment", "carry", "total", "memo"];

function invoicePrompt(parts, pg, prev) {
  return [
    "あなたは、鉄工所「よつば建設工業」の事務員さんの手伝いです。画像は、材料屋から来た月の請求書をスキャンしたものです。",
    pg && pg.count ? `この請求書は全部で ${pg.count} ページあり、画像はそのうち ${pg.from}〜${pg.to} ページめです。` : "",
    parts > 1 ? `画像が ${parts} 枚あるのは、ページを上から順に分けたもの（縦長のページは上と下の2枚）です。上から順につなげて読み、分け目で重なっている行は1回だけ数えてください。` : "",
    prev && prev.no ? `前のページの最後の伝票は「${prev.no}」${prev.date ? `（${prev.date}）` : ""}${prev.chuban ? `・注番 ${prev.chuban}` : ""}です。このページの頭に番号のない行があれば、その伝票のつづきです。` : "",
    "",
    "1. まず、これが月の請求書（請求書・請求明細書・合計請求明細書・請求書の表紙と納品書の写し など）かどうかを決めて isInvoice に入れてください。見積書・注文書・1回の納品書だけ・白紙などは false にして、kind に書類の種類を書きます。",
    "2. 請求書なら、明細の行を上から順に全部 rows に写してください（この画像のページの分だけ）。推測で埋めず、読めない所は null にします。",
    "",
    "rows の kind（行の種類）：",
    "- item：品物・加工・塗装・送料・運賃・配送費・加工費・諸経費・孔あけ など、お金を払うものの行。値引き・返品はマイナスの金額で item。",
    "- subtotal：伝票計・上記伝票計・小計・〈小計〉・【10%対象小計】・課税対象額・売上伝票計 の行（その伝票の no を入れる）。",
    "- tax：消費税の行（消費税等・外税消費税計・請求時消費税・納品書ごとの税の行）。",
    "- payment：入金・御入金・振込・口座振替 の行（伝票の番号のような番号がついていても payment）。",
    "- carry：繰越・前回御請求・前月請求・残高 の行。右はしの「残高」の列（前の月からの足しこみ）の数は、どこにも使わない。",
    "- total：合計・御買上額・総合計・税抜売上金額・税率ごとの合計・請求書の表紙の合計 の行。",
    "- memo：金額のない行（工事名・現場名・注番だけの行・送り先・「お届け済」など）。わかれば、その伝票の no と chuban を入れる。",
    "",
    "決まり：",
    "- 1行が納品書1枚の「合計請求明細書」（伝票番号・税抜・消費税・合計が並ぶ）は、1行を item にして、amount は税抜（本体）の金額にする。",
    "- no：その行の納品書（伝票）の番号を、書いてあるまま（例「26-049450」「053717294-01」「014892」）。請求書そのものの番号（請求書No.・請求ID・いちばん上の見出しの伝票No.）は入れない。" +
      "番号が1行めにだけ書いてあり2行めから空の伝票・ページをまたいでつづく行は、上の伝票の番号を入れる。番号がない請求書は null。",
    "- date：その行の日付を YYYY-MM-DD で。和暦は西暦に（令和8年＝2026年）。「26/09/15」は 2026-09-15、「26 914」は 2026-09-14。日付が書いていない行は、上の行と同じ日付。",
    "- chuban：注番（英字2文字＋数字5けた。例 ND26084）がその伝票にあれば、注番だけ。空白・ハイフンはのぞく（「OT 26008」→ OT26008、「ND-26094」→ ND26094）。" +
      "うしろの人の名前・工事名は入れない。英字2文字＋数字5けたでない番号（5690・H-378361・260910003 など）は入れない。英字の O と数字の 0 がにているときは、頭の2文字は英字として読む。",
    "- amount：税抜の金額を数字だけで（円・カンマは付けない）。▲・△・－のついた数はマイナス。金額のない行は null。",
    "- text：品名や行の中身を短く（20字まで）。",
    "- 同じ中身の写し（請求書と納品書が1枚に写っている・控え）があるときは、1つだけ読む。",
    "- 手書きの請求書で、マスの中の斜めの線は「ここから下は書いていない」の印。数字にしない。",
    "- kaiage：今回（当月）の御買上額・お買上額・売上額・御買上金額の、税抜の金額。消費税・繰越・入金は入れない（「今回御請求額」「税込御買上額」ではない）。このページに書いていなければ null。",
    "- tax・total：消費税額・今回御請求額（書いてあれば）。closeDate：締め日（締切日・請求日・「○月末日締」）を YYYY-MM-DD。invoiceNo：請求書の番号（あれば）。slipCount：伝票枚数・納品書枚数（書いてあれば）。supplier：請求書を出した会社の名前。",
    "- doubt には、番号・日付・金額のうち、読みにくかった所だけを短く（1つ20字くらい、3つまで）。",
  ].filter(s => s !== "").join("\n");
}

const INVOICE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["isInvoice", "kind", "supplier", "invoiceNo", "closeDate", "kaiage", "tax", "total", "slipCount", "rows", "doubt"],
  properties: {
    isInvoice: { type: "boolean" },
    kind: { type: "string" },
    supplier: nullable("string"),
    invoiceNo: nullable("string"),
    closeDate: nullable("string"),
    kaiage: nullable("number"),
    tax: nullable("number"),
    total: nullable("number"),
    slipCount: nullable("number"),
    rows: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["kind", "no", "date", "chuban", "text", "amount"],
        properties: {
          kind: { type: "string", enum: INV_KINDS },
          no: nullable("string"), date: nullable("string"), chuban: nullable("string"), text: { type: "string" }, amount: nullable("number"),
        },
      },
    },
    doubt: { type: "array", items: { type: "string" } },
  },
};

/** data.images = [JPEG の base64]（2ページまで・上から順）、data.pages = {from, to, count}、data.prev = {no, date, chuban}（前の回の最後の伝票）、
 *  data.model（くらべるときだけ）→ { inv: 読んだもの, run: {model, ms, in, out} } */
async function readInvoice(client, data) {
  const images = arr(data.images).map(String).filter(Boolean).slice(0, INV_MAX_IMAGES);
  if (!images.length) throw new HttpsError("invalid-argument", "請求書の絵がありません");
  if (images.some(b => b.length > SLIP_MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(b))) throw new HttpsError("invalid-argument", "請求書の絵が大きすぎるか、こわれています");
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const p = data.pages || {}, pg = { from: num(p.from), to: num(p.to), count: num(p.count) };
  const q = data.prev || {}, cut = v => (v == null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, 40));
  const prev = { no: cut(q.no), date: cut(q.date), chuban: cut(q.chuban) };
  const model = COMPARE_MODELS[data.model] ? data.model : INVOICE_MODEL;
  const t0 = Date.now();
  let res;
  try {
    // 行が多い請求書（菅機械産業は1ページに40行ほど）は答えが長いので、ストリームで受けて最後にまとめる（時間切れにしない）
    res = await client.beta.messages.stream({
      model,
      max_tokens: 32000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: INVOICE_SCHEMA } },
      ...(COMPARE_MODELS[model] && !COMPARE_MODELS[model].fallback ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      messages: [{
        role: "user",
        content: [
          ...images.map(b => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } })),
          { type: "text", text: invoicePrompt(images.length, pg.count ? pg : null, prev) },
        ],
      }],
    }).finalMessage();
  } catch (err) {
    throw aiError(err);
  }
  await addTokens(res.usage);
  const run = { model: res.model, ms: Date.now() - t0, in: (res.usage && res.usage.input_tokens) || 0, out: (res.usage && res.usage.output_tokens) || 0 };
  if (res.stop_reason === "refusal") throw new HttpsError("failed-precondition", "AI に読み取りを断られました。手で合わせてください");
  if (res.stop_reason === "max_tokens") throw new HttpsError("resource-exhausted", "請求書の行が多すぎて、AI が読みきれませんでした");
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  let inv;
  try { inv = JSON.parse(text); } catch (err) { throw new HttpsError("internal", "AI の答えを読めませんでした。もう一度ためしてください"); }
  // 形をそろえる（ない種類の行は落とす。字は長すぎないように）
  const s = (v, n) => (v == null || v === "" ? null : String(v).replace(/\s+/g, " ").trim().slice(0, n));
  inv.rows = arr(inv.rows).filter(r => r && INV_KINDS.includes(r.kind)).slice(0, 600)
    .map(r => ({ kind: r.kind, no: s(r.no, 40), date: s(r.date, 10), chuban: s(r.chuban, 20), text: s(r.text, 40) || "", amount: num(r.amount) }));
  inv.doubt = arr(inv.doubt).map(x => String(x).slice(0, 40)).slice(0, 3);
  return { inv, run };
}

/** data = { task: "ping" | "usage" | "match" | "slip" | "invoice", lines?, images?, force?, pages?, prev?, model?（くらべるときだけ） } */
export const zairyoAi = onCall({
  region: "asia-southeast1", invoker: "public", secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 300, memory: "512MiB", maxInstances: 3,   // AI は60行で1分ほどかかることがある
}, async request => {
  await requireOffice(request);
  const task = String((request.data || {}).task || "");
  if (task === "usage") return usageNow();
  if (task !== "ping" && task !== "match" && task !== "slip" && task !== "invoice") throw new HttpsError("invalid-argument", "AI にたのむことが、わかりません");

  await countUp();
  // まえうしろの空白・改行はとる（クリップボードからわたすと、最後に改行がつくことがある）
  const client = new Anthropic({ apiKey: String(ANTHROPIC_API_KEY.value() || "").trim(), maxRetries: 1, timeout: 280 * 1000 });
  if (task === "match") return { ...(await matchItems(client, request.data || {})), ...(await usageNow()) };
  if (task === "slip") return { ...(await readSlip(client, request.data || {})), ...(await usageNow()) };
  if (task === "invoice") return { ...(await readInvoice(client, request.data || {})), ...(await usageNow()) };
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
