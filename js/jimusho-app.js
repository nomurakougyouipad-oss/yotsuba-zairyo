// 事務所のパソコン：登録ずみの画面（上の箱・依頼／注文ごと／工事（注番）ごと・さがす・⚙ 設定）。試作の事務所の画面と同じ形
// - 11章 5-1：依頼を見る（読むだけ）。現場から送られた依頼を新しい順に。取り消された依頼は、下にたたんで灰色で
// - 材料屋を決めて注文する（注文の文をコピー →「注文した」）は 5-2、注文ごと・工事ごと・届いた は 5-3、納品書の金額・請求は 5-4
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { $, esc, zenkana, runChecks, openSheet } from "./common.js";
import { normCatalog, lineText, fmtQty, kibouText } from "./tanomu.js";
import { renderSettings } from "./settei.js";

const pad = n => String(n).padStart(2, "0");
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const linesOf = r => Object.values(r.lines || {});
const isCancelled = r => r.status === "cancelled";
/** まだ注文していない依頼（5-2 で「全部注文した」がわかるようになったら、それも外す） */
const isNew = r => r.status === "sent";

export function startOfficeApp(main) {
  const st = { view: "irai", q: "", reqs: null, catalog: null, settingsOpen: false };

  main.innerHTML = `
    <div id="home" class="stack">
      <section class="boxes" id="boxes" aria-label="注文のようす"></section>
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="見かた" id="seg">
          <button type="button" role="tab" data-view="irai">依頼</button>
          <button type="button" role="tab" data-view="orders">注文ごと</button>
          <button type="button" role="tab" data-view="kouji">工事（注番）<wbr>ごと</button>
        </div>
        <input id="q" class="inp search" type="search" placeholder="注番・件名・品名・人でさがす" aria-label="さがす" autocomplete="off">
        <button type="button" class="btn" id="setBtn">⚙ 設定</button>
      </div>
      <div id="filterNote" class="filter-note" hidden></div>
      <div id="list"></div>
      <details class="block hidbox"><summary>つながりのたしかめ</summary><ul class="checks" id="checks"></ul></details>
    </div>
    <div id="setView" class="stack" hidden>
      <button type="button" class="back" id="setBack">‹ 依頼・注文の画面にもどる</button>
      <section class="card" id="settei"></section>
    </div>`;
  runChecks($("#checks", main));

  /* ---------- さがす ---------- */
  function matchReq(r) {
    const q = st.q.trim().normalize("NFKC").toLowerCase();
    if (!q) return true;
    return [r.chuban, r.kenmei, r.chumonsha, r.tantou, r.basho, r.contactedName, r.memo, ...linesOf(r).map(l => l.spec + " " + (l.note || ""))]
      .some(v => String(v || "").normalize("NFKC").toLowerCase().includes(q));
  }
  const newReqs = () => (st.reqs || []).filter(r => isNew(r) && matchReq(r));

  /* ---------- 上の箱・タブ ---------- */
  function drawTop() {
    const n = newReqs().length;
    const box = (cls, c, label, num, attrs) =>
      `<button type="button" class="box ${cls}" ${attrs} style="--c:${c}"><span class="lab">${label}</span><span class="num">${num}<span class="unit">件</span></span></button>`;
    $("#boxes", main).innerHTML =
      box(`new${n ? " has" : ""}`, "var(--amber)", "現場からの新しい依頼", st.reqs ? n : "…", `data-view="irai" aria-pressed="${st.view === "irai"}"`) +
      // 下の3つは、5-2 で注文ができてから数が出る
      box("soon", "var(--amber)", "材料が<wbr>まだ届いていない", "—", "disabled") +
      box("soon", "var(--blue)", "届いた・<wbr>請求まだ", "—", "disabled") +
      box("soon", "var(--grey)", "請求ずみ", "—", "disabled");
    const all = (st.reqs || []).filter(isNew).length;
    main.querySelectorAll("#seg [data-view]").forEach(b => {
      b.setAttribute("aria-selected", b.dataset.view === st.view);
      if (b.dataset.view === "irai") b.innerHTML = "依頼" + (all ? `<span class="badge">${all}</span>` : "");
    });
    const note = $("#filterNote", main);
    note.hidden = !st.q.trim();
    note.innerHTML = st.q.trim() ? `<span>「<b>${esc(st.q.trim())}</b>」でさがし中</span><button type="button" class="linkbtn" id="clearQ">ぜんぶ表示にもどす</button>` : "";
  }

  /* ---------- 一覧 ---------- */
  function reqCard(r) {
    const ls = linesOf(r), cx = isCancelled(r);
    return `
      <article class="ocard${cx ? " cx" : ""}" tabindex="0" data-req="${esc(r.id)}" style="--c:${cx ? "var(--grey)" : "var(--amber)"}">
        <div class="card-head"><span class="sup">${esc(r.chumonsha)}さんから</span>
          <span class="ochip${cx ? "" : " solid"}">${cx ? "取り消された" : "新しい依頼"}</span></div>
        <div class="kouji"><span class="chuban">${esc(r.chuban)}</span><span class="kenmei">${esc(zenkana(r.kenmei))}</span></div>
        <div class="items">${esc(ls.map(lineText).join("\n"))}</div>
        <dl class="meta">
          <div><dt>希望日</dt><dd>${esc(kibouText(r.kibou))}</dd></div>
          <div><dt>届け先</dt><dd>${esc(r.basho || "—")}</dd></div>
          <div><dt>送った</dt><dd>${md(r.sentAt)} ${hm(r.sentAt)}</dd></div>
          ${r.contactedName ? `<div><dt>連絡ずみ</dt><dd class="hl">${esc(r.contactedName)}</dd></div>` : ""}
          ${cx && r.cancelledAt ? `<div><dt>取り消し</dt><dd>${md(r.cancelledAt)} ${hm(r.cancelledAt)}</dd></div>` : ""}
        </dl>
        <div class="card-foot"><span class="amt"><span class="num">${ls.length}</span><span>点</span></span>
          <button type="button" class="btn${cx ? "" : " primary"}" data-reqopen="${esc(r.id)}">中身を見る</button></div>
      </article>`;
  }

  function drawList() {
    const list = $("#list", main);
    if (st.view !== "irai") {
      list.innerHTML = `<p class="empty">「${st.view === "orders" ? "注文ごと" : "工事（注番）ごと"}」は、材料屋に注文できるようになってから作ります（5-3）。</p>`;
      return;
    }
    if (!st.reqs) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const news = newReqs();
    const cxs = st.reqs.filter(r => isCancelled(r) && matchReq(r));
    list.innerHTML =
      (news.length
        ? `<div class="ocards">${news.map(reqCard).join("")}</div>`
        : `<p class="empty">${st.q.trim() ? "あてはまる依頼はありません。" : "新しい依頼はありません。<br>現場のスマホから送られた注文が、ここに来ます。"}</p>`) +
      (cxs.length ? `<details class="block hidbox" id="cxBox"><summary>現場が取り消した依頼（${cxs.length}）</summary><div class="ocards">${cxs.map(reqCard).join("")}</div></details>` : "");
  }

  function draw() {
    const open = !!$("#cxBox[open]", main);
    drawTop();
    drawList();
    if (open && $("#cxBox", main)) $("#cxBox", main).open = true;
  }

  /* ---------- 依頼の中身（右から出る） ---------- */
  function openReq(id) {
    const r = (st.reqs || []).find(x => x.id === id);
    if (!r) return;
    const ls = linesOf(r), cx = isCancelled(r);
    const catName = c => (st.catalog && (st.catalog.cats.find(x => x.id === c) || {}).name) || "";
    const html = `
      <div class="pw" id="reqWrap">
        <div class="panel-head"><div>
          <span class="eyebrow">現場からの依頼　${md(r.sentAt)} ${hm(r.sentAt)}</span>
          <h2 id="panelTitle">${esc(r.chumonsha)}さんから ${ls.length}点</h2>
          <div class="kouji"><span class="chuban">${esc(r.chuban)}</span><span class="kenmei">${esc(zenkana(r.kenmei))}</span></div>
        </div><button type="button" class="x" data-close aria-label="閉じる">×</button></div>
        ${cx ? `<p class="warn">現場が取り消しました${r.cancelledAt ? `（${md(r.cancelledAt)} ${hm(r.cancelledAt)}）` : ""}。注文しないでください。</p>` : ""}
        <div class="block"><dl class="dl">
          <dt>希望日</dt><dd>${esc(kibouText(r.kibou))}</dd>
          <dt>届け先</dt><dd>${esc(r.basho || "—")}</dd>
          <dt>注文者</dt><dd>${esc(r.chumonsha)}</dd>
          <dt>担当者</dt><dd>${esc(r.tantou || "—")}</dd>
          ${r.typed ? "<dt>工事</dt><dd>日報の一覧にない工事（現場が注番を手で書いた）</dd>" : ""}
          ${r.contactedName ? `<dt>連絡ずみ</dt><dd class="hl">${esc(r.chumonsha)}さんが ${esc(r.contactedName)} に連絡ずみ</dd>` : ""}
          ${r.memo ? `<dt>メモ</dt><dd>${esc(r.memo)}</dd>` : ""}
        </dl></div>
        <div class="block"><h3>品物</h3>
          <div class="lrows">${ls.map(l => `
            <div class="lrow">
              <div class="lspec">${catName(l.cat) ? `<span class="tag">${esc(catName(l.cat))}</span>` : ""}${esc(l.spec)}${l.note ? " " + esc(l.note) : ""}</div>
              <div class="lqty"><span class="num">${esc(fmtQty(l.qty))}</span>${esc(l.unit)}</div>
            </div>`).join("")}</div>
        </div>
        ${cx ? "" : '<p class="hint">品物ごとに材料屋を決めて注文するところは、次に作ります（5-2）。</p>'}
      </div>`;
    openSheet(html, null, { side: true });
  }

  /* ---------- 押したとき ---------- */
  main.addEventListener("click", e => {
    const t = e.target.closest("[data-view],[data-reqopen],[data-req],#setBtn,#setBack,#clearQ");
    if (!t || t.disabled) return;
    if (t.dataset.view) { st.view = t.dataset.view; draw(); }
    else if (t.dataset.reqopen) openReq(t.dataset.reqopen);
    else if (t.dataset.req) openReq(t.dataset.req);
    else if (t.id === "setBtn") showSettings(true);
    else if (t.id === "setBack") showSettings(false);
    else if (t.id === "clearQ") { st.q = ""; $("#q", main).value = ""; draw(); }
  });
  main.addEventListener("keydown", e => {
    const c = e.target.closest && e.target.closest("[data-req]");
    if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openReq(c.dataset.req); }
  });
  main.addEventListener("input", e => {
    if (e.target.id === "q") { st.q = e.target.value; draw(); }
  });

  /** ⚙ 設定：はじめて開くときに作る（そのあとは見せる・かくすだけ） */
  function showSettings(on) {
    $("#home", main).hidden = on;
    $("#setView", main).hidden = !on;
    if (on && !st.settingsOpen) { renderSettings($("#settei", main)); st.settingsOpen = true; }
    window.scrollTo(0, 0);
  }

  /* ---------- データ ---------- */
  onValue(ref(db, "zairyo/requests"), s => {
    st.reqs = Object.entries(s.val() || {}).map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    draw();
  });
  onValue(ref(db, "zairyo/master/catalog"), s => { st.catalog = normCatalog(s.val()); });

  draw();
}
