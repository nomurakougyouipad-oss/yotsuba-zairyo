// Firebase（yotsuba-daicho）につなぐ
// - 下の設定はページに入れてよいもの（秘密ではありません）。秘密（APIキー sk-ant- …・合言葉）はここに書かない
// - Firebase の部品の版は、ほかのよつばのアプリと同じ 12.19.0
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase, ref, onValue, get } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

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

/** データベースにつながっているかを見張ります。cb(true / false) */
export function watchConnected(cb) {
  return onValue(ref(db, ".info/connected"), snap => cb(snap.val() === true));
}

/** 鍵（ルール）がかかっているかをたしかめます。登録していない人が読めなければ true */
export async function isLocked() {
  try {
    await get(ref(db, "zairyo"));
    return false;
  } catch (err) {
    if (/permission/i.test(String(err && err.message))) return true;
    throw err;
  }
}
