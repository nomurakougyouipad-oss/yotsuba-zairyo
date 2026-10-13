// AI（Claude）の入口（11章 7-3）
// - APIキーは Cloud Functions の secret（ANTHROPIC_API_KEY）。持ち主が自分のパソコンのターミナルで入れる。
//   ページ・GitHub・チャットには出さない。このプログラムも、キーを画面や記録に出さない
// - 呼べるのは事務所の端末だけ（lib.js の requireOffice）
// - 1日の回数の上限（AI_DAILY_LIMIT）。使った回数とトークンは /config/ai/days/{日付}（だれも読めない場所）に書き、画面にはこのプログラムが返す
// - モデルは 7-5 で本物の納品書でくらべてから、持ち主が決める。それまでは Claude Opus 5.5
// - Claude が断った（refusal）ときは、Claude のサーバーがほかのモデルでやりなおす（fallbacks: "default"）
// - いまは「つながるか」のためし（task: "ping"）と、今日使った回数（task: "usage"）だけ。
//   品名を品物一覧に当てる（7-4）・納品書を読む（7-5）は、あとで足す
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import Anthropic from "@anthropic-ai/sdk";
import { db, requireOffice } from "./lib.js";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODEL = "claude-opus-5-5";
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
  return { used: d.count || 0, limit: AI_DAILY_LIMIT, tokensIn: d.in || 0, tokensOut: d.out || 0, model: MODEL, key: keyShape() };
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

/** data = { task: "ping" | "usage" } */
export const zairyoAi = onCall({
  region: "asia-southeast1", invoker: "public", secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 120, memory: "512MiB", maxInstances: 3,
}, async request => {
  await requireOffice(request);
  const task = String((request.data || {}).task || "");
  if (task === "usage") return usageNow();
  if (task !== "ping") throw new HttpsError("invalid-argument", "AI にたのむことが、わかりません");

  await countUp();
  // まえうしろの空白・改行はとる（クリップボードからわたすと、最後に改行がつくことがある）
  const client = new Anthropic({ apiKey: String(ANTHROPIC_API_KEY.value() || "").trim(), maxRetries: 1, timeout: 60 * 1000 });
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
