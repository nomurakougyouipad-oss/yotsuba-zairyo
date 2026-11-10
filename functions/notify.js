// プッシュ通知（事務所のパソコンの右下に出る）── 予定アプリ・車両アプリと同じしくみ（10/14 持ち主）
// - 事務所のパソコンが ⚙ 設定 →「通知」でオンにすると、通知の受け取り番号（トークン）が
//   /zairyo/notify/tokens/{トークン} = {uid, name, ua, at} に入る
// - 現場から新しい依頼が来たら（/zairyo/requests に足されたら）、すぐにオンのパソコンへ送る（zairyoNotifyRequest）
//   送ってから10分より古い依頼（バックアップからもどしたときなど）や、取り消した依頼は知らせない
// - 「ためしに通知を送る」は /zairyo/notify/tests/{番号} = {token, uid, at} を足すと、そのパソコンにだけ送る（zairyoNotifyTest）
//   結果（ok・error）を同じ所に書きもどす。画面が読んで知らせて、消す
// - 送るのは data だけ（title・body・tag・url）。表示はパソコンの sw.js がする（予定・車両と同じ）
// - 登録を消した端末・事務所でなくなった端末のトークンには送らない（見つけたら消す）。使えなくなったトークンも消す
// - 場所は、データベースと同じシンガポール（asia-southeast1）。OPTS に書く（index.js の setGlobalOptions は効かないため）
// - 材料屋のアプリ（2-6・10/16 持ち主 1A・2B・3A）：注文が変わったら zairyoNotifyOrder が知らせる
//   材料屋の端末へ：【新しい注文】（アプリに送った）・【直しました】・【取り消し】。LINE・電話の注文は、もう知っているので知らせない
//   事務所のパソコンへ：【受けました】（届ける日つき）だけ。夜も休みもすぐ送る。トークンは /zairyo/notify/supTokens/{トークン} = {uid, sup, name, ua, at}
// - 11/10（持ち主）：依頼が来てから30分たっても、まだ注文していない依頼があれば、事務所にもう一度だけ知らせる（zairyoRemindRequests）。
//   5分ごとに見まわる（夜も土日も）。「まだ注文していない」は事務所の上の箱と同じ数え方（status "sent"。一部だけ注文した依頼も入る）。
//   同じ依頼で知らせるのは1回だけ（知らせた依頼は /zairyo/notify/reminded/{依頼} = 時刻。サーバーだけが書く）。3日より前の依頼では知らせない
//   出し方（押すか × を押すまで残す・押すと依頼の一覧）は sw.js（tag saisoku）
// - 11/10（持ち主）：今日ほしい依頼（希望日が今日か過ぎた日。「最短」は入れない）は、新しい依頼の通知の題を【今日ほしい】で始める。
//   2回目の知らせも30分ではなく10分（ほかの依頼は30分のまま）
import { onValueCreated, onValueWritten } from "firebase-functions/v2/database";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getMessaging } from "firebase-admin/messaging";
import { db } from "./lib.js";

const OPTS = { region: "asia-southeast1", instance: "yotsuba-daicho-default-rtdb", maxInstances: 3, memory: "256MiB", timeoutSeconds: 60 };
const FRESH_MS = 10 * 60 * 1000;   // これより古い依頼は知らせない
const URL_OFFICE = "./jimusho.html";
const SUP_TOKENS = "zairyo/notify/supTokens";   // 材料屋の端末（2-6）
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

/** 日本の今日 "YYYY-MM-DD" */
const todayJst = (now = Date.now()) => new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
/** 今日ほしい依頼か（希望日が今日か、もう過ぎた日。「最短」は入れない。11/10 持ち主。事務所の画面の isUrgent と同じ） */
export const isUrgent = (r, now = Date.now()) => /^\d{4}-\d{2}-\d{2}$/.test((r && r.kibou) || "") && r.kibou <= todayJst(now);
const HOT = "【今日ほしい】";

