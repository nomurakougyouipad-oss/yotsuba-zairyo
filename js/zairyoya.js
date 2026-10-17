// 材料屋のアプリ（zairyoya.html・2回目）
// - 入り方：よつば建設工業の事務所から届いた専用リンク（zairyoya.html?k=鍵）で開く →
//   その材料屋の合言葉と、この端末の名前（だれの端末か）を入れて登録（最初の1回だけ）。端末は何台でも（10/14 持ち主）
// - 鍵は、ホーム画面に追加したアプリでも使えるように、住所の ?k= に入れる（iPhone はホーム画面のアプリと Safari で保存場所が別のため、
//   ホーム画面のアプリを開いてから登録する。そのとき鍵が住所に残っている必要がある）
// - 2-2：注文を見る（4つのタブ・注文の中身）。2-3：受けました・届ける日・届けました・事務所が直した／取り消した知らせ。2-4：金額を入れる（納品書の金額になる）。2-5：図面・写真のダウンロード。2-6：通知と、新しい・直した・取り消しの印
import { ref, query, orderByChild, equalTo, onValue, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, call } from "./firebase.js";
import { $, esc, zenkana, toast, initTheme, registerSW, openSheet } from "./common.js";
import { whoAmI, registerSup, errorText, isIPhoneBrowser } from "./touroku.js";
import { lineText, kibouText, fmtQty } from "./tanomu.js";
import { pushState, enablePush, disablePush, refreshPush, testPush } from "./tsuuchi.js";
import { yen, slipsOf, supAddSlip, supSeePrice } from "./chumon.js";
import { slipFormHTML, wireSlipForm, readSlipForm } from "./kingaku.js";
import { sizeText } from "./fairu.js";
import { openPhoto } from "./shashin.js";

initTheme();
registerSW();
const main = $("#main");
const KEY = new URLSearchParams(location.search).get("k") || new URLSearchParams(location.hash.slice(1)).get("k") || "";
start();

async function start() {
  main.innerHTML = '<section class="card"><p class="muted">しらべています…</p></section>';
  let me;
  try {
    me = await whoAmI();
  } catch (ex) {
    main.innerHTML = `<section class="card"><h2>つながりません</h2><p class="err">${esc(errorText(ex))}</p>
      <button class="btn big full" type="button" id="retry">もう一度</button></section>`;
    $("#retry").addEventListener("click", start);
    return;
  }
  if (me && me.role === "sup") return showHome(me);
  showCode(me);
}

const IPHONE_NOTE = `
  <section class="card notice">
    <h2>iPhone の方は、先にホーム画面に追加してください</h2>
    <ol class="steps">
      <li>［共有］ボタン（□から↑が出ている形）を押す</li>
      <li>「ホーム画面に追加」を押す</li>
      <li>ホーム画面にできた「よつば資材便」を開いて、そこで登録する</li>
    </ol>
    <p class="muted">Safari のまま登録すると、ホーム画面のアプリでは登録が消えてしまいます。</p>
  </section>`;

/** 合言葉と、この端末の名前を入れて登録する */
function showCode(me) {
  $("#who").textContent = "材料屋のアプリ";
  if (!KEY) {
    main.innerHTML = `
      <section class="card">
        <h2>専用リンクから開いてください</h2>
        <p class="muted">よつば建設工業の事務所から届いたリンク（LINE・メール）を押して開いてください。</p>
        ${me && me.removed ? '<p class="warn">この端末の登録は消されています。届いたリンクから、もう一度登録してください。</p>' : ""}
      </section>`;
    return;
  }
  main.innerHTML = `
    ${isIPhoneBrowser() ? IPHONE_NOTE : ""}
    <section class="card narrow-card">
      <span class="eyebrow">よつば建設工業さまからの注文を受けるアプリ</span>
      <h2>はじめての登録</h2>
      ${me && me.removed ? '<p class="warn">この端末の登録は消されています。もう一度登録してください。</p>' : ""}
      ${me && me.lost ? '<p class="warn">この端末に覚えていた登録が、消えていました。もう一度登録してください。</p>' : ""}
      ${me && (me.role === "genba" || me.role === "office") ? '<p class="warn">この端末は、よつば建設工業の社内の端末として登録されています。ここで登録すると、材料屋のアプリに変わります。</p>' : ""}
      <form id="codeForm" class="form" novalidate>
        <div class="field">
          <label for="code">合言葉</label>
          <input id="code" class="inp" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
          <p class="hint">よつば建設工業の事務所から聞いた合言葉です。</p>
        </div>
        <div class="field">
          <label for="devName">この端末の名前</label>
          <input id="devName" class="inp" type="text" maxlength="20" autocomplete="off" placeholder="例：山田のスマホ／事務所のパソコン">
          <p class="hint">だれの端末かが分かる名前にしてください。</p>
        </div>
        <p class="err" id="err" role="alert"></p>
        <button class="btn primary big full" type="submit" id="go">登録する</button>
      </form>
    </section>`;
  const go = $("#go"), err = $("#err");
  $("#codeForm").addEventListener("submit", async e => {
    e.preventDefault();
    const code = $("#code").value, name = $("#devName").value.trim();
    if (!code.trim()) { err.textContent = "合言葉を入れてください"; return; }
    if (!name) { err.textContent = "この端末の名前を入れてください"; return; }
    go.disabled = true;
    go.textContent = "登録しています…";
    err.textContent = "";
    try {
      await registerSup(KEY, code, name);
      start();
    } catch (ex) {
      err.textContent = errorText(ex);
      go.disabled = false;
      go.textContent = "登録する";
    }
  });
}

