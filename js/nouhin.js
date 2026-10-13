// 納品書の取りこみ（11章 7-5a。試作の「納品書の取り込み」と同じ考え方）
// - スキャン（PDF・写真）をえらぶかドラッグ → 1ページずつ絵にして、AI（サーバーの zairyoAi task "slip"）で読む
// - 縦長の紙は上と下に分けて送る（小さい字も読めるように）。PDF は pdf.js で絵にする。6ページ目からは「読む」を押してから
// - 1枚に注番がいくつかあれば、注番ごとに分ける。注番の読みまちがい（数字の所の O→0、I・L→1）は直す
// - 注番＋材料屋で注文をさがして「この注文に入れる」。なければ「新しい注文として入れる」か「入れない」
// - たしかめてほしい所：AI が読みにくかった所・明細の合計と納品書の合計のちがい・金額が読めない行・知らない頭文字
// - 入れると、注文の「納品書の金額」に入る（5-4 の addSlip と同じ）。まだ届いていない注文は「届いた」になる。
//   金額のない納品書は「届いた」にするだけ
// - 7-5b：材料集計表（Excel・CSV・はりつけた表）も同じ画面で読む（js/hyou.js。AI は使わない）。注番＋材料屋＋納品書番号（なければ日付）ごとにまとめる
// - 同じ納品書を止める・取りこみの記録・まとめて取り消す・元のスキャンの保存は 7-5c
import { ref, get, push, set, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth, call } from "./firebase.js";
import { esc, zenkana, toast, openSheet } from "./common.js";
import { ymd } from "./tanomu.js";
import { addSlip, markArrived, yen, toPrice, ST } from "./chumon.js";
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

function toGroups(res, supList, prefixOk) {
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
    if (!m.id && res.supplier) g.doubt.push(`材料屋「${res.supplier}」が分かりません。えらんでください`);
    if (total != null && Math.abs(total - all) > 1) g.doubt.push(`明細の合計 ${yen(all)}円 と、納品書の合計 ${yen(total)}円 がちがいます`);
    g.noPrice = rs.every(r => r.amount == null);
    if (!g.noPrice && rs.some(r => r.amount == null)) g.doubt.push("金額が読めない行があります");
    if (rs.some(r => REPAIR.test(r.spec))) g.doubt.push("修理・工賃の行があります。材料費に入れないなら、その行を消してください（×）");
    if (!chuban) g.doubt.push("注番が読めませんでした。入れてください");
    else if (!prefixOk(chuban)) g.doubt.push(`注番の頭文字「${chuban.slice(0, 2)}」が、注番の会社の表にありません`);
    return g;
  });
}