/** 新しい依頼の通知の文（今日ほしい依頼は、題のはじめに【今日ほしい】。11/10） */
export function requestMessage(id, r, now = Date.now()) {
  const n = Object.keys(r.lines || {}).length;
  const where = [r.kibou ? `いつ：${kibouText(r.kibou)}` : "", r.basho ? `届け先：${show(r.basho)}` : ""].filter(Boolean).join("　");
  return {
    title: `${isUrgent(r, now) ? HOT : ""}現場から新しい依頼（${show(r.chumonsha) || "名前なし"}さん）`.slice(0, 60),
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

/** いまその材料屋として登録されている端末のトークン [{token, name}]（2-6）。登録が消えた・材料屋がちがう端末のトークンは消す */
async function supTokens(supId) {
  const [tokens, devices] = await Promise.all([db().ref(SUP_TOKENS).get(), db().ref("zairyo/devices").get()]);
  const dev = devices.val() || {}, list = [], gone = {};
  for (const [token, t] of Object.entries(tokens.val() || {})) {
    const d = t && t.uid && dev[t.uid];
    if (!d || d.role !== "sup" || d.sup !== t.sup) gone[token] = null;
    else if (t.sup === supId) list.push({ token, name: t.name || "?" });
  }
  if (Object.keys(gone).length) {
    await db().ref(SUP_TOKENS).update(gone);
    logger.info(`登録のない材料屋の端末のトークン ${Object.keys(gone).length}件を消しました`);
  }
  return list;
}

/** 送る。使えなくなったトークンは消す（path＝トークンのしまい場所）。{ ok: 送れた数, errors: [code] } */
async function sendTo(targets, msg, path = "zairyo/notify/tokens") {
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
  if (Object.keys(dead).length) await db().ref(path).update(dead);
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

/* ---------- まだ注文していない依頼を、もう一度だけ知らせる（11/10） ---------- */
const REMIND_AFTER = 30 * 60 * 1000;             // 来てから30分
const REMIND_URGENT = 10 * 60 * 1000;            // 今日ほしい依頼は10分（11/10 持ち主）
const REMIND_MAX_AGE = 3 * 24 * 3600 * 1000;     // 3日より前の依頼では知らせない（バックアップからもどしたときなど）
const REMINDED = "zairyo/notify/reminded";       // 知らせた依頼 {依頼: 時刻}
/** 時刻 → "11/10 9:05"（日本の時刻） */
const whenText = ts => { const d = new Date(ts + 9 * 3600 * 1000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

/** 知らせの文。open＝まだ注文していない依頼ぜんぶ、due＝こんど知らせる依頼（古い順） */
export function remindMessage(open, due, now = Date.now()) {
  const shown = due.slice(0, 3).map(([, r]) => `${isUrgent(r, now) ? "【今日】" : ""}${show(r.chumonsha) || "名前なし"}さん ${show(r.chuban)}（${whenText(r.sentAt)}に来た）`);
  const rest = open.length - shown.length;
  return {
    title: `${due.some(([, r]) => isUrgent(r, now)) ? HOT : ""}まだ注文していない依頼が${open.length}件あります`,
    body: [...shown, rest > 0 ? `ほか${rest}件` : ""].filter(Boolean).join("\n").slice(0, 200),
    tag: "saisoku",
    url: URL_OFFICE,
  };
}
/** 見まわりで決めること（データベースは読まない。ためしやすいように）。
 *  reqs＝/zairyo/requests、marks＝/zairyo/notify/reminded → { due: [依頼], gone: {もう要らない印: null}, msg: 知らせの文 | null } */
export function remindPlan(reqs, marks, now) {
  const open = Object.entries(reqs || {}).filter(([, r]) => r && r.status === "sent" && typeof r.sentAt === "number").sort(([, a], [, b]) => a.sentAt - b.sentAt);
  const done = marks || {};
  const due = open.filter(([id, r]) => now - r.sentAt >= (isUrgent(r, now) ? REMIND_URGENT : REMIND_AFTER) && now - r.sentAt <= REMIND_MAX_AGE && !done[id]);
  const openIds = new Set(open.map(([id]) => id));
  const gone = Object.fromEntries(Object.keys(done).filter(id => !openIds.has(id)).map(id => [id, null]));   // 注文した・取り消した・消えた依頼の印は片づける
  return { due: due.map(([id]) => id), gone, msg: due.length ? remindMessage(open, due, now) : null };
}
export const zairyoRemindRequests = onSchedule({
  region: "asia-southeast1", schedule: "every 5 minutes", timeZone: "Asia/Tokyo", retryCount: 0, maxInstances: 1, memory: "256MiB", timeoutSeconds: 60,
}, async () => {
  const now = Date.now();
  const [reqs, marks] = await Promise.all([db().ref("zairyo/requests").get(), db().ref(REMINDED).get()]);
  const plan = remindPlan(reqs.val(), marks.val(), now);
  const upd = { ...plan.gone };
  if (plan.msg) {
    const targets = await officeTokens();
    const r = await sendTo(targets, plan.msg);
    // 同じ依頼で知らせるのは1回だけ。1つも送れなかったとき（通信のまちがいなど）は、次の見まわりでもう一度。通知がオンのパソコンがないときは、知らせたことにする
    if (r.ok || !targets.length) plan.due.forEach(id => { upd[id] = now; });
  }
  if (Object.keys(upd).length) await db().ref(REMINDED).update(upd);
});

/* ---------- 材料屋のアプリ（2-6）：注文が変わったら知らせる ---------- */
const fresh = ts => typeof ts === "number" && Date.now() - ts <= FRESH_MS;   // もどしたデータなどで古い知らせを出さない
const orderHead = o => `${show(o.chuban)} ${show(o.kenmei)}`.slice(0, 80);
const supUrl = id => `./zairyoya.html?o=${encodeURIComponent(id)}`;   // 押したら、その注文を開く
/** いちばん新しい「直した：…」の文（「直した：」はとる） */
function lastEdit(o) {
  const last = Object.values(o.log || {}).filter(x => x && x.what).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  return last ? String(last.what).replace(/^直した：/, "").slice(0, 100) : "";
}
/** 材料屋への知らせの文（kind：new・edit・cancel）。同じ注文の知らせは重ねない（tag） */
export function supMessage(kind, id, o) {
  const n = Object.keys(o.lines || {}).length;
  const body = {
    new: [`${orderHead(o)}・${n}点`, [o.kibou ? `希望日：${kibouText(o.kibou)}` : "", o.basho ? `届け先：${show(o.basho)}` : ""].filter(Boolean).join("　")],
    edit: [orderHead(o), lastEdit(o) || "アプリで直したところを見てください"],
    cancel: [orderHead(o), "届けないでください"],
  }[kind];
  const title = { new: "【新しい注文】よつば建設工業から", edit: "【直しました】よつば建設工業が注文を直しました", cancel: "【取り消し】よつば建設工業が注文を取り消しました" }[kind];
  return { title, body: body.filter(Boolean).join("\n").slice(0, 200), tag: `sup_${id}`, url: supUrl(id) };
}
/** 事務所への知らせ：材料屋が受けた（届ける日つき） */
export function acceptMessage(id, o) {
  return {
    title: `【受けました】${show(o.supplierName)}が注文を受けました`.slice(0, 60),
    body: [orderHead(o), o.deliverDate ? `${kibouText(o.deliverDate)}に届ける予定` : ""].filter(Boolean).join("\n"),
    tag: `uke_${id}`,
    url: URL_OFFICE,
  };
}
/** 前と後をくらべて、知らせることを決める → [{ to: "sup" | "office", msg }] */
export function orderEvents(id, b, a) {
  if (!a || !a.supState) return [];
  const out = [], toSup = kind => out.push({ to: "sup", msg: supMessage(kind, id, a) });
  b = b || {};
  if (b.status !== "cancelled" && a.status === "cancelled") { if (b.supState && fresh(a.cancelledAt)) toSup("cancel"); return out; }
  if (a.status === "cancelled") return out;
  if (!b.supState && a.supState === "sent" && a.supVia !== "line" && fresh(a.supSentAt)) toSup("new");
  else if (a.supEditedAt && a.supEditedAt !== b.supEditedAt && fresh(a.supEditedAt)) toSup("edit");
  if (b.supState === "sent" && a.supState === "accepted" && fresh(a.supAcceptedAt)) out.push({ to: "office", msg: acceptMessage(id, a) });
  return out;
}
export const zairyoNotifyOrder = onValueWritten({ ...OPTS, ref: "/zairyo/orders/{id}" }, async event => {
  const a = event.data.after.val(), b = event.data.before.val();
  for (const ev of orderEvents(event.params.id, b, a)) {
    if (ev.to === "sup") await sendTo(await supTokens(a.supplier), ev.msg, SUP_TOKENS);
    else await sendTo(await officeTokens(), ev.msg);
  }
});

/** 「ためしに通知を送る」：たのんだパソコン（材料屋の端末も。2-6）にだけ送って、結果を書きもどす */
export const zairyoNotifyTest = onValueCreated({ ...OPTS, ref: "/zairyo/notify/tests/{id}" }, async event => {
  const t = event.data.val() || {};
  const done = v => event.data.ref.update({ done: true, ...v });
  if (typeof t.token !== "string" || !TOKEN_RE.test(t.token)) return done({ ok: false, error: "通知の番号の形がちがいます" });
  const supTok = (await db().ref(`${SUP_TOKENS}/${t.token}`).get()).val();
  if (supTok) {   // 材料屋の端末
    const mine = (await supTokens(supTok.sup)).filter(x => x.token === t.token);
    if (!mine.length || supTok.uid !== t.uid) return done({ ok: false, error: "この端末の通知が、オンになっていません" });
    const r = await sendTo(mine, { title: "ためしの通知（よつば資材便）", body: "この端末に、よつば建設工業からの知らせが届きます", tag: `test_${event.params.id}`, url: "./zairyoya.html" }, SUP_TOKENS);
    return done(r.ok ? { ok: true } : { ok: false, error: r.errors[0] || "送れませんでした" });
  }
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