/* ==================== 2-2：注文を見る・2-3：受ける・届ける（10/16） ====================
   - 自分あての注文（supplier ＝ この端末の材料屋）を読む（ルールで、ほかの材料屋の注文・依頼・事務所の設定は読めない）
   - 事務所が「アプリに送る」を押した注文だけ出す（supState がある注文。持ち主 B）
   - タブは、つぎに何をするかの名前（持ち主の案）：① 受ける／② 届ける／③ 金額を入れる／終わった（件数つき）
   - 2-3：「受けました」（届ける日を入れる）→ ② 届ける。「届ける日を変える」。「届けました」→ ③ 金額を入れる。
     「届けました」で、よつば建設工業の「届いた」にもなる（持ち主 3A）。書けるのは決まった欄だけ（ルール）
   - 事務所が直した・取り消した注文は、「わかりました」を押すまで ① 受ける に印つきで出す
   - 2-4：「③ 金額を入れる」で、品物ごとの単価（Kg・¥/kg でも）と合計を入れて送る → よつば建設工業の「納品書の金額」（材料屋が入れた の印）。
     事務所が先に納品書の金額を入れていたら、入れずに、金額をたしかめて「わかりました」（持ち主 3A）。送ったあとは直せない（電話。持ち主 2A）
   - 2-5：図面・写真は、サーバーの係（zairyoSupFiles）が「自分あての注文か・取り消しでないか」を調べてから渡すリンクで出す。
     写真は品物の下に小さく（持ち主 1A）。リンクは事務所と同じ形（2A）。取り消しのほかは「終わった」注文でも出す（3A）
   - 2-6：通知をオンにすると、新しい注文・直した・取り消しが届く（サーバーの係 zairyoNotifyOrder）。押すと zairyoya.html?o=注文 で、その注文を開く。
     一覧のカードは色の帯と大きな印（新しい・直した・取り消し）、「① 受ける」の数は赤。印は「受けました」「わかりました」を押すまで消えない。
     直した注文は、直したところに色をつけて「4枚 → 5枚」（事務所が直す前の値 supPrev とくらべる）。取り消しの注文は全体を灰色に、品物に線 */
const TAB_KEY = "yotsuba-zairyoya-tab";
const isCx = o => o.status === "cancelled";
/** 事務所が取り消した（まだ「わかりました」を押していない） */
const needCx = o => isCx(o) && !o.supCxSeenAt;
/** 事務所が直した（まだ「わかりました」を押していない） */
const edited = o => !isCx(o) && !!o.supEditedAt && !(o.supEditSeenAt >= o.supEditedAt);
const TABS = [
  { id: "uke", label: "① 受ける", hint: "新しい注文です。中身を見て、届ける日を入れて「受けました」を押してください。事務所が直した・取り消した注文も、ここに出ます。",
    has: o => needCx(o) || edited(o) || (!isCx(o) && o.supState === "sent") },
  { id: "todokeru", label: "② 届ける", hint: "受けた注文です。届けたら「届けました」を押してください。",
    has: o => !isCx(o) && !edited(o) && o.supState === "accepted" },
  { id: "kingaku", label: "③ 金額を入れる", hint: "届けた注文です。金額を入れてください。",
    has: o => !isCx(o) && !edited(o) && o.supState === "delivered" },
  { id: "owari", label: "終わった", hint: "金額まで入れた注文と、取り消しになった注文です。",
    has: o => (isCx(o) && !needCx(o)) || (!isCx(o) && !edited(o) && o.supState === "priced") },
];
const pad = n => String(n).padStart(2, "0");
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const today = () => dayOf(Date.now());
/** 事務所が、もう納品書の金額を入れている */
const hasSlips = o => slipsOf(o).length > 0;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
/** 希望日の早い順（最短がいちばん上）。同じなら、送られた順 */
const byKibou = (a, b) => (a.kibou === "最短" ? "0" : a.kibou || "9").localeCompare(b.kibou === "最短" ? "0" : b.kibou || "9") || ((a.supSentAt || 0) - (b.supSentAt || 0));
/** 届ける日の早い順 */
const byDeliver = (a, b) => (a.deliverDate || "9").localeCompare(b.deliverDate || "9") || byKibou(a, b);

