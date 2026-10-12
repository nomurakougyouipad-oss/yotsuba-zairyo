// 事務所のパソコン：登録ずみの画面（上の箱・依頼／注文ごと／工事（注番）ごと・さがす・⚙ 設定）。試作の事務所の画面と同じ形
// - 11章 5-1：依頼を見る。現場から送られた依頼を新しい順に。取り消された依頼は、下にたたんで灰色で
// - 11章 5-2：依頼の中身で、品物ごとに材料屋を決める（現場が連絡した材料屋 → なければ品物一覧の「いつもの材料屋」）→
//   材料屋ごとに「注文の文をコピー」→「注文した」。注文を取り消して依頼にもどすこともできる（js/chumon.js）
// - 注文ごと・工事ごと・届いた は 5-3、納品書の金額・請求は 5-4
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { $, esc, zenkana, toast, runChecks, openSheet } from "./common.js";
import { errorText } from "./touroku.js";
import { normCatalog, lineText, fmtQty, kibouText } from "./tanomu.js";
import { orderText, draftOrder, placeOrder, cancelOrder } from "./chumon.js";
import { renderSettings } from "./settei.js";

const pad = n => String(n).padStart(2, "0");
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999);
const linesOf = r => Object.values(r.lines || {});
const isCancelled = r => r.status === "cancelled";
/** まだ注文しきっていない依頼（status "sent"。一部だけ注文したものも入る） */
const isNew = r => r.status === "sent";

