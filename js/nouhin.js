// 納品書の取りこみ（11章 7-5a。試作の「納品書の取り込み」と同じ考え方）
// - スキャン（PDF・写真）をえらぶかドラッグ → 1ページずつ絵にして、AI（サーバーの zairyoAi task "slip"）で読む
// - 縦長の紙は上と下に分けて送る（小さい字も読めるように）。PDF は pdf.js で絵にする。6ページ目からは「読む」を押してから
// - 1枚に注番がいくつかあれば、注番ごとに分ける。注番の読みまちがい（数字の所の O→0、I・L→1）は直す
// - 注番＋材料屋で注文をさがして「この注文に入れる」。なければ「新しい注文として入れる」か「入れない」
// - たしかめてほしい所：AI が読みにくかった所・明細の合計と納品書の合計のちがい・金額が読めない行・知らない頭文字
// - 入れると、注文の「納品書の金額」に入る（5-4 の addSlip と同じ）。まだ届いていない注文は「届いた」になる。
//   金額のない納品書は「届いた」にするだけ
// - 7-5b：材料集計表（Excel・CSV・はりつけた表）も同じ画面で読む（js/hyou.js。AI は使わない）。注番＋材料屋＋納品書番号（なければ日付）ごとにまとめる
// - 7-5c：同じ納品書はもう入っていれば「入れない」にして知らせる（同じ材料屋で同じ納品書番号・同じ注文に同じ金額と日付・この取りこみの中で同じもの）。
//   10/30（持ち主。事務員さんが中を見ずに入れても困らないように）：どれも「入れない」にしておくだけで、入れる先をえらびなおせば入れられる
//   ① 金額のない紙（送り状・受領書など）は、入れる先の注文がなければ「入れない」（「新しい注文として入れる」は、えらびなおせばできる）
//   ② 同じ紙：材料屋と注番が同じで、番号が同じ（金額がちがっても）か、番号がどちらかになければ日付が同じで合計金額か品名と数が同じ。
//      番号が同じでも注番がちがえば別の納品書（1枚に注番が2つの納品書）。金額のない紙は、金額のある紙と品名と数が同じなら「入れない」
//   ③ 金額がぜんぶ 0 の紙は、金額のない紙と同じ（入れると「届いた」にするだけ）。金額の欄に数を書けば、金額のある納品書になる
//   ⑤ 新しく作った注文には kind:"nouhin"（一覧に「納品書から」の印・しぼりこみ。jimusho-app.js）
//   入れたら取りこみの記録（/zairyo/imports：いつ・だれが・どのファイル・どの注文に何を入れたか）。「前の取りこみ」から、まとめて取り消せる
//   （入れた納品書の金額と単価の記録を消す・「届いた」にした注文はもどす・新しく作った注文は取り消す・請求ずみの注文はさわらない）。
//   元のスキャンは Storage の zairyo/scans/{端末の番号}/{番号}.jpg に保存して、注文の納品書から見られる
// - 11/2（事務員さん「入れない」になっていて、どうすればよいか分からなかった）：「入れる先」→「どの注文に入れますか？」。
//   注番・材料屋の注文がアプリにないときは、その場に説明（引き取りなど、アプリで注文していない分→「新しい注文として入れる」／
//   送り状・控え→「入れない」のまま）と2つのボタン。金額のない紙に単価・金額を書いたら、自動の「入れない」を外して、えらびなおしてもらう。
//   数がない行に単価だけ書いたら「数を入れると、金額が出ます」
// - 11/4（事務員さん）：注番を打ちなおしたら、7字そろったときに（欄から出たときも）すぐ合う注文をさがしなおす。知らせと
//   「どの注文に入れますか？」だけかきなおす（全部かきなおすと、押したボタンが入れかわって1回目が効かなかった）。
//   材料屋・注番の知らせは、いまの材料屋・注番で毎回出す（正しく直したら消える）。説明の箱に「上の注番・材料屋を直すと、合う注文が出ます」。
//   注番が1字ちがい（となりの2字の入れかわりも）の同じ材料屋の注文があれば「この注文ではありませんか？」（押すと注番を直して、その注文に入れる）
import { ref, get, push, set, update, query, limitToLast, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { ref as sref, uploadBytes, deleteObject } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js";
import { db, auth, call, storage } from "./firebase.js";
import { esc, zenkana, toast, openSheet } from "./common.js";
import { ymd } from "./tanomu.js";
import { addSlip, markArrived, yen, toPrice, ST, slipsOf } from "./chumon.js";
import { watchJobs, CHUBAN_RE } from "./nippo.js";
import { matchSupplier } from "./line-parse.js";
import { errorText } from "./touroku.js";
import { TABLE_OK, readTableFile, textToTable, tableToRows } from "./hyou.js";

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/";
const FIRST_PAGES = 5;        // これより多いページは「読む」を押してから（お金がかかるので）
const SCAN_OK = /\.(pdf|jpe?g|png|webp)$/i;
const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999);

/* ---------- 絵にする ---------- */
let pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(PDFJS + "pdf.min.mjs").then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs"; return m; })
      .catch(err => { pdfjsP = null; throw err; });
  }
  return pdfjsP;
}
/** ファイル → { count, page(k) → canvas }（長い辺 2000px くらい） */
async function openScan(file) {
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    return {
      count: doc.numPages,
      page: async k => {
        const pg = await doc.getPage(k + 1);
        const v1 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: 2000 / Math.max(v1.width, v1.height) });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: x, viewport: vp }).promise;
        return c;
      },
    };
  }
  const bmp = await createImageBitmap(file);
  return {
    count: 1,
    page: async () => {
      const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(bmp, 0, 0, c.width, c.height);
      return c;
    },
  };
}
const b64 = c => c.toDataURL("image/jpeg", 0.85).split(",")[1];
/** 縦長の紙は上と下に分ける（少し重ねて切る） */
function scanParts(c) {
  if (c.height <= c.width * 1.15) return [b64(c)];
  const half = Math.ceil(c.height / 2), ov = Math.round(c.height * 0.06);
  return [[0, half + ov], [half - ov, c.height - half + ov]].map(([y, h]) => {
    const p = document.createElement("canvas");
    p.width = c.width; p.height = h;
    p.getContext("2d").drawImage(c, 0, y, c.width, h, 0, 0, c.width, h);
    return b64(p);
  });
}
function thumbOf(c) {
  const s = Math.min(1, 1400 / Math.max(c.width, c.height));
  const t = document.createElement("canvas");
  t.width = Math.round(c.width * s); t.height = Math.round(c.height * s);
  t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.8);
}