function showHome(me) {
  $("#who").textContent = `${me.supName || "材料屋"}・${me.name}`;
  document.querySelector(".wrap").classList.remove("narrow");   // パソコンでは横に2列
  let tab = "uke";
  try { const t = localStorage.getItem(TAB_KEY); if (TABS.some(x => x.id === t)) tab = t; } catch (err) { }
  let orders = null, openId = "";
  const ui = {};   // 注文の画面だけの状態 { 注文: { changeDate, askDeliver, dirty（金額を入れかけ）, pending（送る前のたしかめ）, draft（やめたときの入れかけ） } }
  main.innerHTML = `
    <section class="card sup-head"><span class="eyebrow">よつば建設工業さまからの注文</span>
      <div class="sup-push" id="supPush"></div>
      <div class="seg sup-tabs" role="tablist" aria-label="注文のようす" id="supTabs"></div></section>
    <p class="hint" id="supHint"></p>
    <div id="supList"></div>`;
  const live = () => (orders || []).filter(o => o.supState);   // 事務所が「アプリに送る」を押した注文だけ
  let wantOpen = new URLSearchParams(location.search).get("o") || "";   // 通知を押して開いた注文（2-6）
  /** 通知（2-6）：オフ・オン・使えない */
  const drawPush = (busy = "") => {
    const st = pushState(), el = $("#supPush");
    el.innerHTML = st === "on" ? `<div class="row push-row"><span>通知：<b>オン</b></span>
        <button type="button" class="btn" data-push="test"${busy ? " disabled" : ""}>${busy === "test" ? "送っています…" : "ためしに送る"}</button>
        <button type="button" class="linkbtn muted" data-push="off"${busy ? " disabled" : ""}>オフにする</button></div>`
      : st === "off" ? `<div class="row push-row"><span>通知：<b>まだオフ</b></span>
        <button type="button" class="btn primary" data-push="on"${busy ? " disabled" : ""}>${busy === "on" ? "オンにしています…" : "通知をオンにする"}</button></div>
        <p class="hint">新しい注文・直した・取り消しを、この端末に知らせます。</p>`
      : st === "blocked" ? '<p class="hint">通知が止められています。ブラウザ（またはスマホ）の設定で、このページの通知を許可してください。</p>'
      : '<p class="hint">この端末・このブラウザでは、通知を使えません。iPhone は「ホーム画面に追加」したアプリで開くと使えます。</p>';
  };
  drawPush();
  refreshPush().catch(() => { });   // オンのときは、だまって受け取り番号を新しくする
  const draw = (force = false) => {   // force＝しまい終わったあと（欄にカーソルが残っていても、かきなおす）
    const ls = live();
    $("#supTabs").innerHTML = TABS.map(t => {
      const n = ls.filter(t.has).length;
      return `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === tab}">${t.label}${n ? `<span class="badge${t.id === "uke" ? " hot" : ""}"${t.id === "uke" ? ' title="まだ見ていない注文があります"' : ""}>${n}</span>` : ""}</button>`;
    }).join("");
    const t = TABS.find(x => x.id === tab);
    $("#supHint").textContent = t.hint;
    if (!orders) { $("#supList").innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    let list = ls.filter(t.has);
    list = tab === "todokeru" ? list.sort(byDeliver) : list.sort((a, b) => (b.supSentAt || b.orderedAt || 0) - (a.supSentAt || a.orderedAt || 0));
    $("#supList").innerHTML = list.length ? `<div class="ocards">${list.map(cardHTML).join("")}</div>`
      : `<p class="empty">${tab === "uke" ? "新しい注文は、ありません。" : "ありません。"}</p>`;
    // 開いている注文の画面も、かきなおす（日付を入れている途中・「本当に？」の途中・金額を入れかけのときはそのまま。
    // ただし金額を入れかけでも、取り消し・直し・事務所が金額を入れた、なら、かきなおす）
    const w = document.getElementById("supOrderWrap");
    const o = openId && w && ls.find(x => x.id === openId);
    if (o) {
      const u = ui[openId] || {};
      const typing = document.activeElement && w.contains(document.activeElement) && document.activeElement.matches("input");
      const pricing = (u.dirty || u.pending) && o.supState === "delivered" && !isCx(o) && !edited(o) && !hasSlips(o);
      if (force || (!typing && !u.askDeliver && !pricing)) openOrder(o, true);
    }
  };
  const openOrder = (o, keepScroll = false) => {
    const panel = document.getElementById("panel"), y = keepScroll && panel ? panel.scrollTop : 0;
    openSheet(orderHTML(o, ui[o.id] || (ui[o.id] = {})), p => {
      // 開いている注文の印は、ここでつける（openSheet は、前の画面の onClose（印を消す）を先に走らせるため）
      openId = o.id;
      p.scrollTop = y;
      const w = p.querySelector("#supOrderWrap");
      const box = w.querySelector("[data-slipform]");
      if (box) wireSlipForm(box, () => { (ui[o.id] || (ui[o.id] = {})).dirty = true; });   // 金額の欄（js/kingaku.js）
      if (!isCx(o) && hasAttach(o)) fillDownloads(w, o);   // 図面・写真（2-5）
      w.addEventListener("click", e => onAct(e, w).catch(ex => {
        const er = w.querySelector(".act-err");
        if (er) er.textContent = "うまくいきませんでした（" + errorText(ex) + "）";
      }));
    }, { side: true, onClose: () => { openId = ""; } });
  };
  /** 注文の画面のボタン（受けました・届ける日を変える・届けました・わかりました） */
  async function onAct(e, w) {
    const t = e.target.closest("[data-act]");
    if (!t || t.disabled) return;
    const o = live().find(x => x.id === openId);
    if (!o) return;
    const u = ui[o.id] || (ui[o.id] = {});
    const err = w.querySelector(".act-err");
    if (err) err.textContent = "";
    const act = t.dataset.act, base = `zairyo/orders/${o.id}`;
    if (act === "fdl" || act === "fdlall") {   // 図面・ファイルのダウンロード（2-5）
      const bs = act === "fdl" ? [t] : [...w.querySelectorAll('[data-act="fdl"][data-url]')];
      saveFiles(bs.map(b => b.dataset.url));
      return;
    }
    if (act === "ph") { if (t.dataset.url) openPhoto("", t.dataset.url); return; }
    const busy = async (label, upd, msg) => {
      const old = t.textContent;
      t.disabled = true; t.textContent = label;
      try { await (typeof upd === "function" ? upd() : update(ref(db, base), upd)); } catch (ex) { t.disabled = false; t.textContent = old; throw ex; }
      // しまい終わったら、日付の欄にカーソルが残っていても外して、かきなおす（欄を入れている途中は、かきなおさないため）
      const ae = document.activeElement;
      if (ae && w.contains(ae)) ae.blur();
      draw(true);
      toast(msg);
    };
    if (act === "accept") {   // 受けました（届ける日は必ず）
      const d = w.querySelector("#dDate").value;
      if (!isDate(d)) { err.textContent = "届ける日をえらんでください"; w.querySelector("#dDate").focus(); return; }
      await busy("しまっています…", { supState: "accepted", supAcceptedAt: serverTimestamp(), supAcceptedBy: me.name, deliverDate: d },
        `受けました。${kibouText(d)} に届ける予定を、よつば建設工業に知らせました`);
      tab = "todokeru";
      try { localStorage.setItem(TAB_KEY, tab); } catch (err2) { }
      draw();
    } else if (act === "date") { u.changeDate = true; openOrder(o, true); }
    else if (act === "dateno") { u.changeDate = false; openOrder(o, true); }
    else if (act === "dateyes") {
      const d = w.querySelector("#dDate").value;
      if (!isDate(d)) { err.textContent = "届ける日をえらんでください"; return; }
      u.changeDate = false;
      await busy("しまっています…", { deliverDate: d }, `届ける日を ${kibouText(d)} に変えました`);
    } else if (act === "deliver") { u.askDeliver = true; openOrder(o, true); }
    else if (act === "deliverno") { u.askDeliver = false; openOrder(o, true); }
    else if (act === "deliveryes") {   // 届けました（よつば建設工業の「届いた」にもなる。もう「届いた」なら、そのまま）
      u.askDeliver = false;
      const by = `${me.supName || "材料屋"}（${me.name}）`.slice(0, 40);
      await busy("しまっています…", {
        supState: "delivered", supDeliveredAt: serverTimestamp(), supDeliveredBy: me.name,
        ...(o.status === "wait" ? { status: "arrived", arrivedAt: serverTimestamp(), arrivedBy: by } : {}),
      }, "届けました。よつば建設工業の「届いた」にもなりました");
      tab = "kingaku";
      try { localStorage.setItem(TAB_KEY, tab); } catch (err2) { }
      draw();
    } else if (act === "cxseen") {
      await busy("しまっています…", { supCxSeenAt: serverTimestamp() }, "取り消しを、たしかめました（「終わった」に入りました）");
    } else if (act === "editseen") {
      await busy("しまっています…", { supEditSeenAt: serverTimestamp() }, "直したところを、たしかめました");
    } else if (act === "price") {   // この金額を送る → 送る前のたしかめ（2-4）
      const box = w.querySelector("[data-slipform]"), r = readSlipForm(box, o);
      if (r.err) { box.querySelector('[data-s="err"]').textContent = r.err; r.focus.focus(); return; }
      u.pending = r.slip;
      openOrder(o, true);
    } else if (act === "priceno") {   // やめる：入れた値のまま、欄にもどす
      u.draft = u.pending; u.pending = null; u.dirty = true;
      openOrder(o, true);
    } else if (act === "priceyes") {   // 送る：よつば建設工業の「納品書の金額」になる
      try {
        await busy("送っています…", () => supAddSlip(o, u.pending, me), `${yen(u.pending.amount)}円を送りました。よつば建設工業の「納品書の金額」になりました`);
      } catch (ex) {
        const now = live().find(x => x.id === o.id);
        if (now && hasSlips(now)) {   // 入れている間に、事務所が先に入れた
          u.pending = null; u.draft = null; u.dirty = false;
          draw(true);
          toast("よつば建設工業が、さきに金額を入れていました。金額をたしかめてください");
          return;
        }
        throw ex;
      }
      u.pending = null; u.draft = null; u.dirty = false;
      tab = "owari";
      try { localStorage.setItem(TAB_KEY, tab); } catch (err2) { }
      draw();
    } else if (act === "priceseen") {   // 事務所が入れた金額をたしかめた（持ち主 3A）
      await busy("しまっています…", () => supSeePrice(o, me), "金額をたしかめました（「終わった」に入りました）");
      tab = "owari";
      try { localStorage.setItem(TAB_KEY, tab); } catch (err2) { }
      draw();
    }
  }
  main.addEventListener("click", async e => {
    const pb = e.target.closest("[data-push]");
    if (pb) {   // 通知（2-6）
      const act = pb.dataset.push;
      drawPush(act);
      try {
        if (act === "on") { await enablePush(); toast("通知をオンにしました。「ためしに送る」で、届くかたしかめられます"); }
        else if (act === "off") { await disablePush(); toast("通知をオフにしました"); }
        else { const r = await testPush(); toast(r.ok ? "ためしの通知を送りました（数秒で届きます）" : `送れませんでした（${r.error}）`); }
      } catch (ex) { toast(`うまくいきませんでした（${errorText(ex)}）`); }
      drawPush();
      return;
    }
    const b = e.target.closest("[data-tab]");
    if (b) {
      tab = b.dataset.tab;
      try { localStorage.setItem(TAB_KEY, tab); } catch (err) { }
      draw();
      return;
    }
    const c = e.target.closest("[data-o]");
    if (c) { const o = (orders || []).find(x => x.id === c.dataset.o); if (o) openOrder(o); }
  });
  main.addEventListener("keydown", e => {
    const c = e.target.closest && e.target.closest("[data-o]");
    if (c && e.target === c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); c.click(); }
  });
  draw();
  onValue(query(ref(db, "zairyo/orders"), orderByChild("supplier"), equalTo(me.sup)), s => {
    orders = Object.entries(s.val() || {}).map(([id, o]) => ({ id, ...o }));
    draw();
    if (wantOpen) {   // 通知を押して開いた（2-6）：その注文のタブにして開く
      const o = live().find(x => x.id === wantOpen);
      wantOpen = "";
      try { const u = new URL(location.href); u.searchParams.delete("o"); history.replaceState(null, "", u.href); } catch (err) { }
      if (o) {
        const t = TABS.find(x => x.has(o));
        if (t) { tab = t.id; try { localStorage.setItem(TAB_KEY, tab); } catch (err) { } draw(); }
        openOrder(o);
      }
    }
  }, ex => { $("#supList").innerHTML = `<p class="err">注文を読めませんでした（${esc(errorText(ex))}）</p>`; });
}

