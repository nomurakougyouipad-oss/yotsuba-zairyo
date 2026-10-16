// 現場のスマホ：登録ずみの画面（たのむ → カート → 送る／送ったもの）
// - たのむ：種類のタブ（2段で全部見せる）→ 品物のタイル → 下から出る画面で寸法・数 → カートに入れる
// - カート：この端末にしまう。なおす・けす。どの工事・いつ・どこ・材料屋に連絡したか・メモ も、いっしょにしまう
// - 送る：/zairyo/requests に入れる（ルールで、自分の名前・自分の端末・新しく作るだけ、をたしかめる）
// - 送ったもの：自分の名前の依頼だけ読む（ルールで、chumonsha が自分の名前の問い合わせだけ通す）。
//   事務所がまだ注文していない（ordered がない）あいだは「取り消す」ができる。消さずに status を "cancelled" にする
// - ★いつもの：自分が送った品物を、多い順に（取り消したものは数えない）
// - 進み具合（注文した・届いた）と金額は、11章 5 で事務所の注文ができてから出す
import { ref, onValue, push, update, query, orderByChild, equalTo, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { $, esc, zenkana, toast, runChecks, checkRow, openSheet, closeSheet, loadDraft, clearDraft } from "./common.js";
import { errorText } from "./touroku.js";
import { watchJobs } from "./nippo.js";
import { jobPicker } from "./kouji.js";
import { normCatalog, openItem, buildSpec, lineText, loadCart, saveCart, newForm, fmtQty, ymd, kibouText } from "./tanomu.js";
import { yen, linePrice, priceText, reqMoney, deliverPlan } from "./chumon.js";
import { attachHTML, fillPhotos, deletePhoto, openWebSearch } from "./shashin.js";

const CAT_KEY = "yotsuba-zairyo-cat";   // さいごに見た種類（この端末だけ）
const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999);
const pad = n => String(n).padStart(2, "0");
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const linesOf = r => Object.values(r.lines || {});
const isCancelled = r => r.status === "cancelled";

/** 依頼の進み具合。os = この依頼から事務所が作った注文（取り消した注文は数えない） */
function progress(r, os = []) {
  if (isCancelled(r)) return { step: 0, label: r.cancelledBy ? "事務所が取り消した" : "取り消した" };   // 事務所が取り消したときは cancelledBy がある（10/14）
  const act = os.filter(o => o.status !== "cancelled");
  if (!act.length) return { step: 1, label: "事務所で確認中" };
  const names = [...new Set(act.map(o => o.supplierName))].join("・");
  const orderedAt = Math.min(...act.map(o => o.orderedAt || Infinity));
  const arrived = act.filter(o => o.status === "arrived" || o.status === "billed");
  // 全部注文して、その注文が全部届いたら「届いた」
  if (r.status === "ordered" && arrived.length === act.length) {
    return { step: 3, label: `届いた（${r.basho || "届け先"}）`, orderedAt, arrivedAt: Math.max(...arrived.map(o => o.arrivedAt || 0)) };
  }
  const label = r.status !== "ordered" ? "一部を注文した" : arrived.length ? "一部が届いた" : "事務所が注文した";
  // 材料屋がアプリで受けた注文は「○日に届く予定」（2回目・2-3）。いくつもあるときは、いちばんおそい日
  const plans = act.filter(o => deliverPlan(o)).map(o => o.deliverDate).sort();
  return { step: 2, label: `${label}（${names}）${plans.length ? `・${kibouText(plans[plans.length - 1])} 届く予定` : ""}`, orderedAt };
}
/** 品物ごとのようす */
function lineStatus(l, os, r) {
  const o = l.orderId && os.find(x => x.id === l.orderId && x.status !== "cancelled");
  if (!o) return { cls: "s1", text: "事務所で確認中" };
  if (o.status === "arrived" || o.status === "billed") return { cls: "s3", text: `届いた（${r.basho || o.basho || "届け先"}）` };
  return { cls: "s2", text: `注文ずみ（${o.supplierName}）・${deliverPlan(o) ? `${deliverPlan(o)} に届く予定` : "まだ届いていない"}` };
}

