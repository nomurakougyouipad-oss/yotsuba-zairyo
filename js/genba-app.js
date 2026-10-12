// 現場のスマホ：登録ずみの画面（たのむ → カート → 送る／送ったもの）
// - たのむ：種類のタブ（2段で全部見せる）→ 品物のタイル → 下から出る画面で寸法・数 → カートに入れる
// - カート：この端末にしまう。なおす・けす。どの工事・いつ・どこ・材料屋に連絡したか・メモ も、いっしょにしまう
// - 送る：/zairyo/requests に入れる（ルールで、自分の名前・自分の端末・新しく作るだけ、をたしかめる）
// - 送ったものは 11章 4-4、★いつもの は送ったものができてから
import { ref, onValue, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { $, esc, zenkana, toast, runChecks, checkRow } from "./common.js";
import { errorText } from "./touroku.js";
import { watchJobs } from "./nippo.js";
import { jobPicker } from "./kouji.js";
import { normCatalog, openItem, loadCart, saveCart, newForm, fmtQty, ymd, kibouText } from "./tanomu.js";

const CAT_KEY = "yotsuba-zairyo-cat";   // さいごに見た種類（この端末だけ）
const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999);

export function startGenbaApp(main, me) {
  const st = {
    tab: "tanomu", cat: "", catalog: null, jobs: null, kaisha: {}, places: null, sups: null,
    cart: loadCart(), sending: false, last: null,
  };
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
    const shown = st.tab === "cart" || st.tab === "done" ? "tanomu" : st.tab;
    main.querySelectorAll(".ph-tabs [data-gtab]").forEach(b => b.setAttribute("aria-selected", b.dataset.gtab === shown));
    picker = null;
    nippoRow = null;
    if (st.tab === "tanomu") body.innerHTML = tanomuHTML();
    else if (st.tab === "cart") { body.innerHTML = cartHTML(); mountPicker(); }
    else if (st.tab === "done") body.innerHTML = doneHTML();
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

  /* ---------- カートと送る ---------- */
  const placeList = () => Object.entries(st.places || {}).filter(([, p]) => !p.hidden).sort(byOrder);
  const supList = () => Object.entries(st.sups || {}).filter(([, s]) => !s.hidden).sort(byOrder);
  /** 届け先：えらんでいなければ、いちばん上（並び順のはじめ） */
  function bashoId() {
    const list = placeList(), f = st.cart.form;
    if (!list.some(([id]) => id === f.bashoId)) f.bashoId = list.length ? list[0][0] : "";
    return f.bashoId;
  }

  function cartHTML() {
    const lines = st.cart.lines, f = st.cart.form;
    if (!lines.length) {
      return `<button type="button" class="back" data-gtab="tanomu">‹ 品物をえらぶ</button>
        <p class="empty">カートは空です。<br>「たのむ」から品物をえらんでください。</p>`;
    }
    const today = ymd(0), tom = ymd(1);
    const custom = f.kibou !== "最短" && f.kibou !== today && f.kibou !== tom;
    const bid = bashoId();
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

      <section class="card"><div id="kouji"></div><p class="err" id="eJob"></p></section>

      <section class="card ph-sec"><h3>いつほしい？</h3>
        <div class="pick" id="kibouPick">
          <button type="button" data-kibou="最短" aria-pressed="${f.kibou === "最短"}">最短</button>
          <button type="button" data-kibou="${today}" aria-pressed="${f.kibou === today}">今日</button>
          <button type="button" data-kibou="${tom}" aria-pressed="${f.kibou === tom}">あした</button>
          <button type="button" data-kibou="__date" aria-pressed="${custom}">${custom ? esc(kibouText(f.kibou)) : "日付をえらぶ"}</button>
        </div>
        <input id="cDate" class="inp" type="date" min="${today}" aria-label="ほしい日" hidden>
      </section>

      <section class="card ph-sec"><h3>どこに届ける？</h3>
        <div class="pick grid2" id="bashoPick">${st.places === null ? '<p class="muted">読んでいます…</p>'
          : placeList().map(([id, p]) => `<button type="button" data-basho="${esc(id)}" aria-pressed="${id === bid}">${esc(p.name)}</button>`).join("")}</div>
      </section>

      <section class="card ph-sec"><h3>材料屋にもう連絡した？</h3>
        <div class="pick grid2">
          <button type="button" data-contact="no" aria-pressed="${!f.contactOn}">まだ（事務所におまかせ）</button>
          <button type="button" data-contact="yes" aria-pressed="${f.contactOn}">電話などで連絡した</button>
        </div>
        <div id="contactSup" class="ph-sec"${f.contactOn ? "" : " hidden"}>
          <span class="jobs-label">どこに連絡しましたか？</span>
          <div class="pick">${supList().map(([id, s]) => `<button type="button" data-csup="${esc(id)}" aria-pressed="${f.contacted === id}">${esc(s.name)}</button>`).join("")}</div>
        </div>
        <p class="err" id="eContact"></p>
      </section>

      <section class="card ph-sec"><h3>メモ（あれば）</h3>
        <textarea id="cMemo" class="inp ta" rows="2" maxlength="500" placeholder="例　ミルシートお願いします">${esc(f.memo)}</textarea>
      </section>

      <p class="err" id="eSend" role="alert"></p>
      <button type="button" class="btn primary big full" id="sendBtn"${st.sending ? " disabled" : ""}>${st.sending ? "送っています…" : "事務所に送る"}</button>
      <p class="hint center">送ると、事務所が材料屋をえらんで注文します。</p>`;
  }

  function mountPicker() {
    const el = $("#kouji", body);
    if (!el) return;
    picker = jobPicker(el, {
      me: me.name,
      kaishaName: ch => (st.kaisha[String(ch).slice(0, 2)] || {}).name || "",
      value: st.cart.job || undefined,
      onChange: v => {
        st.cart.job = v;
        // 固定の注番（日報の常設）で、件名に届け先の名前が入っているとき（例：工場）は、届け先もそこにする
        const j = !v.typed && st.jobs && st.jobs.all.get(v.chuban);
        const p = j && j.fixed && placeList().find(([, x]) => j.kenmei.includes(x.name));
        if (p && st.cart.form.bashoId !== p[0]) { st.cart.form.bashoId = p[0]; paintPicks(); }
        const e = $("#eJob", body);
        if (e) e.textContent = "";
        saveCart(st.cart);
      },
    });
    if (st.jobs) picker.setJobs(st.jobs);
  }

  /** いつ・どこ・連絡のボタンだけ、えらんだ印をつけなおす（「どの工事？」をかきなおさないように） */
  function paintPicks() {
    const f = st.cart.form, today = ymd(0), tom = ymd(1);
    const custom = f.kibou !== "最短" && f.kibou !== today && f.kibou !== tom;
    body.querySelectorAll("[data-kibou]").forEach(b => {
      if (b.dataset.kibou === "__date") { b.setAttribute("aria-pressed", custom); b.textContent = custom ? kibouText(f.kibou) : "日付をえらぶ"; }
      else b.setAttribute("aria-pressed", b.dataset.kibou === f.kibou);
    });
    body.querySelectorAll("[data-basho]").forEach(b => b.setAttribute("aria-pressed", b.dataset.basho === f.bashoId));
    body.querySelectorAll("[data-contact]").forEach(b => b.setAttribute("aria-pressed", (b.dataset.contact === "yes") === f.contactOn));
    body.querySelectorAll("[data-csup]").forEach(b => b.setAttribute("aria-pressed", b.dataset.csup === f.contacted));
    const cs = $("#contactSup", body);
    if (cs) cs.hidden = !f.contactOn;
  }

  async function send() {
    const f = st.cart.form, e = id => $(id, body);
    ["#eJob", "#eContact", "#eSend"].forEach(id => { if (e(id)) e(id).textContent = ""; });
    const jobErr = picker ? picker.check() : "どの工事の材料か、えらんでください";
    if (jobErr) { e("#eJob").textContent = jobErr; e("#kouji").scrollIntoView({ block: "center" }); return; }
    if (f.contactOn && !(st.sups || {})[f.contacted]) { e("#eContact").textContent = "連絡した材料屋をえらんでください"; e("#eContact").scrollIntoView({ block: "center" }); return; }
    if (!st.cart.lines.length) return;

    const job = picker.value();
    const j = !job.typed && st.jobs ? st.jobs.all.get(job.chuban) : null;
    const place = (st.places || {})[bashoId()];
    const lines = {};
    for (const l of st.cart.lines) {
      lines[l.uid] = { key: l.key, cat: l.cat, name: l.name, vals: l.vals || {}, spec: l.spec, note: l.note || "", qty: Number(l.qty), unit: l.unit };
    }
    const req = {
      chumonsha: me.name,
      uid: auth.currentUser.uid,
      chuban: job.chuban,
      kenmei: j ? j.kenmei : job.kenmei,
      tantou: j ? j.tantou : "",
      typed: !!job.typed,
      kibou: f.kibou || "最短",
      basho: place ? place.name : "",
      bashoId: place ? bashoId() : "",
      contacted: f.contactOn ? f.contacted : "",
      contactedName: f.contactOn ? st.sups[f.contacted].name : "",
      memo: (f.memo || "").trim(),
      sentAt: serverTimestamp(),
      status: "sent",
      lines,
    };

    st.sending = true;
    const btn = e("#sendBtn");
    btn.disabled = true;
    btn.textContent = "送っています…";
    // 電波が弱いと、送り終わるまで時間がかかる（データベースが届いたと返すまで待つ）
    const slow = setTimeout(() => { if (st.sending && e("#sendBtn")) e("#sendBtn").textContent = "送っています…（電波が弱いようです。このまま待ってください）"; }, 6000);
    try {
      const r = await push(ref(db, "zairyo/requests"), req);
      st.last = { id: r.key, chuban: req.chuban, kenmei: req.kenmei, n: st.cart.lines.length };
      st.cart = { lines: [], job: null, form: newForm() };
      saveCart(st.cart);
      st.tab = "done";
      draw();
      window.scrollTo(0, 0);
    } catch (ex) {
      if (e("#eSend")) e("#eSend").textContent = "送れませんでした。" + errorText(ex);
      if (e("#sendBtn")) { e("#sendBtn").disabled = false; e("#sendBtn").textContent = "事務所に送る"; }
    } finally {
      clearTimeout(slow);
      st.sending = false;
    }
  }

  function doneHTML() {
    const r = st.last;
    return `
      <section class="card done-screen">
        <div class="ok" aria-hidden="true">✓</div>
        <h2>事務所に送りました</h2>
        ${r ? `<p><span class="chuban">${esc(r.chuban)}</span>　${esc(zenkana(r.kenmei))}<br>${r.n}点</p>` : ""}
        <p class="muted">事務所が材料屋に注文します。届いたら「送ったもの」で分かります。</p>
        <div class="btns">
          <button type="button" class="btn primary big" data-gtab="sent">送ったものを見る</button>
          <button type="button" class="btn big" data-gtab="tanomu">続けてたのむ</button>
        </div>
      </section>`;
  }

  /* ---------- 送ったもの（4-4 で作る） ---------- */
  function sentHTML() {
    return `
      <section class="card"><h2>送ったもの</h2><p class="muted">送った注文は、ここに出ます（次に作ります）。</p></section>
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
    else if (st.jobs) nippoRow("ok", `えらべる工事 ${st.jobs.open.length}件・固定の注番 ${st.jobs.fixed.length}件`);
    else nippoRow("wait", "読んでいます…");
  }

  /* ---------- 押したとき ---------- */
  main.addEventListener("click", e => {
    const t = e.target.closest("[data-gtab],[data-cat],[data-item],[data-cedit],[data-cdel],[data-kibou],[data-basho],[data-contact],[data-csup],#sendBtn");
    if (!t || t.disabled) return;
    const d = t.dataset, f = st.cart.form;
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
    } else if (d.kibou) {
      if (d.kibou === "__date") {
        const inp = $("#cDate", body);
        inp.hidden = false;
        inp.focus();
        if (inp.showPicker) { try { inp.showPicker(); } catch (err) { } }
        return;
      }
      f.kibou = d.kibou;
      $("#cDate", body).hidden = true;
      paintPicks();
      saveCart(st.cart);
    } else if (d.basho) {
      f.bashoId = d.basho;
      paintPicks();
      saveCart(st.cart);
    } else if (d.contact) {
      f.contactOn = d.contact === "yes";
      if (!f.contactOn) f.contacted = "";
      paintPicks();
      saveCart(st.cart);
    } else if (d.csup) {
      f.contacted = d.csup;
      $("#eContact", body).textContent = "";
      paintPicks();
      saveCart(st.cart);
    } else if (t.id === "sendBtn") {
      send();
    }
  });
  main.addEventListener("input", e => {
    if (e.target.id === "cMemo") { st.cart.form.memo = e.target.value; saveCart(st.cart); }
  });
  main.addEventListener("change", e => {
    if (e.target.id === "cDate" && e.target.value) {
      st.cart.form.kibou = e.target.value < ymd(0) ? ymd(0) : e.target.value;
      e.target.hidden = true;
      paintPicks();
      saveCart(st.cart);
    }
  });

  /* ---------- データ ---------- */
  onValue(ref(db, "zairyo/master/catalog"), s => {
    st.catalog = normCatalog(s.val());
    if (st.tab === "tanomu") draw();
  }, ex => toast(errorText(ex)));
  onValue(ref(db, "zairyo/master/places"), s => { st.places = s.val() || {}; if (st.tab === "cart" && !st.sending) draw(); });
  onValue(ref(db, "zairyo/master/suppliers"), s => { st.sups = s.val() || {}; if (st.tab === "cart" && !st.sending) draw(); });
  // 注番の頭の2文字の会社名（台帳ぜんたいの表 /common/kaisha）
  onValue(ref(db, "common/kaisha"), s => { st.kaisha = s.val() || {}; if (picker && st.jobs) picker.setJobs(st.jobs); });
  watchJobs(d => { st.jobs = d; if (picker) picker.setJobs(d); showNippo(); }, ex => showNippo(ex));

  draw();
}