/** 注文のカード（一覧） */
function cardHTML(o) {
  const cx = isCx(o);
  const color = cx ? "var(--grey)" : edited(o) ? "var(--amber)" : o.supState === "delivered" ? "var(--blue)" : o.supState === "priced" ? "var(--grey)" : "var(--amber)";
  const chip = needCx(o) ? "取り消しになりました" : cx ? "取り消し" : edited(o) ? "事務所が直しました"
    : o.supState === "sent" ? "新しい注文" : o.supState === "accepted" ? (o.supVia === "line" ? "LINE・電話で受けた" : "受けた") : o.supState === "delivered" ? "届けた" : "おわり";
  const solid = needCx(o) || edited(o) || (!cx && o.supState === "sent");
  const mk = markOf(o);   // 新しい・直した・取り消し（2-6。「受けました」「わかりました」まで消えない）
  return `
    <article class="ocard${cx && !needCx(o) ? " cx" : ""}${mk ? ` mark-${mk}` : ""}" tabindex="0" data-o="${esc(o.id)}" style="--c:${color}">
      ${mk ? `<span class="bigmark">${MARK[mk]}</span>` : ""}
      <div class="card-head"><span class="kouji"><span class="chuban">${esc(o.chuban)}</span><span class="kenmei">${esc(zenkana(o.kenmei || ""))}</span></span>
        ${mk ? "" : `<span class="ochip${solid ? " solid" : ""}">${chip}</span>`}</div>
      <div class="items">${esc(Object.values(o.lines || {}).map(lineText).join("\n"))}</div>
      <dl class="meta">
        <div><dt>希望日</dt><dd>${esc(kibouText(o.kibou))}</dd></div>
        ${o.deliverDate && !cx ? `<div><dt>届ける日</dt><dd>${esc(kibouText(o.deliverDate))}</dd></div>` : ""}
        <div><dt>届け先</dt><dd>${esc(o.basho || "—")}</dd></div>
        <div><dt>注文日</dt><dd>${o.supSentAt || o.orderedAt ? md(o.supSentAt || o.orderedAt) : ""}</dd></div>
        ${o.supState === "priced" && !cx && o.nouhin != null ? `<div><dt>金額</dt><dd>${yen(o.nouhin)}円</dd></div>` : ""}
      </dl>
    </article>`;
}

