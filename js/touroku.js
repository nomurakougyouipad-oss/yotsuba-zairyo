// 合言葉での登録（現場のスマホ・事務所のパソコン共通）
// - 端末ごとの番号は Firebase の匿名ログインで作る（つまり、名前・パスワードなしで1台ずつ番号をふる）
// - 合言葉はサーバー（zairyoRegisterDevice）がたしかめて、役割（zr_role）と名前（zr_name）をつける
// - 登録のあとは getIdToken(true) でトークンを新しくする（しないと、ルールが新しい役割を最大1時間見てくれない）
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { ref, get, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { auth, db, call } from "./firebase.js";

/** ページを開いたときのログインの状態が分かるまで待つ（答えは使わず、そのあとは auth.currentUser を見る。
 *  開いたときにログインしていなくても、登録でログインしたあとは currentUser に入るため） */
const authReady = new Promise(resolve => {
  const off = onAuthStateChanged(auth, () => { off(); resolve(); });
});

/* 登録した端末の番号を、ブラウザにも控えておく（ログインだけが消えたときに気づけるように） */
const UID_KEY = "yotsuba-zairyo-uid";
function lastUid() {
  try { return localStorage.getItem(UID_KEY) || ""; } catch (err) { return ""; }
}
function saveUid(uid) {
  try { localStorage.setItem(UID_KEY, uid); } catch (err) { }
}

/** この端末の登録をしらべる
 *  { role: "genba" | "office", name } … 登録ずみ
 *  { role: null, removed: true }      … 事務所が登録を消した
 *  { role: null, lost: true }         … 登録したはずのログインが、この端末から消えていた
 *  null                               … まだ登録していない */
export async function whoAmI() {
  await authReady;
  const user = auth.currentUser;
  if (!user) return lastUid() ? { role: null, lost: true } : null;
  let { claims } = await user.getIdTokenResult();
  const snap = await get(ref(db, `zairyo/devices/${user.uid}`));
  if (!snap.exists()) return claims.zr_role ? { role: null, removed: true } : null;
  // 登録はあるのに、トークンが登録の前のまま残っていたときは、新しくしてから見る
  if (!claims.zr_role) ({ claims } = await user.getIdTokenResult(true));
  if (!claims.zr_role) return null;
  saveUid(user.uid);
  touch(user.uid, snap.val());
  return { role: claims.zr_role, name: claims.zr_name || "" };
}

/** 合言葉で登録する。現場で name がないときは { needName, staff } が返る（まだ登録していない） */
export async function register(kind, code, name = "") {
  if (!auth.currentUser) await signInAnonymously(auth);
  const res = await call("zairyoRegisterDevice")({ kind, code, name, kiki: kikiName() });
  if (res.data && res.data.role) {
    await auth.currentUser.getIdToken(true);
    saveUid(auth.currentUser.uid);
  }
  return res.data;
}

/* ---------- 機種と最後に開いた日（事務所の「登録した端末」で、どの端末か見分けるため） ---------- */
const SEEN_EVERY = 60 * 60 * 1000;   // 最後に開いた日は、1時間に1回まで書く

/** この端末の機種（例 iPhone・ホーム画面、Windows・Edge） */
export function kikiName() {
  const ua = navigator.userAgent || "";
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = /iPhone|iPod/.test(ua) ? "iPhone" : ipad ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : "";
  const br = isStandalone() ? (os === "Windows" || os === "Mac" ? "アプリ" : "ホーム画面")
    : / Line\//.test(ua) ? "LINE" : /Edg(A|iOS)?\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, br].filter(Boolean).join("・") || "わからない";
}

/** 開いたときに、自分の登録の欄に「最後に開いた日」と機種を書く（まちがっても止めない） */
function touch(uid, d) {
  const upd = {};
  if (!d.seenAt || Date.now() - d.seenAt > SEEN_EVERY) upd.seenAt = serverTimestamp();
  const k = kikiName();
  if (d.kiki !== k) upd.kiki = k;
  if (Object.keys(upd).length) update(ref(db, `zairyo/devices/${uid}`), upd).catch(() => { });
}

/** まちがいを、やさしい言葉にする */
export function errorText(err) {
  const code = String((err && err.code) || "");
  if (code === "auth/configuration-not-found" || code === "auth/operation-not-allowed" || code === "auth/admin-restricted-operation") {
    return "Firebase の「匿名ログイン」がオフになっています。持ち主に知らせてください";
  }
  if (code === "auth/network-request-failed" || code === "functions/unavailable" || code === "functions/deadline-exceeded") {
    return "つながりませんでした。電波をたしかめて、もう一度ためしてください";
  }
  // サーバーの言葉をそのまま出す（うしろにつく [403] などの番号は消す）
  if (code.startsWith("functions/") && code !== "functions/internal" && err.message) return err.message.replace(/\s*\[\d{3}\]$/, "");
  return "うまくいきませんでした。もう一度ためしてください（" + (code || (err && err.message) || "わからないまちがい") + "）";
}

/** iPhone の Safari で開いている（ホーム画面のアプリではない）か */
export function isIPhoneBrowser() {
  return isIOS() && !isStandalone();
}
function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}
