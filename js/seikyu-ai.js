// 月の請求書を AI で読んで、アプリの納品書と合わせる（11/20 持ち主。「まとめて請求」の画面から使う）
// - 請求書（PDF・写真）を前から順に、2ページずつ AI（サーバーの zairyoAi task "invoice"）にわたす。前の回の最後の伝票もわたす
//   （つづきのページの頭に番号がない材料屋がある：えひめファスナー）
// - AI は明細の行を1行ずつ、種類（品物・小計・税・入金・繰越・合計・メモ）をつけて返す。足し算はアプリでする
// - 品物の行を足した金額が「御買上額（税抜）」と合わないときは、読みまちがいかもしれないので、はじめのチェックを入れない
//   （手書きの請求書・請求書と納品書が1枚に写っていて2回数えたときも、ここで止まる。11/20 持ち主）
// - 合わせ方：納品書の番号（書き方のちがい「-1」「/001」・頭の0・ハイフンはそろえる）→ 番号がないときは 注番・日付・金額
// - 「合う」「金額がちがう」「請求書にない」「アプリにない」に分ける。くらべるのは税抜だけ（税のかけ方は材料屋ごとにちがう）
import { call } from "./firebase.js";
import { openScan, scanParts } from "./nouhin.js";

const MAX_IMAGES = 4;   // 1回にわたす絵（サーバーの INV_MAX_IMAGES と同じ）

/** 請求書のファイル（何個でも。前から順に1つの請求書のページとする）を読む。onStep(何回め, 全部で何回) */
export async function readInvoiceFiles(files, { model, onStep } = {}) {
  // 1. ページを絵にする（縦長のページは上下2枚に分ける。納品書の取りこみと同じ）
  const pages = [];
  for (const f of files) {
    const sc = await openScan(f);
    for (let k = 0; k < sc.count; k++) pages.push(scanParts(await sc.page(k)));
  }
  if (!pages.length) throw new Error("請求書のページがありません");
  // 2. 絵が4枚までになるように、ページをかたまりに分ける（1ページはわけない）
  const chunks = [];
  let cur = null;
  pages.forEach((imgs, i) => {
    if (!cur || cur.images.length + imgs.length > MAX_IMAGES) { cur = { from: i + 1, to: i + 1, images: [] }; chunks.push(cur); }
    cur.images.push(...imgs); cur.to = i + 1;
  });
  // 3. 前から順にたのむ（前の回の最後の伝票をわたす）
  const parts = [], runs = [];
  let prev = null;
  for (let i = 0; i < chunks.length; i++) {
    if (onStep) onStep(i + 1, chunks.length);
    const c = chunks[i];
    const res = (await call("zairyoAi", { timeout: 300000 })({ task: "invoice", images: c.images, pages: { from: c.from, to: c.to, count: pages.length }, prev, ...(model ? { model } : {}) })).data;
    const inv = res.inv || {};
    parts.push({ ...inv, from: c.from, to: c.to });
    runs.push(res.run || {});
    const last = [...(inv.rows || [])].reverse().find(r => r.no);
    if (last) prev = { no: last.no, date: last.date || "", chuban: last.chuban || "" };
  }
  return { inv: mergeInvoice(parts), runs, pages: pages.length, calls: chunks.length };
}

/** 何回かに分けて読んだ答えを1つにする（合計などは、はじめに書いてあったページの数を使う） */
export function mergeInvoice(parts) {
  const first = k => { for (const p of parts) if (p[k] != null && p[k] !== "") return p[k]; return null; };
  const rows = [];
  parts.forEach(p => (p.rows || []).forEach(r => rows.push({ ...r, page: p.from })));
  return {
    isInvoice: parts.some(p => p.isInvoice), kind: first("kind") || "",
    supplier: first("supplier"), invoiceNo: first("invoiceNo"), closeDate: first("closeDate"),
    kaiage: first("kaiage"), tax: first("tax"), total: first("total"), slipCount: first("slipCount"),
    rows, doubt: parts.flatMap(p => p.doubt || []).slice(0, 6),
  };
}