/** つぎにやること（注文の画面のいちばん上） */
function actHTML(o, u) {
  const err = '<p class="err act-err" role="alert"></p>';
  if (needCx(o)) return `
    <div class="block act" style="--c:var(--danger)"><h3>取り消しになりました</h3>
      <p class="warn">この注文は、よつば建設工業が取り消しました${o.cancelledAt ? `（${md(o.cancelledAt)} ${hm(o.cancelledAt)}）` : ""}。届けないでください。</p>
      <button type="button" class="btn primary big" data-act="cxseen">わかりました</button>${err}</div>`;
  if (isCx(o)) return '<div class="block"><p class="warn">この注文は、よつば建設工業が取り消しました。</p></div>';
  if (edited(o)) {
    const last = Object.values(o.log || {}).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    return `
    <div class="block act" style="--c:var(--blue)"><h3>事務所が注文を直しました</h3>
      <p>${md(o.supEditedAt)} ${hm(o.supEditedAt)} に、よつば建設工業が直しました。下の中身を見なおしてください。${o.supPrev ? "<b>色がついている所</b>が、直したところです。" : ""}</p>
      ${last && last.what ? `<p class="hint">${esc(last.what.replace(/^直した：/, "直したところ："))}</p>` : ""}
      <button type="button" class="btn primary big" data-act="editseen">わかりました</button>${err}</div>`;
  }
  const dateIn = v => `<div class="field"><label for="dDate">届ける日</label>
      <input id="dDate" class="inp" type="date" min="${today()}" value="${esc(v || "")}"></div>`;
  if (o.supState === "sent") return `
    <div class="block act" style="--c:var(--amber)"><h3>つぎにやること：受ける</h3>
      <p>中身を見て、届ける日を入れて「受けました」を押してください。よつば建設工業に、届ける日が知らされます。</p>
      ${dateIn(isDate(o.kibou) ? o.kibou : "")}
      <button type="button" class="btn primary big" data-act="accept">受けました</button>${err}
      <p class="hint">受けられないとき・わからないことがあるときは、よつば建設工業に電話してください。</p></div>`;
  if (o.supState === "accepted") return `
    <div class="block act" style="--c:var(--amber)"><h3>つぎにやること：届ける</h3>
      <p>届ける日：<b>${o.deliverDate ? esc(kibouText(o.deliverDate)) : "まだ決めていません"}</b></p>
      ${u.changeDate ? `${dateIn(o.deliverDate)}<div class="row"><button type="button" class="btn primary" data-act="dateyes">この日に変える</button><button type="button" class="btn" data-act="dateno">やめる</button></div>`
        : u.askDeliver ? `<div class="confirm"><p class="confirm-q">届けましたか？（よつば建設工業の「届いた」にもなります）</p>
          <div class="confirm-btns"><button type="button" class="btn primary" data-act="deliveryes">届けました</button><button type="button" class="btn" data-act="deliverno">やめる</button></div></div>`
        : `<div class="row"><button type="button" class="btn primary big" data-act="deliver">届けました</button><button type="button" class="btn" data-act="date">${o.deliverDate ? "届ける日を変える" : "届ける日を入れる"}</button></div>`}
      ${err}</div>`;
  const slipsText = slipsOf(o).map(([, s]) => (s.date ? `${Number(s.date.slice(5, 7))}/${Number(s.date.slice(8))} の納品書` : "納品書")).join("・");
  if (o.supState === "delivered" && hasSlips(o)) return `
    <div class="block act" style="--c:var(--blue)"><h3>つぎにやること：金額をたしかめる</h3>
      <p>よつば建設工業が、もう納品書の金額を入れています。</p>
      <p>金額：<b>${yen(o.nouhin)}円</b>（税抜・${esc(slipsText)}）</p>
      <p class="hint">ちがっていたら、よつば建設工業に電話してください。</p>
      <button type="button" class="btn primary big" data-act="priceseen">わかりました</button>${err}</div>`;
  if (o.supState === "delivered" && u.pending) return `
    <div class="block act" style="--c:var(--blue)"><h3>つぎにやること：金額を入れる</h3>
      <div class="confirm"><p class="confirm-q">合計 ${yen(u.pending.amount)}円（税抜）で送りますか？</p>
        <p class="hint">送ったあと、金額がちがっていたら、よつば建設工業に電話してください（事務所が直します）。</p>
        <div class="confirm-btns"><button type="button" class="btn primary" data-act="priceyes">送る</button><button type="button" class="btn" data-act="priceno">やめる</button></div></div>${err}</div>`;
  if (o.supState === "delivered") return `
    <div class="block act" style="--c:var(--blue)"><h3>つぎにやること：金額を入れる</h3>
      <p>${o.supDeliveredAt ? `${md(o.supDeliveredAt)} に届けました。` : "届けました。"}品物ごとに単価を入れると、合計が出ます（税抜）。</p>
      ${slipFormHTML(o, { slip: u.draft || null, date: o.supDeliveredAt ? dayOf(o.supDeliveredAt) : "" })}
      <button type="button" class="btn primary big" data-act="price">この金額を送る</button>
      <p class="hint">送ると、よつば建設工業の「納品書の金額」になります。</p>${err}</div>`;
  const sup = (o.slips || {}).sup;
  return `<div class="block act" style="--c:var(--grey)"><h3>この注文はおわりです</h3>
      ${o.nouhin != null ? `<p>金額：<b>${yen(o.nouhin)}円</b>（税抜${o.supPricedAt ? `・${md(o.supPricedAt)} に${sup ? "送りました" : "たしかめました"}` : ""}）</p>` : ""}
      ${sup && sup.fixBy ? `<p class="warn">よつば建設工業が金額を直しました（はじめに送った金額は ${yen(sup.supAmount)}円）。</p>` : ""}
      <p class="hint">金額がちがっていたら、よつば建設工業に電話してください。</p></div>`;
}