/* ---------- 読んだものを、注番ごとのまとまりにする（試作の scanToGroups） ---------- */
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : toPrice(v));
/** 単価・金額の欄に出す形（3けたごとにカンマ。直すときはカンマがあってもよい＝toPrice が読む） */
const comma = v => (v == null || v === "" ? "" : Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 3 }));
const REPAIR = /修理|工賃|技術料|出張費/;   // 修理・工賃の行（工賃は日報から台帳へ行くので、材料費には入れない）
function fixChuban(s) {
  const v = String(s || "").normalize("NFKC").toUpperCase().replace(/\s/g, "");
  const m = v.match(/^([A-Z]{2})([0-9OIL]{5})$/);
  return m ? m[1] + m[2].replace(/O/g, "0").replace(/[IL]/g, "1") : v;
}
/** 文の中から注番を取り出す（例「OT26250・松本」→ OT26250）。数字が2で始まるものだけ（容器番号などはひろわない） */
function extractChubans(s) {
  const v = String(s || "").normalize("NFKC").toUpperCase();
  return [...new Set((v.match(/[A-Z]{2}\s*2[0-9OIL]{4}(?![0-9])/g) || []).map(x => fixChuban(x)))];
}
const okDate = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : "");

/* ---------- 同じ紙か（10/30 ②） ---------- */
/** 品名のくらべ方：全角・半角、大文字・小文字、空白・ハイフン、× と x のちがいはそろえる */
const specKey = s => String(s || "").normalize("NFKC").toUpperCase().replace(/[\s\-‐－―ー]/g, "").replace(/[×*＊]/g, "X");
/** 品名と数がぜんぶ同じか（行の並びは見ない） */
const itemsKey = rows => rows.map(r => `${specKey(r.spec)}|${r.qty ?? ""}`).sort().join("\n");
const sameItems = (a, b) => !!a.length && itemsKey(a) === itemsKey(b);
const noKey = s => String(s || "").normalize("NFKC").toUpperCase().replace(/\s/g, "");
const sameNo = (a, b) => !!a && !!b && noKey(a) === noKey(b);
const sameDay = (a, b) => !a || !b || a === b;
/** 金額のない紙か（どの行にも金額がない・ぜんぶ 0 も同じ。③）。材料集計表は、いつも金額のある表 */
const noPriceOf = gr => !gr.table && gr.rows.every(r => r.amount == null || r.amount === 0);

function toGroups(res, supList) {
  const head = extractChubans(res.chuban);
  const notes = [];
  let fromName = false;
  const rows = (res.rows || []).map(r => {
    const qty = num(r.qty), price = num(r.price);
    let amount = num(r.amount);
    if (amount == null && qty != null && price != null) amount = Math.round(qty * price);
    let ch = extractChubans(r.chuban)[0] || "";
    if (!ch && head.length === 1) ch = head[0];
    if (!ch && !head.length) { ch = extractChubans(r.name)[0] || ""; if (ch) fromName = true; }
    return { chuban: ch, spec: String(r.name || "（品名なし）").trim().slice(0, 300), qty, unit: String(r.unit || "").trim().slice(0, 10), price, amount };
  });
  if (!rows.length) return [];
  if (fromName) { const f = rows.find(r => r.chuban).chuban; rows.forEach(r => { if (!r.chuban) r.chuban = f; }); notes.push("注番は品名の欄から読みました（注文番号の欄は空）"); }
  if (head.length > 1 && rows.some(r => !r.chuban)) { rows.forEach(r => { if (!r.chuban) r.chuban = head[0]; }); notes.push(`注番が ${head.join("・")} とあります。行ごとの注番をたしかめてください`); }
  const by = new Map();
  rows.forEach(r => { if (!by.has(r.chuban)) by.set(r.chuban, []); by.get(r.chuban).push(r); });
  const m = matchSupplier(res.supplier || "", supList);
  const total = num(res.total);
  const all = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const doubt0 = (res.doubt || []).map(String).filter(Boolean);
  return [...by].map(([chuban, rs]) => {
    const g = {
      chuban, supId: m.id || "", supRaw: res.supplier || "", no: String(res.slipNo || "").trim().slice(0, 40), date: okDate(res.date),
      rows: rs, dest: "", saved: false, err: "",
    };
    g.doubt = [...doubt0, ...notes];
    if (by.size > 1) g.doubt.unshift(`1枚の納品書を注番ごとに ${by.size}つに分けました`);
    if (total != null && Math.abs(total - all) > 1) g.doubt.push(`明細の合計 ${yen(all)}円 と、納品書の合計 ${yen(total)}円 がちがいます`);
    if (noPriceOf(g)) { if (rs.some(r => r.amount === 0)) g.doubt.push("金額がぜんぶ 0 です。金額のない紙としてあつかいます"); }
    else if (rs.some(r => r.amount == null)) g.doubt.push("金額が読めない行があります");
    if (rs.some(r => REPAIR.test(r.spec))) g.doubt.push("修理・工賃の行があります。材料費に入れないなら、その行を消してください（×）");
    return g;   // 材料屋・注番の知らせは、いまの材料屋・注番で毎回出す（openImport の keyDoubts）
  });
}

