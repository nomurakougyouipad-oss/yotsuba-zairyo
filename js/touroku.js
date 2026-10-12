// 合言葉での登録（現場のスマホ・事務所のパソコン共通）
// - 端末ごとの番号は Firebase の匿名ログインで作る（つまり、名前・パスワードなしで1台ずつ番号をふる）
// - 合言葉はサーバー（zairyoRegisterDevice）がたしかめて、役割（zr_role）と名前（zr_name）をつける
// - 登録のあとは getIdToken(true) でトークンを新しくする（しないと、ルールが新しい役割を最大1時間見てくれない）
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { auth, db, call } from "./firebase.js";

/** ログインの状態が分かるまで待つ */
const authReady = new Promise(resolve => {
  const off = onAuthStateChanged(auth, user => { off(); resolve(user); });
});

/** この端末の登録をしらべる
 *  { role: "genba" | "office", name } … 登録ずみ
 *  { role: null, removed: true }      … 事務所が登録を消した
 *  null                               … まだ登録していない */
export async function whoAmI() {
  const user = await authReady;
  if (!user) return null;
  const { claims } = await user.getIdTokenResult();
  if (!claims.zr_role) return null;
  const snap = await get(ref(db, `zairyo/devices/${user.uid}`));
  if (!snap.exists()) return { role: null, removed: true };
  return { role: claims.zr_role, name: claims.zr_name || "" };
}

/** 合言葉で登録する。現場で name がないときは { needName, staff } が返る（まだ登録していない） */
export async function register(kind, code, name = "") {
  if (!auth.currentUser) await signInAnonymously(auth);
  const res = await call("zairyoRegisterDevice")({ kind, code, name });
  if (res.data && res.data.role) await auth.currentUser.getIdToken(true);
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
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  return ios && !standalone;
}