export function startGenbaApp(main, me) {
  const st = {
    tab: "tanomu", cat: "", catalog: null, jobs: null, kaisha: {}, places: null, sups: null,
    cart: loadCart(), sending: false, last: null,
    reqs: null,   // 自分が送った依頼 [{id, …}]（新しい順）
    orders: [],   // 自分の依頼から事務所が作った注文
  };
  const ordersFor = reqId => st.orders.filter(o => o.reqId === reqId);
  let picker = null, nippoRow = null, askDel = "";
  let catChosen = false;   // 種類のタブを自分でえらんだか（えらんでいなければ、★いつもの があればそれを出す）
  try { st.cat = localStorage.getItem(CAT_KEY) || ""; catChosen = !!st.cat; } catch (err) { }

  main.innerHTML = `
    <div class="g-tools"><button type="button" class="btn websearch" id="webBtn">🔍 ネットでさがす</button></div>
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
  /** ★いつもの：自分が送った品物（品物・品名・メモが同じものをまとめる）を、多い順に12こまで */
  function favList() {
    if (!st.catalog || !st.reqs) return [];
    const m = new Map();
    // 古い順に見て、数・単位は「いちばん新しいとき」のものにする
    for (const r of st.reqs.slice().reverse()) {
      if (isCancelled(r)) continue;
      for (const l of linesOf(r)) {
        const it = st.catalog.item.get(l.key);
        if (!it) continue;   // 品物一覧から消えた品物は出さない
        const spec = buildSpec(it, l.vals || {});
        const k = `${l.key}|${spec}|${l.note || ""}`;
        const cur = m.get(k);
        if (cur) Object.assign(cur, { n: cur.n + 1, qty: l.qty, unit: l.unit, at: r.sentAt });
        else m.set(k, { key: l.key, vals: { ...(l.vals || {}) }, note: l.note || "", qty: l.qty, unit: l.unit, n: 1, spec, catName: it.catName, at: r.sentAt });
      }
    }
    return [...m.values()].sort((a, b) => b.n - a.n || b.at - a.at).slice(0, 12);
  }

  function tanomuHTML() {
    if (!st.catalog) return '<p class="muted">品物の一覧を読んでいます…</p>';
    const cats = st.catalog.cats;
    if (!cats.length) return '<p class="warn">品物の一覧が、まだありません。事務所に知らせてください。</p>';
    const favs = favList();
    if (!catChosen && favs.length) st.cat = "fav";
    if (!(st.cat === "fav" && favs.length) && !cats.some(c => c.id === st.cat)) st.cat = favs.length ? "fav" : cats[0].id;
    const tabs = `
      <div class="cats" role="tablist" aria-label="物の種類">
        ${favs.length ? `<button type="button" role="tab" data-cat="fav" aria-selected="${st.cat === "fav"}">★<wbr>いつもの</button>` : ""}
        ${cats.map(c => `<button type="button" role="tab" data-cat="${esc(c.id)}" aria-selected="${c.id === st.cat}">${esc(c.name).replace(/・/g, "・<wbr>")}</button>`).join("")}
      </div>`;
    if (st.cat === "fav") {
      return tabs + `
        <p class="hint">${esc(me.name)}さんが前に送った物です。押すと同じ内容が出てくるので、数を直してカートに入れられます。</p>
        <div class="favs">${favs.map((f, i) => `
          <button type="button" class="fav" data-fav="${i}">
            <span class="f-spec">${esc(f.spec + (f.note ? " " + f.note : ""))}</span>
            <span class="f-meta">${esc(f.catName)}・前回 ${esc(fmtQty(f.qty))}${esc(f.unit)}・${f.n}回</span>
            <span class="f-add" aria-hidden="true">＋</span>
          </button>`).join("")}</div>`;
    }
    const cat = cats.find(c => c.id === st.cat);
    return tabs + `
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
          <span class="cl-spec">${esc(l.spec)}${l.note ? `<span class="cl-note">${esc(l.note)}</span>` : ""}${(l.photos && l.photos.length) || l.link
            ? `<span class="cl-note">${[l.photos && l.photos.length ? `写真${l.photos.length}枚` : "", l.link ? "リンクあり" : ""].filter(Boolean).join("・")}</span>` : ""}</span>
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
      recent: recentMap,
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

  /** 自分が最近たのんだ工事 {注番: {mine: 日時}}（「どの工事？」の並びに使う。取り消したものは入れない） */
  function recentMap() {
    const m = {};
    for (const r of st.reqs || []) {
      if (isCancelled(r) || !r.sentAt) continue;
      const at = new Date(r.sentAt).toISOString();
      if (!m[r.chuban] || at > m[r.chuban].mine) m[r.chuban] = { mine: at };
    }
    return m;
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
      if (l.photos && l.photos.length) lines[l.uid].photos = l.photos;
      if (l.link) lines[l.uid].link = l.link;
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

  /* ---------- 送ったもの ---------- */
  function sentHTML() {
    const list = st.reqs === null ? '<p class="muted">読んでいます…</p>'
      : !st.reqs.length ? `<p class="empty">${esc(me.name)}さんが送った注文は、まだありません。</p>`
      : st.reqs.map(r => {
        const pg = progress(r, ordersFor(r.id)), ls = linesOf(r);
        return `
          <button type="button" class="sent${isCancelled(r) ? " cx" : ""}${pg.step >= 3 ? " got" : ""}" data-sent="${esc(r.id)}">
            <span class="sent-top"><span>${md(r.sentAt)} ${hm(r.sentAt)} に送った</span><span>${ls.length}点</span></span>
            <span class="kouji"><span class="chuban">${esc(r.chuban)}</span><span class="kenmei">${esc(zenkana(r.kenmei))}</span></span>
            <span class="items">${esc(ls.map(lineText).join("\n"))}</span>
            <span class="sent-st s${pg.step}">${esc(pg.label)}</span>
            ${(() => { const mo = reqMoney(r, ordersFor(r.id)); return !isCancelled(r) && mo.anyKnown
              ? `<span class="sent-money">金額 <b class="num">${yen(mo.total)}</b>円（税抜）${mo.allKnown ? "" : '<span class="hint">　ほかはまだ</span>'}</span>` : ""; })()}
          </button>`;
      }).join("");
    return `
      <div class="sents">${list}</div>
      <details class="block hidbox"><summary>つながりのたしかめ</summary><ul class="checks" id="checks"></ul></details>`;
  }

  /** 金額（税抜）：材料屋ごとの材料費と合計。事務所が納品書・請求書から入れたもの */
  function moneyHTML(r, os) {
    if (isCancelled(r)) return "";
    const mo = reqMoney(r, os);
    if (!mo.per.length) return "";
    return `
      <div class="block"><h3>金額（税抜）</h3><dl class="dl yenlist">
        ${mo.per.map(x => `<dt>${esc(x.sup)}</dt><dd>${x.amount != null ? `<b class="num">${yen(x.amount)}</b>円` : `<span class="hint">まだ（${x.status === "wait" ? "届いていない" : "納品書の金額待ち"}）</span>`}</dd>`).join("")}
        ${mo.per.length > 1 && mo.anyKnown ? `<dt>合計</dt><dd><b class="num big">${yen(mo.total)}</b>円${mo.allKnown ? "" : '<span class="hint">　ほかはまだ</span>'}</dd>` : ""}
      </dl><p class="hint">金額は、事務所が納品書や請求書から入れたものです。</p></div>`;
  }

  /** 送ったものの中身（下から出る）。事務所がまだ注文していなければ「取り消す」 */
  function openSent(id) {
    const r = (st.reqs || []).find(x => x.id === id);
    if (!r) return;
    const os = ordersFor(r.id), pg = progress(r, os), ls = linesOf(r);
    const canCancel = !isCancelled(r) && !r.ordered;
    const steps = [["送った", r.sentAt, pg.step >= 1], ["注文した", pg.orderedAt, pg.step >= 2], ["届いた", pg.arrivedAt, pg.step >= 3]];
    const html = `
      <div class="pw" id="sentWrap">
        <div class="panel-head"><div><span class="eyebrow">送ったもの　${md(r.sentAt)} ${hm(r.sentAt)}</span>
          <h2 id="panelTitle"><span class="chuban big">${esc(r.chuban)}</span></h2><span class="kenmei">${esc(zenkana(r.kenmei))}</span></div>
          <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
        ${isCancelled(r)
          ? `<div class="block"><p class="warn">${r.cancelledAt ? `${md(r.cancelledAt)} ${hm(r.cancelledAt)} に` : ""}${r.cancelledBy ? "事務所が" : ""}取り消しました${r.cancelReason ? `（理由：${esc(r.cancelReason)}）` : ""}</p></div>`
          : `<div class="block">
              <ol class="steps" style="--c:${pg.step >= 3 ? "var(--blue)" : "var(--amber)"}">${steps.map(([l, d, done]) => `<li class="${done ? "done" : ""}">${l}<span class="d">${done && d ? md(d) : ""}</span></li>`).join("")}</ol>
              <p class="center"><b>${esc(pg.label)}</b></p>
            </div>`}
        ${Object.keys(r.log || {}).length ? `<div class="block"><h3>事務所の記録</h3><ul class="loglist">${Object.values(r.log).filter(Boolean).sort((a, b) => (a.at || 0) - (b.at || 0)).map(x => `<li><span class="num">${x.at ? `${md(x.at)} ${hm(x.at)}` : ""}</span> ${esc(x.what || "")}</li>`).join("")}</ul></div>` : ""}
        <div class="block"><h3>品物</h3>
          <ul class="slines">${Object.entries(r.lines || {}).map(([lid, l]) => {
            const s = lineStatus(l, os, r), lp = linePrice(l, lid, os);
            return `<li><span>${esc(lineText(l))}</span>${isCancelled(r) ? "" : `<span class="st ${s.cls}">${esc(s.text)}</span>`}${lp ? `<span class="lp">${esc(priceText(lp))}</span>` : ""}</li>`;
          }).join("")}</ul>
        </div>
        ${attachHTML(r.lines)}
        ${moneyHTML(r, os)}
        <div class="block"><dl class="dl">
          <dt>いつほしい</dt><dd>${esc(kibouText(r.kibou))}</dd>
          <dt>届け先</dt><dd>${esc(r.basho || "—")}</dd>
          ${r.contactedName ? `<dt>連絡ずみ</dt><dd>${esc(r.contactedName)}</dd>` : ""}
          ${r.memo ? `<dt>メモ</dt><dd>${esc(r.memo)}</dd>` : ""}
        </dl></div>
        ${canCancel ? `
          <div class="cx-start" id="cxRow">
            <button type="button" class="btn danger full" id="cxBtn">この注文を取り消す</button>
            <span class="hint center">事務所が注文する前なら、取り消せます</span>
          </div>` : ""}
        <p class="err" id="cxErr" role="alert"></p>
      </div>`;
    openSheet(html, p => {
      const w = p.querySelector("#sentWrap");
      fillPhotos(w);
      w.addEventListener("click", async e => {
        const row = w.querySelector("#cxRow");
        if (e.target.id === "cxBtn") {
          // 1行目に文字、2行目に大きいボタン2つ
          row.className = "confirm";
          row.innerHTML = `<p class="confirm-q">本当に取り消しますか？</p>
            <div class="confirm-btns"><button type="button" class="btn danger" id="cxYes">取り消す</button><button type="button" class="btn" id="cxNo">やめる</button></div>`;
          row.scrollIntoView({ block: "nearest" });
          row.querySelector("#cxNo").focus({ preventScroll: true });
        } else if (e.target.id === "cxNo") {
          openSent(id);
        } else if (e.target.id === "cxYes") {
          e.target.disabled = true;
          e.target.textContent = "取り消しています…";
          try {
            await update(ref(db, `zairyo/requests/${id}`), { status: "cancelled", cancelledAt: serverTimestamp() });
            closeSheet();
            toast("注文を取り消しました");
          } catch (ex) {
            // 事務所がちょうど注文したときなどは、ルールで止まる
            w.querySelector("#cxErr").textContent = "取り消せませんでした。事務所がもう注文したかもしれません。事務所に知らせてください（" + errorText(ex) + "）";
            e.target.disabled = false;
            e.target.textContent = "取り消す";
          }
        }
      });
    });
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

  /** カートに入れる（品物・★いつもの・ネットでさがす から） */
  function addLine(line) {
    st.cart.lines.push(line);
    saveCart(st.cart);
    draw();
    toast(`カートに入れました（${st.cart.lines.length}点）`);
  }
  /** カートの行をなおしたとき */
  const editLine = l => nl => { Object.assign(l, nl); saveCart(st.cart); draw(); toast("なおしました"); };

  /** ネットでさがす。見つけた物は「自由に書く」に品名を入れて開く（スクショをつけて、カートへ） */
  function openWeb(q0) {
    openWebSearch(q => {
      const free = st.catalog && ([...st.catalog.item.values()].find(x => x.key === "tool:free") || [...st.catalog.item.values()].find(x => x.free));
      if (!free) { toast("「自由に書く」が品物一覧にありません。事務所に知らせてください"); return; }
      openItem(st.catalog, free.key, { vals: { __free: q }, qty: 1, unit: free.unit || "個", note: "" }, addLine);
    }, q0);
  }

  /** 開きなおしたとき、書きかけ（品物の画面・ネットでさがす）があれば、その画面にそのままもどす */
  function restoreDraft() {
    const dr = loadDraft();
    if (!dr) return;
    if (dr.kind === "web") return openWeb(dr.q || "");
    if (dr.kind !== "item") return clearDraft();
    if (dr.editUid) {
      const l = st.cart.lines.find(x => x.uid === dr.editUid);
      if (!l) return clearDraft();   // なおしていたカートの行が、もうない
      return openItem(st.catalog, l.key, l, editLine(l), dr);
    }
    openItem(st.catalog, dr.key, null, addLine, dr);
  }

  /* ---------- 押したとき ---------- */
  main.addEventListener("click", e => {
    const t = e.target.closest("[data-gtab],[data-cat],[data-item],[data-fav],[data-sent],[data-cedit],[data-cdel],[data-kibou],[data-basho],[data-contact],[data-csup],#sendBtn,#webBtn");
    if (!t || t.disabled) return;
    const d = t.dataset, f = st.cart.form;
    if (d.gtab) {
      st.tab = d.gtab;
      askDel = "";
      draw();
      window.scrollTo(0, 0);
    } else if (d.cat) {
      st.cat = d.cat;
      catChosen = true;
      try { localStorage.setItem(CAT_KEY, st.cat); } catch (err) { }
      draw();
    } else if (d.item) {
      openItem(st.catalog, d.item, null, addLine);
    } else if (t.id === "webBtn") {
      openWeb();
    } else if (d.fav) {
      const f = favList()[Number(d.fav)];
      if (f) openItem(st.catalog, f.key, { vals: f.vals, qty: f.qty, unit: f.unit, note: f.note }, addLine);
    } else if (d.sent) {
      openSent(d.sent);
    } else if (d.cedit) {
      const l = st.cart.lines.find(x => x.uid === d.cedit);
      if (l) openItem(st.catalog, l.key, l, editLine(l));
    } else if (d.cdel) {
      if (askDel !== d.cdel) { askDel = d.cdel; draw(); return; }   // けすときは2回押す
      askDel = "";
      const gone = st.cart.lines.find(x => x.uid === d.cdel);
      (gone && gone.photos || []).forEach(deletePhoto);
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
    const first = !st.catalog;
    st.catalog = normCatalog(s.val());
    if (st.tab === "tanomu") draw();
    if (first) restoreDraft();   // 品物一覧を読んでから、書きかけの画面にもどす
  }, ex => toast(errorText(ex)));
  onValue(ref(db, "zairyo/master/places"), s => { st.places = s.val() || {}; if (st.tab === "cart" && !st.sending) draw(); });
  onValue(ref(db, "zairyo/master/suppliers"), s => { st.sups = s.val() || {}; if (st.tab === "cart" && !st.sending) draw(); });
  // 注番の頭の2文字の会社名（台帳ぜんたいの表 /common/kaisha）
  onValue(ref(db, "common/kaisha"), s => { st.kaisha = s.val() || {}; if (picker && st.jobs) picker.setJobs(st.jobs); });
  watchJobs(d => { st.jobs = d; if (picker) picker.setJobs(d); showNippo(); }, ex => showNippo(ex));
  // 自分が送った依頼（ルールで、この問い合わせだけ通す）
  onValue(query(ref(db, "zairyo/requests"), orderByChild("chumonsha"), equalTo(me.name)), s => {
    st.reqs = Object.entries(s.val() || {}).map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    if (st.tab === "sent" || st.tab === "tanomu") draw();
  }, ex => { st.reqs = []; toast("送ったものを読めませんでした（" + errorText(ex) + "）"); });
  // 自分の依頼から事務所が作った注文（ルールで、この問い合わせだけ通す）。読めないときは「事務所で確認中」のまま
  onValue(query(ref(db, "zairyo/orders"), orderByChild("chumonsha"), equalTo(me.name)), s => {
    st.orders = Object.entries(s.val() || {}).map(([id, o]) => ({ id, ...o }));
    if (st.tab === "sent") draw();
  }, () => { st.orders = []; });

  draw();
}