/** 注文の中身（右から出る） */
function orderHTML(o, u) {
  const ls = Object.values(o.lines || {});
  const files = Object.entries(o.files || {}).filter(([, f]) => f && f.name).sort(([, a], [, b]) => (a.at || 0) - (b.at || 0));
  const photos = ls.reduce((n, l) => n + Object.keys(l.photos || {}).length, 0);
  const links = [...new Set(ls.map(l => l.link).filter(Boolean))];
  return `
    <div class="pw${isCx(o) ? " cxsheet" : ""}" id="supOrderWrap">
      <div class="panel-head"><div><span class="eyebrow">よつば建設工業さまからの注文</span>
        <h2 id="panelTitle" class="mt6">${hv(o, "chuban")}</h2>
        <div class="kouji"><span class="kenmei">${hv(o, "kenmei", v => zenkana(v || ""))}</span></div></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      ${actHTML(o, u)}
      <div class="block"><h3>品名・数量</h3><ul class="g-lines">${Object.entries(o.lines || {}).map(([lid, l]) => { const p = prevOf(o).lines[lid]; return `<li${p ? ' class="chg-line"' : ""}>${lineHTML(l, p)}${photosHTML(o, lid, l)}</li>`; }).join("")}</ul>
        ${photos && !isCx(o) ? '<p class="hint">写真を押すと、大きく見られます。</p>' : ""}</div>
      <div class="block"><dl class="dl">
        <dt>希望日</dt><dd>${hv(o, "kibou", kibouText)}</dd>
        ${o.deliverDate && !isCx(o) ? `<dt>届ける日</dt><dd>${esc(kibouText(o.deliverDate))}</dd>` : ""}
        <dt>届け先</dt><dd>${hv(o, "basho", v => v || "—")}${o.bashoText ? `<br><span class="hint">${esc(o.bashoText)}</span>` : ""}</dd>
        <dt>注文者</dt><dd>${hv(o, "chumonsha", v => v || "—")}</dd>
        ${o.tantou || "tantou" in prevOf(o).head ? `<dt>担当者</dt><dd>${hv(o, "tantou", v => v || "（なし）")}</dd>` : ""}
        ${o.memo || "memo" in prevOf(o).head ? `<dt>メモ</dt><dd>${hv(o, "memo", v => v || "（なし）")}</dd>` : ""}
        <dt>注文日</dt><dd>${o.supSentAt ? `${md(o.supSentAt)} ${hm(o.supSentAt)}` : o.orderedAt ? md(o.orderedAt) : ""}${o.supVia === "line" ? "（LINE・電話で受けた注文）" : ""}</dd>
        ${o.supAcceptedAt && o.supVia !== "line" ? `<dt>受けた</dt><dd>${md(o.supAcceptedAt)} ${hm(o.supAcceptedAt)}${o.supAcceptedBy ? `（${esc(o.supAcceptedBy)}）` : ""}</dd>` : ""}
        ${o.supDeliveredAt ? `<dt>届けた</dt><dd>${md(o.supDeliveredAt)} ${hm(o.supDeliveredAt)}${o.supDeliveredBy ? `（${esc(o.supDeliveredBy)}）` : ""}</dd>` : ""}
      </dl></div>
      ${files.length && !isCx(o) ? `<div class="block"><h3>図面・ファイル</h3>
        <ul class="flist">${files.map(([fid, f]) => `
          <li><span class="fname">${esc(f.name || "")}<small class="hint">${sizeText(f.size)}</small></span>
            <span class="fbtns"><button type="button" class="btn" data-act="fdl" data-fid="${esc(fid)}" disabled>ダウンロード</button></span></li>`).join("")}</ul>
        ${files.length > 1 ? '<div class="row"><button type="button" class="btn" data-act="fdlall" disabled>ぜんぶダウンロード</button></div>' : ""}
        <p class="hint">スマホ・パソコンの「ダウンロード」に入ります。</p></div>` : ""}
      ${(files.length || photos) && !isCx(o) ? '<p class="hint" data-dlmsg role="status">図面・写真を読んでいます…</p>' : ""}
      ${links.length ? `<div class="block"><h3>参考のページ</h3>
        ${links.map(h => `<a class="shoplink" href="${esc(h)}" target="_blank" rel="noopener noreferrer">参考のページを開く</a>`).join("")}</div>` : ""}
    </div>`;
}

