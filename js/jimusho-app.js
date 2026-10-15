// 事務所のパソコン：登録ずみの画面（上の箱・依頼／注文ごと／工事（注番）ごと・さがす・⚙ 設定）。試作の事務所の画面と同じ形
// - 11章 5-1：依頼を見る。現場から送られた依頼を新しい順に。取り消された依頼は、下にたたんで灰色で
// - 11章 5-2：依頼の中身で、品物ごとに材料屋を決める（現場が連絡した材料屋 → なければ品物一覧の「いつもの材料屋」）→
//   材料屋ごとに「注文の文をコピー」→「注文した」。注文を取り消して依頼にもどすこともできる（js/chumon.js）
// - 11章 5-3：注文ごと（ようすでしぼる＝上の箱を押す）・工事（注番）ごと・注文の中身（届いた・もどす・コピー・取り消して依頼にもどす）
// - 納品書の金額・請求は 5-4
// - 11章 7-1：「＋ LINE・電話の注文を入れる」（js/line-chumon.js）。依頼なしの注文（reqId なし）
// - 11章 7-5a：「納品書の取りこみ」（js/nouhin.js）。スキャンを AI で読んで、注文の納品書の金額に入れる
import { ref, onValue, update, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { $, esc, zenkana, toast, runChecks, openSheet, closeSheet } from "./common.js";
import { errorText } from "./touroku.js";
import { normCatalog, lineText, fmtQty, kibouText, ymd } from "./tanomu.js";
import { orderText, sendUrl, sendLabel, draftOrder, placeOrder, cancelOrder, ST, isLate, markArrived, markSent, backToWait, yen, toPrice, cost, slipsOf, addSlip, removeSlip, markBilled, backToArrived, billMany } from "./chumon.js";
import { renderSettings } from "./settei.js";
import { photosHTML, fillPhotos, attachHTML, linkLabel, shopOf, pageLink, SHOPS } from "./shashin.js";
import { openLineOrder } from "./line-chumon.js";
import { openImport } from "./nouhin.js";
import { openReqEdit, openOrderEdit } from "./naosu.js";
import { printFax } from "./fax.js";
import { fileBlockHTML, wireFiles, filesOf, downloadFiles } from "./fairu.js";
import { openKakouOrder } from "./kakou.js";

/** まだ材料屋に送っていない注文（加工品。「送った」を押すまで。10/15） */
const isUnsent = o => !!o.unsent && o.status === "wait";

const pad = n => String(n).padStart(2, "0");
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 依頼・注文の記録（事務所が取り消した・もどした・直した。10/14）。古い順 */
function logHTML(r) {
  const ls = Object.values(r.log || {}).filter(Boolean).sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!ls.length) return "";
  return `<details class="block hidbox" id="reqLog"><summary>記録（${ls.length}）</summary>
    <ul class="loglist">${ls.map(x => `<li><span class="num">${x.at ? `${md(x.at)} ${hm(x.at)}` : ""}</span> <b>${esc(x.by || "")}</b> ${esc(x.what || "")}</li>`).join("")}</ul></details>`;
}
const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999);
const linesOf = r => Object.values(r.lines || {});
const isCancelled = r => r.status === "cancelled";
/** まだ注文しきっていない依頼（status "sent"。一部だけ注文したものも入る） */
const isNew = r => r.status === "sent";

/** スマホ・タブレットか（LINE の「送る」画面を文入りで開けるのは、スマホの LINE だけ） */
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** 注文の文をコピーする。sup をわたすと、その材料屋の送り方（Gmail・LINE）も開く（10/14）
 *  コピーした文は fb（下の欄）にも出す（うまくコピーできなかったときに、選んでコピーできるように）
 *  コピーは開く前にする（新しいタブが前に出ると、このページからはコピーできなくなるため）
 *  LINE は、パソコンでは開かない（LINE の説明に「LINE URLスキームは、デスクトップ版（macOS、Windows）のLINEではサポートされません」。
 *  line.me/R/share を開くと、Chrome で line.me のトップページが出るだけだった 10/14 持ち主）。コピーと「○○ をえらんで、貼り付けて」だけ */
async function copyOrSend(o, sup, fb, info = {}) {
  const text = orderText(o, info);   // info＝⚙ 設定の「会社・注文書」と電話番号（決まり文句・電話番号が入る）
  // FAX（10/14）：注文書を印刷する画面を開く（印刷の画面で FAX 用のプリンターをえらぶ）。文のコピーもしておく
  if (sup && sup.send === "fax") {
    printFax(o, sup, info);
    fb.hidden = false;
    fb.querySelector("textarea").value = text;
    try { await navigator.clipboard.writeText(text); } catch (ex) { }
    const note = fb.querySelector(".send-note");
    note.textContent = `印刷の画面を開きました。プリンターで「FAX」をえらんで、${sup.fax ? `${sup.fax} に` : "送り先の FAX 番号に"}送ってください。${sup.fax ? "" : "（FAX 番号は ⚙ 設定 → 材料屋 で入れられます）"}`;
    note.hidden = false;
    toast("印刷の画面を開きました");
    return;
  }
  const lineCopyOnly = !!sup && sup.send === "line" && !isPhone();
  const url = sup && !lineCopyOnly ? sendUrl(sup, o, info) : "";
  fb.hidden = false;
  fb.querySelector("textarea").value = text;
  let copied = true;
  try { await navigator.clipboard.writeText(text); } catch (ex) { copied = false; fb.querySelector("textarea").select(); }
  if (url) window.open(url, "_blank", "noopener");
  // 注文につけたファイル（注文書・図面）は、メールのときに「ダウンロード」に出す。Gmail を開く住所ではファイルをつけられないので、
  // Gmail のクリップで付けてもらう（10/15 事務所の相談）
  const files = url && sup.send === "mail" ? filesOf(o).map(([, f]) => f) : [];
  let dl = "", dlOk = false;
  if (files.length) {
    try {
      await downloadFiles(files);
      dlOk = true;
      dl = `ファイル${files.length}つを「ダウンロード」に入れました。Gmail のクリップ（📎）から付けて、送信してください。` +
        (files.length > 1 ? "（1回目だけ、Chrome が「複数のファイルのダウンロード」を聞きます。このページで「許可」を押してください）" : "");
    } catch (ex) {
      dl = "ファイルを「ダウンロード」に出せませんでした。「ファイル（注文書・図面）」の欄の「ダウンロード」から出してください。";
    }
  }
  // 送るときの知らせは、ボタンの下に残す（すぐ消える知らせだと、見落とすため）
  const who = sup && sup.lineTo ? `「${sup.lineTo}」` : "送り先";
  const msg = lineCopyOnly
      ? `${copied ? "文をコピーしました。" : "コピーできませんでした。下の文を選んでコピーしてから、"}LINE で${who}をえらんで、貼り付けて送ってください。`
    : !url ? ""
    : sup.send === "mail" ? "Gmail を開きました。" + dl + (!sup.email ? "メールアドレスが入っていないので、宛先を入れてください（⚙ 設定 → 材料屋 で入れられます）。" : dlOk ? "" : "中身を見て、送信してください。")
    : `LINE で${who}をえらんで、送ってください。文が入っていなければ、はりつけてください（コピーしてあります）。`;
  const note = fb.querySelector(".send-note");
  note.textContent = msg;
  note.hidden = !msg;
  if (lineCopyOnly) toast(copied ? `文をコピーしました。LINE で${who}をえらんでください` : "コピーできませんでした。下の文を選んでコピーしてください");
  else if (!url) toast(copied ? "注文の文をコピーしました。LINE やメールにはりつけられます" : "コピーできませんでした。下の文を選んでコピーしてください");
  else if (sup.send === "mail" && files.length) toast(dlOk ? "ファイルをダウンロードに入れました。Gmail のクリップから付けてください" : "Gmail を開きました。ファイルは出せませんでした");
  else toast(sup.send === "mail" ? "Gmail を開きました" : sup.lineTo ? `LINE で「${sup.lineTo}」をえらんでください` : "LINE を開きました");
}

/** 注番をコピーする（ネットのお店で買うとき、お店の備考などの欄にはりつける。10/15） */
async function copyChuban(ch) {
  try {
    await navigator.clipboard.writeText(ch);
    toast(`注番 ${ch} をコピーしました。お店の備考などの欄にはりつけられます`);
  } catch (ex) {
    toast(`コピーできませんでした。注番は ${ch} です`);
  }
}