/* ---------- 番号・注番をそろえる ---------- */
/** 納品書の番号をくらべる形に：全角→半角・大文字・うしろの枝番（-1・/001・-01）をとる・英数字だけ・頭の0をとる */
export function normNo(s) {
  let t = String(s || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  t = t.replace(/[-/](\d{1,3})$/, "");
  t = t.replace(/[^0-9A-Z]/g, "").replace(/^0+(?=\d)/, "");
  return t;
}
/** 同じ納品書の番号か：そろえた形が同じ、か、どちらも6けた以上の数字で、片方がもう片方で始まる（信栄機鋼：2-60-1149875 /001 と 26011498750010） */
export function sameNo(a, b) {
  const x = normNo(a), y = normNo(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return /^\d{6,}$/.test(x) && /^\d{6,}$/.test(y) && (x.startsWith(y) || y.startsWith(x));
}
/** 注番をそろえる（空白・ハイフンをとる。頭の 0 は英字の O）。注番の形でなければ "" */
export function normChuban(s) {
  const t = String(s || "").normalize("NFKC").toUpperCase().replace(/[\s\-ー－]/g, "").replace(/^0/, "O").replace(/^(.)0/, "$1O");
  return /^[A-Z]{2}\d{5}$/.test(t) ? t : "";
}

/* ---------- 請求書の納品書ごとのまとまり ---------- */
/** 品物の行を、納品書ごとにまとめて足す。番号がない請求書は、日付と注番でまとめる。
 *  → [{ key, no, date, chubans, amount（品物の行の合計）, sub（印刷してある小計。なければ null）, n（品物の行の数） }] */
export function invoiceSlips(rows) {
  const m = new Map();
  // 番号がない請求書（あべ工房）は、「日付・注文番号・件名」の行（金額なし）のあとに金額の行がつづく。上の行の日付・注番を引きつぐ
  let ctx = { date: "", ch: "" };
  for (const r0 of rows || []) {
    if (r0.kind !== "item" && r0.kind !== "subtotal" && r0.kind !== "memo") continue;
    let r = r0;
    if (!r.no) {
      const c0 = normChuban(r.chuban);
      if (r.date && r.date !== ctx.date) ctx = { date: r.date, ch: c0 };
      else if (c0) ctx.ch = c0;
      r = { ...r, date: r.date || ctx.date, chuban: c0 || ctx.ch };
      if (r.kind === "memo") continue;
    }
    const k = r.no ? "N:" + normNo(r.no) : `D:${r.date || ""}|${normChuban(r.chuban)}`;
    const g = m.get(k) || { key: k, no: r.no || "", date: r.date || "", chubans: new Set(), amount: 0, sub: null, n: 0 };
    if (!g.date && r.date) g.date = r.date;
    const c = normChuban(r.chuban); if (c) g.chubans.add(c);
    if (r.kind === "item" && r.amount != null) { g.amount += Number(r.amount) || 0; g.n++; }
    if (r.kind === "subtotal" && r.amount != null) g.sub = (g.sub || 0) + (Number(r.amount) || 0);
    m.set(k, g);
  }
  return [...m.values()].filter(g => g.n > 0).map(g => ({ ...g, amount: Math.round(g.amount), chubans: [...g.chubans] }));
}
/** 品物の行を全部足した金額と、御買上額（税抜）が合うか */
export function checkInvoice(inv) {
  const sum = Math.round((inv.rows || []).filter(r => r.kind === "item" && r.amount != null).reduce((t, r) => t + (Number(r.amount) || 0), 0));
  const kaiage = inv.kaiage == null ? null : Math.round(Number(inv.kaiage));
  return { sum, kaiage, ok: kaiage != null && sum === kaiage };
}

/* ---------- アプリの納品書と合わせる ---------- */
/** invSlips … invoiceSlips の答え、app … [{ key, o, sid, s: {no, date, amount}, month }]（請求まだの納品書）、
 *  bare … [{ key, o }]（納品書がない注文）、month … いまえらんでいる「○月分」
 *  → { ok: [{x, v}], diff: [{x, v}], notInApp: [v], notOnInv: [x] }（x＝アプリの納品書・v＝請求書の納品書） */
export function matchInvoice(invSlips, app, bare, month) {
  const used = new Set(), pairs = [], left = [];
  const amt = x => Math.round(Number(x.s ? x.s.amount : x.o.nouhin) || 0);
  // 1. 番号で合わせる（どちらにも番号があるとき）
  for (const v of invSlips) {
    const x = v.no ? app.find(a => !used.has(a.key) && a.s.no && sameNo(a.s.no, v.no)) : null;
    if (x) { used.add(x.key); pairs.push({ x, v }); } else left.push(v);
  }
  // 2. 番号で合わなかったもの：注番＋日付 → 注番＋金額 → 日付＋金額（請求書かアプリのどちらかに番号がないときだけ）
  const notInApp = [];
  const free = a => !used.has(a.key);
  const canPair = (a, v) => !(v.no && a.s && a.s.no);   // どちらにも番号があって合わないものは、べつの納品書
  for (const v of left) {
    const ch = v.chubans;
    const tries = [
      a => a.s && ch.includes(normChuban(a.o.chuban)) && a.s.date === v.date,
      a => ch.includes(normChuban(a.o.chuban)) && amt(a) === v.amount,
      a => a.s && v.date && a.s.date === v.date && amt(a) === v.amount,
    ];
    let x = null;
    for (const t of tries) { x = [...app, ...bare].find(a => free(a) && canPair(a, v) && t(a)); if (x) break; }
    if (x) { used.add(x.key); pairs.push({ x, v }); } else notInApp.push(v);
  }
  const ok = pairs.filter(p => amt(p.x) === p.v.amount), diff = pairs.filter(p => amt(p.x) !== p.v.amount);
  const notOnInv = app.filter(a => !used.has(a.key) && a.month === month);
  return { ok, diff, notInApp, notOnInv };
}