export function startOfficeApp(main, me) {
  const st = {
    view: "irai", q: "", reqs: null, orders: null, catalog: null, sups: null, places: null,
    settingsOpen: false,
    pick: {},        // 依頼ごとの、品物にえらんだ材料屋 {依頼id: {品物id: 材料屋id}}（「注文した」までは、この画面だけ）
    openId: "",      // いま中身を出している依頼
  };

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
  const ordersOf = reqId => (st.orders || []).filter(o => o.reqId === reqId);

  /* ---------- 上の箱・タブ ---------- */
  function drawTop() {
    const n = newReqs().length;
    const wait = (st.orders || []).filter(o => o.status === "wait").length;
    const box = (cls, c, label, num, attrs) =>
      `<button type="button" class="box ${cls}" ${attrs} style="--c:${c}"><span class="lab">${label}</span><span class="num">${num}<span class="unit">件</span></span></button>`;
    $("#boxes", main).innerHTML =
      box(`new${n ? " has" : ""}`, "var(--amber)", "現場からの新しい依頼", st.reqs ? n : "…", `data-view="irai" aria-pressed="${st.view === "irai"}"`) +
      // 押してしぼりこむのは 5-3 から（いまは数だけ）
      box("soon", "var(--amber)", "材料が<wbr>まだ届いていない", st.orders ? wait : "…", "disabled") +
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
    const chip = cx ? "取り消された" : r.ordered ? "一部注文ずみ" : "新しい依頼";
    return `
      <article class="ocard${cx ? " cx" : ""}" tabindex="0" data-req="${esc(r.id)}" style="--c:${cx ? "var(--grey)" : "var(--amber)"}">
        <div class="card-head"><span class="sup">${esc(r.chumonsha)}さんから</span>
          <span class="ochip${cx || r.ordered ? "" : " solid"}">${chip}</span></div>
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
          <button type="button" class="btn${cx ? "" : " primary"}" data-reqopen="${esc(r.id)}">${cx ? "中身を見る" : "材料屋を決める"}</button></div>
      </article>`;
  }

  function drawList() {
    const list = $("#list", main);
    if (st.view !== "irai") {
      list.innerHTML = `<p class="empty">「${st.view === "orders" ? "注文ごと" : "工事（注番）ごと"}」は、次に作ります（5-3）。</p>`;
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

  /* ---------- 依頼の中身（右から出る）：材料屋を決めて注文する ---------- */
  const supList = () => Object.entries(st.sups || {}).filter(([, s]) => !s.hidden).sort(byOrder);
  /** 品物の「いつもの材料屋」：品物ごと → なければ種類ごと（品物一覧） */
  function usualSup(l) {
    if (!st.catalog) return "";
    const it = st.catalog.item.get(l.key);
    const cat = st.catalog.cats.find(c => c.id === l.cat);
    return (it && it.sup) || (cat && cat.sup) || "";
  }
  /** まだ注文していない品物に、えらんでいる材料屋（はじめは：現場が連絡した材料屋 → いつもの材料屋） */
  function picksOf(r) {
    const p = st.pick[r.id] || (st.pick[r.id] = {});
    for (const [id, l] of Object.entries(r.lines || {})) {
      if (l.orderId) { delete p[id]; continue; }
      if (!(id in p)) p[id] = (r.contacted && st.sups && st.sups[r.contacted] ? r.contacted : usualSup(l)) || "";
    }
    return p;
  }
  /** 材料屋ごとのまとまり（まだ注文していない品物だけ） */
  function groupsOf(r) {
    const p = picksOf(r), m = new Map(), none = [];
    for (const [id, l] of Object.entries(r.lines || {})) {
      if (l.orderId) continue;
      const s = p[id];
      if (!s || !st.sups || !st.sups[s]) { none.push(id); continue; }
      if (!m.has(s)) m.set(s, []);
      m.get(s).push(id);
    }
    return { groups: [...m.entries()], none };
  }
  const bashoText = r => ((st.places || {})[r.bashoId] || {}).text || "";

  function reqHTML(r) {
    const ls = Object.entries(r.lines || {}), cx = isCancelled(r);
    const catName = c => (st.catalog && (st.catalog.cats.find(x => x.id === c) || {}).name) || "";
    const p = cx ? {} : picksOf(r);
    const orderById = id => (st.orders || []).find(o => o.id === id);
    const rows = ls.map(([id, l]) => {
      const o = l.orderId ? orderById(l.orderId) : null;
      const sup = cx ? ""
        : l.orderId ? `<span class="done-sup">✓ 注文ずみ<br>${esc(o ? o.supplierName : "")}</span>`
        : `<select class="inp" data-pick="${esc(id)}" aria-label="${esc(l.spec)} の材料屋">
            <option value="">材料屋をえらぶ</option>
            ${supList().map(([sid, s]) => `<option value="${esc(sid)}"${p[id] === sid ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>`;
      return `
        <div class="lrow${cx ? "" : " has-sup"}${l.orderId ? " ordered" : ""}">
          <div class="lspec">${catName(l.cat) ? `<span class="tag">${esc(catName(l.cat))}</span>` : ""}${esc(l.spec)}${l.note ? " " + esc(l.note) : ""}</div>
          <div class="lqty"><span class="num">${esc(fmtQty(l.qty))}</span>${esc(l.unit)}</div>
          ${cx ? "" : `<div class="lsup">${sup}</div>`}
        </div>`;
    }).join("");
    const os = ordersOf(r.id).sort((a, b) => (a.orderedAt || 0) - (b.orderedAt || 0));
    return `
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
        <div class="block"><h3>${cx ? "品物" : "1. 品物ごとに材料屋を決める"}</h3>
          ${cx ? "" : `<p class="hint">${r.contactedName ? `現場が連絡した ${esc(r.contactedName)} を入れています。` : "品物一覧の「いつもの材料屋」が最初から入っています。"}ちがえば、えらびなおしてください。</p>`}
          <div class="lrows">${rows}</div>
        </div>
        ${cx ? "" : `<div class="block" id="groupsBox">${groupsHTML(r)}</div>`}
        ${os.length ? `<div class="block"><h3>この依頼から注文したもの</h3><div class="olist">${os.map(orderItemHTML).join("")}</div></div>` : ""}
      </div>`;
  }

  function groupsHTML(r) {
    const { groups, none } = groupsOf(r);
    let h = "<h3>2. 材料屋ごとに注文する</h3>";
    if (groups.length) {
      h += `<div class="groups">${groups.map(([sid, ids]) => {
        const s = st.sups[sid];
        return `
          <div class="group">
            <div class="g-head"><span class="sup">${esc(s.name)}</span><span class="g-tag">${esc(s.to || "御中")}</span><span class="hint g-n">${ids.length}点</span></div>
            <ul class="g-lines">${ids.map(id => `<li>${esc(lineText(r.lines[id]))}</li>`).join("")}</ul>
            <div class="row"><button type="button" class="btn" data-gcopy="${esc(sid)}">注文の文をコピー</button>
              <button type="button" class="btn primary" data-gorder="${esc(sid)}">注文した</button></div>
            <div class="field" data-gfb="${esc(sid)}" hidden><span class="lab">コピーした文（うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
              <textarea class="inp ta copybox" rows="12" readonly></textarea></div>
          </div>`;
      }).join("")}</div>
      <p class="hint">「注文の文をコピー」して、LINE・メールで材料屋に送ってから、「注文した」を押してください。</p>`;
    }
    if (none.length) h += `<p class="err">材料屋が決まっていない品物が ${none.length}点 あります（上の 1. でえらんでください）</p>`;
    if (!groups.length && !none.length) h += "<p>この依頼は、すべて注文しました。</p>";
    return h;
  }

  function orderItemHTML(o) {
    const cx = o.status === "cancelled";
    return `
      <div class="oitem${cx ? " cx" : ""}">
        <div class="oi-head"><b>${esc(o.supplierName)}</b>
          <span class="muted">${md(o.orderedAt)} ${hm(o.orderedAt)} 注文（${esc(o.orderedBy || "")}）</span></div>
        <ul class="g-lines">${Object.values(o.lines || {}).map(l => `<li>${esc(lineText(l))}</li>`).join("")}</ul>
        ${cx ? `<p class="muted">取り消した（${o.cancelledAt ? `${md(o.cancelledAt)} ${hm(o.cancelledAt)}・` : ""}${esc(o.cancelledBy || "")}）。品物は依頼にもどしました。</p>`
          : o.status === "wait" ? `
            <div class="cx-start" id="ocx-${esc(o.id)}">
              <button type="button" class="btn danger" data-ocancel="${esc(o.id)}">注文を取り消して依頼にもどす</button>
              <span class="hint">押しまちがえたときや、材料屋を変えたいときに。材料屋に連絡したあとなら、材料屋にも取り消しを伝えてください。</span>
            </div>` : ""}
      </div>`;
  }

  function openReq(id, keepScroll = false) {
    const r = (st.reqs || []).find(x => x.id === id);
    if (!r) return;
    const panel = document.getElementById("panel");
    const y = keepScroll && panel ? panel.scrollTop : 0;
    st.openId = id;
    openSheet(reqHTML(r), p => {
      p.scrollTop = y;
      const w = p.querySelector("#reqWrap");
      w.addEventListener("change", e => {
        const s = e.target.closest("[data-pick]");
        if (!s) return;
        picksOf(r)[s.dataset.pick] = s.value;
        const gb = w.querySelector("#groupsBox");
        if (gb) gb.innerHTML = groupsHTML(r);
      });
      w.addEventListener("click", e => onPanelClick(e, w).catch(ex => toast(errorText(ex))));
    }, { side: true });
  }

  /** 中身の画面で押したとき */
  async function onPanelClick(e, w) {
    const t = e.target.closest("[data-gcopy],[data-gorder],[data-ocancel],[data-ocyes],[data-ocno]");
    if (!t || t.disabled) return;
    const r = (st.reqs || []).find(x => x.id === st.openId);
    if (!r) return;
    const d = t.dataset;
    const draftFor = sid => {
      const g = groupsOf(r).groups.find(([s]) => s === sid);
      return g ? draftOrder(r, sid, st.sups[sid], g[1], bashoText(r)) : null;
    };
    if (d.gcopy) {
      const dr = draftFor(d.gcopy);
      if (!dr) return;
      const text = orderText(dr);
      const fb = w.querySelector(`[data-gfb="${CSS.escape(d.gcopy)}"]`);
      fb.hidden = false;
      fb.querySelector("textarea").value = text;
      try {
        await navigator.clipboard.writeText(text);
        toast("注文の文をコピーしました。LINE やメールにはりつけられます");
      } catch (ex) {
        fb.querySelector("textarea").select();
        toast("コピーできませんでした。下の文を選んでコピーしてください");
      }
    } else if (d.gorder) {
      const dr = draftFor(d.gorder);
      if (!dr) return;
      t.disabled = true;
      t.textContent = "しまっています…";
      try {
        await placeOrder(r, dr, me);
      } catch (ex) {
        t.disabled = false;
        t.textContent = "注文した";
        throw ex;
      }
      toast(`${dr.supplierName} に注文しました（材料がまだ届いていない に入りました）`);
    } else if (d.ocancel) {
      const box = w.querySelector(`#ocx-${CSS.escape(d.ocancel)}`);
      box.className = "confirm";
      box.innerHTML = `<p class="confirm-q">この注文を取り消して、品物を依頼にもどしますか？</p>
        <div class="confirm-btns"><button type="button" class="btn danger" data-ocyes="${esc(d.ocancel)}">取り消す</button><button type="button" class="btn" data-ocno>やめる</button></div>`;
      box.scrollIntoView({ block: "nearest" });
    } else if ("ocno" in d) {
      openReq(st.openId, true);
    } else if (d.ocyes) {
      const o = (st.orders || []).find(x => x.id === d.ocyes);
      if (!o) return;
      t.disabled = true;
      t.textContent = "取り消しています…";
      try {
        await cancelOrder(o, r, me);
      } catch (ex) {
        t.disabled = false;
        t.textContent = "取り消す";
        throw ex;
      }
      toast(`${o.supplierName} への注文を取り消しました。品物は依頼にもどりました`);
    }
  }

  /** データが変わったら、出している中身もかきなおす（見ていた場所のまま。えらびかけの材料屋はのこす） */
  function refreshPanel() {
    const sh = document.getElementById("sheet");
    if (!st.openId || !sh || sh.hidden || !document.getElementById("reqWrap")) return;
    const a = document.activeElement;
    if (a && a.closest && a.closest("#reqWrap") && a.matches("select, textarea")) return;   // えらんでいる途中はかきなおさない
    openReq(st.openId, true);
  }

  /* ---------- 押したとき（一覧） ---------- */
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
    if (c && e.target === c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openReq(c.dataset.req); }
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
    refreshPanel();
  });
  onValue(ref(db, "zairyo/orders"), s => {
    st.orders = Object.entries(s.val() || {}).map(([id, o]) => ({ id, ...o }));
    draw();
    refreshPanel();
  }, ex => { st.orders = []; toast("注文を読めませんでした（" + errorText(ex) + "）"); });
  onValue(ref(db, "zairyo/master/catalog"), s => { st.catalog = normCatalog(s.val()); });
  onValue(ref(db, "zairyo/master/suppliers"), s => { st.sups = s.val() || {}; refreshPanel(); });
  onValue(ref(db, "zairyo/master/places"), s => { st.places = s.val() || {}; });

  draw();
}
