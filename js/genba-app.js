// 現場のスマホ：登録ずみの画面（たのむ → カート → 送る／送ったもの）
// - たのむ：種類のタブ（2段で全部見せる）→ 品物のタイル → 下から出る画面で寸法・数 → カートに入れる
// - カート：この端末にしまう。なおす・けす。「どの工事？」もここでえらぶ（えらんだ工事もカートといっしょにしまう）
// - 送る（いつ・どこ・材料屋に連絡したか・メモ）は 11章 4-3、送ったものは 4-4、★いつもの は送ったものができてから
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { $, esc, toast, runChecks, checkRow } from "./common.js";
import { errorText } from "./touroku.js";
import { watchJobs } from "./nippo.js";
import { jobPicker } from "./kouji.js";
import { normCatalog, openItem, loadCart, saveCart, fmtQty } from "./tanomu.js";

const CAT_KEY = "yotsuba-zairyo-cat";   // さいごに見た種類（この端末だけ）

export function startGenbaApp(main, me) {
  const st = { tab: "tanomu", cat: "", catalog: null, jobs: null, kaisha: {}, cart: loadCart() };
  let picker = null, nippoRow = null, askDel = "";
  try { st.cat = localStorage.getItem(CAT_KEY) || ""; } catch (err) { }

  main.innerHTML = `
    <div class="ph-tabs" role="tablist" aria-label="画面">
      <button type="button" role="tab" data-gtab="tanomu">たのむ</button>
      <button type="button" role="tab" data-gtab="sent">送ったもの</button>
    </div>
    <div id="gBody" class="stack"></div>
    <div id="cartBar" class="cartbar" hidden></div>`;
  const body = $("#gBody", main), bar = $("#cartBar", main);

  function draw() {
    const shown = st.tab === "cart" ? "tanomu" : st.tab;
    main.querySelectorAll(".ph-tabs [data-gtab]").forEach(b => b.setAttribute("aria-selected", b.dataset.gtab === shown));
    picker = null;
    nippoRow = null;
    if (st.tab === "tanomu") body.innerHTML = tanomuHTML();
    else if (st.tab === "cart") { body.innerHTML = cartHTML(); mountPicker(); }
    else { body.innerHTML = sentHTML(); mountChecks(); }
    bar.hidden = st.tab !== "tanomu";
    bar.innerHTML = barHTML();
  }

  /* ---------- たのむ ---------- */
  function tanomuHTML() {
    if (!st.catalog) return '<p class="muted">品物の一覧を読んでいます…</p>';
    const cats = st.catalog.cats;
    if (!cats.length) return '<p class="warn">品物の一覧が、まだありません。事務所に知らせてください。</p>';
    if (!cats.some(c => c.id === st.cat)) st.cat = cats[0].id;
    const cat = cats.find(c => c.id === st.cat);
    return `
      <div class="cats" role="tablist" aria-label="物の種類">
        ${cats.map(c => `<button type="button" role="tab" data-cat="${esc(c.id)}" aria-selected="${c.id === st.cat}">${esc(c.name).replace(/・/g, "・<wbr>")}</button>`).join("")}
      </div>
      <div class="tiles">${cat.items.map(it => {
        const key = `${cat.id}:${it.id}`, n = st.cart.lines.filter(l => l.key === key).length;
        return `
          <button type="button" class="tile" data-item="${esc(key)}">
            <span class="t-name">${esc(it.name).replace(/・/g, "・<wbr>")}</span>
            <span class="t-sub">${esc(it.sub || "")}</span>
            ${n ? `<span class="t-in" aria-label="カートに${n}点">${n}</span>` : ""}
          </button>`;
      }).join("")}</div>`;
  }

  function barHTML() {
    const n = st.cart.lines.length;
    return n
      ? `<span class="cb-count"><span>カート</span><span class="num">${n}</span><span>点</span></span>
         <button type="button" class="btn primary big" data-gtab="cart">注文に進む</button>`
      : `<span class="cb-empty">品物をえらんで、カートに入れてください</span>
         <button type="button" class="btn primary" disabled>注文に進む</button>`;
  }

  /* ---------- カート ---------- */
  function cartHTML() {
    const lines = st.cart.lines;
    if (!lines.length) {
      return `<button type="button" class="back" data-gtab="tanomu">‹ 品物をえらぶ</button>
        <p class="empty">カートは空です。<br>「たのむ」から品物をえらんでください。</p>`;
    }
    return `
      <button type="button" class="back" data-gtab="tanomu">‹ 品物をえらぶ にもどる</button>
      <h2 class="h-cart">カートの中身（${lines.length}点）</h2>
      <ul class="cartlist">${lines.map(l => `
        <li>
          <span class="cl-spec">${esc(l.spec)}${l.note ? `<span class="cl-note">${esc(l.note)}</span>` : ""}</span>
          <span class="cl-qty">${esc(fmtQty(l.qty))}<small>${esc(l.unit)}</small></span>
          <span class="cl-act">
            <button type="button" class="linkbtn" data-cedit="${esc(l.uid)}">なおす</button>
            <button type="button" class="linkbtn muted" data-cdel="${esc(l.uid)}">${askDel === l.uid ? "もう一度押すとけします" : "けす"}</button>
          </span>
        </li>`).join("")}</ul>
      <section class="card"><div id="kouji"></div></section>
      <p class="hint">このあと「いつ・どこに届ける・材料屋に連絡したか・メモ」を足して、送れるようにします（次に作ります）。</p>
      <button type="button" class="btn primary big full" disabled>送る（次に作ります）</button>`;
  }

  function mountPicker() {
    const el = $("#kouji", body);
    if (!el) return;
    picker = jobPicker(el, {
      me: me.name,
      kaishaName: ch => (st.kaisha[String(ch).slice(0, 2)] || {}).name || "",
      value: st.cart.job || undefined,
      onChange: v => { st.cart.job = v; saveCart(st.cart); },
    });
    if (st.jobs) picker.setJobs(st.jobs);
  }

  /* ---------- 送ったもの（4-4 で作る） ---------- */
  function sentHTML() {
    return `
      <section class="card"><h2>送ったもの</h2><p class="muted">送った注文は、ここに出ます（「送る」ができたら）。</p></section>
      <section class="card"><h2>つながりのたしかめ</h2><ul class="checks" id="checks"></ul></section>`;
  }
  function mountChecks() {
    const list = $("#checks", body);
    runChecks(list, { sw: true });
    nippoRow = checkRow(list, "日報の注番を読める");
    showNippo();
  }
  function showNippo(err) {
    if (!nippoRow) return;
    if (err) nippoRow("bad", "読めません（" + errorText(err) + "）");
    else if (st.jobs) nippoRow("ok", `えらべる工事 ${st.jobs.open.length}件・工場で使う物 ${st.jobs.fixed.length}件`);
    else nippoRow("wait", "読んでいます…");
  }

  /* ---------- 押したとき ---------- */
  main.addEventListener("click", e => {
    const t = e.target.closest("[data-gtab],[data-cat],[data-item],[data-cedit],[data-cdel]");
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.gtab) {
      st.tab = d.gtab;
      askDel = "";
      draw();
      window.scrollTo(0, 0);
    } else if (d.cat) {
      st.cat = d.cat;
      try { localStorage.setItem(CAT_KEY, st.cat); } catch (err) { }
      draw();
    } else if (d.item) {
      openItem(st.catalog, d.item, null, line => {
        st.cart.lines.push(line);
        saveCart(st.cart);
        draw();
        toast(`カートに入れました（${st.cart.lines.length}点）`);
      });
    } else if (d.cedit) {
      const l = st.cart.lines.find(x => x.uid === d.cedit);
      if (l) openItem(st.catalog, l.key, l, nl => { Object.assign(l, nl); saveCart(st.cart); draw(); toast("なおしました"); });
    } else if (d.cdel) {
      if (askDel !== d.cdel) { askDel = d.cdel; draw(); return; }   // けすときは2回押す
      askDel = "";
      st.cart.lines = st.cart.lines.filter(x => x.uid !== d.cdel);
      saveCart(st.cart);
      draw();
      toast("けしました");
    }
  });

  /* ---------- データ ---------- */
  onValue(ref(db, "zairyo/master/catalog"), s => {
    st.catalog = normCatalog(s.val());
    if (st.tab === "tanomu") draw();
  }, ex => toast(errorText(ex)));
  // 注番の頭の2文字の会社名（台帳ぜんたいの表 /common/kaisha）
  onValue(ref(db, "common/kaisha"), s => { st.kaisha = s.val() || {}; if (picker && st.jobs) picker.setJobs(st.jobs); });
  watchJobs(d => { st.jobs = d; if (picker) picker.setJobs(d); showNippo(); }, ex => showNippo(ex));

  draw();
}
