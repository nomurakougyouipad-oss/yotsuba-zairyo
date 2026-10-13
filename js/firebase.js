// Firebase（yotsuba-daicho）につなぐ
// - 下の設定はページに入れてよいもの（秘密ではありません）。秘密（APIキー sk-ant- …・合言葉）はここに書かない
// - Firebase の部品の版は、ほかのよつばのアプリと同じ 12.19.0
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase, ref, onValue, get } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { initializeAuth, browserLocalPersistence, indexedDBLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBcbbpWgnsUO00_CkvSEV7QLCl0sXjKlEw",
  authDomain: "yotsuba-daicho.firebaseapp.com",
  databaseURL: "https://yotsuba-daicho-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "yotsuba-daicho",
  storageBucket: "yotsuba-daicho.firebasestorage.app",
  messagingSenderId: "263998950615",
  appId: "1:263998950615:web:5299df16af54fee4bfb492"
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
// ログインの保存場所：localStorage を先に使う（10/12 iPhone で、開きなおすとログインが消えたため。ためしに変えた）
// 前に IndexedDB にしまったログインは、Firebase が localStorage へ移してくれる
export const auth = initializeAuth(app, {
  persistence: [browserLocalPersistence, indexedDBLocalPersistence, browserSessionPersistence],
});
const functions = getFunctions(app, "asia-southeast1");   // サーバーのプログラムの場所（データベースと同じシンガポール）
export const storage = getStorage(app);                   // 写真の置き場（東京 asia-northeast1。10/12 持ち主）

/** サーバーのプログラムを呼ぶ。call("zairyoRegisterDevice")({ … }) */
export const call = (name, opts) => httpsCallable(functions, name, opts);   // opts 例 { timeout: 180000 }（AI は時間がかかる）

/** データベースにつながっているかを見張ります。cb(true / false) */
export function watchConnected(cb) {
  return onValue(ref(db, ".info/connected"), snap => cb(snap.val() === true));
}

/** 登録した端末だけが読める所（注文する人の一覧）を読めるかをたしかめます */
export async function canReadMaster() {
  try {
    await get(ref(db, "zairyo/master/staff"));
    return true;
  } catch (err) {
    if (/permission/i.test(String(err && err.message))) return false;
    throw err;
  }
}