/** 納品書の取りこみの画面を開く。opts = { sups, getOrders() → 注文の並び, me } */
export function openImport({ sups, getOrders, me }) {
  const supList = Object.entries(sups || {}).sort(byOrder);
  const cards = [];   // [{ name, page, thumb, parts, status: "wait"|"reading"|"done"|"err"|"notslip", kind, err, groups }]
  let jobs = null, stopJobs = null, closeLog = null, kaisha = {}, kotei = {}, codesOk = false;
  const prefixOk = ch => !!kaisha[ch.slice(0, 2)] || Object.keys(kotei).some(k => k.slice(0, 2) === ch.slice(0, 2));

  const html = `
    <div class="pw" id="impWrap">
      <div class="panel-head"><div><span class="eyebrow">スキャンした納品書（PDF・写真）</span><h2 id="panelTitle">納品書の取りこみ</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <p class="hint">納品書のスキャンをえらぶか、ここにドラッグしてください。AI が読んで表にします（1枚 10〜20秒）。読んだものとスキャンを見くらべて、注文に入れます。</p>
      <label class="imp-drop" id="impDrop"><input type="file" id="impFile" accept=".pdf,image/*,.xlsx,.xls,.csv,.tsv,.txt" multiple hidden>
        <span class="btn">ファイルをえらぶ</span><span class="hint">スキャンした PDF・写真（JPEG・PNG）／材料集計表の Excel・CSV。何枚でもいっしょに入れられます</span></label>
      <details class="block hidbox" id="impPasteBox"><summary>表をはりつける（Excel からコピーした表）</summary>
        <textarea id="impPaste" class="inp ta" rows="5" placeholder="見出しの行（注番・品名・金額 など）もいっしょにコピーして、ここにはりつけてください"></textarea>
        <div class="row"><button type="button" class="btn" id="impPasteGo">読み取る</button></div></details>
      <details class="block hidbox" id="impLog"><summary>前の取りこみ（まとめて取り消す）</summary><div id="impLogList" class="stack"><p class="muted">読んでいます…</p></div></details>
      <div id="impList" class="stack"></div>
      <div class="sheet-foot" id="impFoot" hidden><p class="err" id="impErr"></p>
        <button type="button" class="btn primary big full" id="impGo"></button></div>
    </div>`;

  openSheet(html, panel => {
    const w = panel.querySelector("#impWrap");
    const g = s => w.querySelector(s);
    stopJobs = watchJobs(d => { jobs = d; }, () => { });
    Promise.all([get(ref(db, "common/kaisha")).then(s => { kaisha = s.val() || {}; }), get(ref(db, "common/kotei")).then(s => { kotei = s.val() || {}; })])
      .then(() => { codesOk = true; }, () => { });   // 読めるまでは、頭文字の知らせは出さない（まちがって出さないように）

    /* ---------- 読む ---------- */
    async function addFiles(files) {
      for (const file of [...files]) {
        if (TABLE_OK.test(file.name)) {
          try {
            const sheets = await readTableFile(file);
            if (!sheets.length) toast(`${file.name} に、見出しの行（金額と、注番か品名）が見つかりませんでした`);
            sheets.forEach(sh => addTable(`${file.name}${sh.sheet ? `（${sh.sheet}）` : ""}`, sh.rows));
          } catch (ex) { toast(`${file.name} を読めませんでした`); }
          continue;
        }
        if (!SCAN_OK.test(file.name)) { toast(`${file.name} は読めません（PDF・写真・Excel・CSV だけ）`); continue; }
        let scan;
        try { scan = await openScan(file); } catch (ex) { toast(`${file.name} を開けませんでした`); continue; }
        for (let k = 0; k < scan.count; k++) {
          const c = { name: file.name, page: scan.count > 1 ? k + 1 : 0, scan, k, status: k < FIRST_PAGES ? "reading" : "wait", groups: [] };
          cards.push(c);
        }
      }
      render();
      for (const c of cards.filter(x => x.status === "reading" && !x.started)) await readCard(c);
    }
    /** 材料集計表の行 → 注番＋材料屋＋納品書番号（なければ日付）ごとのまとまり */
    function addTable(name, rows) {
      const by = new Map();
      rows.forEach(r => {
        const k = [fixChuban(r.chuban), r.supRaw, r.no || r.date].join("|");
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(r);
      });
      const groups = [...by.values()].map(rs => {
        const r0 = rs[0], m = matchSupplier(r0.supRaw || "", supList), chuban = fixChuban(r0.chuban);
        const gr = {
          chuban, supId: m.id || "", supRaw: r0.supRaw, no: r0.no.slice(0, 40), date: rs.map(r => r.date).find(Boolean) || "",
          rows: rs.map(r => ({ spec: r.spec.slice(0, 300), qty: r.qty, unit: r.unit.slice(0, 10), price: r.price, amount: r.amount })),
          dest: "", saved: false, err: "", table: true,
          doubt: [`表の ${rs.map(r => r.at).join("・")} 行目`],
        };
        if (rs.some(r => REPAIR.test(r.spec))) gr.doubt.push("修理・工賃の行があります。材料費に入れないなら、その行を消してください（×）");
        gr.dest = defaultDest(gr);
        return gr;
      });
      cards.push({ name, table: true, status: "done", groups });
      render();
    }

    async function readCard(c, force = false) {
      c.started = true;
      c.status = "reading";
      render();
      try {
        if (!c.parts) {
          const cv = await c.scan.page(c.k);
          c.thumb = thumbOf(cv);
          c.parts = scanParts(cv);
          c.full = await new Promise(res => cv.toBlob(res, "image/jpeg", 0.85));   // 入れるときに Storage に保存する
        }
        render();
        const r = (await call("zairyoAi", { timeout: 300000 })({ task: "slip", images: c.parts, force })).data;
        const s = r.slip;
        if (!s.isSlip) { c.status = "notslip"; c.kind = s.kind || "納品書ではない書類"; }
        else {
          c.status = "done";
          c.groups = toGroups(s, supList);
          if (!c.groups.length) { c.status = "err"; c.err = "品物の行が読めませんでした"; }
          // 入れる先は、自分でえらんでいない紙は全部決めなおす（あとから読んだ金額のある紙と、前に読んだ金額のない紙が同じ品物のときのため。②）
          cards.forEach(x => x.groups.forEach(gr => { if (!gr.saved && !gr.picked) gr.dest = defaultDest(gr); }));
        }
      } catch (ex) {
        c.status = "err";
        c.err = errorText(ex);
      }
      render();
    }

    /* ---------- 入れる先（注番＋材料屋の注文） ---------- */
    const candidates = gr => (getOrders() || []).filter(o => o.status !== "cancelled" && o.chuban === gr.chuban)
      .sort((a, b) => (a.supplier === gr.supId ? 0 : 1) - (b.supplier === gr.supId ? 0 : 1) || (b.orderedAt || 0) - (a.orderedAt || 0));
    /** 同じ紙か（②）。材料屋と注番が同じで、番号が同じか、番号がどちらかになければ日付が同じで合計金額か品名と数が同じ。
     *  rows・amt・date・no は、くらべる相手（前に入れた納品書、またはこの取りこみの紙） */
    const samePaper = (gr, x) => sameNo(gr.no, x.no) || ((!gr.no || !x.no) && sameDay(gr.date, x.date) && (x.amt === sumOf(gr) || sameItems(gr.rows, x.rows)));
    /** もう入っている納品書か → { o, s, amt, priced? }（前に入れた納品書）／{ c, amt, priced? }（この取りこみの中の紙）／null
     *  priced：金額のない紙が、金額のある納品書と同じ品物（金額は、その納品書のほうで入れる） */
    function dupOf(gr) {
      const np = noPriceOf(gr);
      for (const o of getOrders() || []) {
        if (o.status === "cancelled" || o.supplier !== gr.supId || o.chuban !== gr.chuban) continue;   // 番号が同じでも、注番がちがえば別の納品書
        for (const [, s] of slipsOf(o)) {
          const x = { no: s.no, date: s.date, amt: s.amount, rows: Object.values(s.rows || {}) };
          if (np ? sameItems(gr.rows, x.rows) && sameDay(gr.date, x.date) : samePaper(gr, x)) return { o, s, amt: s.amount, priced: np };
        }
      }
      const mine = cards.flatMap(c => c.groups.map(x => ({ c, x })));
      const at = mine.findIndex(m => m.x === gr);
      for (const [i, { c, x }] of mine.entries()) {
        if (x === gr || x.supId !== gr.supId || x.chuban !== gr.chuban) continue;
        const xnp = noPriceOf(x);
        if (np && !xnp) {   // 金額のない紙：金額のある紙（前でもあとでも）と同じ品物なら入れない
          if (sameItems(gr.rows, x.rows) && sameDay(gr.date, x.date)) return { c, amt: sumOf(x), priced: true };
          continue;
        }
        if (i > at || (!np && xnp)) continue;   // ここからは前の紙だけ。金額のある紙は、金額のない紙では止めない
        if (samePaper(gr, { no: x.no, date: x.date, amt: sumOf(x), rows: x.rows })) return { c, amt: sumOf(x) };
      }
      return null;
    }
    /** 入れる先の注文（注番＋材料屋で、まだ届いていないか届いた注文） */
    const hitOf = gr => candidates(gr).find(o => o.supplier === gr.supId && (o.status === "wait" || o.status === "arrived"));
    function defaultDest(gr) {
      if (dupOf(gr)) return "skip";
      const hit = hitOf(gr);
      if (hit) return hit.id;
      return noPriceOf(gr) ? "skip" : "";   // 合う注文がないときは、事務員さんが「新しい注文として入れる」か「入れない」をえらぶ。金額のない紙は「入れない」（①）
    }
    /** 注番が1字ちがいか、となりの2字が入れかわっている（11/4 読みまちがいかもしれない注番） */
    function nearChuban(a, b) {
      if (!a || !b || a === b || a.length !== b.length) return false;
      const d = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));
      return d.length === 1 || (d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]);
    }
    /** 「この注文ではありませんか？」：注番が近い、同じ材料屋の注文（まだ届いていないか届いた。待ち・新しい順に3つまで） */
    const nearOf = gr => (getOrders() || []).filter(o => o.supplier === gr.supId && (o.status === "wait" || o.status === "arrived") && nearChuban(o.chuban, gr.chuban))
      .sort((a, b) => (a.status === "wait" ? 0 : 1) - (b.status === "wait" ? 0 : 1) || (b.orderedAt || 0) - (a.orderedAt || 0)).slice(0, 3);

    /** 材料屋・注番の知らせ（11/4：いまの材料屋・注番で毎回出す。前は読んだときのままで、正しく直しても消えなかった） */
    function keyDoubts(gr) {
      const d = [];
      if (!gr.supId && gr.supRaw) d.push(`材料屋「${gr.supRaw}」が分かりません。えらんでください`);
      else if (!gr.supId && gr.table) d.push("材料屋の列がありません。えらんでください");
      if (!CHUBAN_RE.test(gr.chuban)) d.push(gr.chEdited ? "注番を正しく入れてください（例 AB26123）" : "注番が読めませんでした。入れてください");
      else if (codesOk && !prefixOk(gr.chuban)) d.push(`注番の頭文字「${gr.chuban.slice(0, 2)}」が、注番の会社の表にありません`);
      return d;
    }
    /** 注番が変わった（11/4）：合う注文をさがしなおして、知らせと「どの注文に入れますか？」だけかきなおす */
    function setChuban(gr, v) {
      gr.chuban = v;
      gr.chEdited = true;
      gr.picked = false;   // 前の注番でえらんだ入れる先は、えらびなおし
      gr.dest = defaultDest(gr);
      refresh();
    }

    /* ---------- 画面 ---------- */
    const sumOf = gr => gr.rows.reduce((s, r) => s + (r.amount || 0), 0);
    const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
    const sumHTML = gr => (noPriceOf(gr) ? "金額のない納品書です（入れると「届いた」にするだけ）。単価か金額を入れると、その金額で入ります" : `明細の合計 <span class="money" data-sum>${yen(sumOf(gr))}</span> 円（税抜）`);
    const pageName = c => `${c.name}${c.page ? `（${c.page}ページ）` : ""}`;
    function dupHTML(gr) {
      const d = dupOf(gr), skip = gr.dest === "skip" ? "「入れない」にしています。入れるときは、どの注文に入れるかをえらびなおしてください。" : "";
      if (!d) return "";   // ① 金額のない紙で、合う注文がないときの説明は、下の「どの注文に入れますか？」に出す（11/2）
      const where = d.o ? `${esc(d.o.supplierName)}・${esc(d.o.chuban)}${d.s.at ? `・${md(d.s.at)} ${esc(d.s.by || "")}` : ""}` : esc(pageName(d.c));
      if (d.priced) return `<p class="okmsg">${d.o ? `金額のある納品書が、もう入っています（${where}）` : `金額のある納品書（${where}）と同じ品物です`}。金額は納品書のほうで入れます。${skip}</p>`;
      const diff = d.amt != null && d.amt !== sumOf(gr) ? `金額がちがいます（${yen(d.amt)}円 と ${yen(sumOf(gr))}円）。どちらかの読みまちがいかもしれません。` : "";
      return `<p class="okmsg">${d.o ? `この納品書は、もう入っています（${where}）` : `同じ納品書${gr.no ? `（番号 ${esc(gr.no)}）` : ""}が、この取りこみの前のほうにもあります（${where}）`}。${diff}${skip}</p>`;
    }
    /** 数がなくて、単価だけの行（金額が出ない。11/2） */
    const needQty = r => r.price != null && r.qty == null && r.amount == null;
    /** どの注文に入れますか（11/2 事務員さん。前は「入れる先」で、「入れない」のときに何をすればよいか分からなかった）。
     *  この注番・材料屋の注文がアプリにないときは、その場に説明（引き取りなど→新しい注文／送り状・控え→入れない）。
     *  同じ注番の注文が1つもなければ2つのボタン、ほかの材料屋の注文があれば、えらぶ所。
     *  11/4：いちばん上に「上の注番・材料屋を直すと、合う注文が出ます」。注番が1字ちがいの注文があれば「この注文ではありませんか？」 */
    function destHTML(gr) {
      const cand = candidates(gr);
      const about = o => `${esc(zenkana(o.kenmei || ""))}（${ST[o.status].chip}・${md(o.orderedAt)} 注文）`;
      const opts = `<option value=""${gr.dest ? "" : " selected"}>えらんでください</option>` +
        cand.map(o => `<option value="${esc(o.id)}"${gr.dest === o.id ? " selected" : ""}>${esc(o.supplierName)}・${esc(o.chuban)} ${about(o)}</option>`).join("") +
        `<option value="new"${gr.dest === "new" ? " selected" : ""}>新しい注文として入れる（アプリで注文していない分）</option><option value="skip"${gr.dest === "skip" ? " selected" : ""}>入れない（送り状・控えなど）</option>`;
      const newHint = gr.dest === "new" && gr.chuban ? `<p class="hint">注番 ${esc(gr.chuban)} で、新しい注文を作ってから入れます（工事件名は日報から）。</p>` : "";
      const none = !dupOf(gr) && CHUBAN_RE.test(gr.chuban) && gr.supId && !cand.some(o => o.supplier === gr.supId);
      if (!none) return `<label class="mini">どの注文に入れますか？<select class="inp" data-f="dest">${opts}</select></label>${newHint}`;
      const btn = (v, label) => `<button type="button" class="btn" data-dest="${v}" aria-pressed="${gr.dest === v}">${label}</button>`;
      const near = nearOf(gr);
      const dif = ch => [...ch].map((c, i) => (c === gr.chuban[i] ? esc(c) : `<span class="dif">${esc(c)}</span>`)).join("");   // ちがう字に線
      const nearHTML = near.length ? `<div class="dest-near">
          <p class="dest-near-h">この注文ではありませんか？</p>
          ${near.map(o => `<div class="near-row"><span>${esc(o.supplierName)}・<b>${dif(o.chuban)}</b> ${about(o)}</span><button type="button" class="btn" data-near="${esc(o.id)}">この注文に入れる</button></div>`).join("")}
          <p class="hint">押すと、上の注番をその注文の注番に直して、その注文に入れます。</p>
        </div>` : "";
      return `<div class="dest-q">
          <h4>どの注文に入れますか？</h4>
          <p class="dest-tip">注番や材料屋の読みまちがいかもしれないときは、上の注番・材料屋を直すと、合う注文が出ます。</p>
          <p>${gr.handPriced && !noPriceOf(gr) ? "<b>金額を入れたので、金額のある納品書として入れます。</b>" : ""}この注番（${esc(gr.chuban)}）・${esc((sups[gr.supId] || {}).name || "")} の注文は、アプリにありません。</p>
          ${nearHTML}
          <ul><li>職員が引き取りに行った分など、<b>アプリで注文していない分</b> →「新しい注文として入れる」</li>
            <li><b>送り状・控え</b>（納品書がべつにある）→「入れない」${gr.dest === "skip" ? "のまま" : ""}</li></ul>
          ${cand.length ? `<select class="inp" data-f="dest" aria-label="どの注文に入れますか">${opts}</select>`
            : `<div class="choice">${btn("new", "新しい注文として入れる")}${btn("skip", "入れない（送り状・控え）")}</div>`}
        </div>${newHint}`;
    }
    function groupHTML(gr, ci, gi) {
      if (gr.saved) return `<div class="imp-g done"><p class="okmsg">入れました：${esc(gr.savedText || "")}</p></div>`;
      return `
        <div class="imp-g" data-c="${ci}" data-g="${gi}">
          <div class="imp-top" data-topbox>${topHTML(gr)}</div>
          <div class="imp-f">
            <label class="mini">材料屋<select class="inp" data-f="supId"><option value="">えらんでください</option>${supList.map(([id, s]) => `<option value="${esc(id)}"${gr.supId === id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
            <label class="mini">注番<input class="inp" data-f="chuban" value="${esc(gr.chuban)}" maxlength="12" autocapitalize="characters"></label>
            <label class="mini">納品書番号<input class="inp" data-f="no" value="${esc(gr.no)}" maxlength="40"></label>
            <label class="mini">日付<input class="inp" type="date" data-f="date" value="${esc(gr.date)}"></label>
          </div>
          <div class="imp-rows">
            ${gr.rows.map((r, ri) => `<div class="imp-row" data-r="${ri}">
              <div class="imp-rhead"><span>品名</span><button type="button" class="linkbtn muted" data-rdel="${ri}">この行を消す ×</button></div>
              <textarea class="inp imp-spec" data-rf="spec" rows="${Math.min(4, Math.max(1, Math.ceil([...r.spec].length / 28)))}" aria-label="品名">${esc(r.spec)}</textarea>
              <div class="imp-nums">
                <label class="mini n-qty">数<input class="inp num" data-rf="qty" inputmode="decimal" value="${r.qty ?? ""}"></label>
                <label class="mini n-unit">単位<input class="inp" data-rf="unit" value="${esc(r.unit)}"></label>
                <label class="mini n-price">単価<input class="inp num" data-rf="price" inputmode="decimal" value="${comma(r.price)}"></label>
                <label class="mini n-amount">金額<input class="inp num" data-rf="amount" inputmode="numeric" value="${comma(r.amount)}"></label>
              </div>
              <p class="hint warn" data-rhint${needQty(r) ? "" : " hidden"}>数を入れると、金額が出ます（金額を直接入れてもよい）</p>
            </div>`).join("")}
          </div>
          <p class="imp-sum">${sumHTML(gr)}</p>
          <div class="imp-dest" data-destbox>${destHTML(gr)}</div>
          ${gr.err ? `<p class="err">${esc(gr.err)}</p>` : ""}
        </div>`;
    }
    function cardHTML(c, ci) {
      const title = `${esc(c.name)}${c.page ? `（${c.page}ページ）` : ""}`;
      if (c.table) {
        return `
        <section class="imp-card table">
          <div class="imp-body"><span class="muted">材料集計表：${title}（${c.groups.length}件）</span>${c.groups.map((gr, gi) => groupHTML(gr, ci, gi)).join("")}</div>
        </section>`;
      }
      let body;
      if (c.status === "wait") body = `<p class="muted">まだ読んでいません。</p><button type="button" class="btn" data-read="${ci}">このページを読む</button>`;
      else if (c.status === "reading") body = '<p class="muted">AI が読んでいます…</p>';
      else if (c.status === "err") body = `<p class="warn">${esc(c.err)}</p><button type="button" class="btn" data-read="${ci}">もう一度読む</button>`;
      else if (c.status === "notslip") body = `<p class="warn">材料の納品書ではないようです（${esc(c.kind)}）。入れません。</p><button type="button" class="linkbtn" data-force="${ci}">納品書として読む</button>`;
      else body = c.groups.map((gr, gi) => groupHTML(gr, ci, gi)).join("");
      return `
        <section class="imp-card">
          <div class="imp-img">${c.thumb ? `<button type="button" class="imp-zoom" data-zoom="${ci}" aria-label="スキャンを大きく見る"><img src="${c.thumb}" alt=""></button>` : '<div class="imp-noimg"></div>'}
            <span class="muted">${title}</span></div>
          <div class="imp-body">${body}</div>
        </section>`;
    }
    const ready = () => cards.flatMap(c => c.groups.filter(gr => !gr.saved && gr.dest && gr.dest !== "skip"));
    function render() {
      g("#impList").innerHTML = cards.map(cardHTML).join("");
      drawFoot();
    }
    /** 1枚の上の知らせ（同じ納品書・たしかめてほしい所） */
    function topHTML(gr) {
      const d = [...gr.doubt, ...keyDoubts(gr)];
      return dupHTML(gr) + (d.length ? `<ul class="imp-doubt">${d.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    }
    /** 中が変わったときだけ入れかえる（同じなら、そのまま。押そうとしているボタンを入れかえない） */
    const put = (el, html) => { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } };
    /** 知らせと「どの注文に入れますか？」と下のボタンだけ、かきなおす（11/4）。
     *  全部かきなおすと、打っている欄や、押そうとしたボタンが入れかわって、1回目のボタンが効かなかった */
    function refresh() {
      cards.forEach((c, ci) => c.groups.forEach((gr, gi) => {
        const box = g(`.imp-g[data-c="${ci}"][data-g="${gi}"]`);
        if (!box) return;
        put(box.querySelector("[data-topbox]"), topHTML(gr));
        put(box.querySelector("[data-destbox]"), destHTML(gr));
      }));
      drawFoot();
    }
    /** いちばん下の「○件を入れる」 */
    function drawFoot() {
      const n = ready().length, reading = cards.some(c => c.status === "reading");
      g("#impFoot").hidden = !cards.some(c => c.groups.length);
      const go = g("#impGo");
      go.disabled = !n || reading;
      go.textContent = reading ? "読んでいます…" : n ? `${n}件を入れる` : "どの注文に入れるか、えらんでください";
    }
    const groupAt = el => { const d = el.closest("[data-g]"); return d ? cards[Number(d.dataset.c)].groups[Number(d.dataset.g)] : null; };

    /* ---------- 押したとき・書いたとき ---------- */
    w.addEventListener("click", e => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.read) readCard(cards[Number(t.dataset.read)]);
      else if (t.dataset.force) readCard(cards[Number(t.dataset.force)], true);
      else if (t.dataset.zoom) zoom(cards[Number(t.dataset.zoom)].thumb);
      else if (t.dataset.dest) { const gr = groupAt(t); gr.dest = t.dataset.dest; gr.picked = true; render(); }   // 「新しい注文として入れる」「入れない」のボタン（11/2）
      else if (t.dataset.near) {   // 「この注文ではありませんか？」の「この注文に入れる」（11/4）：注番をその注文の注番に直して、その注文に入れる
        const gr = groupAt(t), o = (getOrders() || []).find(x => x.id === t.dataset.near);
        if (!gr || !o) return;
        gr.chuban = o.chuban;
        gr.chEdited = true;
        const d = dupOf(gr);   // もうその注文に入っている納品書なら「入れない」（同じ納品書の知らせが出る）
        gr.dest = d ? "skip" : o.id;
        gr.picked = !d;
        render();
      }
      else if (t.dataset.rdel) {
        const gr = groupAt(t);
        gr.rows.splice(Number(t.dataset.rdel), 1);
        if (!gr.rows.length) gr.dest = "skip";
        render();
      }
      else if (t.id === "impPasteGo") {
        const rows = tableToRows(textToTable(g("#impPaste").value));
        if (!rows || !rows.length) { toast("見出しの行（金額と、注番か品名）が見つかりませんでした"); return; }
        addTable("はりつけた表", rows);
        g("#impPaste").value = "";
        g("#impPasteBox").open = false;
      }
      else if (t.id === "impGo") saveAll().catch(ex => { g("#impErr").textContent = errorText(ex); render(); });
    });
    g("#impFile").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
    const drop = g("#impDrop");
    w.addEventListener("dragover", e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); drop.classList.add("on"); } });
    w.addEventListener("dragleave", () => drop.classList.remove("on"));
    w.addEventListener("drop", e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); drop.classList.remove("on"); addFiles(e.dataTransfer.files); });
    // 品名の欄で Enter を押しても、改行しない（品名は1行。長いときは折りかえして見せるだけ）
    w.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList && e.target.classList.contains("imp-spec")) e.preventDefault(); });
    w.addEventListener("input", e => {
      const t = e.target, gr = groupAt(t);
      if (!gr) return;
      if (t.dataset.rf) {
        const r = gr.rows[Number(t.closest("[data-r]").dataset.r)], f = t.dataset.rf;
        const np0 = noPriceOf(gr);
        if (f === "spec") r.spec = t.value.replace(/\s*\n\s*/g, " ").trim();   // 品名は1行（折りかえして見せるだけ）
        else if (f === "unit") r.unit = t.value.trim();
        else r[f] = toPrice(t.value);
        const am = t.closest("[data-r]").querySelector('[data-rf="amount"]');
        if ((f === "qty" || f === "price") && r.qty != null && r.price != null && !am.dataset.touched) {
          r.amount = Math.round(r.qty * r.price);
          am.value = comma(r.amount);
        }
        if (f === "amount") t.dataset.touched = "1";
        const box = t.closest(".imp-g"), s = box.querySelector(".imp-sum");
        if (s) s.innerHTML = sumHTML(gr);   // 金額を書くと、金額のない紙から金額のある納品書になる（③）
        const rh = t.closest("[data-r]").querySelector("[data-rhint]");
        if (rh) rh.hidden = !needQty(r);   // 数がなくて単価だけ → 金額が出ない（11/2）
        // 金額を書いて、金額のない紙が金額のある納品書になった（または、もどった）：自分でえらんでいなければ、どの注文に入れるかを決めなおす。
        // 前は自動の「入れない」のままで、気づかないと入らなかった（11/2）。書いている欄はそのまま（下の所だけ、かきなおす）
        if (np0 !== noPriceOf(gr)) {
          gr.handPriced = !noPriceOf(gr);
          if (!gr.picked) gr.dest = defaultDest(gr);
          refresh();
        }
      } else if (t.dataset.f === "chuban") {
        // 7字そろったら（例 AB26123）、欄から出るのを待たずに、すぐ合う注文をさがしなおす（11/4）。そろっていない間は、欄から出たとき（change）
        const v = fixChuban(t.value);
        if (CHUBAN_RE.test(v) && v !== gr.chuban) setChuban(gr, v);
      } else if (t.dataset.f === "no") gr.no = t.value.trim();
    });
    w.addEventListener("change", e => {
      const t = e.target, gr = groupAt(t);
      if (!gr || !t.dataset.f) return;
      if (t.dataset.f === "chuban") {   // 欄から出たとき：7字でない注番も、ここでさがしなおす。全部はかきなおさない（押そうとしたボタンが入れかわらないように。11/4）
        const v = fixChuban(t.value);
        t.value = v;
        if (v !== gr.chuban) setChuban(gr, v);
        return;
      }
      if (t.dataset.f === "supId") { gr.supId = t.value; gr.dest = defaultDest(gr); }
      else if (t.dataset.f === "date") gr.date = t.value;
      else if (t.dataset.f === "dest") { gr.dest = t.value; gr.picked = true; }   // 自分でえらんだ入れる先は、あとで読んだ紙では変えない
      render();
    });

    /* ---------- 入れる ---------- */
    async function saveAll() {
      const list = ready();
      g("#impErr").textContent = "";
      for (const gr of list) {
        gr.err = "";
        if (!CHUBAN_RE.test(gr.chuban)) gr.err = "注番を正しく入れてください（例 AB26123）";
        else if (!gr.supId) gr.err = "材料屋をえらんでください";
        else if (!noPriceOf(gr) && gr.rows.some(r => r.amount == null)) gr.err = "金額が入っていない行があります";
      }
      if (list.some(gr => gr.err)) { render(); g("#impErr").textContent = "直してほしい所があります（赤い字）"; return; }
      const go = g("#impGo");
      go.disabled = true;
      go.textContent = "入れています…";
      const imp = push(ref(db, "zairyo/imports")).key;   // この取りこみの番号（記録と、納品書の imp）
      const items = [], used = new Set();
      for (const gr of list) {
        const c = cards.find(x => x.groups.includes(gr));
        try {
          const created = gr.dest === "new", np = noPriceOf(gr);
          const o = created ? await newOrder(gr) : (getOrders() || []).find(x => x.id === gr.dest);
          if (!o) throw new Error("入れる先の注文が見つかりません");
          const item = { orderId: o.id, created, arrived: o.status === "wait", amount: np ? 0 : sumOf(gr), chuban: o.chuban, sup: o.supplier, no: gr.no || "" };
          if (np) {
            if (o.status === "wait") await markArrived(o, me);
          } else {
            const rows = {};
            gr.rows.forEach((r, i) => {
              const x = { spec: r.spec || "（品名なし）", amount: Math.round(r.amount || 0) };
              if (r.qty != null) x.qty = r.qty;
              if (r.unit) x.unit = r.unit;
              if (r.price != null) x.price = r.price;
              rows["r" + String(i + 1).padStart(2, "0")] = x;
            });
            const slip = { date: gr.date || ymd(0), amount: sumOf(gr), rows, imp };
            if (gr.no) slip.no = gr.no;
            const scan = await scanOf(c);
            if (scan) slip.scan = scan;
            const r = await addSlip(o, slip, me);
            item.slipId = r.sid;
            if (r.priceIds.length) item.priceIds = r.priceIds;
          }
          items.push(item);
          used.add(c);
          gr.saved = true;
          gr.savedText = `${o.supplierName}・${o.chuban}${np ? "（届いたにしました）" : `・${yen(sumOf(gr))}円`}`;
        } catch (ex) {
          gr.err = errorText(ex);
        }
      }
      // 取りこみの記録（まとめて取り消すときに使う）
      if (items.length) {
        const files = [...used].map(c => {
          const f = { name: c.name.slice(0, 200), kind: c.table ? (c.name === "はりつけた表" ? "paste" : "table") : "scan" };
          if (c.scanPath) f.scan = c.scanPath;
          return f;
        });
        await set(ref(db, `zairyo/imports/${imp}`), {
          at: serverTimestamp(), by: me.name, byUid: auth.currentUser.uid, count: items.length, files, items,
        }).catch(ex => toast("取りこみの記録をのこせませんでした（" + errorText(ex) + "）"));
      }
      render();
      toast(items.length ? `納品書を ${items.length}件 入れました` : "入れられませんでした");
    }

    /** スキャンを Storage に保存して、置き場所を返す（1枚につき1回。表のときは保存しない） */
    async function scanOf(c) {
      if (!c || c.table || !c.full) return "";
      if (c.scanPath) return c.scanPath;
      const path = `zairyo/scans/${auth.currentUser.uid}/${push(ref(db, "zairyo/imports")).key.replace(/[^A-Za-z0-9]/g, "")}.jpg`;
      try {
        await uploadBytes(sref(storage, path), c.full, { contentType: "image/jpeg" });
        c.scanPath = path;
      } catch (ex) {
        toast("スキャンを保存できませんでした（納品書の金額は入れます）");
        return "";
      }
      return path;
    }

    /* ---------- 前の取りこみ・まとめて取り消す ---------- */
    let imports = null, askUndo = "";
    const hm = ts => { const d = new Date(ts); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
    const stopLog = onValue(query(ref(db, "zairyo/imports"), limitToLast(10)), snap => { imports = snap.val() || {}; drawLog(); }, () => { g("#impLogList").innerHTML = '<p class="warn">記録を読めませんでした</p>'; });
    function drawLog() {
      const list = Object.entries(imports || {}).sort(([, a], [, b]) => (b.at || 0) - (a.at || 0));
      g("#impLogList").innerHTML = !list.length ? '<p class="muted">まだ取りこみはありません。</p>' : list.map(([id, r]) => `
        <div class="imp-log">
          <div><b>${r.at ? `${md(r.at)} ${hm(r.at)}` : ""}</b>　${esc(r.by || "")}・${r.count || 0}件
            <span class="muted">（${Object.values(r.files || {}).map(f => esc(f.name)).join("・")}）</span></div>
          ${r.undone ? `<p class="muted">取り消しました（${r.undoneAt ? `${md(r.undoneAt)} ${hm(r.undoneAt)}・` : ""}${esc(r.undoneBy || "")}）</p>`
            : askUndo === id ? `<div class="confirm"><p class="confirm-q">この取りこみで入れた納品書の金額を消して、「届いた」にした注文はもどし、新しく作った注文は取り消します。よいですか？</p>
              <div class="confirm-btns"><button type="button" class="btn danger" data-undoyes="${esc(id)}">取り消す</button><button type="button" class="btn" data-undono>やめる</button></div></div>`
            : `<button type="button" class="btn" data-undo="${esc(id)}">まとめて取り消す</button>`}
        </div>`).join("");
    }
    g("#impLogList").addEventListener("click", e => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.undo) { askUndo = t.dataset.undo; drawLog(); }
      else if ("undono" in t.dataset) { askUndo = ""; drawLog(); }
      else if (t.dataset.undoyes) {
        t.disabled = true;
        undoImport(t.dataset.undoyes).then(msg => { askUndo = ""; toast(msg); }, ex => { t.disabled = false; toast(errorText(ex)); });
      }
    });
    async function undoImport(id) {
      const rec = imports[id], skipped = [];
      if (!rec || rec.undone) return "もう取り消してあります";
      for (const it of Object.values(rec.items || {})) {
        const o = (getOrders() || []).find(x => x.id === it.orderId);
        if (!o) continue;
        if (o.status === "billed") { skipped.push(o.chuban); continue; }   // 請求ずみの注文はさわらない
        const base = `zairyo/orders/${o.id}`, upd = {};
        const rest = slipsOf(o).filter(([sid]) => sid !== it.slipId);
        if (it.slipId && (o.slips || {})[it.slipId]) {
          upd[`${base}/slips/${it.slipId}`] = null;
          upd[`${base}/nouhin`] = rest.length ? rest.reduce((s, [, x]) => s + (Number(x.amount) || 0), 0) : null;
        }
        Object.values(it.priceIds || {}).forEach(p => { upd[`zairyo/prices/${p}`] = null; });
        if (it.created) {
          upd[`${base}/status`] = "cancelled";
          upd[`${base}/cancelledAt`] = serverTimestamp();
          upd[`${base}/cancelledBy`] = me.name;
        } else if (it.arrived && o.status === "arrived" && !rest.length) {
          upd[`${base}/status`] = "wait";
          upd[`${base}/arrivedAt`] = null;
          upd[`${base}/arrivedBy`] = null;
        }
        if (Object.keys(upd).length) await update(ref(db), upd);
      }
      Object.values(rec.files || {}).forEach(f => { if (f.scan) deleteObject(sref(storage, f.scan)).catch(() => { }); });
      await update(ref(db, `zairyo/imports/${id}`), { undone: true, undoneAt: serverTimestamp(), undoneBy: me.name });
      return skipped.length ? `取り消しました（${skipped.join("・")} は請求ずみなので、そのままにしました）` : "取りこみを取り消しました";
    }
    closeLog = stopLog;

    /** 納品書から新しい注文を作る（まだ届いていない注文として作ってから、納品書を入れる） */
    async function newOrder(gr) {
      const sup = sups[gr.supId];
      const job = jobs && jobs.all.get(gr.chuban);
      const lines = {};
      gr.rows.forEach((r, i) => {
        lines["l" + String(i + 1).padStart(2, "0")] = { spec: r.spec || "（品名なし）", qty: r.qty > 0 ? r.qty : 1, unit: r.unit || "式" };
      });
      const order = {
        supplier: gr.supId, supplierName: sup.name, to: sup.to || "御中",
        chuban: gr.chuban, kenmei: (job && job.kenmei) || "（納品書から入れた注文）", tantou: (job && job.tantou) || "", chumonsha: "",
        kibou: "最短", basho: "", bashoText: "", contacted: false,
        memo: `納品書から入れた注文${gr.no ? `（納品書番号 ${gr.no}）` : ""}`.slice(0, 500),
        kind: "nouhin",   // 納品書から作った注文の印（アプリで注文していない。10/30 ⑤）
        status: "wait", lines,
        orderedAt: serverTimestamp(), orderedBy: me.name, orderedByUid: auth.currentUser.uid,
      };
      const r = push(ref(db, "zairyo/orders"));
      await set(r, order);
      return { ...order, id: r.key, orderedAt: Date.now() };
    }

    function zoom(src) {
      const d = document.createElement("div");
      d.className = "lightbox";
      d.innerHTML = `<img alt="" src="${src}"><button type="button" class="x" aria-label="閉じる">×</button>`;
      const close = () => { d.remove(); document.removeEventListener("keydown", onKey, true); };
      const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
      d.addEventListener("click", close);
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(d);
    }
    render();
  }, {
    side: true, onClose: () => { if (stopJobs) stopJobs(); if (closeLog) closeLog(); },
    // まだ入れていない納品書（読んでいるもの・「入れない」でない読んだもの）や、はりつけた表があれば、閉じる前に聞く（11/2）
    guard: () => cards.some(c => c.status === "reading" || c.groups.some(gr => !gr.saved && gr.dest !== "skip")) || !!(document.querySelector("#impPaste") || {}).value,
    guardText: "まだ入れていない納品書があります。閉じると、読みとったものが消えます。閉じますか？",
  });
}
