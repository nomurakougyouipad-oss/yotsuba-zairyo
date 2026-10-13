// プッシュ通知（事務所のパソコンの右下に出る）── 予定アプリ・車両アプリと同じしくみ（10/14 持ち主）
// - このパソコンで通知を許可して、Firebase Cloud Messaging の受け取り番号（トークン）をもらい、
//   /zairyo/notify/tokens/{トークン} = {uid, name, ua, at} にしまう。送るのはサーバー（functions/notify.js）、出すのは sw.js
// - 公開鍵（VAPID）は Firebase の「プロジェクトの設定 → Cloud Messaging → ウェブプッシュ証明書」のもの。秘密ではない
// - 通知の部品（firebase-messaging）は、使うときだけ読む
import { ref, set, remove, push, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { app, db, auth } from "./firebase.js";
import { kikiName } from "./touroku.js";

const VAPID_KEY = "BDBrg9wtNVmj_WVissoEiIWmGtqUYQTNd9nlodJ_X1SncSgAo4LyUz5c8iOR9lmrMCJV2VUw0yqmD83IQ0C147g";
const MESSAGING_SDK = "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js";   // ほかの Firebase の部品と同じ版
const TOKEN_KEY = "yotsuba-zairyo-push-token";   // このパソコンのトークン
const TOKENS = "zairyo/notify/tokens";
const WAIT = { sdk: 20000, sw: 20000, token: 30000, test: 30000 };   // 返事が来ないときに打ち切る長さ

const lsGet = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (err) { return ""; } };
const lsSet = v => { try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch (err) { } };

/** p が ms たっても終わらなければ「時間切れ」にする */
function inTime(p, ms, what) {
  return new Promise((ok, ng) => {
    const t = setTimeout(() => ng(new Error(`${what}の返事がありません（${ms / 1000}秒）`)), ms);
    Promise.resolve(p).then(v => { clearTimeout(t); ok(v); }, e => { clearTimeout(t); ng(e); });
  });
}

/** このパソコンの通知のようす
 *  'unsupported' … このブラウザでは使えない / 'blocked' … 通知が止められている / 'on' … オン / 'off' … まだ */
export function pushState() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && lsGet() ? "on" : "off";
}

let mP = null;
/** 通知の部品と、このパソコンの service worker を用意する → { m, reg, sdk } */
async function messaging() {
  if (!mP) {
    mP = (async () => {
      const sdk = await inTime(import(MESSAGING_SDK), WAIT.sdk, "通知の部品");
      if (!(await sdk.isSupported())) throw new Error("このブラウザでは通知を使えません");
      const reg = await inTime(navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready), WAIT.sw, "service worker");
      return { m: sdk.getMessaging(app), reg, sdk };
    })().catch(err => { mP = null; throw err; });
  }
  return mP;
}

/** トークンをもらって、このパソコンの名前とひもづけてしまう（前のトークンは片づける） */
async function saveToken() {
  const { m, reg, sdk } = await messaging();
  const token = await inTime(sdk.getToken(m, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg }), WAIT.token, "通知の番号");
  if (!token) throw new Error("通知の番号がもらえませんでした");
  const user = auth.currentUser;
  const { claims } = await user.getIdTokenResult();
  await set(ref(db, `${TOKENS}/${token}`), {
    uid: user.uid, name: String(claims.zr_name || "事務所").slice(0, 60), ua: kikiName().slice(0, 80), at: serverTimestamp(),
  });
  const old = lsGet();
  if (old && old !== token) await remove(ref(db, `${TOKENS}/${old}`)).catch(() => { });
  lsSet(token);
  return token;
}

/** 「通知をオンにする」。許可のたずねは、押したらすぐに出す（先に何かを待たない） */
export async function enablePush() {
  const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (p !== "granted") {
    const e = new Error(p === "denied" ? "通知が許可されませんでした" : "通知の許可が、まだです");
    e.code = p;
    throw e;
  }
  return saveToken();
}

/** 「オフにする」：このパソコンにはもう送らない */
export async function disablePush() {
  const token = lsGet();
  if (token) await remove(ref(db, `${TOKENS}/${token}`));
  lsSet("");
  try { const { m, sdk } = await messaging(); await sdk.deleteToken(m); } catch (err) { }
}

/** 事務所の画面を開いたときに、だまってトークンを新しくする（トークンはときどき変わるため）。オンのときだけ */
export async function refreshPush() {
  if (pushState() !== "on") return;
  await saveToken();
}

/** 「ためしに通知を送る」：サーバーにたのんで、このパソコンにだけ送ってもらう → { ok, error } */
export async function testPush() {
  const token = lsGet();
  if (!token) return { ok: false, error: "このパソコンの通知が、オンになっていません" };
  const r = push(ref(db, "zairyo/notify/tests"));
  await set(r, { token, uid: auth.currentUser.uid, at: serverTimestamp() });
  let off = () => { };
  try {
    return await inTime(new Promise(ok => {
      off = onValue(r, s => { const v = s.val(); if (v && v.done) ok({ ok: !!v.ok, error: v.error || "" }); }, () => { });
    }), WAIT.test, "サーバー");
  } finally {
    off();
    remove(r).catch(() => { });
  }
}
