// 合言葉での登録（現場のスマホ・事務所のパソコン共通）
// - 端末ごとの番号は Firebase の匿名ログインで作る（つまり、名前・パスワードなしで1台ずつ番号をふる）
// - 合言葉はサーバー（zairyoRegisterDevice）がたしかめて、役割（zr_role）と名前（zr_name）をつける
// - 登録のあとは getIdToken(true) でトークンを新しくする（しないと、ルールが新しい役割を最大1時間見てくれない）
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
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
  return { role: claims.zr_role, name: claims.zr_name || "" };
}

/** 合言葉で登録する。現場で name がないときは { needName, staff } が返る（まだ登録していない） */
export async function register(kind, code, name = "") {
  if (!auth.currentUser) await signInAnonymously(auth);
  const res = await call("zairyoRegisterDevice")({ kind, code, name });
  if (res.data && res.data.role) {
    await auth.currentUser.getIdToken(true);
    saveUid(auth.currentUser.uid);
  }
  return res.data;
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

/** しらべ用の1行（登録の画面の下に小さく出す。登録が消える問題が分かったら外す）
 *  例：しらべ用：番号 aBjfGP／前の番号 なし／保存 LS○ IDB○／ホーム画面のアプリ */
export async function diagText() {
  let ls = false;
  try {
    localStorage.setItem("yotsuba-zairyo-test", "1");
    ls = localStorage.getItem("yotsuba-zairyo-test") === "1";
    localStorage.removeItem("yotsuba-zairyo-test");
  } catch (err) { }
  const idb = await new Promise(resolve => {
    try {
      const req = indexedDB.open("yotsuba-zairyo-test");
      req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase("yotsuba-zairyo-test"); resolve(true); };
      req.onerror = () => resolve(false);
    } catch (err) { resolve(false); }
  });
  const cur = auth.currentUser ? auth.currentUser.uid.slice(0, 6) : "なし";
  const last = lastUid() ? lastUid().slice(0, 6) : "なし";
  return `しらべ用：番号 ${cur}／前の番号 ${last}／保存 LS${ls ? "○" : "×"} IDB${idb ? "○" : "×"}／${isStandalone() ? "ホーム画面のアプリ" : "ブラウザ"}`;
}
