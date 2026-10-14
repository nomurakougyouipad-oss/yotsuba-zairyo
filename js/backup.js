// 事務所の「今すぐバックアップを保存」（11章 8-2）
// - 材料注文のデータ（依頼・注文・請求・単価・設定・登録した端末）と、台帳ぜんたいの注番の会社（/common）を
//   1つのファイル（JSON）にして、このパソコンに保存する
// - 写真（Storage）と合言葉（/config）は入れない。写真は 8-3 の週1回のまるごと保存で守る
// - 戻すのは、持ち主のパソコンのターミナルで tools/restore-backup.mjs を使う（まちがえて上書きしないように、アプリからは戻さない）
import { ref, get } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";

/** 保存する場所と、画面に出す名前（tools/restore-backup.mjs と同じ並び） */
export const BACKUP_PATHS = [
  ["zairyo/requests", "依頼"],
  ["zairyo/orders", "注文"],
  ["zairyo/invoices", "まとめて請求"],
  ["zairyo/prices", "単価の記録"],
  ["zairyo/imports", "納品書の取りこみの記録"],
  ["zairyo/officeInfo", "会社・注文書・電話番号"],
  ["zairyo/master", "設定（材料屋・注文する人・届け先・品物一覧）"],
  ["zairyo/devices", "登録した端末"],
  ["common", "注番の会社・固定の注番・注番の年"],
];
const LAST_KEY = "yotsuba-zairyo-lastbackup";

const n = v => (v && typeof v === "object" ? Object.keys(v).length : 0);
const items = cat => (cat && cat.cats ? Object.values(cat.cats).reduce((s, c) => s + n(c && c.items), 0) : 0);

/** 画面に出す中身の数（例「12件」「材料屋 5・注文する人 8…」） */
export function countText(path, v) {
  if (path === "zairyo/master") {
    const m = v || {};
    return `材料屋 ${n(m.suppliers)}・注文する人 ${n(m.staff)}・届け先 ${n(m.places)}・品物 ${items(m.catalog)}`;
  }
  if (path === "zairyo/officeInfo") {
    const o = v || {};
    return `会社の情報 ${o.company ? "あり" : "なし"}・決まり文句 ${o.phrases ? "あり" : "なし"}・電話番号 ${n(o.tels)}人`;
  }
  if (path === "common") {
    const c = v || {};
    return `会社 ${n(c.kaisha)}・固定の注番 ${n(c.kotei)}・注番の年 ${c.chubanYear || "なし"}`;
  }
  return `${n(v)}${path === "zairyo/devices" ? "台" : "件"}`;
}

/** いまのデータを読む → { 場所: 中身 } */
export async function readAll() {
  const data = {};
  for (const [p] of BACKUP_PATHS) data[p] = (await get(ref(db, p))).val();
  return data;
}

const pad = x => String(x).padStart(2, "0");
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

/** 読んで、ファイルにして保存する。{ name, size, data } を返す */
export async function saveBackup(byName = "") {
  const data = await readAll();
  const now = new Date();
  const file = {
    app: "yotsuba-zairyo", kind: "backup", version: 1, project: "yotsuba-daicho",
    savedAt: now.toISOString(), savedBy: byName,
    note: "よつば材料注文のバックアップ。写真と合言葉は入っていない。戻すときは tools/restore-backup.mjs を使う",
    data,
  };
  const name = `zairyo-backup-${stamp(now)}.json`;
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  const last = { at: now.getTime(), name, size: blob.size };
  try { localStorage.setItem(LAST_KEY, JSON.stringify(last)); } catch (err) { }
  return { ...last, data };
}

/** このパソコンで前に保存したとき { at, name, size } か null */
export function lastBackup() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) || "null"); } catch (err) { return null; }
}