/* ---------- 2-5：図面・写真（サーバーの係 zairyoSupFiles がリンクを渡す） ---------- */
/** 図面・写真があるか */
const hasAttach = o => Object.keys(o.files || {}).length > 0 || Object.values(o.lines || {}).some(l => Object.keys(l.photos || {}).length);
/** 品物の下の写真（小さく。リンクはあとで fillDownloads が入れる。持ち主 1A） */
function photosHTML(o, lid, l) {
  const ps = Object.values(l.photos || {});
  if (!ps.length || isCx(o)) return "";
  return `<div class="photos">${ps.map((p, i) => `<span class="ph"><button type="button" class="ph-img" data-act="ph" data-ph="${esc(lid)}/${i}" aria-label="写真を大きく見る"><img alt=""></button></span>`).join("")}</div>`;
}
/** リンクは、同じ注文・同じファイルなら1回だけもらう（画面をかきなおすたびに聞かない） */
const dlCache = new Map();
function linksOf(o) {
  const sig = JSON.stringify([o.files || {}, Object.values(o.lines || {}).map(l => l.photos || {})]);
  const c = dlCache.get(o.id);
  if (c && c.sig === sig) return c.p;
  const p = call("zairyoSupFiles")({ orderId: o.id }).then(r => r.data || {});
  p.catch(() => { if (dlCache.get(o.id) && dlCache.get(o.id).p === p) dlCache.delete(o.id); });   // うまくいかなかったら、つぎにまた聞く
  dlCache.set(o.id, { sig, p });
  return p;
}
/** 開いた注文の画面に、写真・ダウンロードのリンクを入れる */
function fillDownloads(w, o) {
  const msg = w.querySelector("[data-dlmsg]");
  linksOf(o).then(r => {
    if (!w.isConnected) return;
    w.querySelectorAll("[data-ph]").forEach(b => {
      const [lid, i] = b.dataset.ph.split("/"), u = ((r.photos || {})[lid] || [])[Number(i)];
      if (u) { b.dataset.url = u; b.querySelector("img").src = u; } else { b.classList.add("ng"); b.textContent = "見られません"; }
    });
    for (const f of r.files || []) {
      const b = w.querySelector(`[data-act="fdl"][data-fid="${CSS.escape(f.id)}"]`);
      if (!b) continue;
      if (f.url) { b.dataset.url = f.url; b.disabled = false; } else b.textContent = "見られません";
    }
    const all = w.querySelector('[data-act="fdlall"]');
    if (all) all.disabled = !w.querySelector('[data-act="fdl"][data-url]');
    if (msg) msg.hidden = true;
  }, ex => {
    if (!w.isConnected || !msg) return;
    msg.textContent = `図面・写真を読めませんでした（${errorText(ex)}）。閉じて、もう一度開いてください`;
    msg.classList.add("err");
  });
}
/** ダウンロード（ファイルの名前は、事務所がつけたときの名前のまま。いくつかなら少しずつずらす） */
function saveFiles(urls) {
  urls.forEach((u, i) => setTimeout(() => {
    const a = document.createElement("a");
    a.href = u;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  }, i * 400));
}