/** 「ネットで買う」材料屋の品物：品物ごとに、現場がつけたそのお店のリンクなら「ページを開く」、
 *  なければ「○○でさがす」（品名でさがしたページ）。1回押して開けるページは1つだけ（ブラウザの決まり）なので、品物ごとのボタンにする（10/15） */
function netLinesHTML(sup, lines) {
  const shop = SHOPS.find(x => x.id === sup.shop);
  return `<ul class="g-lines net-lines">${lines.map(l => {
    const own = !!l.link && (!shop || shopOf(l.link) === shop.id);
    const href = own ? pageLink(l.link) : shop ? shop.url(l.spec || "") : "";   // モノタロウの写真のリンクは、商品のページにする
    return `<li><span>${esc(lineText(l))}</span>${href ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${own ? "ページを開く" : `${esc(shop.name)}でさがす`}</a>` : ""}</li>`;
  }).join("")}</ul>
    ${shop ? "" : '<p class="hint">⚙ 設定 → 材料屋 で、お店（モノタロウ・ミスミ・アマゾン）をえらぶと、品名でさがすボタンが出ます。</p>'}`;
}

export function startOfficeApp(main, me) {
  const st = {
    view: "irai", filter: "all", q: "", reqs: null, orders: null, catalog: null, sups: null, places: null,
    openOrderId: "",   // いま中身を出している注文
    settingsOpen: false,
    pick: {},        // 依頼ごとの、品物にえらんだ材料屋 {依頼id: {品物id: 材料屋id}}（「注文した」までは、この画面だけ）
    openId: "",      // いま中身を出している依頼
    cxAsk: "", cxReason: "",   // 「取り消し」をたしかめている依頼と、書いている理由（10/14）
    rsAsk: "",                 // 「取り消しをもどす」をたしかめている依頼
  };

  main.innerHTML = `
    <div id="home" class="stack">
      <section class="boxes" id="boxes" aria-label="注文のようす"></section>
      <section class="entry" aria-labelledby="entryTitle">
        <h2 id="entryTitle">事務所から注文を入れる</h2>
        <div class="entry-btns">
          <button type="button" class="entry-btn" id="lineBtn"><b>＋ LINE・電話の注文</b><span>LINE や電話で来た注文を、そのまま入れます</span></button>
          <button type="button" class="entry-btn" id="kakouBtn"><b>＋ 加工品の注文（図面つき）</b><span>注文書・図面のファイルをつけて注文します。メールでいっしょに送れます</span></button>
          <button type="button" class="entry-btn soon" disabled><b>＋ 見積依頼<span class="soon-tag">準備中</span></b><span>いくつかの材料屋に見積を出して、くらべてから注文します</span></button>
        </div>
      </section>
      <section class="after" aria-labelledby="afterTitle">
        <h2 id="afterTitle">届いたあと</h2>
        <button type="button" class="btn" id="impBtn">納品書の取りこみ<small>スキャン・PDF・表から金額を入れる</small></button>
        <button type="button" class="btn" id="billBtn">まとめて請求<small>月の請求書で請求ずみにする</small></button>
      </section>
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
  function matchOrder(o) {
    const q = st.q.trim().normalize("NFKC").toLowerCase();
    if (!q) return true;
    return [o.chuban, o.kenmei, o.supplierName, o.chumonsha, o.tantou, o.basho, o.memo, ...Object.values(o.lines || {}).map(l => l.spec + " " + (l.note || ""))]
      .some(v => String(v || "").normalize("NFKC").toLowerCase().includes(q));
  }
  const liveOrders = () => (st.orders || []).filter(o => o.status !== "cancelled" && matchOrder(o));

  /* ---------- 上の箱・タブ ---------- */
  function drawTop() {
    const n = newReqs().length;
    const box = (cls, c, label, num, attrs) =>
      `<button type="button" class="box ${cls}" ${attrs} style="--c:${c}"><span class="lab">${label}</span><span class="num">${num}<span class="unit">件</span></span></button>`;
    const base = liveOrders();
    $("#boxes", main).innerHTML =
      box(`new${n ? " has" : ""}`, "var(--amber)", "現場からの新しい依頼", st.reqs ? n : "…", `data-newbox aria-pressed="${st.view === "irai"}"`) +
      // 押すと、その注文だけの一覧（「注文ごと」）。もう一度押すと、しぼりこみをやめる
      ["wait", "arrived", "billed"].map(s => box("", ST[s].color, ST[s].label.replace("材料が", "材料が<wbr>").replace("・", "・<wbr>"),
        st.orders ? base.filter(o => o.status === s).length : "…",
        `data-filter="${s}" aria-pressed="${st.view !== "irai" && st.filter === s}"`)).join("");
    const all = (st.reqs || []).filter(isNew).length;
    main.querySelectorAll("#seg [data-view]").forEach(b => {
      b.setAttribute("aria-selected", b.dataset.view === st.view);
      if (b.dataset.view === "irai") b.innerHTML = "依頼" + (all ? `<span class="badge">${all}</span>` : "");
    });
    const parts = [];
    if (st.view !== "irai" && st.filter !== "all") parts.push(`「<b>${ST[st.filter].label}</b>」だけ`);
    if (st.q.trim()) parts.push(`「<b>${esc(st.q.trim())}</b>」でさがし中`);
    const note = $("#filterNote", main);
    note.hidden = !parts.length;
    note.innerHTML = parts.length ? `<span>${parts.join("・")}</span><button type="button" class="linkbtn" id="clearQ">ぜんぶ表示にもどす</button>` : "";
  }

  /* ---------- 事務所が依頼を取り消す・もどす（10/14） ----------
     消さずに status を "cancelled" にして、いつ（cancelledAt）・だれ（cancelledBy＝このパソコンの名前）・理由（cancelReason）を残す。
     記録（log）にも1行ずつ残す。もう注文した品物があるときは取り消せない（先に「注文を取り消して依頼にもどす」。持ち主 A）。
     「取り消しをもどす」は、取り消した依頼の一覧の中だけに出す（持ち主）。もどすと新しい依頼にもどる */
  const activeOrdersOf = r => ordersOf(r.id).filter(o => o.status !== "cancelled");
  function cxBoxHTML(r) {
    const act = activeOrdersOf(r);
    if (act.length) {
      return `<div class="rcx-box"><p class="warn">この依頼から、もう注文した品物があります（${esc([...new Set(act.map(o => o.supplierName))].join("・"))}）。
        先に「注文ごと」でその注文を開いて「注文を取り消して依頼にもどす」をしてから、取り消してください。</p>
        <div class="confirm-btns"><button type="button" class="btn" data-rcxno>とじる</button></div></div>`;
    }
    return `<div class="rcx-box"><p class="confirm-q">この依頼を取り消しますか？</p>
      <label class="mini">理由（なくてもよい）<input id="rcxReason" class="inp" maxlength="100" autocomplete="off" value="${esc(st.cxReason)}" placeholder="例 二重に来た"></label>
      <div class="confirm-btns"><button type="button" class="btn danger" data-rcxyes="${esc(r.id)}">取り消す</button><button type="button" class="btn" data-rcxno>やめる</button></div></div>`;
  }
  function rsBoxHTML(r) {
    return `<div class="rcx-box"><p class="confirm-q">この依頼を、もとにもどしますか？（「現場からの新しい依頼」にもどります）</p>
      <div class="confirm-btns"><button type="button" class="btn primary" data-rrsyes="${esc(r.id)}">もどす</button><button type="button" class="btn" data-rcxno>やめる</button></div></div>`;
  }
  /** 記録に1行足す形（update にまぜる） */
  const logEntry = (reqId, what) => ({ [`log/${push(ref(db, `zairyo/requests/${reqId}/log`)).key}`]: { at: serverTimestamp(), by: me.name || "事務所", what } });
  async function cancelReq(id, btn) {
    const r = (st.reqs || []).find(x => x.id === id);
    if (!r || isCancelled(r)) return;
    if (activeOrdersOf(r).length) { draw(); return; }
    const why = String(st.cxReason || "").trim().slice(0, 100);
    btn.disabled = true;
    await update(ref(db, `zairyo/requests/${id}`), {
      status: "cancelled", cancelledAt: serverTimestamp(), cancelledBy: me.name || "事務所", cancelReason: why || null,
      ...logEntry(id, "取り消し" + (why ? `（理由：${why}）` : "")),
    });
    st.cxAsk = ""; st.cxReason = "";
    toast(`${r.chumonsha}さんの依頼（${r.chuban}）を取り消しました。下の「取り消した依頼」に入りました`);
  }
  async function restoreReq(id, btn) {
    const r = (st.reqs || []).find(x => x.id === id);
    if (!r || !isCancelled(r)) return;
    btn.disabled = true;
    await update(ref(db, `zairyo/requests/${id}`), {
      status: "sent", cancelledAt: null, cancelledBy: null, cancelReason: null,
      ...logEntry(id, `取り消しをもどした（${r.cancelledBy ? "事務所" : "現場"}が取り消していた）`),
    });
    st.rsAsk = "";
    toast(`${r.chumonsha}さんの依頼（${r.chuban}）を、新しい依頼にもどしました`);
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
          ${cx ? `<div><dt>取り消し</dt><dd>${r.cancelledAt ? `${md(r.cancelledAt)} ${hm(r.cancelledAt)}・` : ""}${r.cancelledBy ? `事務所（${esc(r.cancelledBy)}）` : "現場"}${r.cancelReason ? `・${esc(r.cancelReason)}` : ""}</dd></div>` : ""}
        </dl>
        <div class="card-foot"><span class="amt"><span class="num">${ls.length}</span><span>点</span></span>
          <span class="row">${cx ? `<button type="button" class="btn" data-rrs="${esc(r.id)}">取り消しをもどす</button>` : `<button type="button" class="btn danger" data-rcx="${esc(r.id)}">取り消し</button>`}
          <button type="button" class="btn${cx ? "" : " primary"}" data-reqopen="${esc(r.id)}">${cx ? "中身を見る" : "材料屋を決める"}</button></span></div>
        ${st.cxAsk === r.id && !cx ? cxBoxHTML(r) : ""}${st.rsAsk === r.id && cx ? rsBoxHTML(r) : ""}
      </article>`;
  }

  /* 注文のカード（試作の cardHTML と同じ） */
  function orderCard(o) {
    const s = ST[o.status] || ST.wait, late = isLate(o, ymd(0)), cx = o.status === "cancelled", unsent = isUnsent(o);
    return `
      <article class="ocard${cx ? " cx" : ""}${unsent ? " unsent" : ""}" tabindex="0" data-open="${esc(o.id)}" style="--c:${s.color}">
        <div class="card-head"><span class="sup">${esc(o.supplierName)}${o.kind === "kakou" ? ' <span class="tag">加工品</span>' : ""}</span>
          <span class="ochip${o.status === "wait" ? " solid" : o.status === "arrived" ? " blue" : ""}">${unsent ? "まだ送っていない" : s.chip}</span></div>
        <div class="kouji"><span class="chuban">${esc(o.chuban)}</span><span class="kenmei">${esc(zenkana(o.kenmei))}</span></div>
        <div class="items">${esc(Object.values(o.lines || {}).map(lineText).join("\n"))}</div>
        <dl class="meta">
          <div><dt>希望日</dt><dd${late ? ' class="late"' : ""}>${esc(kibouText(o.kibou))}${late ? "（すぎています）" : ""}</dd></div>
          <div><dt>届け先</dt><dd>${esc(o.basho || "—")}</dd></div>
          <div><dt>注文者</dt><dd>${esc(o.chumonsha || "—")}</dd></div>
          <div><dt>注文した</dt><dd>${md(o.orderedAt)}</dd></div>
        </dl>
        <div class="card-foot">${amtHTML(o)}
          ${unsent ? '<span class="hint warn">開いて「メールで送る」→ 送信したら「送った」</span>'
            : o.status === "wait" ? `<button type="button" class="btn primary" data-next="${esc(o.id)}">届いた</button>`
            : o.status === "arrived" ? `<button type="button" class="btn" data-bill="${esc(o.id)}">請求が来た</button>` : ""}</div>
      </article>`;
  }

  /** 並び：まだ届いていない → 届いた → 請求ずみ。その中で、希望日がすぎた注文が上、そのあと新しい順 */
  function sortOrders(list) {
    const rank = { wait: 0, arrived: 1, billed: 2, cancelled: 3 }, today = ymd(0);
    return list.slice().sort((a, b) => (rank[a.status] - rank[b.status]) || ((isUnsent(b) ? 1 : 0) - (isUnsent(a) ? 1 : 0))   // まだ送っていない加工品がいちばん上
      || ((isLate(b, today) ? 1 : 0) - (isLate(a, today) ? 1 : 0)) || ((b.orderedAt || 0) - (a.orderedAt || 0)));
  }

  function drawOrders(list) {
    if (!st.orders) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const shown = sortOrders(liveOrders().filter(o => st.filter === "all" || o.status === st.filter));
    const cxs = st.filter === "all" ? sortOrders((st.orders || []).filter(o => o.status === "cancelled" && matchOrder(o))) : [];
    list.innerHTML =
      (shown.length ? `<div class="ocards">${shown.map(orderCard).join("")}</div>` : '<p class="empty">あてはまる注文はありません。</p>') +
      (cxs.length ? `<details class="block hidbox" id="cxOrders"><summary>取り消した注文（${cxs.length}）</summary><div class="ocards">${cxs.map(orderCard).join("")}</div></details>` : "");
  }

  /* 工事（注番）ごと：注番ごとの注文の数。押すと、その注番の注文だけの一覧 */
  function drawKouji(list) {
    if (!st.orders) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const groups = new Map();
    liveOrders().filter(o => st.filter === "all" || o.status === st.filter).forEach(o => {
      if (!groups.has(o.chuban)) groups.set(o.chuban, []);
      groups.get(o.chuban).push(o);
    });
    if (!groups.size) { list.innerHTML = '<p class="empty">あてはまる工事はありません。</p>'; return; }
    const cards = [...groups.entries()].sort((a, b) => b[0].slice(2).localeCompare(a[0].slice(2)) || a[0].localeCompare(b[0])).map(([cb, os]) => {
      const w = os.filter(o => o.status === "wait").length, a = os.filter(o => o.status === "arrived").length;
      const color = w ? "var(--amber)" : a ? "var(--blue)" : "var(--grey)";
      const latest = os.reduce((x, o) => (o.orderedAt || 0) > (x.orderedAt || 0) ? o : x, os[0]);
      const total = os.reduce((t, o) => t + (cost(o) || 0), 0), noAmt = os.filter(o => cost(o) == null).length;
      return `
        <button type="button" class="kcard" data-kouji="${esc(cb)}" style="--c:${color}">
          <span class="kouji"><span class="chuban">${esc(cb)}</span><span class="kenmei">${esc(zenkana(latest.kenmei))}</span></span>
          <span class="kstats"><span>注文 <b>${os.length}</b> 件</span><span>材料がまだ届いていない <b>${w}</b></span><span>請求まだ <b>${a}</b></span></span>
          <span class="kcost"><span class="lab">材料費</span><span><span class="num big">${yen(total)}</span><span class="yen">円</span></span>
            <span class="khint">${noAmt ? `金額が入っていない注文が ${noAmt} 件あります` : "全部の金額が入っています"}</span></span>
        </button>`;
    }).join("");
    list.innerHTML = `<div class="ocards">${cards}</div>`;
  }

  function drawList() {
    const list = $("#list", main);
    if (st.view === "orders") return drawOrders(list);
    if (st.view === "kouji") return drawKouji(list);
    if (!st.reqs) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const news = newReqs();
    const cxs = st.reqs.filter(r => isCancelled(r) && matchReq(r));
    list.innerHTML =
      (news.length
        ? `<div class="ocards">${news.map(reqCard).join("")}</div>`
        : `<p class="empty">${st.q.trim() ? "あてはまる依頼はありません。" : "新しい依頼はありません。<br>現場のスマホから送られた注文が、ここに来ます。"}</p>`) +
      (cxs.length ? `<details class="block hidbox" id="cxBox"><summary>取り消した依頼（${cxs.length}）</summary><div class="ocards">${cxs.map(reqCard).join("")}</div></details>` : "");
  }

  function draw() {
    const open = [...main.querySelectorAll("#list details[id][open]")].map(d => d.id);
    drawTop();
    drawList();
    for (const id of open) { const d = $(`#${id}`, main); if (d) d.open = true; }
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
  /** 現場がつけたリンクがネットのお店（モノタロウ・ミスミ・アマゾン）のページなら、そのお店の材料屋
   *  （⚙ 設定で送り方「ネットで買う」とお店をえらんだもの。なければ ""）（10/15） */
  function linkSup(l) {
    const shop = l.link ? shopOf(l.link) : "";
    const hit = shop && supList().find(([, s]) => s.send === "net" && s.shop === shop);
    return hit ? hit[0] : "";
  }
  /** まだ注文していない品物に、えらんでいる材料屋（はじめは：リンクのお店 → 現場が連絡した材料屋 → いつもの材料屋） */
  function picksOf(r) {
    const p = st.pick[r.id] || (st.pick[r.id] = {});
    for (const [id, l] of Object.entries(r.lines || {})) {
      if (l.orderId) { delete p[id]; continue; }
      if (!(id in p)) p[id] = linkSup(l) || (r.contacted && st.sups && st.sups[r.contacted] ? r.contacted : usualSup(l)) || "";
    }
    return p;
  }
  /** 品物の行についている写真（小さい絵）とリンク */
  function lineAttach(l) {
    const ps = Object.values(l.photos || {});
    return (ps.length ? `<div class="photos sm">${photosHTML(ps)}</div>` : "") +
      (l.link ? `<a class="shoplink" href="${esc(pageLink(l.link))}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(pageLink(l.link)))} のページを開く</a>` : "");
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
  /** 単位の一覧（品物一覧の units。まだ読めていなければ、よく使うもの） */
  const unitsList = () => (st.catalog && st.catalog.units && st.catalog.units.length ? st.catalog.units : ["個", "本", "組", "枚", "m", "kg", "式", "セット"]);

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
          <div class="lspec">${catName(l.cat) ? `<span class="tag">${esc(catName(l.cat))}</span>` : ""}${esc(l.spec)}${l.note ? " " + esc(l.note) : ""}${lineAttach(l)}</div>
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
        ${cx ? `<p class="warn">${r.cancelledBy ? `事務所（${esc(r.cancelledBy)}）` : "現場"}が取り消しました${r.cancelledAt ? `（${md(r.cancelledAt)} ${hm(r.cancelledAt)}）` : ""}${r.cancelReason ? `。理由：${esc(r.cancelReason)}` : ""}。注文しないでください。</p>` : ""}
        <div class="block"><dl class="dl">
          <dt>希望日</dt><dd>${esc(kibouText(r.kibou))}</dd>
          <dt>届け先</dt><dd>${esc(r.basho || "—")}</dd>
          <dt>注文者</dt><dd>${esc(r.chumonsha)}</dd>
          <dt>担当者</dt><dd>${esc(r.tantou || "—")}</dd>
          ${r.typed ? "<dt>工事</dt><dd>日報の一覧にない工事（現場が注番を手で書いた）</dd>" : ""}
          ${r.contactedName ? `<dt>連絡ずみ</dt><dd class="hl">${esc(r.chumonsha)}さんが ${esc(r.contactedName)} に連絡ずみ</dd>` : ""}
          ${r.memo ? `<dt>メモ</dt><dd>${esc(r.memo)}</dd>` : ""}
        </dl>${cx ? "" : `<div class="row"><button type="button" class="btn" data-redit>依頼を直す</button></div>`}</div>
        ${logHTML(r)}
        <div class="block"><h3>${cx ? "品物" : "1. 品物ごとに材料屋を決める"}</h3>
          ${cx ? "" : `<p class="hint">${r.contactedName ? `現場が連絡した ${esc(r.contactedName)} を入れています。` : "品物一覧の「いつもの材料屋」が最初から入っています。"}${ls.some(([, l]) => !l.orderId && linkSup(l)) ? "ネットのお店のリンクがある品物は、そのお店にしています。" : ""}ちがえば、えらびなおしてください。</p>`}
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
        if (s.send === "net") return `
          <div class="group">
            <div class="g-head"><span class="sup">${esc(s.name)}</span><span class="g-tag">ネットで買う</span><span class="hint g-n">${ids.length}点</span></div>
            ${netLinesHTML(s, ids.map(id => r.lines[id]))}
            <div class="row"><button type="button" class="btn" data-chuban="${esc(r.chuban)}">注番をコピー</button>
              <button type="button" class="btn primary" data-gorder="${esc(sid)}">注文した</button></div>
            <p class="hint">お店のページで買ってから、「注文した」を押してください。注番は、お店の備考などの欄にはりつけておくと、あとで納品書と合わせやすくなります。</p>
          </div>`;
        return `
          <div class="group">
            <div class="g-head"><span class="sup">${esc(s.name)}</span><span class="g-tag">${esc(s.to || "御中")}</span><span class="hint g-n">${ids.length}点</span></div>
            <ul class="g-lines">${ids.map(id => { const l = r.lines[id], n = Object.keys(l.photos || {}).length;
              return `<li>${esc(lineText(l))}${n ? ` <span class="tag">写真${n}枚は別に送る</span>` : ""}${l.link ? ` <span class="tag">リンクつき</span>` : ""}</li>`; }).join("")}</ul>
            <div class="row"><button type="button" class="btn" data-gcopy="${esc(sid)}">注文の文をコピー</button>
              ${sendLabel(s) ? `<button type="button" class="btn" data-gsend="${esc(sid)}">${sendLabel(s)}</button>` : ""}
              <button type="button" class="btn primary" data-gorder="${esc(sid)}">注文した</button></div>
            <div class="field" data-gfb="${esc(sid)}" hidden><p class="send-note" role="status" hidden></p><span class="lab">コピーした文（うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
              <textarea class="inp ta copybox" rows="12" readonly></textarea></div>
          </div>`;
      }).join("")}</div>
      ${groups.some(([sid]) => st.sups[sid].send !== "net") ? '<p class="hint">「注文の文をコピー」（または「メールで送る」「LINE で送る」）で材料屋に送ってから、「注文した」を押してください。</p>' : ""}`;
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
    st.openOrderId = "";
    openSheet(reqHTML(r), p => {
      p.scrollTop = y;
      fillPhotos(p);
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
    const t = e.target.closest("[data-redit],[data-gcopy],[data-gsend],[data-gorder],[data-ocancel],[data-ocyes],[data-ocno],[data-chuban]");
    if (!t || t.disabled) return;
    const r = (st.reqs || []).find(x => x.id === st.openId);
    if (!r) return;
    const d = t.dataset;
    if (d.chuban) return copyChuban(d.chuban);   // ネットで買う（10/15）
    if ("redit" in d) {   // 依頼を直す（10/14）
      return openReqEdit({ r, orders: ordersOf(r.id), places: st.places, units: unitsList(), me, onDone: () => openReq(r.id) });
    }
    const draftFor = sid => {
      const g = groupsOf(r).groups.find(([s]) => s === sid);
      return g ? draftOrder(r, sid, st.sups[sid], g[1], bashoText(r)) : null;
    };
    if (d.gcopy || d.gsend) {
      const sid = d.gcopy || d.gsend, dr = draftFor(sid);
      if (!dr) return;
      await copyOrSend(dr, d.gsend ? st.sups[sid] : null, w.querySelector(`[data-gfb="${CSS.escape(sid)}"]`), st.info);
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
      afterSave(w);
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
      afterSave(w);
    }
  }

  /** カードの金額：材料費（請求書の金額。まだなら納品書の金額） */
  function amtHTML(o) {
    const c = cost(o);
    return c != null
      ? `<span class="amt"><span>材料費</span><span class="num">${yen(c)}</span><span class="yen">円</span><span>（${o.seikyu != null ? "請求" : "納品書"}）</span></span>`
      : '<span class="amt"><span>金額はまだ</span></span>';
  }

  /* ---------- 納品書の金額（1つの注文に何枚でも） ---------- */
  function slipBlockHTML(o) {
    const sl = slipsOf(o), lines = Object.entries(o.lines || {});
    const form = `
      <p class="hint">品物ごとに単価を入れると、合計が出ます。合計だけでもかまいません。${o.status === "wait" ? "入れると「届いた」になります。" : ""}</p>
      <div class="prows">${lines.map(([lid, l]) => `
        <div class="prow">
          <div class="p-spec">${esc(l.spec)}${l.note ? " " + esc(l.note) : ""}<span class="hint">　×${esc(fmtQty(l.qty))}${esc(l.unit)}</span></div>
          <div class="yen-in"><input class="inp" data-mpi="${esc(lid)}" inputmode="decimal" placeholder="単価" aria-label="${esc(l.spec)} の単価"><span>円 ×${esc(fmtQty(l.qty))}</span></div>
          <div class="p-sum num" data-mps="${esc(lid)}"></div>
        </div>`).join("")}</div>
      <div class="ptotal"><label for="mTotal">合計（税抜）</label><div class="yen-in"><input id="mTotal" class="inp" inputmode="numeric" placeholder="0"><span>円</span></div></div>
      <div class="two">
        <div class="field"><label for="mSlipNo">納品書の番号（あれば）</label><input id="mSlipNo" class="inp" maxlength="40" autocomplete="off"></div>
        <div class="field"><label for="mDate">日付</label><input id="mDate" class="inp" type="date" value="${ymd(0)}"></div>
      </div>
      <p class="err" id="eSlip"></p>
      <div class="row"><button type="button" class="btn primary" data-slipsave>納品書の金額を入れる</button></div>`;
    return `
      <div class="block" id="slipBlock"><h3>納品書の金額</h3>
        ${sl.length ? `<ul class="slips">${sl.map(([sid, s]) => `
          <li>
            <div class="sl-top"><span class="sl-lab">納品書${s.no ? "　No." + esc(s.no) : ""}${s.date ? "　" + esc(s.date.slice(5).replace("-", "/").replace(/^0/, "")) : ""}</span>
              ${s.amount != null ? `<span class="money">${yen(s.amount)}</span><span>円</span>` : '<span class="hint">金額なし</span>'}
              <button type="button" class="linkbtn muted" data-slipdel="${esc(sid)}">消す</button></div>
            ${s.scan ? `<button type="button" class="linkbtn" data-phview="${esc(s.scan)}">納品書のスキャンを見る</button>` : ""}
            ${s.rows && Object.keys(s.rows).length ? `<details class="sl-rows"><summary>明細（${Object.keys(s.rows).length}行）</summary><ul>${Object.values(s.rows).map(r =>
              `<li>${esc(r.spec)}${r.qty != null ? "　×" + esc(fmtQty(r.qty)) + esc(r.unit || "") : ""}${r.price != null ? "　@" + yen(r.price) : ""}　${yen(r.amount)}円</li>`).join("")}</ul></details>` : ""}
            <span class="hint">入れた人：${esc(s.by || "")}${s.imp ? "（納品書の取りこみ）" : ""}</span>
          </li>`).join("")}</ul>
          ${sl.length > 1 ? `<p class="ptotal"><span>納品書の合計</span><span class="money">${yen(o.nouhin)}</span><span>円</span></p>` : ""}
          <div class="row"><button type="button" class="linkbtn" data-slipmore>＋ 納品書をもう1枚入れる</button></div>` : ""}
        <div id="slipFormBox"${sl.length ? " hidden" : ""}>${form}</div>
      </div>`;
  }

  /** 単価を入れたら、品物ごとの金額と合計を出す（合計を手で直したら、そのまま） */
  function calcSlip(w) {
    const sb = w.querySelector("#slipBlock");
    if (!sb) return;
    const o = (st.orders || []).find(x => x.id === st.openOrderId);
    if (!o) return;
    let tot = 0, any = false;
    for (const [lid, l] of Object.entries(o.lines || {})) {
      const v = toPrice(sb.querySelector(`[data-mpi="${CSS.escape(lid)}"]`).value);
      const a = v == null ? null : Math.round(v * Number(l.qty));
      sb.querySelector(`[data-mps="${CSS.escape(lid)}"]`).textContent = a != null ? yen(a) + "円" : "";
      if (a != null) { tot += a; any = true; }
    }
    const t = sb.querySelector("#mTotal");
    if (!t.dataset.manual) t.value = any ? yen(tot) : "";
  }

  /* ---------- 注文の中身（右から出る）：届いた・もどす・コピー・取り消して依頼にもどす ---------- */
  function orderHTML(o) {
    const s = ST[o.status] || ST.wait, late = isLate(o, ymd(0)), cx = o.status === "cancelled";
    const osup = st.sups && st.sups[o.supplier], unsent = isUnsent(o), net = !!osup && osup.send === "net";
    const steps = [["注文した", o.orderedAt, true], ["届いた", o.arrivedAt, o.status === "arrived" || o.status === "billed"], ["請求が来た", o.billedAt, o.status === "billed"]];
    if (o.kind === "kakou") steps.splice(0, 1, ["入れた", o.orderedAt, true], ["送った", o.sentAt, !o.unsent]);   // 加工品（10/15）
    // 材料屋に送るところ（ネットで買う材料屋は、お店のページ）。まだ送っていない注文は、上の「つぎにやること」に出す
    const sendArea = net ? `
        <div class="block"><h3>お店のページ（ネットで買う）</h3>${netLinesHTML(osup, Object.values(o.lines || {}))}
          <div class="row"><button type="button" class="btn" data-chuban="${esc(o.chuban)}">注番をコピー</button></div></div>` : `
        <div class="row"><button type="button" class="btn" data-ocopy="${esc(o.id)}">注文の文をコピー（メール・LINE用）</button>
          ${sendLabel(osup) ? `<button type="button" class="btn" data-osend="${esc(o.id)}">${sendLabel(osup)}</button>` : ""}</div>
        <div class="field" id="oCopyFb" hidden><p class="send-note" role="status" hidden></p><span class="lab">コピーした文（うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
          <textarea class="inp ta copybox" rows="12" readonly></textarea></div>`;
    let act = "";
    if (unsent) {   // まだ送っていない（加工品。10/15）：送ってから「送った」
      act = `<div class="block act" style="--c:var(--amber)"><h3>つぎにやること</h3>
          <p class="warn">まだ材料屋に送っていません。</p>
          <p>${net ? "お店のページで買ってから" : osup && osup.send === "mail" ? "「メールで送る」で Gmail を開いて、ファイルをつけて送信してから" : "注文の文を送ってから"}、「送った」を押してください。</p>
          ${sendArea}
          <button type="button" class="btn primary big" data-osent="${esc(o.id)}">送った</button></div>`;
    } else if (o.status === "wait") {
      act = `<div class="block act" style="--c:${s.color}"><h3>つぎにやること</h3>
          <p>材料は届きましたか？<br><span class="hint">納品書が来ていれば、下の「納品書の金額」で入れると「届いた」になります。</span></p>
          <button type="button" class="btn primary big" data-arrive="${esc(o.id)}">届いた（金額はあとで）</button></div>`;
    } else if (o.status === "arrived") {
      act = `<div class="block act" style="--c:${s.color}"><h3>つぎにやること</h3>
          <p>請求書は来ましたか？</p>
          <div class="field"><label for="amtS">請求書の金額（税抜）</label>
            <div class="yen-in"><input id="amtS" class="inp" inputmode="numeric" placeholder="0" value="${o.nouhin != null ? yen(o.nouhin) : ""}"><span>円</span></div>
            <span class="hint">${o.nouhin != null ? "納品書の金額を入れてあります。ちがえば直してください。" : "納品書の金額は、まだ入っていません。"}</span></div>
          <p class="err" id="eBill"></p>
          <div class="row"><button type="button" class="btn primary big" data-billgo="${esc(o.id)}">請求が来た</button>
            <button type="button" class="linkbtn" data-back="${esc(o.id)}">「材料がまだ届いていない」にもどす</button></div></div>`;
    } else if (o.status === "billed") {
      act = `<div class="block act" style="--c:var(--grey)"><h3>この注文はおわりです</h3>
          <p>材料費 <span class="money">${yen(cost(o))}</span> 円 が、注番 ${esc(o.chuban)} の材料費に入ります。</p>
          <button type="button" class="linkbtn" data-unbill="${esc(o.id)}">「請求まだ」にもどす</button></div>`;
    } else if (cx) {
      act = `<div class="block"><p class="warn">この注文は取り消しました${o.cancelledAt ? `（${md(o.cancelledAt)} ${hm(o.cancelledAt)}・${esc(o.cancelledBy || "")}）` : ""}。${o.reqId ? "品物は依頼にもどしました。" : ""}</p></div>`;
    }
    return `
      <div class="pw" id="orderWrap">
        <div class="panel-head"><div>
          <span class="ochip${o.status === "wait" ? " solid" : o.status === "arrived" ? " blue" : ""}">${unsent ? "まだ送っていない" : s.chip}</span>${o.kind === "kakou" ? ' <span class="tag">加工品</span>' : ""}
          <h2 id="panelTitle" class="mt6">${esc(o.supplierName)}</h2>
          <div class="kouji"><span class="chuban">${esc(o.chuban)}</span><span class="kenmei">${esc(zenkana(o.kenmei))}</span></div>
        </div><button type="button" class="x" data-close aria-label="閉じる">×</button></div>
        ${cx ? "" : `<div class="block"><ol class="steps" style="--c:${s.color}">${steps.map(([l, d, done]) => `<li class="${done ? "done" : ""}">${l}<span class="d">${done && d ? md(d) : ""}</span></li>`).join("")}</ol></div>`}
        ${act}
        ${cx ? "" : slipBlockHTML(o)}
        <div class="block"><h3>品名・数量</h3><ul class="g-lines">${Object.values(o.lines || {}).map(l => `<li>${esc(lineText(l))}</li>`).join("")}</ul>
          ${cx ? "" : `<div class="row"><button type="button" class="btn" data-oedit>注文を直す</button></div>`}</div>
        ${fileBlockHTML(o, !cx)}
        ${logHTML(o)}
        ${attachHTML(o.lines, "写真・リンク（材料屋に写真を送るときは、写真を開いて保存してください）")}
        <div class="block"><dl class="dl">
          <dt>希望日</dt><dd${late ? ' class="late"' : ""}>${esc(kibouText(o.kibou))}${late ? "（すぎています）" : ""}</dd>
          <dt>届け先</dt><dd>${esc(o.basho || "—")}</dd>
          <dt>注文者</dt><dd>${esc(o.chumonsha || "—")}</dd>
          <dt>担当者</dt><dd>${esc(o.tantou || "—")}</dd>
          <dt>来たところ</dt><dd>${o.reqId ? `現場のスマホ（${esc(o.chumonsha)}さん）` : o.kind === "kakou" ? "事務所（加工品）" : "LINE・電話"}</dd>
          <dt>${o.kind === "kakou" ? "入れた" : "注文した"}</dt><dd>${md(o.orderedAt)} ${hm(o.orderedAt)}（${esc(o.orderedBy || "")}）</dd>
          ${o.sentAt ? `<dt>送った</dt><dd>${md(o.sentAt)} ${hm(o.sentAt)}（${esc(o.sentBy || "")}）</dd>` : ""}
          ${o.arrivedAt ? `<dt>届いた</dt><dd>${md(o.arrivedAt)} ${hm(o.arrivedAt)}（${esc(o.arrivedBy || "")}）</dd>` : ""}
          ${o.billedAt ? `<dt>請求が来た</dt><dd>${md(o.billedAt)} ${hm(o.billedAt)}（${esc(o.billedBy || "")}）</dd>` : ""}
          <dt>請求書の金額</dt><dd>${o.seikyu != null ? yen(o.seikyu) + " 円" : "—"}</dd>
          ${o.contacted ? `<dt>連絡ずみ</dt><dd>${esc(o.chumonsha)}さんが ${esc(o.supplierName)} に連絡ずみ</dd>` : ""}
          ${o.memo ? `<dt>メモ</dt><dd>${esc(o.memo)}</dd>` : ""}
        </dl></div>
        ${o.src ? `<details class="block hidbox"><summary>LINE の元の文</summary><pre class="src-text">${esc(o.src)}</pre></details>` : ""}
        ${unsent ? "" : sendArea}
        ${o.status === "wait" ? `
          <div class="cx-start" id="ocx-${esc(o.id)}">
            <button type="button" class="btn danger" data-ocancel="${esc(o.id)}">${o.reqId ? "注文を取り消して依頼にもどす" : "注文を取り消す"}</button>
            <span class="hint">押しまちがえたときや、材料屋を変えたいときに。材料屋に連絡したあとなら、材料屋にも取り消しを伝えてください。</span>
          </div>` : ""}
      </div>`;
  }

  /** 入れたばかりの注文を開く（データが届くまで、少し待つ。3秒たっても来なければやめる） */
  function waitOpen(id, tries = 0) {
    if ((st.orders || []).some(x => x.id === id)) openOrder(id);
    else if (tries < 30) setTimeout(() => waitOpen(id, tries + 1), 100);
  }

  function openOrder(id, keepScroll = false, focusSel = "") {
    const o = (st.orders || []).find(x => x.id === id);
    if (!o) return;
    const panel = document.getElementById("panel");
    const y = keepScroll && panel ? panel.scrollTop : 0;
    st.openOrderId = id;
    st.openId = "";
    openSheet(orderHTML(o), p => {
      p.scrollTop = y;
      fillPhotos(p);
      const w = p.querySelector("#orderWrap");
      w.addEventListener("click", e => onOrderClick(e, w).catch(ex => toast(errorText(ex))));
      // ファイル（注文書・図面）をつける・出す・消す（10/15。js/fairu.js）
      wireFiles(w, () => (st.orders || []).find(x => x.id === id), me, { onErr: ex => toast(errorText(ex)), redraw: () => openOrder(id, true) });
      w.addEventListener("input", e => {
        if (e.target.matches("[data-mpi]")) calcSlip(w);
        if (e.target.id === "mTotal") { if (e.target.value.trim()) e.target.dataset.manual = "1"; else delete e.target.dataset.manual; }
        if (e.target.matches("[data-mpi], #mTotal")) w.querySelector("#eSlip").textContent = "";
        if (e.target.id === "amtS") w.querySelector("#eBill").textContent = "";
      });
      if (focusSel) {
        const f = w.querySelector(focusSel);
        if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); f.scrollIntoView({ block: "center" }); }, 30);
      }
    }, { side: true });
  }

  async function onOrderClick(e, w) {
    const t = e.target.closest("[data-oedit],[data-arrive],[data-osent],[data-back],[data-ocopy],[data-osend],[data-ocancel],[data-ocyes],[data-ocno],[data-slipsave],[data-slipdel],[data-slipmore],[data-billgo],[data-unbill],[data-chuban]");
    if (!t || t.disabled) return;
    const d = t.dataset, o = (st.orders || []).find(x => x.id === st.openOrderId);
    if (!o) return;
    if (d.chuban) return copyChuban(d.chuban);   // ネットで買う（10/15）
    if ("oedit" in d) {   // 注文を直す（10/14）
      const r = o.reqId ? (st.reqs || []).find(x => x.id === o.reqId) || null : null;
      return openOrderEdit({ o, r, places: st.places, units: unitsList(), me, onDone: () => openOrder(o.id) });
    }
    const busy = async (label, fn) => {
      const old = t.textContent;
      t.disabled = true;
      t.textContent = label;
      try { await fn(); } catch (ex) { t.disabled = false; t.textContent = old; throw ex; }
      // しまい終わったら、欄にカーソルが残っていても（Safari など）、中身をかきなおす
      const a = document.activeElement;
      if (a && w.contains(a)) a.blur();
      refreshPanel();
    };
    if (d.osent) {   // 加工品：材料屋に送った（10/15）
      await busy("しまっています…", () => markSent(o, me));
      toast("「送った」にしました（材料がまだ届いていない）");
    } else if (d.arrive) {
      await busy("しまっています…", () => markArrived(o, me));
      toast("「届いた」にしました。納品書の金額は、あとで入れられます");
    } else if (d.back) {
      await busy("もどしています…", () => backToWait(o));
      toast("「材料がまだ届いていない」にもどしました");
    } else if ("slipmore" in d) {
      w.querySelector("#slipFormBox").hidden = false;
      t.hidden = true;
      const f = w.querySelector("[data-mpi]") || w.querySelector("#mTotal");
      f.focus({ preventScroll: true });
      f.scrollIntoView({ block: "nearest" });
    } else if ("slipsave" in d) {
      const sb = w.querySelector("#slipBlock"), err = sb.querySelector("#eSlip");
      const total = toPrice(sb.querySelector("#mTotal").value);
      if (total == null) { err.textContent = "金額を入れてください（品物ごとの単価か、合計）"; return; }
      const date = sb.querySelector("#mDate").value || ymd(0);
      const rows = {};
      for (const [lid, l] of Object.entries(o.lines || {})) {
        const v = toPrice(sb.querySelector(`[data-mpi="${CSS.escape(lid)}"]`).value);
        if (v == null) continue;
        rows[lid] = { spec: l.spec + (l.note ? " " + l.note : ""), qty: Number(l.qty), unit: l.unit, price: v, amount: Math.round(v * Number(l.qty)) };
      }
      const was = o.status;
      await busy("しまっています…", () => addSlip(o, { no: sb.querySelector("#mSlipNo").value.trim(), date, amount: Math.round(total), rows }, me));
      toast("納品書の金額を入れました" + (was === "wait" ? "（「届いた」にしました）" : ""));
    } else if (d.slipdel) {
      if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "もう一度押すと消えます"; return; }   // 消すときは2回押す
      await busy("消しています…", () => removeSlip(o, d.slipdel));
      toast("納品書を消しました");
    } else if (d.billgo) {
      const amt = toPrice(w.querySelector("#amtS").value);
      if (amt == null) { w.querySelector("#eBill").textContent = "請求書の金額を入れてください"; return; }
      await busy("しまっています…", () => markBilled(o, Math.round(amt), me));
      toast("「請求が来た」にしました（請求ずみ）");
    } else if (d.unbill) {
      await busy("もどしています…", () => backToArrived(o));
      toast("「請求まだ」にもどしました");
    } else if (d.ocopy || d.osend) {
      await copyOrSend(o, d.osend ? st.sups[o.supplier] : null, w.querySelector("#oCopyFb"), st.info);
    } else if (d.ocancel) {
      const box = w.querySelector(`#ocx-${CSS.escape(d.ocancel)}`);
      box.className = "confirm";
      box.innerHTML = `<p class="confirm-q">${o.reqId ? "この注文を取り消して、品物を依頼にもどしますか？" : "この注文を取り消しますか？（消さずに「取り消した」の印で残します）"}</p>
        <div class="confirm-btns"><button type="button" class="btn danger" data-ocyes="${esc(d.ocancel)}">取り消す</button><button type="button" class="btn" data-ocno>やめる</button></div>`;
      box.scrollIntoView({ block: "nearest" });
    } else if ("ocno" in d) {
      openOrder(o.id, true);
    } else if (d.ocyes) {
      const r = o.reqId ? (st.reqs || []).find(x => x.id === o.reqId) : null;
      await busy("取り消しています…", () => cancelOrder(o, r, me));
      toast(`${o.supplierName} への注文を取り消しました${o.reqId ? "。品物は依頼にもどりました" : ""}`);
      afterSave(w);
    }
  }

  /* ---------- まとめて請求（材料屋ごとの月の請求書。11章 5-4 の B） ---------- */
  const bulk = { sup: "", pick: {}, amt: {}, totalManual: false, armed: false, done: "" };

  function bulkHTML() {
    const arrived = (st.orders || []).filter(o => o.status === "arrived");
    const supIds = [...new Set(arrived.map(o => o.supplier))];
    const name = id => ((st.sups || {})[id] || {}).name || (arrived.find(o => o.supplier === id) || {}).supplierName || id;
    const list = bulk.sup ? sortOrders(arrived.filter(o => o.supplier === bulk.sup)).reverse() : [];
    return `
      <div class="pw" id="bulkWrap">
        <div class="panel-head"><div><span class="eyebrow">月の請求書</span><h2 id="panelTitle">まとめて請求</h2></div>
          <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
        <p class="hint">材料屋から来た請求書で、「届いた・請求まだ」の注文をまとめて「請求ずみ」にします。1件ずつのときは、注文の中身の「請求が来た」でもできます。</p>
        ${bulk.done ? `<p class="okmsg">${esc(bulk.done)}</p>` : ""}
        <div class="field"><label for="bSup">材料屋</label>
          <select id="bSup" class="inp">
            <option value="">${supIds.length ? "えらんでください" : "「届いた・請求まだ」の注文はありません"}</option>
            ${supIds.map(id => `<option value="${esc(id)}"${id === bulk.sup ? " selected" : ""}>${esc(name(id))}（${arrived.filter(o => o.supplier === id).length}件）</option>`).join("")}
          </select></div>
        ${bulk.sup && list.length ? `
          <div class="block"><h3>届いた・請求まだの注文（${list.length}件）</h3>
            <div class="brows">${list.map(o => `
              <div class="brow">
                <label class="b-main"><input type="checkbox" data-bpick="${esc(o.id)}"${bulk.pick[o.id] ? " checked" : ""}>
                  <span><span class="b-top">届いた ${o.arrivedAt ? md(o.arrivedAt) : "—"}・<span class="chuban">${esc(o.chuban)}</span> ${esc(zenkana(o.kenmei))}</span>
                    <span class="b-items">${esc(Object.values(o.lines || {}).map(lineText).join("／"))}</span></span></label>
                <div class="yen-in"><input class="inp" data-bamt="${esc(o.id)}" inputmode="numeric" placeholder="金額" value="${esc(bulk.amt[o.id] ?? "")}" aria-label="${esc(o.chuban)} の金額"><span>円</span></div>
              </div>`).join("")}</div>
            <p class="ptotal"><span id="bCount"></span><span class="money" id="bSum"></span><span>円</span></p>
            <p class="hint">金額のはじめは、納品書の金額です。請求書とちがう注文は、直してください。</p>
          </div>
          <div class="block">
            <div class="ptotal"><label for="bTotal">請求書の合計（税抜）</label><div class="yen-in"><input id="bTotal" class="inp" inputmode="numeric" placeholder="0"><span>円</span></div></div>
            <div class="two">
              <div class="field"><label for="bNo">請求書の番号（あれば）</label><input id="bNo" class="inp" maxlength="40" autocomplete="off"></div>
              <div class="field"><label for="bDate">請求書の日付</label><input id="bDate" class="inp" type="date" value="${ymd(0)}"></div>
            </div>
            <p class="warn" id="bDiff" hidden></p>
            <p class="err" id="bErr"></p>
            <button type="button" class="btn primary big full" id="bGo">請求ずみにする</button>
          </div>` : ""}
      </div>`;
  }

  /** えらんだ件数・合計・請求書とのちがいを出す */
  function bulkCalc(w) {
    const picked = Object.keys(bulk.pick).filter(id => bulk.pick[id]);
    const sum = picked.reduce((s, id) => s + (toPrice(bulk.amt[id]) || 0), 0);
    if (!w.querySelector("#bSum")) return;
    w.querySelector("#bCount").textContent = `えらんだ ${picked.length}件の合計`;
    w.querySelector("#bSum").textContent = yen(sum);
    const t = w.querySelector("#bTotal");
    if (!bulk.totalManual) t.value = picked.length ? yen(sum) : "";
    const total = toPrice(t.value), diff = w.querySelector("#bDiff");
    const off = total != null && Math.round(total) !== Math.round(sum);
    diff.hidden = !off;
    diff.textContent = off ? `えらんだ注文の合計（${yen(sum)}円）と、請求書の合計（${yen(total)}円）が ${yen(Math.abs(total - sum))}円 ちがいます。たしかめてください。` : "";
    const go = w.querySelector("#bGo");
    go.textContent = bulk.armed ? "ちがいのまま請求ずみにする（もう一度押す）" : `えらんだ ${picked.length}件を請求ずみにする`;
    go.disabled = !picked.length;
  }

  function openBulk(keepScroll = false) {
    const panel = document.getElementById("panel");
    const y = keepScroll && panel ? panel.scrollTop : 0;
    st.openId = "";
    st.openOrderId = "";
    openSheet(bulkHTML(), p => {
      p.scrollTop = y;
      const w = p.querySelector("#bulkWrap");
      bulkCalc(w);
      w.addEventListener("change", e => {
        if (e.target.id === "bSup") {
          // 材料屋をえらんだら、その材料屋の「届いた・請求まだ」を全部えらんで、金額は納品書の金額から
          bulk.sup = e.target.value;
          bulk.pick = {};
          bulk.amt = {};
          bulk.totalManual = false;
          bulk.armed = false;
          bulk.done = "";
          for (const o of (st.orders || []).filter(x => x.status === "arrived" && x.supplier === bulk.sup)) {
            bulk.pick[o.id] = true;
            bulk.amt[o.id] = o.nouhin != null ? yen(o.nouhin) : "";
          }
          openBulk(true);
        } else if (e.target.dataset.bpick) {
          bulk.pick[e.target.dataset.bpick] = e.target.checked;
          bulk.armed = false;
          bulkCalc(w);
        }
      });
      w.addEventListener("input", e => {
        if (e.target.dataset.bamt) bulk.amt[e.target.dataset.bamt] = e.target.value;
        if (e.target.id === "bTotal") bulk.totalManual = !!e.target.value.trim();
        if (e.target.dataset.bamt || e.target.id === "bTotal") { bulk.armed = false; w.querySelector("#bErr").textContent = ""; bulkCalc(w); }
      });
      w.addEventListener("click", e => {
        if (e.target.id === "bGo") bulkGo(w, e.target).catch(ex => { w.querySelector("#bErr").textContent = errorText(ex); e.target.disabled = false; bulkCalc(w); });
      });
    }, { side: true });
  }

  async function bulkGo(w, btn) {
    const err = w.querySelector("#bErr");
    const sup = { id: bulk.sup, name: ((st.sups || {})[bulk.sup] || {}).name || "" };
    const rows = [];
    for (const [id, on] of Object.entries(bulk.pick)) {
      if (!on) continue;
      const o = (st.orders || []).find(x => x.id === id && x.status === "arrived");
      if (!o) continue;
      const a = toPrice(bulk.amt[id]);
      if (a == null) { err.textContent = `${o.chuban} の金額を入れてください（入れないなら、チェックを外してください）`; return; }
      rows.push({ o, amount: Math.round(a) });
      if (!sup.name) sup.name = o.supplierName;
    }
    if (!rows.length) { err.textContent = "請求ずみにする注文をえらんでください"; return; }
    const total = toPrice(w.querySelector("#bTotal").value);
    if (total == null) { err.textContent = "請求書の合計を入れてください"; return; }
    const sum = rows.reduce((s, x) => s + x.amount, 0);
    if (Math.round(total) !== sum && !bulk.armed) { bulk.armed = true; bulkCalc(w); return; }   // ちがうときは、もう一度押してもらう
    btn.disabled = true;
    btn.textContent = "しまっています…";
    await billMany(sup, rows, { no: w.querySelector("#bNo").value.trim(), date: w.querySelector("#bDate").value || ymd(0), total: Math.round(total) }, me);
    bulk.done = `${sup.name} の ${rows.length}件を請求ずみにしました（合計 ${yen(sum)}円）`;
    bulk.sup = "";
    bulk.pick = {};
    bulk.amt = {};
    bulk.totalManual = false;
    bulk.armed = false;
    toast(bulk.done);
    openBulk();
  }

  /** しまい終わったら、欄にカーソルが残っていても（Safari など）、中身をかきなおす */
  function afterSave(w) {
    const a = document.activeElement;
    if (a && w.contains(a)) a.blur();
    refreshPanel();
  }

  /** データが変わったら、出している中身もかきなおす（見ていた場所のまま。えらびかけの材料屋はのこす） */
  function refreshPanel() {
    const sh = document.getElementById("sheet");
    if (!sh || sh.hidden) return;
    const a = document.activeElement;
    if (st.openId && document.getElementById("reqWrap")) {
      if (a && a.closest && a.closest("#reqWrap") && a.matches("select, textarea")) return;   // えらんでいる途中はかきなおさない
      if (document.querySelector("#reqWrap .confirm")) return;   // 「本当に？」を出している途中はかきなおさない
      openReq(st.openId, true);
    } else if (st.openOrderId && document.getElementById("orderWrap")) {
      if (a && a.closest && a.closest("#orderWrap") && a.matches("input, textarea")) return;   // 金額などを入れている途中
      if (document.querySelector("#orderWrap .confirm")) return;   // 「本当に？」を出している途中はかきなおさない
      openOrder(st.openOrderId, true);
    }
  }

  /* ---------- 押したとき（一覧） ---------- */
  main.addEventListener("click", e => {
    // カードの中の「取り消し」のたしかめの所（理由の欄など）は、押してもカードを開かない
    if (e.target.closest(".rcx-box") && !e.target.closest("[data-rcxyes],[data-rcxno],[data-rrsyes]")) return;
    const t = e.target.closest("[data-rcx],[data-rcxyes],[data-rcxno],[data-rrs],[data-rrsyes],[data-newbox],[data-filter],[data-view],[data-next],[data-bill],[data-kouji],[data-reqopen],[data-req],[data-open],#billBtn,#lineBtn,#kakouBtn,#impBtn,#setBtn,#setBack,#clearQ");
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.rcx || d.rrs || "rcxno" in d) {
      st.cxAsk = d.rcx || ""; st.cxReason = ""; st.rsAsk = d.rrs || "";
      draw();
      const r = main.querySelector("#rcxReason");
      if (r) r.focus({ preventScroll: true });
    }
    else if (d.rcxyes) cancelReq(d.rcxyes, t).catch(ex => { t.disabled = false; toast(errorText(ex)); });
    else if (d.rrsyes) restoreReq(d.rrsyes, t).catch(ex => { t.disabled = false; toast(errorText(ex)); });
    else if ("newbox" in d) { st.view = "irai"; st.filter = "all"; draw(); }
    else if (d.filter) {
      // ようすの箱：その注文だけの一覧。もう一度押すと、しぼりこみをやめる
      st.filter = st.view !== "irai" && st.filter === d.filter ? "all" : d.filter;
      if (st.view === "irai") st.view = "orders";
      draw();
    }
    else if (d.view) { st.view = d.view; draw(); }
    else if (d.next) {
      const o = (st.orders || []).find(x => x.id === d.next);
      if (!o) return;
      t.disabled = true;
      markArrived(o, me).then(() => toast("「届いた」にしました。納品書の金額は、あとで入れられます"), ex => { t.disabled = false; toast(errorText(ex)); });
    }
    else if (d.bill) openOrder(d.bill, false, "#amtS");
    else if (d.kouji) { st.view = "orders"; st.q = d.kouji; $("#q", main).value = d.kouji; draw(); window.scrollTo({ top: 0 }); }
    else if (d.reqopen) openReq(d.reqopen);
    else if (d.req) openReq(d.req);
    else if (d.open) openOrder(d.open);
    else if (t.id === "billBtn") { bulk.done = ""; openBulk(); }
    else if (t.id === "impBtn") openImport({ sups: st.sups, getOrders: () => st.orders, me });
    else if (t.id === "kakouBtn") {   // 加工品の注文（図面つき）（10/15）
      openKakouOrder({ sups: st.sups, places: st.places, units: unitsList(), me, onPlaced: id => { st.view = "orders"; st.filter = "all"; draw(); waitOpen(id); } });
    }
    else if (t.id === "lineBtn") {
      openLineOrder({ sups: st.sups, places: st.places, catalog: st.catalog, me, onPlaced: id => { st.view = "orders"; st.filter = "all"; draw(); openOrder(id); } });
    }
    else if (t.id === "setBtn") showSettings(true);
    else if (t.id === "setBack") showSettings(false);
    else if (t.id === "clearQ") { st.q = ""; st.filter = "all"; $("#q", main).value = ""; draw(); }
  });
  main.addEventListener("keydown", e => {
    const c = e.target.closest && e.target.closest("[data-req],[data-open]");
    if (c && e.target === c && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      if (c.dataset.req) openReq(c.dataset.req); else openOrder(c.dataset.open);
    }
  });
  main.addEventListener("input", e => {
    if (e.target.id === "q") { st.q = e.target.value; draw(); }
    if (e.target.id === "rcxReason") st.cxReason = e.target.value;
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
  // ⚙ 設定の「会社・注文書」と、注文する人の電話番号（事務所だけ読める。注文の文・FAX に入れる。10/14）
  st.info = {};
  onValue(ref(db, "zairyo/officeInfo"), s => { st.info = s.val() || {}; }, () => { st.info = {}; });

  draw();
}
