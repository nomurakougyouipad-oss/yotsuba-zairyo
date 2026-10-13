// 材料集計表（Excel・CSV・はりつけた表）を読む（11章 7-5b。試作の tableToRows と同じ考え方。AI は使わない）
// - 見出しの行は、上から15行の中で「金額」と「注番か品名」がある行を自動でさがす
// - 列は見出しの言葉で見つける（注番・日付・材料屋・納品書番号・品名・材質・規格・数量・単位・単価・金額・備考）
// - 空の行と、小計・合計・総計の行はとばす。金額のない行も入れない
// - Excel は SheetJS（cdnjs の xlsx 0.18.5）で読む。シートが何枚あっても、全部見る
import { toPrice } from "./chumon.js";

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
export const TABLE_OK = /\.(xlsx|xls|csv|tsv|txt)$/i;

let xlsxP = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxP) {
    xlsxP = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = XLSX_URL;
      s.onload = () => res(window.XLSX);
      s.onerror = () => { xlsxP = null; rej(new Error("Excel を読む道具を読みこめませんでした")); };
      document.head.appendChild(s);
    });
  }
  return xlsxP;
}

/** CSV・タブ区切り（Excel からはりつけた表）→ 行の並び */
function splitCsv(line, delim) {
  if (delim === "\t") return line.split("\t");
  const out = [];
  let cur = "", qt = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (qt) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else qt = false; } else cur += c; }
    else if (c === '"') qt = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
export function textToTable(text) {
  // 空の行も残す（表の何行目かが、ファイルの行とそろうように。空の行は tableToRows でとばす）
  const lines = String(text || "").replace(/^﻿/, "").replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  const delim = lines.some(l => l.includes("\t")) ? "\t" : ",";
  return lines.map(l => splitCsv(l, delim));
}

const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** いろいろな日付 → YYYY-MM-DD（読めなければ ""） */
export function toISODate(v, today = new Date()) {
  if (v == null || v === "") return "";
  const mk = (y, m, d) => (y > 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? iso(new Date(y, m - 1, d)) : "");
  if (v instanceof Date && !isNaN(v)) { const d = new Date(v.getTime() + 43200000); return mk(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  if (typeof v === "number") {   // Excel の日付の数
    if (v > 30000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return mk(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
    return "";
  }
  const s = String(v).normalize("NFKC").trim();
  let m = s.match(/(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = s.match(/^(?:R|令和)\s*(\d{1,2})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/i);
  if (m) return mk(2018 + +m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/);
  if (m) return mk(today.getFullYear(), +m[1], +m[2]);
  return "";
}

const COLS = {
  chuban: /^(注文番号|注番|工事番号)/, date: /^(日付|納品日|年月日)/, sup: /^(材料屋|仕入先|取引先|業者|注文先)/,
  slip: /^(納品書番号|納品書No\.?|伝票番号|伝票No\.?|伝票|番号|No\.?)$/i, name: /^(品名|名称)/, mat: /^材質/, size: /^(形格|規格|寸法|サイズ)/,
  qty: /^(数量|数)$/, unit: /^単位$/, price: /^(材料単価|単価)/, amount: /^金額/, note: /^(備考|メモ)/,
};
const cellStr = c => String(c ?? "").normalize("NFKC").replace(/\s/g, "");
const numOf = v => (typeof v === "number" && Number.isFinite(v) ? v : toPrice(v));

/** 表 → 納品書の行 [{chuban, date, supRaw, no, spec, qty, unit, price, amount, at: 何行目}]。見出しが見つからなければ null */
export function tableToRows(table) {
  let h = -1;
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const r = (table[i] || []).map(cellStr);
    if (r.some(c => /^金額/.test(c)) && r.some(c => COLS.chuban.test(c) || COLS.name.test(c))) { h = i; break; }
  }
  if (h < 0) return null;
  const col = {};
  table[h].map(cellStr).forEach((c, i) => { for (const [k, re] of Object.entries(COLS)) if (col[k] == null && re.test(c)) { col[k] = i; break; } });
  const get = (r, k) => (col[k] == null ? "" : r[col[k]]);
  const out = [];
  table.slice(h + 1).forEach((r, j) => {
    if (!r || !r.some(c => cellStr(c))) return;
    if (r.some(c => /小計|合計|総計/.test(String(c ?? "")))) return;
    const amount = numOf(get(r, "amount"));
    if (amount == null) return;
    const note = String(get(r, "note") ?? "");
    const spec = [get(r, "name"), get(r, "mat"), get(r, "size")].map(x => String(x ?? "").trim()).filter(Boolean).join(" ");
    const slipFromNote = (note.match(/(?:納品書|伝票|売上)(?:番号|No\.?|NO\.?|№)?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]*)/) || [])[1] || "";
    out.push({
      chuban: String(get(r, "chuban") ?? "").normalize("NFKC").toUpperCase().replace(/\s/g, ""),
      date: toISODate(get(r, "date")),
      supRaw: String(get(r, "sup") ?? "").trim() || note,
      no: String(get(r, "slip") ?? "").trim() || slipFromNote,
      spec: spec || "（品名なし）",
      qty: numOf(get(r, "qty")),
      unit: String(get(r, "unit") ?? "").trim(),
      price: numOf(get(r, "price")),
      amount: Math.round(amount),
      at: h + 2 + j,   // 表の何行目か（1からかぞえる）
    });
  });
  return out;
}

/** ファイル → [{ sheet: シートの名前, rows }]（見出しが見つかったシートだけ） */
export async function readTableFile(file) {
  if (/\.(csv|tsv|txt)$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    // Excel の CSV は Shift_JIS のことがあるので、UTF-8 で読めない字が多ければ Shift_JIS で読みなおす
    let text = new TextDecoder("utf-8").decode(buf);
    if ((text.match(/�/g) || []).length > 3) text = new TextDecoder("shift_jis").decode(buf);
    const rows = tableToRows(textToTable(text));
    return rows ? [{ sheet: "", rows }] : [];
  }
  const X = await loadXLSX();
  const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellDates: true });
  const out = [];
  for (const name of wb.SheetNames) {
    const table = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    const rows = tableToRows(table);
    if (rows && rows.length) out.push({ sheet: name, rows });
  }
  return out;
}