/* ---------- 2-6：新しい・直した・取り消しの印と、直したところ ---------- */
const MARK = { new: "新しい", edit: "直した", cx: "取り消し" };
/** 印（「受けました」「わかりました」を押すまで消えない）。LINE・電話の注文は、もう知っているので「新しい」にしない */
const markOf = o => (needCx(o) ? "cx" : edited(o) ? "edit" : !isCx(o) && o.supState === "sent" ? "new" : "");
/** 直す前の値（材料屋がまだ「わかりました」を押していない直しだけ） */
const prevOf = o => (edited(o) && o.supPrev ? { head: o.supPrev.head || {}, lines: o.supPrev.lines || {} } : { head: {}, lines: {} });
/** 「前 → 後」（前は線、後は色） */
const chgHTML = (a, b) => `<span class="chg"><del>${esc(String(a ?? "") || "（なし）")}</del> → <mark>${esc(String(b ?? "") || "（なし）")}</mark></span>`;
/** 上の欄の1つ（直していれば「前 → 後」） */
function hv(o, f, fmt = v => v ?? "") {
  const p = prevOf(o).head;
  if (f in p && String(p[f] ?? "") !== String(o[f] ?? "")) return chgHTML(fmt(p[f]), fmt(o[f]));
  return esc(String(fmt(o[f]) ?? ""));
}
/** 品物の1行（直していれば、直したところだけ「前 → 後」） */
function lineHTML(l, p) {
  if (!p) return esc(lineText(l));
  const spec = "spec" in p && p.spec !== l.spec ? chgHTML(p.spec, l.spec) : esc(l.spec);
  const note = "note" in p && (p.note || "") !== (l.note || "") ? " " + chgHTML(p.note, l.note) : l.note ? " " + esc(l.note) : "";
  const oq = "qty" in p ? p.qty : l.qty, ou = "unit" in p ? p.unit : l.unit;
  const qty = Number(oq) !== Number(l.qty) || ou !== l.unit ? chgHTML(fmtQty(oq) + ou, fmtQty(l.qty) + l.unit) : esc(fmtQty(l.qty) + l.unit);
  return `${spec}${note}　×${qty}`;
}