/** 納品書の取りこみの画面を開く。opts = { sups, getOrders() → 注文の並び, me } */
export function openImport({ sups, getOrders, me }) {
  const supList = Object.entries(sups || {}).sort(byOrder);
  const cards = [];   // [{ name, page, thumb, parts, status: "wait"|"reading"|"done"|"err"|"notslip", kind, err, groups }]
  let jobs = null, stopJobs = null, kaisha = {}, kotei = {};
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
      <div id="impList" class="stack"></div>
      <div class="sheet-foot" id="impFoot" hidden><p class="err" id="impErr"></p>
        <button type="button" class="btn primary big full" id="impGo"></button></div>
    </div>`;

  openSheet(html, panel => {
    const w = panel.querySelector("#impWrap");
    const g = s => w.querySelector(s);
    stopJobs = watchJobs(d => { jobs = d; }, () => { });
    get(ref(db, "common/kaisha")).then(s => { kaisha = s.val() || {}; }, () => { });
    get(ref(db, "common/kotei")).then(s => { kotei = s.val() || {}; }, () => { });

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
          dest: "", saved: false, err: "", noPrice: false,
          doubt: [`表の ${rs.map(r => r.at).join("・")} 行目`],
        };
        if (!m.id) gr.doubt.push(r0.supRaw ? `材料屋「${r0.supRaw}」が分かりません。えらんでください` : "材料屋の列がありません。えらんでください");
        if (rs.some(r => REPAIR.test(r.spec))) gr.doubt.push("修理・工賃の行があります。材料費に入れないなら、その行を消してください（×）");
        if (!CHUBAN_RE.test(chuban)) gr.doubt.push("注番が読めませんでした。入れてください");
        else if (!prefixOk(chuban)) gr.doubt.push(`注番の頭文字「${chuban.slice(0, 2)}」が、注番の会社の表にありません`);
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
        }
        render();
        const r = (await call("zairyoAi", { timeout: 300000 })({ task: "slip", images: c.parts, force })).data;
        const s = r.slip;
        if (!s.isSlip) { c.status = "notslip"; c.kind = s.kind || "納品書ではない書類"; }
        else {
          c.status = "done";
          c.groups = toGroups(s, supList, prefixOk);
          if (!c.groups.length) { c.status = "err"; c.err = "品物の行が読めませんでした"; }
          c.groups.forEach(gr => { gr.dest = defaultDest(gr); });
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
    function defaultDest(gr) {
      const hit = candidates(gr).find(o => o.supplier === gr.supId && (o.status === "wait" || o.status === "arrived"));
      return hit ? hit.id : "";   // 合う注文がないときは、事務員さんが「新しい注文として入れる」か「入れない」をえらぶ
    }

    /* ---------- 画面 ---------- */
    const sumOf = gr => gr.rows.reduce((s, r) => s + (r.amount || 0), 0);
    function groupHTML(gr, ci, gi) {
      if (gr.saved) return `<div class="imp-g done"><p class="okmsg">入れました：${esc(gr.savedText || "")}</p></div>`;
      const cand = candidates(gr);
      const destOpts = `<option value=""${gr.dest ? "" : " selected"}>えらんでください</option>` +
        cand.map(o => `<option value="${esc(o.id)}"${gr.dest === o.id ? " selected" : ""}>${esc(o.supplierName)}・${esc(o.chuban)} ${esc(zenkana(o.kenmei || ""))}（${ST[o.status].chip}・${new Date(o.orderedAt).getMonth() + 1}/${new Date(o.orderedAt).getDate()} 注文）</option>`).join("") +
        `<option value="new"${gr.dest === "new" ? " selected" : ""}>新しい注文として入れる</option><option value="skip"${gr.dest === "skip" ? " selected" : ""}>入れない</option>`;
      return `
        <div class="imp-g" data-c="${ci}" data-g="${gi}">
          ${gr.doubt.length ? `<ul class="imp-doubt">${gr.doubt.map(d => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
          <div class="imp-f">
            <label class="mini">材料屋<select class="inp" data-f="supId"><option value="">えらんでください</option>${supList.map(([id, s]) => `<option value="${esc(id)}"${gr.supId === id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
            <label class="mini">注番<input class="inp" data-f="chuban" value="${esc(gr.chuban)}" maxlength="12" autocapitalize="characters"></label>
            <label class="mini">納品書番号<input class="inp" data-f="no" value="${esc(gr.no)}" maxlength="40"></label>
            <label class="mini">日付<input class="inp" type="date" data-f="date" value="${esc(gr.date)}"></label>
          </div>
          <table class="imp-rows"><thead><tr><th>品名</th><th>数</th><th>単位</th><th>単価</th><th>金額</th><th></th></tr></thead><tbody>
            ${gr.rows.map((r, ri) => `<tr data-r="${ri}">
              <td><input class="inp" data-rf="spec" value="${esc(r.spec)}" aria-label="品名"></td>
              <td><input class="inp num" data-rf="qty" inputmode="decimal" value="${r.qty ?? ""}" aria-label="数"></td>
              <td><input class="inp" data-rf="unit" value="${esc(r.unit)}" aria-label="単位"></td>
              <td><input class="inp num" data-rf="price" inputmode="decimal" value="${r.price ?? ""}" aria-label="単価"></td>
              <td><input class="inp num" data-rf="amount" inputmode="numeric" value="${r.amount ?? ""}" aria-label="金額"></td>
              <td><button type="button" class="linkbtn muted" data-rdel="${ri}" aria-label="この行を消す">×</button></td></tr>`).join("")}
          </tbody></table>
          <p class="imp-sum">${gr.noPrice ? "金額のない納品書です（入れると「届いた」にするだけ）" : `明細の合計 <span class="money" data-sum>${yen(sumOf(gr))}</span> 円（税抜）`}</p>
          <label class="mini">入れる先<select class="inp" data-f="dest">${destOpts}</select></label>
          ${gr.dest === "new" && gr.chuban ? `<p class="hint">注番 ${esc(gr.chuban)} で、新しい注文を作ってから入れます（工事件名は日報から）。</p>` : ""}
          ${!gr.dest && gr.chuban && gr.supId && !cand.some(o => o.supplier === gr.supId) ? '<p class="hint warn">この注番・材料屋の注文がありません。「新しい注文として入れる」か「入れない」をえらんでください。</p>' : ""}
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
      const n = ready().length, reading = cards.some(c => c.status === "reading");
      g("#impFoot").hidden = !cards.some(c => c.groups.length);
      const go = g("#impGo");
      go.disabled = !n || reading;
      go.textContent = reading ? "読んでいます…" : n ? `${n}件を入れる` : "入れる先をえらんでください";
    }
    const groupAt = el => { const d = el.closest("[data-g]"); return d ? cards[Number(d.dataset.c)].groups[Number(d.dataset.g)] : null; };

    /* ---------- 押したとき・書いたとき ---------- */
    w.addEventListener("click", e => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.read) readCard(cards[Number(t.dataset.read)]);
      else if (t.dataset.force) readCard(cards[Number(t.dataset.force)], true);
      else if (t.dataset.zoom) zoom(cards[Number(t.dataset.zoom)].thumb);
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
    w.addEventListener("input", e => {
      const t = e.target, gr = groupAt(t);
      if (!gr) return;
      if (t.dataset.rf) {
        const r = gr.rows[Number(t.closest("[data-r]").dataset.r)], f = t.dataset.rf;
        if (f === "spec" || f === "unit") r[f] = t.value.trim();
        else r[f] = toPrice(t.value);
        if ((f === "qty" || f === "price") && r.qty != null && r.price != null && !t.closest("tr").querySelector('[data-rf="amount"]').dataset.touched) {
          r.amount = Math.round(r.qty * r.price);
          t.closest("tr").querySelector('[data-rf="amount"]').value = r.amount;
        }
        if (f === "amount") t.dataset.touched = "1";
        const s = t.closest(".imp-g").querySelector("[data-sum]");
        if (s) s.textContent = yen(sumOf(gr));
      } else if (t.dataset.f === "no") gr.no = t.value.trim();
    });
    w.addEventListener("change", e => {
      const t = e.target, gr = groupAt(t);
      if (!gr || !t.dataset.f) return;
      if (t.dataset.f === "supId") { gr.supId = t.value; gr.dest = defaultDest(gr); }
      else if (t.dataset.f === "chuban") { gr.chuban = fixChuban(t.value); gr.dest = defaultDest(gr); }
      else if (t.dataset.f === "date") gr.date = t.value;
      else if (t.dataset.f === "dest") gr.dest = t.value;
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
        else if (!gr.noPrice && gr.rows.some(r => r.amount == null)) gr.err = "金額が入っていない行があります";
      }
      if (list.some(gr => gr.err)) { render(); g("#impErr").textContent = "直してほしい所があります（赤い字）"; return; }
      const go = g("#impGo");
      go.disabled = true;
      go.textContent = "入れています…";
      let n = 0;
      for (const gr of list) {
        try {
          let o = gr.dest === "new" ? await newOrder(gr) : (getOrders() || []).find(x => x.id === gr.dest);
          if (!o) throw new Error("入れる先の注文が見つかりません");
          if (gr.noPrice) {
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
            const slip = { date: gr.date || ymd(0), amount: sumOf(gr), rows };
            if (gr.no) slip.no = gr.no;
            await addSlip(o, slip, me);
          }
          gr.saved = true;
          gr.savedText = `${o.supplierName}・${o.chuban}${gr.noPrice ? "（届いたにしました）" : `・${yen(sumOf(gr))}円`}`;
          n++;
        } catch (ex) {
          gr.err = errorText(ex);
        }
      }
      render();
      toast(n ? `納品書を ${n}件 入れました` : "入れられませんでした");
    }

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
  }, { side: true, onClose: () => { if (stopJobs) stopJobs(); } });
}
