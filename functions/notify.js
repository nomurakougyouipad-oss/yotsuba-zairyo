// プッシュ通知（事務所のパソコンの右下に出る）── 予定アプリ・車両アプリと同じしくみ（10/14 持ち主）
// - 事務所のパソコンが ⚙ 設定 →「通知」でオンにすると、通知の受け取り番号（トークン）が
//   /zairyo/notify/tokens/{トークン} = {uid, name, ua, at} に入る
// - 現場から新しい依頼が来たら（/zairyo/requests に足されたら）、すぐにオンのパソコンへ送る（zairyoNotifyRequest）
//   送ってから10分より古い依頼（バックアップからもどしたときなど）や、取り消した依頼は知らせない
// - 「ためしに通知を送る」は /zairyo/notify/tests/{番号} = {token, uid, at} を足すと、そのパソコンにだけ送る（zairyoNotifyTest）
//   結果（ok・error）を同じ所に書きもどす。画面が読んで知らせて、消す
// - 送るのは data だけ（title・body・tag・url）。表示はパソコンの sw.js がする（予定・車両と同じ）
// - 登録を消した端末・事務所でなくなった端末のトークンには送らない（見つけたら消す）。使えなくなったトークンも消す
// - 場所は、データベースと同じシンガポール（asia-southeast1）
import { onValueCreated } from "firebase-functions/v2/database";
import { logger } from "firebase-functions/v2";
import { getMessaging } from "firebase-admin/messaging";
import { db } from "./lib.js";

const OPTS = { region: "asia-southeast1", instance: "yotsuba-daicho-default-rtdb", maxInstances: 3, memory: "256MiB", timeoutSeconds: 60 };
const FRESH_MS = 10 * 60 * 1000;   // これより古い依頼は知らせない
const URL_OFFICE = "./jimusho.html";
// 使えなくなったトークン（パソコンが通知の許可を取り消した・ブラウザのデータを消した など）
const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);
const TOKEN_RE = /^[A-Za-z0-9_:-]{20,4096}$/;   // データベースのルールと同じ形
const WEEK = "日月火水木金土";

/** "2026-10-20" → "10/20（火）"。"最短" などはそのまま */
function kibouText(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ""));
  if (!m) return String(k || "");
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${+m[2]}/${+m[3]}（${WEEK[d.getUTCDay()]}）`;
}
// 日報の件名の半角カナは、全角にして出す（画面の zenkana と同じ見え方）
const show = s => String(s ?? "").replace(/[｡-ﾟ]+/g, m => m.normalize("NFKC")).trim();

/** 新しい依頼の通知の文 */
export function requestMessage(id, r) {
  const n = Object.keys(r.lines || {}).length;
  const where = [r.kibou ? `いつ：${kibouText(r.kibou)}` : "", r.basho ? `届け先：${show(r.basho)}` : ""].filter(Boolean).join("　");
  return {
    title: `現場から新しい依頼（${show(r.chumonsha) || "名前なし"}さん）`.slice(0, 60),
    body: [`${show(r.chuban)} ${show(r.kenmei)}・${n}点`.slice(0, 80), where].filter(Boolean).join("\n"),
    tag: `irai_${id}`,
    url: URL_OFFICE,
  };
}

/** いま事務所として登録されている端末のトークン [{token, name}]。登録が消えた端末のトークンは消す */
async function officeTokens() {
  const [tokens, devices] = await Promise.all([db().ref("zairyo/notify/tokens").get(), db().ref("zairyo/devices").get()]);
  const dev = devices.val() || {}, list = [], gone = {};
  for (const [token, t] of Object.entries(tokens.val() || {})) {
    if (t && t.uid && dev[t.uid] && dev[t.uid].role === "office") list.push({ token, name: t.name || "?" });
    else gone[token] = null;
  }
  if (Object.keys(gone).length) {
    await db().ref("zairyo/notify/tokens").update(gone);
    logger.info(`登録のない端末のトークン ${Object.keys(gone).length}件を消しました`);
  }
  return list;
}

/** 送る。使えなくなったトークンは消す。{ ok: 送れた数, errors: [code] } */
async function sendTo(targets, msg) {
  if (!targets.length) return { ok: 0, errors: [] };
  const res = await getMessaging().sendEachForMulticast({
    tokens: targets.map(t => t.token),
    data: msg,
    webpush: { headers: { Urgency: "high", TTL: String(24 * 3600) } },
  });
  const dead = {}, errors = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = (r.error && r.error.code) || "unknown";
    errors.push(code);
    if (DEAD.has(code)) dead[targets[i].token] = null;
    logger.warn(`送れませんでした（${targets[i].name}）`, code, r.error && r.error.message);
  });
  if (Object.keys(dead).length) await db().ref("zairyo/notify/tokens").update(dead);
  logger.info(`通知「${msg.title}」${res.successCount}件送信・使えないトークン ${Object.keys(dead).length}件を消しました`);
  return { ok: res.successCount, errors };
}

/** 現場から新しい依頼が来たら、通知がオンの事務所のパソコンへ */
export const zairyoNotifyRequest = onValueCreated({ ...OPTS, ref: "/zairyo/requests/{id}" }, async event => {
  const r = event.data.val() || {};
  if (r.status !== "sent" || typeof r.sentAt !== "number" || Date.now() - r.sentAt > FRESH_MS) return;
  const targets = await officeTokens();
  await sendTo(targets, requestMessage(event.params.id, r));
});

/** 「ためしに通知を送る」：たのんだパソコンにだけ送って、結果を書きもどす */
export const zairyoNotifyTest = onValueCreated({ ...OPTS, ref: "/zairyo/notify/tests/{id}" }, async event => {
  const t = event.data.val() || {};
  const done = v => event.data.ref.update({ done: true, ...v });
  if (typeof t.token !== "string" || !TOKEN_RE.test(t.token)) return done({ ok: false, error: "通知の番号の形がちがいます" });
  const mine = (await officeTokens()).filter(x => x.token === t.token);
  const tok = (await db().ref(`zairyo/notify/tokens/${t.token}`).get()).val();
  if (!mine.length || !tok || tok.uid !== t.uid) return done({ ok: false, error: "このパソコンの通知が、オンになっていません" });
  const r = await sendTo(mine, {
    title: "ためしの通知（よつば資材便）",
    body: "このパソコンに、通知が届きます",
    tag: `test_${event.params.id}`,
    url: URL_OFFICE,
  });
  return done(r.ok ? { ok: true } : { ok: false, error: r.errors[0] || "送れませんでした" });
});
