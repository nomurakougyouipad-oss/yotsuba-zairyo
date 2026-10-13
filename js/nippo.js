// 日報（Firebase yotsuba-nippo）を読む ── 読むだけ。日報のデータベースには、ぜったいに書かない（CLAUDE.md の決まり 2）
// - このファイルでは、読む部品（ref・onValue）だけを使う。set・update・push・remove は持ってこない
// - 日報の設定は、日報のページ（nippo.html）に入っている公開の設定と同じ（秘密ではない）
// - 日報のデータ：master/jobs/{注番} = {no, name, owner, start, end, fixed, active}、終わった注番は master/closed（並び）、
//   作業者の名簿は master/workers/{w001…} = {name, kubun, shozoku, active}
//   日報の送信画面と同じく「active が false でなく、closed にない」注番を出す
// - 日報の注番を正しいものとして出す（10/12 持ち主）。常設の注番も、日報の名前で出す
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const nippoConfig = {
  apiKey: "AIzaSyDRTF3YW0oTbMcN3cwsmMDJWoLX4HpVtPk",
  authDomain: "yotsuba-nippo.firebaseapp.com",
  databaseURL: "https://yotsuba-nippo-default-rtdb.firebaseio.com",
  projectId: "yotsuba-nippo",
  storageBucket: "yotsuba-nippo.firebasestorage.app",
  messagingSenderId: "1007360975873",
  appId: "1:1007360975873:web:ac229f3f4016b81e994c00"
};
const db = getDatabase(initializeApp(nippoConfig, "nippo"));

/** 注番の形：英字2文字＋年2けた＋件数3けた */
export const CHUBAN_RE = /^[A-Z]{2}\d{5}$/;

/** 日報の注番を見張る。変わるたびに cb を呼ぶ
 *  cb({ open, fixed, all, bad })
 *    open  … えらべる工事（常設でない）[{chuban, kenmei, tantou, fixed:false}]
 *    fixed … 常設の注番（現場の画面では「固定の注番」）[{chuban, kenmei, tantou, fixed:true}]
 *    all   … 日報にある注番ぜんぶ Map(注番 → {…, closed})（終わった注番も入る。手で書いた注番のたしかめに使う）
 *    bad   … 形がちがう注番（えらぶ一覧には出さない）
 *  返り値：見張るのをやめる関数 */
export function watchJobs(cb, onErr) {
  let jobs = null, closed = null;
  const emit = () => {
    if (!jobs || !closed) return;
    const all = new Map(), open = [], fixed = [], bad = [];
    for (const j of Object.values(jobs)) {
      if (!j || !j.no) continue;
      if (!CHUBAN_RE.test(j.no)) { bad.push(j.no); continue; }
      const x = { chuban: j.no, kenmei: j.name || "", tantou: j.owner || "", fixed: !!j.fixed };
      const done = j.active === false || closed.has(j.no);
      all.set(x.chuban, { ...x, closed: done });
      if (!done) (x.fixed ? fixed : open).push(x);
    }
    cb({ open, fixed, all, bad });
  };
  const off1 = onValue(ref(db, "master/jobs"), s => { jobs = s.val() || {}; emit(); }, onErr);
  const off2 = onValue(ref(db, "master/closed"), s => { closed = new Set(Object.values(s.val() || {})); emit(); }, onErr);
  return () => { off1(); off2(); };
}

/** 日報の作業者の名簿（master/workers = {w001: {name, kubun:"自社"|"協力", shozoku:会社, active}}）を見張る
 *  cb([{name, kubun, shozoku}]) … 休止（active が false）の人はのぞく。⚙ 設定の「日報の人から足す」に使う
 *  返り値：見張るのをやめる関数 */
export function watchWorkers(cb, onErr) {
  return onValue(ref(db, "master/workers"), s => {
    cb(Object.values(s.val() || {})
      .filter(w => w && w.name && w.active !== false)
      .map(w => ({ name: String(w.name).trim(), kubun: w.kubun || "", shozoku: w.shozoku || "" })));
  }, onErr);
}
