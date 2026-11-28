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
import { $, esc, zenkana, toast, runChecks, openSheet, closeSheet, keepPlace } from "./common.js";
import { errorText } from "./touroku.js";
import { normCatalog, lineText, fmtQty, kibouText, ymd } from "./tanomu.js";
import { orderText, sendUrl, sendLabel, draftOrder, placeOrder, cancelOrder, ST, isLate, markArrived, markSent, isAppSup, appSentFields, sendToApp, supStateText, deliverPlan, backToWait, yen, toPrice, cost, slipsOf, addSlip, removeSlip, fixSupSlip, markBilled, backToArrived, billSlips, shimeOf, shimeText, billMonth, billPeriod, azkText, orderPdf, pdfLine, npSlipsOf, npDupOf, deliveredRows, notInOrder, checksOrd, sameThing, removeNpSlip, setRowOrd, lineDone, isLineOrder, LINE_NOTE, slipScans, isReturnSlip, hasReturn, isKakou, partOf, gotList, markGot, coveredBy, withOf, unWith, linesShort, FREE_PLACE, freePlace } from "./chumon.js";
import { renderSettings } from "./settei.js";
import { photosHTML, fillPhotos, attachHTML, linkLabel, shopOf, pageLink, SHOPS } from "./shashin.js";
import { openLineOrder } from "./line-chumon.js";
import { openImport } from "./nouhin.js";
import { openReqEdit, openOrderEdit } from "./naosu.js";
import { printFax, faxHTML } from "./fax.js";
import { htmlToPdf, pdfName, downloadBlob, loadPdfLibs } from "./pdf.js";
import { fileBlockHTML, wireFiles, filesOf, downloadFiles } from "./fairu.js";
import { openKakouOrder } from "./kakou.js";
import { slipFormHTML, wireSlipForm, readSlipForm } from "./kingaku.js";
import { CHUBAN_RE } from "./nippo.js";
import { quoteState, isOpenQuote, quoteCard, openQuoteForm, quoteHTML, wireQuote, qLines } from "./mitsumori.js";
import { openAzukari, azItems, lineSpec } from "./azukari.js";
import { readInvoiceFiles, invoiceSlips, checkInvoice, matchInvoice } from "./seikyu-ai.js";
import { matchSupplier } from "./line-parse.js";
import { placePickHTML, onFreeInput } from "./basho.js";
import { initNav, go as navGo, back as navBack, pushSnap, snapNow } from "./modoru.js";

/** 一覧・注文の画面の小さい印（加工品・見積から。10/15） */
const KIND_TAG = { kakou: "加工品", mekki: "めっき", mitsumori: "見積から", nouhin: "納品書から" };   // nouhin＝納品書の取りこみで作った注文（アプリで注文していない。10/30）
const kindTag = o => (KIND_TAG[o.kind] ? ` <span class="tag">${KIND_TAG[o.kind]}</span>` : "") + (o.supState ? ' <span class="tag">アプリ</span>' : "") + (hasReturn(o) ? ' <span class="tag ret-tag">返品・交換</span>' : "");   // 返品・交換の納品書がある（11/19）   // アプリ＝材料屋のアプリに送った注文（2-2）
/** 事務所で入れて、あとで「送った」を押す注文（加工品・めっき・見積から） */
const officeKind = o => o.kind === "kakou" || o.kind === "mekki" || o.kind === "mitsumori";

/** まだ材料屋に送っていない注文（加工品・見積から。「送った」を押すまで。10/15） */
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
/** 今日ほしい依頼（希望日が今日か、もう過ぎた日。「最短」は入れない。11/10 持ち主）。まだ注文しきっていない依頼だけ */
const isUrgent = r => isNew(r) && /^\d{4}-\d{2}-\d{2}$/.test(r.kibou || "") && r.kibou <= ymd(0);
/* ---------- 2-6（10/17 持ち主）：事務所の印。① 新しい（注文するまで）② 取り消し（現場が取り消した依頼。「わかりました」まで）
   ③ 返事なし（アプリに送った日のつぎの日（土日はのぞく）になっても、材料屋が受けていない）。④ 受けたは、知らせでわかるのでつけない ---------- */
const CX_MARK_FROM = Date.parse("2026-10-17T00:00:00+09:00");   // これより前の取り消しは、もう見たことにする
const genbaCxUnseen = r => r.status === "cancelled" && !r.cancelledBy && !r.officeCxSeenAt && (r.cancelledAt || 0) >= CX_MARK_FROM;
/** その日のつぎの、土日でない日の 0時 */
function nextWorkday(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}
const noReply = o => o.status === "wait" && o.supState === "sent" && typeof o.supSentAt === "number" && Date.now() >= nextWorkday(o.supSentAt);

/** スマホ・タブレットか（LINE の「送る」画面を文入りで開けるのは、スマホの LINE だけ） */
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** 注文の文をコピーする。sup をわたすと、その材料屋の送り方（Gmail・LINE）も開く（10/14）
 *  コピーした文は fb（下の欄）にも出す（うまくコピーできなかったときに、選んでコピーできるように）
 *  コピーは開く前にする（新しいタブが前に出ると、このページからはコピーできなくなるため）
 *  LINE は、パソコンでは開かない（LINE の説明に「LINE URLスキームは、デスクトップ版（macOS、Windows）のLINEではサポートされません」。
 *  line.me/R/share を開くと、Chrome で line.me のトップページが出るだけだった 10/14 持ち主）。コピーと「○○ をえらんで、貼り付けて」だけ
 *  メールのときは、注文書（見積依頼は見積依頼書）の PDF を作って「ダウンロード」に出す（11/2 事務員さん。js/pdf.js。加工品・めっきは作らない）。
 *  Gmail は、押してから間があきすぎると Chrome が開かせないので、PDF を待つのは2.5秒まで（できていなければ、Gmail を開いてから出す） */
let sending = false;   // PDF を作っている間に、もう一度押されたときは何もしない
async function copyOrSend(o, sup, fb, info = {}, pack = null) {
  if (sending) return;
  sending = true;
  try { await sendNow(o, sup, fb, info, pack); } finally { sending = false; }
}
async function sendNow(o, sup, fb, info, pack) {
  // pack＝見積依頼など、注文でないものを送るとき { text, url(sup, { pdf }), fax(), files, pdf() }（10/15 js/mitsumori.js の quotePack）
  // pdf()＝メールにつける PDF { what（注文書・見積依頼書）, html（FAX の紙）, name（ファイルの名前）, label（2枚以上のときの紙の下の名前） }。つけないときは null（11/2）
  const P = pack || {
    text: orderText(o, info), url: (s, opt) => sendUrl(s, o, info, opt), fax: () => printFax(o, sup, info), files: filesOf(o).map(([, f]) => f),
    pdf: orderPdf(o) ? () => ({ what: "注文書", html: faxHTML(o, sup, info, { mail: true }), name: pdfName("注文書", o.chuban, o.supplierName), label: `注文書　${o.chuban}　${o.supplierName}` }) : null,
  };
  const text = P.text;   // info＝⚙ 設定の「会社・注文書」と電話番号（決まり文句・電話番号が入る）
  // FAX（10/14）：注文書を印刷する画面を開く（印刷の画面で FAX 用のプリンターをえらぶ）。文のコピーもしておく
  if (sup && sup.send === "fax") {
    P.fax();
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
  const mail = !!sup && sup.send === "mail";
  fb.hidden = false;
  fb.querySelector("textarea").value = text;
  let copied = true;
  try { await navigator.clipboard.writeText(text); } catch (ex) { copied = false; fb.querySelector("textarea").select(); }
  const note = fb.querySelector(".send-note");
  // メールにつける PDF（11/2）：できたら先に「ダウンロード」へ。2.5秒でできていなければ、Gmail を開いてから
  const job = mail && P.pdf ? P.pdf() : null;
  let pdf = null, pdfErr = null, pdfLater = null;
  if (job) {
    note.textContent = `${job.what}の PDF を作っています…`;
    note.hidden = false;
    const made = htmlToPdf(job.html, { label: job.label }).then(blob => ({ blob, name: job.name }));
    made.catch(() => { });
    const r = await Promise.race([made.then(x => ({ x }), e => ({ e })), new Promise(res => setTimeout(res, 2500, null))]);
    if (!r) pdfLater = made;
    else if (r.x) { pdf = r.x; downloadBlob(pdf.blob, pdf.name); }
    else pdfErr = r.e;
  }
  const saidPdf = !!job && !pdfErr;   // 本文に「注文書（PDF）を添付しております。」を入れたか
  const url = sup && !lineCopyOnly ? P.url(sup, { pdf: saidPdf }) : "";
  if (url) window.open(url, "_blank", "noopener");
  if (pdfLater) {
    try { pdf = await pdfLater; downloadBlob(pdf.blob, pdf.name); } catch (ex) { pdfErr = ex; }
  }
  // 注文につけたファイル（注文書・図面）は、メールのときに「ダウンロード」に出す。Gmail を開く住所ではファイルをつけられないので、
  // Gmail のクリップで付けてもらう（10/15 事務所の相談）
  const files = url && mail ? P.files : [];
  let filesOk = false, filesErr = "";
  if (files.length) {
    try {
      await downloadFiles(files);
      filesOk = true;
    } catch (ex) {
      filesErr = "ファイルを「ダウンロード」に出せませんでした。「ファイル（注文書・図面）」の欄の「ダウンロード」から出してください。";
    }
  }
  // 「ダウンロード」に入れたもの（PDF とファイル）
  const what = job ? job.what : "";
  const got = [pdf ? `${what}の PDF（${pdf.name}）` : "", filesOk ? `ファイル${files.length}つ` : ""].filter(Boolean);
  const nDl = (pdf ? 1 : 0) + (filesOk ? files.length : 0);
  let dl = got.length ? `${got.join("と、")}を「ダウンロード」に入れました。Gmail のクリップ（📎）から付けて、送信してください。` +
    (nDl > 1 ? "（1回目だけ、Chrome が「複数のファイルのダウンロード」を聞きます。このページで「許可」を押してください）" : "") : "";
  if (pdfErr) dl += saidPdf ? `${what}の PDF は作れませんでした。本文の「${pdfLine(what)}」の行を消して送るか、Gmail を閉じて、もう一度押してください。`
    : `${what}の PDF は作れませんでした（ネットをたしかめて、もう一度押すと作りなおします）。`;
  dl += filesErr;
  // 送るときの知らせは、ボタンの下に残す（すぐ消える知らせだと、見落とすため）
  const who = sup && sup.lineTo ? `「${sup.lineTo}」` : "送り先";
  const msg = lineCopyOnly
      ? `${copied ? "文をコピーしました。" : "コピーできませんでした。下の文を選んでコピーしてから、"}LINE で${who}をえらんで、貼り付けて送ってください。`
    : !url ? ""
    : mail ? "Gmail を開きました。" + dl + (!sup.email ? "メールアドレスが入っていないので、宛先を入れてください（⚙ 設定 → 材料屋 で入れられます）。" : got.length || pdfErr ? "" : "中身を見て、送信してください。")
    : `LINE で${who}をえらんで、送ってください。文が入っていなければ、はりつけてください（コピーしてあります）。`;
  note.textContent = msg;
  note.hidden = !msg;
  if (lineCopyOnly) toast(copied ? `文をコピーしました。LINE で${who}をえらんでください` : "コピーできませんでした。下の文を選んでコピーしてください");
  else if (!url) toast(copied ? "注文の文をコピーしました。LINE やメールにはりつけられます" : "コピーできませんでした。下の文を選んでコピーしてください");
  else if (mail && pdfErr) toast(`Gmail を開きました。${what}の PDF は作れませんでした`);
  else if (mail && (job || files.length)) toast(got.length ? "「ダウンロード」に入れました。Gmail のクリップから付けてください" : "Gmail を開きました。ファイルは出せませんでした");
  else toast(mail ? "Gmail を開きました" : sup.lineTo ? `LINE で「${sup.lineTo}」をえらんでください` : "LINE を開きました");
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
  const TITLE0 = document.title;   // 「よつば資材便｜事務所」（依頼がないときのタブの名前）
  const st = {
    view: "irai", filter: "all", q: "", reqs: null, orders: null, catalog: null, sups: null, places: null,
    src: "",   // "nouhin"＝納品書から作った注文だけ（「注文ごと」「工事ごと」。10/30）
    openOrderId: "",   // いま中身を出している注文
    sheet: null,   // いま右に出している画面 { kind: "req"|"order"|"quote"|"bulk"|"form", id }（「← 戻る」でもどすため。11/28）
    gotAsk: "",   // 加工品の「届いた」で「全部か何個か」をえらんでいる注文（11/19）
    mOpen: new Set(),   // 開いている「▼ 明細を見る」（かきなおしても開いたまま。11/4）
    kojiOpen: {},   // 工事ごとの「届いた品物」を開いたか {注番: true/false}（11/4）
    settingsOpen: false,
    pick: {},        // 依頼ごとの、品物にえらんだ材料屋 {依頼id: {品物id: 材料屋id}}（「注文した」までは、この画面だけ）
    kib: {},         // 依頼ごとの、品物ごとに変えた希望日 {依頼id: {品物id: "最短" | "YYYY-MM-DD"}}（11/10。「注文した」までは、この画面だけ）
    gnote: {},       // 依頼ごとの、材料屋へのひとこと {依頼id: {まとまり: 文}}（11/10。はじめは現場のメモ）
    kibAsk: "", skipAsk: "", skipWhy: "", gplace: {}, placeAsk: "",   // gplace＝まとまりごとに変えた届け先 {依頼: {まとまり: {id, free}}}・placeAsk＝届け先を変えているまとまり（11/27）   // 希望日を変えている品物・「注文しない」をたしかめている品物（"依頼id/品物id"）と理由（11/10）
    openId: "",      // いま中身を出している依頼
    cxAsk: "", cxReason: "",   // 「取り消し」をたしかめている依頼と、書いている理由（10/14）
    rsAsk: "",                 // 「取り消しをもどす」をたしかめている依頼
    quotes: null, openQuoteId: "", qui: {},   // 見積（10/15）。qui＝見積の画面だけの状態 {見積: { editAns, ordering, askClose }}
  };

  main.innerHTML = `
    <div id="home" class="stack">
      <section class="boxes" id="boxes" aria-label="注文のようす"></section>
      <section class="entry" aria-labelledby="entryTitle">
        <h2 id="entryTitle">事務所から注文を入れる</h2>
        <div class="entry-btns">
          <button type="button" class="entry-btn" id="lineBtn"><b>＋ LINE・電話の注文</b><span>LINE や電話で来た注文を、そのまま入れます</span></button>
          <button type="button" class="entry-btn" id="kakouBtn"><b>＋ 加工品の注文（図面つき）</b><span>注文書・図面のファイルをつけて注文します。めっき依頼もここから</span></button>
          <button type="button" class="entry-btn" id="mitsuBtn"><b>＋ 見積依頼</b><span>材料屋に見積を出して、返事の金額で注文します</span></button>
        </div>
      </section>
      <section class="after" aria-labelledby="afterTitle">
        <h2 id="afterTitle">届いたあと</h2>
        <button type="button" class="btn" id="impBtn">納品書の取りこみ<small>スキャン・PDF・表から金額を入れる</small></button>
        <button type="button" class="btn" id="billBtn">請求書の取りこみ（まとめて請求）<small>月の請求書を AI で読んで、納品書と合わせます</small></button>
      </section>
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="見かた" id="seg">
          <button type="button" role="tab" data-view="irai">依頼</button>
          <button type="button" role="tab" data-view="orders">注文ごと</button>
          <button type="button" role="tab" data-view="kouji">工事（注番）<wbr>ごと</button>
          <button type="button" role="tab" data-view="mitsu">見積</button>
        </div>
        <input id="q" class="inp search" type="search" placeholder="注番・件名・品名・人でさがす" aria-label="さがす" autocomplete="off">
        <button type="button" class="btn" id="azBtn" hidden>預かり</button>
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
  const srcOk = o => !st.src || o.kind === st.src;
  /** 上の箱のしぼりこみに合うか。「納品書だけで入った注文」だけを見るときは、さがしていなければ請求ずみを出さない
   *  （11/5 持ち主。請求ずみは、上の「請求ずみ」を押すか、さがすと出る） */
  const statusOk = o => (st.filter === "all" ? !(st.src && o.status === "billed" && !st.q.trim()) : o.status === st.filter);
  const liveOrders = () => (st.orders || []).filter(o => o.status !== "cancelled" && matchOrder(o) && srcOk(o));
  /** 納品書から作った注文があるときだけ、一覧の上に出す（押すと、それだけの一覧。10/30）。
   *  まちがいの知らせに見えないように、目立つ色の帯にしないで1行の小さい字にする（11/5 事務員さんが心配した） */
  function srcBar() {
    const n = st.src ? 0 : (st.orders || []).filter(o => o.status !== "cancelled" && o.status !== "billed" && o.kind === "nouhin").length;   // まだ請求していない分だけ（11/5）
    return n ? `<div class="src-bar"><span class="src-t">アプリを通さず、納品書だけで入った注文（引き取りなど）</span><span class="src-n">：まだ請求していない ${n}件</span><button type="button" class="linkbtn muted" data-src="nouhin">見る</button></div>` : "";
  }

  /* ---------- 上の箱・タブ ---------- */
  function drawTop() {
    const n = newReqs().length;
    const box = (cls, c, label, num, attrs) =>
      `<button type="button" class="box ${cls}" ${attrs} style="--c:${c}"><span class="lab">${label}</span><span class="num">${num}<span class="unit">件</span></span></button>`;
    const base = liveOrders();
    const qOpen = (st.quotes || []).filter(isOpenQuote), qWait = qOpen.filter(q => quoteState(q).key === "wait").length;
    const ordersView = st.view === "orders" || st.view === "kouji";
    $("#boxes", main).innerHTML =
      box(`new${n ? " has" : ""}`, "var(--amber)", "現場からの新しい依頼", st.reqs ? n : "…", `data-newbox aria-pressed="${st.view === "irai"}"`) +
      // 見積の返事待ち（10/15）：押すと「見積」のタブ
      box(`new${qWait ? " has" : ""}`, "var(--amber)", "見積の返事待ち", st.quotes ? qWait : "…", `data-mitsubox aria-pressed="${st.view === "mitsu"}"`) +
      // 押すと、その注文だけの一覧（「注文ごと」）。もう一度押すと、しぼりこみをやめる
      ["wait", "arrived", "billed"].map(s => box("", ST[s].color, ST[s].label.replace("材料が", "材料が<wbr>").replace("・", "・<wbr>"),
        st.orders ? base.filter(o => o.status === s).length : "…",
        `data-filter="${s}" aria-pressed="${ordersView && st.filter === s}"`)).join("");
    const all = (st.reqs || []).filter(isNew).length, cxn = (st.reqs || []).filter(genbaCxUnseen).length;
    // ブラウザのタブの名前に、まだ注文していない依頼の数（上の箱と同じ数え方。0件のときは今まで通り。11/10 持ち主）
    document.title = st.reqs && all ? `（${all}）新しい依頼｜よつば資材便` : TITLE0;
    main.querySelectorAll("#seg [data-view]").forEach(b => {
      b.setAttribute("aria-selected", b.dataset.view === st.view);
      if (b.dataset.view === "irai") b.innerHTML = "依頼" + (all ? `<span class="badge">${all}</span>` : "") + (cxn ? `<span class="badge hot" title="現場が取り消した依頼（まだ見ていない）">取消${cxn}</span>` : "");
      if (b.dataset.view === "mitsu") b.innerHTML = "見積" + (qOpen.length ? `<span class="badge">${qOpen.length}</span>` : "");
    });
    const parts = [];
    if (ordersView && st.filter !== "all") parts.push(`「<b>${ST[st.filter].label}</b>」だけ`);
    if (ordersView && st.src) parts.push(st.filter === "all" && !st.q.trim()
      ? "「<b>納品書だけで入った注文</b>」の、まだ請求していない分だけ（請求ずみは、上の「請求ずみ」を押すか、さがすと出ます）"
      : "「<b>納品書だけで入った注文</b>」だけ");
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
  /** 品物の希望日を変える（依頼のとおりにしたら、変えていないことにする。11/10） */
  function setKib(r, id, v) {
    if (!v || v === (r.kibou || "最短")) delete kibsOf(r)[id];
    else kibsOf(r)[id] = v;
  }
  /** 品物を「注文しない」にする（11/10 事務員さん「1個だけ注文先が決まらない」）。のこりが全部済んだら（注文した・注文しない）依頼は済み */
  async function skipLine(r, lid, why) {
    const l = (r.lines || {})[lid];
    if (!l || l.orderId || isCancelled(r)) return;
    const w = String(why || "").trim().slice(0, 100);
    const rest = Object.entries(r.lines || {}).filter(([id, x]) => id !== lid && !x.orderId && !x.skip);
    const upd = { [`lines/${lid}/skip`]: { why: w, by: (me.name || "事務所").slice(0, 60), at: serverTimestamp() }, ...logEntry(r.id, `「${l.spec}」を注文しないにした${w ? `（${w}）` : ""}`) };
    if (!rest.length) upd.status = "ordered";
    await update(ref(db, `zairyo/requests/${r.id}`), upd);
    toast(`「${l.spec}」を注文しないにしました${rest.length ? "" : "（この依頼は、すべて済みました）"}`);
  }
  /** 「注文しない」をもどす（また注文できるようにする） */
  async function unskipLine(r, lid) {
    const l = (r.lines || {})[lid];
    if (!l || !l.skip) return;
    const upd = { [`lines/${lid}/skip`]: null, ...logEntry(r.id, `「${l.spec}」の「注文しない」をもどした`) };
    if (r.status === "ordered") upd.status = "sent";
    await update(ref(db, `zairyo/requests/${r.id}`), upd);
    toast(`「${l.spec}」を、また注文できるようにしました`);
  }
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
      status: "sent", cancelledAt: null, cancelledBy: null, cancelReason: null, officeCxSeenAt: null, officeCxSeenBy: null,
      ...logEntry(id, `取り消しをもどした（${r.cancelledBy ? "事務所" : "現場"}が取り消していた）`),
    });
    st.rsAsk = "";
    toast(`${r.chumonsha}さんの依頼（${r.chuban}）を、新しい依頼にもどしました`);
  }

  /** 現場が取り消した依頼を見た（「わかりました」。2-6） */
  async function seeCx(id, btn) {
    btn.disabled = true;
    await update(ref(db, `zairyo/requests/${id}`), { officeCxSeenAt: serverTimestamp(), officeCxSeenBy: me.name || "事務所" });
    toast("見ました（下の「取り消した依頼」に入りました）");
  }

  /* ---------- 一覧 ---------- */
  function reqCard(r) {
    const ls = linesOf(r), cx = isCancelled(r), done = r.status === "ordered";   // done＝済んだ（注文した・注文しない。11/10）
    const chip = cx ? "取り消された" : done ? "済み" : r.ordered ? "一部注文ずみ" : "新しい依頼";
    const hot = !genbaCxUnseen(r) && isUrgent(r);   // 今日ほしい（11/10）
    const mk = genbaCxUnseen(r) ? "cx" : hot ? "hot" : isNew(r) && !r.ordered ? "new" : "";   // 印（2-6）
    return `
      <article class="ocard${cx && !mk ? " cx" : ""}${mk ? ` mark-${mk}` : ""}" tabindex="0" data-req="${esc(r.id)}" style="--c:${cx ? "var(--grey)" : "var(--amber)"}">
        ${mk ? `<span class="bigmark">${{ cx: "取り消し", hot: "今日ほしい", new: "新しい" }[mk]}</span>` : ""}
        <div class="card-head"><span class="sup">${esc(r.chumonsha)}さんから</span>
          ${mk && !(mk === "hot" && r.ordered) ? "" : `<span class="ochip${cx || r.ordered || done ? "" : " solid"}">${chip}</span>`}</div>
        <div class="kouji"><span class="chuban">${esc(r.chuban)}</span><span class="kenmei">${esc(zenkana(r.kenmei))}</span></div>
        <div class="items">${esc(ls.map(l => lineText(l) + (l.skip ? "（注文しない）" : "")).join("\n"))}</div>
        <dl class="meta">
          <div><dt>希望日</dt><dd${hot ? ' class="hot-t"' : ""}>${esc(kibouText(r.kibou))}</dd></div>
          <div><dt>届け先</dt><dd>${esc(r.basho || "—")}</dd></div>
          ${r.tantou ? `<div><dt>担当</dt><dd>${esc(r.tantou)}</dd></div>` : ""}
          <div><dt>送った</dt><dd>${md(r.sentAt)} ${hm(r.sentAt)}</dd></div>
          ${r.contactedName ? `<div><dt>連絡ずみ</dt><dd class="hl">${esc(r.contactedName)}</dd></div>` : ""}
          ${cx ? `<div><dt>取り消し</dt><dd>${r.cancelledAt ? `${md(r.cancelledAt)} ${hm(r.cancelledAt)}・` : ""}${r.cancelledBy ? `事務所（${esc(r.cancelledBy)}）` : "現場"}${r.cancelReason ? `・${esc(r.cancelReason)}` : ""}</dd></div>` : ""}
        </dl>
        <div class="card-foot"><span class="amt"><span class="num">${ls.length}</span><span>点</span></span>
          <span class="row">${genbaCxUnseen(r) ? `<button type="button" class="btn primary" data-rcxseen="${esc(r.id)}">わかりました</button>`
            : cx ? `<button type="button" class="btn" data-rrs="${esc(r.id)}">取り消しをもどす</button>` : done ? "" : `<button type="button" class="btn danger" data-rcx="${esc(r.id)}">取り消し</button>`}
          <button type="button" class="btn${cx || done ? "" : " primary"}" data-reqopen="${esc(r.id)}">${cx || done ? "中身を見る" : "材料屋を決める"}</button></span></div>
        ${st.cxAsk === r.id && !cx ? cxBoxHTML(r) : ""}${st.rsAsk === r.id && cx ? rsBoxHTML(r) : ""}
      </article>`;
  }

  /* 注文のカード（試作の cardHTML と同じ） */
  function orderCard(o) {
    const s = ST[o.status] || ST.wait, late = isLate(o, ymd(0)), cx = o.status === "cancelled", unsent = isUnsent(o), nr = noReply(o);
    const pt = isKakou(o) && o.status === "wait" ? partOf(o) : null, part = !!(pt && pt.any && !pt.done);   // 加工品の一部届いた（11/19）
    return `
      <article class="ocard${cx ? " cx" : ""}${unsent ? " unsent" : ""}${nr ? " mark-late" : part ? " mark-part" : ""}" tabindex="0" data-open="${esc(o.id)}" style="--c:${s.color}">
        ${nr ? '<span class="bigmark">返事なし</span>' : part ? `<span class="bigmark">一部届いた ${pt.got}/${pt.want}</span>` : ""}
        <div class="card-head"><span class="sup">${esc(o.supplierName)}${kindTag(o)}</span>
          ${nr ? "" : `<span class="ochip${o.status === "wait" ? " solid" : o.status === "arrived" ? " blue" : ""}">${unsent ? "まだ送っていない" : s.chip}</span>`}</div>
        <div class="kouji"><span class="chuban">${esc(o.chuban)}</span><span class="kenmei">${esc(zenkana(o.kenmei))}</span></div>
        <div class="items">${esc(Object.values(o.lines || {}).map(l => lineText(l) + azkText(l)).join("\n"))}</div>
        <dl class="meta">
          <div><dt>希望日</dt><dd${late ? ' class="late"' : ""}>${esc(kibouText(o.kibou))}${late ? "（すぎています）" : ""}</dd></div>
          <div><dt>届け先</dt><dd>${esc(o.basho || "—")}</dd></div>
          <div><dt>注文者</dt><dd>${esc(o.chumonsha || "—")}</dd>${o.tantou ? `<dt class="tan">担当</dt><dd>${esc(o.tantou)}</dd>` : ""}</div>
          <div><dt>${o.kind === "nouhin" ? "入れた" : "注文した"}</dt><dd>${md(o.orderedAt)}</dd></div>
          ${deliverPlan(o) ? `<div><dt>届く予定</dt><dd>${esc(deliverPlan(o))}</dd></div>` : ""}
          ${part ? `<div><dt>届いた</dt><dd>${pt.want}中 ${pt.got}（のこり ${Math.max(0, pt.want - pt.got)}）</dd></div>` : ""}
          ${nr ? `<div><dt>アプリに送った</dt><dd>${md(o.supSentAt)} ${hm(o.supSentAt)}</dd></div>` : ""}
        </dl>
        ${nr ? '<p class="hint warn nr-note">材料屋がまだ受けていません。電話して、たしかめてください。</p>' : ""}
        <div class="card-foot">${amtHTML(o)}
          ${unsent ? (isAppSup(st.sups && st.sups[o.supplier]) ? '<span class="hint warn">開いて「アプリに送る」</span>' : '<span class="hint warn">開いて「メールで送る」→ 送信したら「送った」</span>')
            : o.status === "wait" ? `<button type="button" class="btn primary" data-next="${esc(o.id)}">届いた</button>`
            : o.status === "arrived" ? `<button type="button" class="btn" data-bill="${esc(o.id)}">請求が来た</button>` : ""}</div>
      </article>`;
  }

  /** 並び：まだ届いていない → 届いた → 請求ずみ。その中で、希望日がすぎた注文が上、そのあと新しい順 */
  function sortOrders(list) {
    const rank = { wait: 0, arrived: 1, billed: 2, cancelled: 3 }, today = ymd(0);
    return list.slice().sort((a, b) => (rank[a.status] - rank[b.status]) || ((isUnsent(b) ? 1 : 0) - (isUnsent(a) ? 1 : 0))   // まだ送っていない加工品がいちばん上
      || ((noReply(b) ? 1 : 0) - (noReply(a) ? 1 : 0))   // 返事なし（2-6）もその上のほう
      || ((isLate(b, today) ? 1 : 0) - (isLate(a, today) ? 1 : 0)) || ((b.orderedAt || 0) - (a.orderedAt || 0)));
  }

  function drawOrders(list) {
    if (!st.orders) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const shown = sortOrders(liveOrders().filter(statusOk));
    const cxs = st.filter === "all" ? sortOrders((st.orders || []).filter(o => o.status === "cancelled" && matchOrder(o) && srcOk(o))) : [];
    list.innerHTML = srcBar() + kojiItemsHTML() +
      (shown.length ? `<div class="ocards">${shown.map(orderCard).join("")}</div>` : '<p class="empty">あてはまる注文はありません。</p>') +
      (cxs.length ? `<details class="block hidbox" id="cxOrders"><summary>取り消した注文（${cxs.length}）</summary><div class="ocards">${cxs.map(orderCard).join("")}</div></details>` : "");
  }

  /** 工事ごとの「届いた品物」（11/4 事務員さん）：さがす欄が注番（工事のカードを押したとき）なら、一覧のいちばん上に、
   *  その注番の全部の注文（材料屋がちがっても）の納品書の明細を1つの表で。10品までは開いて出す。行を押すと、その注文 */
  function kojiItemsHTML() {
    const cb = st.q.trim().normalize("NFKC").toUpperCase();
    if (!CHUBAN_RE.test(cb)) return "";
    const os = (st.orders || []).filter(o => o.status !== "cancelled" && o.chuban === cb);
    const rows = os.flatMap(o => deliveredRows(o).map(x => ({ ...x, o })))
      .sort((a, b) => (b.s.date || "").localeCompare(a.s.date || "") || (b.s.at || 0) - (a.s.at || 0));
    if (!rows.length) return "";
    const total = os.reduce((t, o) => t + (o.nouhin || 0), 0), open = st.kojiOpen[cb] ?? rows.length <= 10;
    return `<div class="block koji-items"><h3>${esc(cb)} で届いた品物</h3>
        <p class="hint">材料屋の納品書から。全部の材料屋・全部の注文の分です。行を押すと、その注文が開きます。注文者は、アプリの注文の注文者です（注文にない品物は —）。</p>
        <details class="mrows" data-koji="${esc(cb)}"${open ? " open" : ""}><summary><span class="ar op">▼</span><span class="op">品物を見る（${rows.length}品・${yen(total)}円）</span><span class="ar cl">▲</span><span class="cl">品物をとじる</span></summary>
          ${deliveredTable(rows, { sup: true, who: true, total })}</details></div>`;
  }

  /* 工事（注番）ごと：注番ごとの注文の数。押すと、その注番の注文だけの一覧 */
  function drawKouji(list) {
    if (!st.orders) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const groups = new Map();
    liveOrders().filter(statusOk).forEach(o => {
      if (!groups.has(o.chuban)) groups.set(o.chuban, []);
      groups.get(o.chuban).push(o);
    });
    if (!groups.size) { list.innerHTML = srcBar() + '<p class="empty">あてはまる工事はありません。</p>'; return; }
    const cards = [...groups.entries()].sort((a, b) => b[0].slice(2).localeCompare(a[0].slice(2)) || a[0].localeCompare(b[0])).map(([cb, os]) => {
      const w = os.filter(o => o.status === "wait").length, a = os.filter(o => o.status === "arrived").length;
      const color = w ? "var(--amber)" : a ? "var(--blue)" : "var(--grey)";
      const latest = os.reduce((x, o) => (o.orderedAt || 0) > (x.orderedAt || 0) ? o : x, os[0]);
      const total = os.reduce((t, o) => t + (cost(o) || 0), 0), noAmt = os.filter(o => cost(o) == null).length;
      const mekki = os.filter(o => o.kind === "mekki").reduce((t, o) => t + (cost(o) || 0), 0);   // めっき代（材料費に入っている。10/15）
      // 担当（工事の担当。11/4）：新しい注文の担当から。ちがう担当がいれば3人まで並べて、それより多ければ「ほか」。空なら出さない
      const tans = [...new Set(os.slice().sort((a, b) => (b.orderedAt || 0) - (a.orderedAt || 0)).map(o => (o.tantou || "").trim()).filter(Boolean))];
      return `
        <button type="button" class="kcard" data-kouji="${esc(cb)}" style="--c:${color}">
          <span class="kouji"><span class="chuban">${esc(cb)}</span><span class="kenmei">${esc(zenkana(latest.kenmei))}</span>${tans.length ? `<span class="ktan">担当 <b>${esc(tans.slice(0, 3).join("・"))}</b>${tans.length > 3 ? " ほか" : ""}</span>` : ""}</span>
          <span class="kstats"><span>注文 <b>${os.length}</b> 件</span><span>材料がまだ届いていない <b>${w}</b></span><span>請求まだ <b>${a}</b></span></span>
          <span class="kcost"><span class="lab">材料費</span><span><span class="num big">${yen(total)}</span><span class="yen">円</span></span>
            ${mekki ? `<span class="khint">うち めっき代 ${yen(mekki)}円</span>` : ""}
            <span class="khint">${noAmt ? `金額が入っていない注文が ${noAmt} 件あります` : "全部の金額が入っています"}</span></span>
        </button>`;
    }).join("");
    list.innerHTML = srcBar() + `<div class="ocards">${cards}</div>`;
  }

  /* 見積（10/15）：やることがある順（まだ送っていない → 返事が来た → 返事待ちの古い順）。注文した・やめたものは下にたたむ */
  function matchQuote(q) {
    const s = st.q.trim().normalize("NFKC").toLowerCase();
    if (!s) return true;
    return [q.chuban, q.kenmei, q.kojiTantou, q.tantou, q.memo, ...Object.values(q.sups || {}).map(x => x.name), ...qLines(q).map(([, l]) => l.spec)]
      .some(v => String(v || "").normalize("NFKC").toLowerCase().includes(s));
  }
  function drawQuotes(list) {
    if (!st.quotes) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const rank = { unsent: 0, answered: 1, wait: 2 };
    const firstSent = q => Math.min(...Object.values(q.sups || {}).map(x => x.sentAt || Infinity));
    const open = st.quotes.filter(q => isOpenQuote(q) && matchQuote(q))
      .sort((a, b) => (rank[quoteState(a).key] - rank[quoteState(b).key]) || (firstSent(a) - firstSent(b)) || ((b.createdAt || 0) - (a.createdAt || 0)));
    const done = st.quotes.filter(q => !isOpenQuote(q) && matchQuote(q)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    list.innerHTML =
      (open.length ? `<div class="ocards">${open.map(quoteCard).join("")}</div>`
        : `<p class="empty">${st.q.trim() ? "あてはまる見積はありません。" : "返事を待っている見積は、ありません。<br>上の「＋ 見積依頼」から作れます。"}</p>`) +
      (done.length ? `<details class="block hidbox" id="qDone"><summary>注文した・やめた見積（${done.length}）</summary><div class="ocards">${done.map(quoteCard).join("")}</div></details>` : "");
  }

  function drawList() {
    const list = $("#list", main);
    if (st.view === "orders") return drawOrders(list);
    if (st.view === "kouji") return drawKouji(list);
    if (st.view === "mitsu") return drawQuotes(list);
    if (!st.reqs) { list.innerHTML = '<p class="muted">読んでいます…</p>'; return; }
    const news = newReqs().sort((a, b) => isUrgent(b) - isUrgent(a));   // 今日ほしい依頼を、いちばん上に（11/10。ほかは今まで通り新しい順）
    const cxNew = st.reqs.filter(r => genbaCxUnseen(r) && matchReq(r));   // 2-6
    const cxs = st.reqs.filter(r => isCancelled(r) && !genbaCxUnseen(r) && matchReq(r));
    // 「注文しない」にした品物がある、済んだ依頼（11/10）：たたんでおく（まちがえたときに、ここから開いて「もどす」）
    const skips = st.reqs.filter(r => r.status === "ordered" && linesOf(r).some(l => l.skip) && matchReq(r));
    list.innerHTML =
      (cxNew.length ? `<h3 class="sec-h">現場が取り消した依頼（見たら「わかりました」）</h3><div class="ocards">${cxNew.map(reqCard).join("")}</div>` : "") +
      (news.length
        ? `<div class="ocards">${news.map(reqCard).join("")}</div>`
        : `<p class="empty">${st.q.trim() ? "あてはまる依頼はありません。" : "新しい依頼はありません。<br>現場のスマホから送られた注文が、ここに来ます。"}</p>`) +
      (skips.length ? `<details class="block hidbox" id="skipBox"><summary>「注文しない」の品物がある、済んだ依頼（${skips.length}）</summary><div class="ocards">${skips.map(reqCard).join("")}</div></details>` : "") +
      (cxs.length ? `<details class="block hidbox" id="cxBox"><summary>取り消した依頼（${cxs.length}）</summary><div class="ocards">${cxs.map(reqCard).join("")}</div></details>` : "");
  }

  /** keep＝データが変わったときのかきなおし（見ていたカードを同じ高さにのこす。js/common.js の keepPlace。11/2 持ち主「画面が勝手に上に飛ぶ」）。
   *  タブ・箱・さがす を押したときは、ふつうにかきなおす */
  function draw(keep = false) {
    const go = () => {
      const open = [...main.querySelectorAll("#list details[id][open]")].map(d => d.id);
      drawTop();
      drawList();
      for (const id of open) { const d = $(`#${id}`, main); if (d) d.open = true; }
    };
    if (keep) keepPlace($("#list", main), "[data-open],[data-req],[data-quote],[data-kouji]", go);
    else go();
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

  /** 品物ごとの希望日（変えていなければ依頼の希望日。11/10） */
  const kibsOf = r => st.kib[r.id] || (st.kib[r.id] = {});
  const kibOf = (r, id) => kibsOf(r)[id] || r.kibou || "最短";
  /** 材料屋ごとのまとまり（まだ注文していない品物だけ。「注文しない」にした品物も入れない）。
   *  同じ材料屋でも希望日がちがえば、まとまりを分ける（注文も2つになる。11/10 事務員さん）→ { groups: [{key, sid, kibou, ids}], none } */
  function groupsOf(r) {
    const p = picksOf(r), m = new Map(), none = [];
    for (const [id, l] of Object.entries(r.lines || {})) {
      if (l.orderId || l.skip) continue;
      const s = p[id];
      if (!s || !st.sups || !st.sups[s]) { none.push(id); continue; }
      const kibou = kibOf(r, id), key = `${s}|${kibou}`;
      if (!m.has(key)) m.set(key, { key, sid: s, kibou, ids: [] });
      m.get(key).ids.push(id);
    }
    return { groups: [...m.values()], none };
  }
  /** 材料屋へのひとこと（まとまりごと。はじめは現場のメモ。11/10） */
  const noteOf = (r, key) => { const n = st.gnote[r.id] || (st.gnote[r.id] = {}); return key in n ? n[key] : r.memo || ""; };
  const bashoText = r => ((st.places || {})[r.bashoId] || {}).text || "";
  /** まとまりの届け先（11/27）：変えていなければ依頼の届け先。変えたら届け先の一覧の所か、手で書いた所 → { id, free, changed, empty, basho, bashoText } */
  const gPlaceOf = (r, key) => {
    const g = ((st.gplace || {})[r.id] || {})[key];
    if (!g) return { id: r.bashoId || "", free: "", changed: false, basho: r.basho || "", bashoText: bashoText(r) };
    if (g.id === FREE_PLACE) { const fp = freePlace(g.free); return { id: FREE_PLACE, free: g.free || "", changed: true, empty: !fp, basho: fp ? fp.basho : "", bashoText: fp ? fp.bashoText : "" }; }
    const p = (st.places || {})[g.id] || {};
    return { id: g.id, free: g.free || "", changed: g.id !== r.bashoId, basho: p.name || "", bashoText: p.text || "" };
  };
  /** まとまりの届け先の札と、変える所（届け先のボタン＋「ほか（手で書く）」） */
  const gPlaceHTML = (r, key) => {
    const pl = gPlaceOf(r, key), K = esc(key), open = st.placeAsk === `${r.id}|${key}`;
    const list = Object.entries(st.places || {}).filter(([, p]) => p && !p.hidden).sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));
    return {
      tag: `<button type="button" class="g-tag g-ptag${pl.changed ? " kib-on" : ""}" data-gplace="${K}" aria-expanded="${open}">届け先 ${esc(pl.id === FREE_PLACE ? pl.basho || "（書いてください）" : pl.basho || "なし")}（変える）</button>`,
      box: open ? `<div class="g-place" data-gkey="${K}"><span class="lab">この注文の届け先${pl.changed ? "（現場がえらんだ届け先から変えました）" : "（はじめは現場がえらんだ届け先）"}</span>${placePickHTML(list, pl.id, { attr: "gbasho", free: pl.free })}</div>` : "",
    };
  };
  /** 単位の一覧（品物一覧の units。まだ読めていなければ、よく使うもの） */
  const unitsList = () => (st.catalog && st.catalog.units && st.catalog.units.length ? st.catalog.units : ["個", "本", "組", "枚", "m", "kg", "式", "セット"]);

  /** 品物の希望日を変える（11/10）：最短・今日・あした・日付。依頼のとおりにもどせる */
  function kibAskHTML(r, id) {
    const now = kibOf(r, id), t = ymd(0), tm = ymd(1), base = r.kibou || "最短";
    const b = (v, label) => `<button type="button" data-kibset="${esc(id)}" data-v="${esc(v)}" aria-pressed="${now === v}">${esc(label)}</button>`;
    return `<div class="lask"><span class="lab">この品物の希望日（同じ材料屋でも、希望日がちがえば注文を分けます）</span>
      <div class="pick sm">${b("最短", "最短")}${b(t, "今日")}${b(tm, "あした")}</div>
      <div class="row"><input class="inp kib-date" type="date" data-kibdate="${esc(id)}" min="${t}" value="${/^\d{4}-/.test(now) ? esc(now) : ""}" aria-label="日付をえらぶ">
        ${now !== base ? `<button type="button" class="linkbtn muted" data-kibset="${esc(id)}" data-v="${esc(base)}">依頼のとおり（${esc(kibouText(base))}）にもどす</button>` : ""}
        <button type="button" class="linkbtn muted" data-kibclose>とじる</button></div></div>`;
  }
  /** 「注文しない」のたしかめ（11/10）。理由は書かなくてもよい */
  function skipAskHTML(r, id) {
    return `<div class="lask confirm"><span class="lab">「${esc(r.lines[id].spec)}」を注文しないにしますか？（現場のスマホにも「事務所：注文しない」と出ます）</span>
      <input class="inp" data-skipwhy maxlength="100" placeholder="理由（例：現場が自分で買う・ほかで手配した）" value="${esc(st.skipWhy)}" aria-label="注文しない理由">
      <div class="row"><button type="button" class="btn" data-skipyes="${esc(id)}">注文しないにする</button><button type="button" class="linkbtn muted" data-skipno>やめる</button></div></div>`;
  }

  function reqHTML(r) {
    const ls = Object.entries(r.lines || {}), cx = isCancelled(r);
    const catName = c => (st.catalog && (st.catalog.cats.find(x => x.id === c) || {}).name) || "";
    const p = cx ? {} : picksOf(r);
    const orderById = id => (st.orders || []).find(o => o.id === id);
    const rows = ls.map(([id, l]) => {
      const o = l.orderId ? orderById(l.orderId) : null, k = `${r.id}/${id}`;
      const kb = kibOf(r, id), kbChanged = !l.orderId && !l.skip && kb !== (r.kibou || "最短");
      // まだ注文していない品物：材料屋をえらぶ ＋ 小さい「希望日を変える」「注文しない…」（11/10。まちがって押さないように目立たなくする）
      const small = `<div class="lsub">
          <button type="button" class="linkbtn muted" data-kibask="${esc(id)}">${kbChanged ? `希望日 ${esc(kibouText(kb))}（変える）` : "希望日を変える"}</button>
          <button type="button" class="linkbtn muted" data-skipask="${esc(id)}">注文しない…</button></div>`;
      const sup = cx ? ""
        : l.orderId ? `<span class="done-sup">✓ 注文ずみ<br>${esc(o ? o.supplierName : "")}</span>`
        : l.skip ? `<span class="skip-sup">注文しない${l.skip.why ? `<br><small>${esc(l.skip.why)}</small>` : ""}</span>
            <div class="lsub"><button type="button" class="linkbtn muted" data-unskip="${esc(id)}">もどす（注文する）</button></div>`
        : `<select class="inp" data-pick="${esc(id)}" aria-label="${esc(l.spec)} の材料屋">
            <option value="">材料屋をえらぶ</option>
            ${supList().map(([sid, s]) => `<option value="${esc(sid)}"${p[id] === sid ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>${small}`;
      return `
        <div class="lrow${cx ? "" : " has-sup"}${l.orderId ? " ordered" : ""}${l.skip ? " skipped" : ""}">
          <div class="lspec">${catName(l.cat) ? `<span class="tag">${esc(catName(l.cat))}</span>` : ""}${esc(l.spec)}${l.note ? " " + esc(l.note) : ""}${kbChanged ? ` <span class="tag kib-tag">希望日 ${esc(kibouText(kb))}</span>` : ""}${lineAttach(l)}</div>
          <div class="lqty"><span class="num">${esc(fmtQty(l.qty))}</span>${esc(l.unit)}</div>
          ${cx ? "" : `<div class="lsup">${sup}</div>`}
          ${!cx && st.kibAsk === k ? kibAskHTML(r, id) : ""}${!cx && st.skipAsk === k ? skipAskHTML(r, id) : ""}
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
          <dt>希望日</dt><dd${isUrgent(r) ? ' class="hot-t"' : ""}>${esc(kibouText(r.kibou))}${isUrgent(r) ? '　<span class="tag hot-tag">今日ほしい</span>' : ""}</dd>
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
        <button type="button" class="btn big full close-big" data-close>閉じる</button>
      </div>`;
  }

  /* ---------- 預かり（11/2 シンプル版。台帳は js/azukari.js） ---------- */
  const azOn = sid => !!(st.sups && st.sups[sid] && st.sups[sid].azukari);
  /** ほかのまだ届いていない注文で「預かりから」にしている数（その預かりの品物ぶん） */
  const azPlanned = (sid, iid, exceptId = "") => (st.orders || []).filter(o => o.supplier === sid && o.status === "wait" && o.id !== exceptId)
    .reduce((t, o) => t + Object.values(o.lines || {}).filter(l => l.azk === iid && l.azkQty > 0 && !l.azkDone).reduce((u, l) => u + Number(l.azkQty), 0), 0);
  /** その材料屋の預かりに、この品物があるか → { iid, x, planned（ほかの注文で使う予定）, avail（それをひいた残り） } か null
   *  品名・単位が同じもの。もう「預かりから」にしてある品物は、その預かりの品物 */
  function azMatch(sid, l, exceptId = "") {
    if (!azOn(sid) || !l) return null;
    const items = ((st.az || {})[sid] || {}).items || {}, full = lineSpec(l);
    const hit = l.azk && items[l.azk] ? [l.azk, items[l.azk]] : azItems((st.az || {})[sid]).find(([, x]) => x.unit === l.unit && (x.spec === full || x.spec === l.spec));
    if (!hit) return null;
    const planned = azPlanned(sid, hit[0], exceptId);
    return { iid: hit[0], x: hit[1], planned, avail: Math.max(0, Number(hit[1].qty) - planned) };
  }
  const azLeftText = m => "預かりにあり（残り " + fmtQty(m.avail) + m.x.unit + (m.planned ? "・ほかの注文で " + fmtQty(m.planned) + m.x.unit + " 使う予定" : "") + "）";
  const azRestText = (l, q) => (q > Number(l.qty) ? "注文の数（" + fmtQty(l.qty) + l.unit + "）より多いです" : Number(l.qty) - q > 0 ? "のこり " + fmtQty(Number(l.qty) - q) + l.unit + "は 新しく用意" : "（全部 預かりから）");
  const azNum = v => { const n = parseFloat(String(v ?? "").normalize("NFKC").replace(/[,，\s]/g, "")); return Number.isFinite(n) ? n : null; };
  const azKey = (r, id) => r.id + "/" + id;
  /** 依頼から注文するときの「預かりにあり（残り○本）」＋「預かりから」＋数の欄 */
  function azRowHTML(r, sid, id) {
    const l = r.lines[id], m = azMatch(sid, l);
    if (!m || m.avail <= 0) return "";
    const q = (st.azWant || {})[azKey(r, id)], on = q != null;
    return ` <span class="tag az-tag">${esc(azLeftText(m))}</span>
      <div class="azrow"><button type="button" class="btn az-want" data-azw="${esc(id)}" aria-pressed="${on}">${on ? "✓ 預かりから" : "預かりから"}</button>
        ${on ? `<input class="inp az-q" data-azq="${esc(id)}" inputmode="decimal" value="${esc(fmtQty(q))}" aria-label="預かりから出す数"><span>${esc(l.unit)}</span>
          <span class="hint" data-azrest="${esc(id)}">${esc(azRestText(l, q))}</span>` : ""}</div>`;
  }
  /** 「預かりから」の数のたしかめ → まちがいの文か "" */
  function azErr(l, q, m) {
    if (!(q > 0)) return l.spec + "：預かりから出す数を入れてください";
    if (q > Number(l.qty)) return l.spec + "：預かりから出す数が、注文の数（" + fmtQty(l.qty) + l.unit + "）より多いです";
    if (!m || q > m.avail) return l.spec + "：預かりの残り（" + (m ? fmtQty(m.avail) : 0) + l.unit + "）より多いです";
    return "";
  }

  /** 注文の中身の品物の行の「預かりから」（11/2）：まだ届いていない注文で、預かりを使う材料屋のときだけ。届くまで、押す・外す・数を直すができる */
  function oAzHTML(o, lid, l) {
    if (o.status !== "wait" || !azOn(o.supplier) || l.azkDone) return "";
    const m = azMatch(o.supplier, l, o.id), set = l.azkQty > 0;
    if (!set && (!m || m.avail <= 0)) return "";
    if (st.oazEdit === o.id + "/" + lid) {
      const q = st.oazVal ?? (set ? Number(l.azkQty) : Math.min(Number(l.qty), m.avail));
      return `${m ? `<div class="azrow"><span class="tag az-tag">${esc(azLeftText(m))}</span></div>` : ""}
        <div class="azrow"><span>預かりから</span><input class="inp az-q" data-oazq="${esc(lid)}" inputmode="decimal" value="${esc(fmtQty(q))}" aria-label="預かりから出す数"><span>${esc(l.unit)}</span>
          <span class="hint" data-oazrest>${esc(azRestText(l, q))}</span></div>
        <div class="row"><button type="button" class="btn primary" data-oazsave="${esc(lid)}">この数にする</button>
          ${set ? `<button type="button" class="btn" data-oazoff="${esc(lid)}">預かりから外す</button>` : ""}
          <button type="button" class="btn" data-oazno>やめる</button></div>`;
    }
    return set ? ` <div class="azrow"><span class="tag az-tag">預かりから ${esc(fmtQty(l.azkQty))}${esc(l.unit)}</span><button type="button" class="linkbtn" data-oaz="${esc(lid)}">直す・外す</button></div>`
      : ` <span class="tag az-tag">${esc(azLeftText(m))}</span> <div class="azrow"><button type="button" class="btn az-want" data-oaz="${esc(lid)}">預かりから</button></div>`;
  }

  function groupsHTML(r) {
    const { groups, none } = groupsOf(r);
    const many = sid => groups.filter(g => g.sid === sid).length > 1;   // 同じ材料屋で、希望日ちがいのまとまりがある
    let h = "<h3>2. 材料屋ごとに注文する</h3>";
    if (groups.length) {
      h += `<div class="groups">${groups.map(({ key, sid, kibou, ids }) => {
        const s = st.sups[sid], K = esc(key);
        // 希望日（11/10）：依頼とちがうか、同じ材料屋で分かれたときは目立たせる
        const kTag = `<span class="g-tag${kibou !== (r.kibou || "最短") || many(sid) ? " kib-on" : ""}">希望日 ${esc(kibouText(kibou))}</span>`;
        const gp = gPlaceHTML(r, key);   // 届け先（11/27 事務員さん：たまに他社など。事務所が注文のときに変える）
        // 材料屋へのひとこと（11/10）：注文の文・メール・PDF・FAX・材料屋のアプリに入る。はじめは現場のメモ
        const note = `<label class="field g-note"><span class="lab">材料屋へのひとこと（注文の文に入ります。なければ空）</span>
            <textarea class="inp ta" rows="2" maxlength="500" data-gnote="${K}" placeholder="例：午前中に届けてください">${esc(noteOf(r, key))}</textarea></label>`;
        if (s.send === "net") return `
          <div class="group">
            <div class="g-head"><span class="sup">${esc(s.name)}</span><span class="g-tag">ネットで買う</span>${kTag}<span class="hint g-n">${ids.length}点</span></div>
            ${netLinesHTML(s, ids.map(id => r.lines[id]))}
            <div class="row"><button type="button" class="btn" data-chuban="${esc(r.chuban)}">注番をコピー</button>
              <button type="button" class="btn primary" data-gorder="${K}">注文した</button></div>
            <p class="hint">お店のページで買ってから、「注文した」を押してください。注番は、お店の備考などの欄にはりつけておくと、あとで納品書と合わせやすくなります。</p>
          </div>`;
        // 材料屋のアプリで受ける材料屋（2回目・2-2）：「アプリに送る」で注文がとどく（持ち主 B）
        if (isAppSup(s)) return `
          <div class="group">
            <div class="g-head"><span class="sup">${esc(s.name)}</span><span class="g-tag">材料屋のアプリ</span>${kTag}${gp.tag}<span class="hint g-n">${ids.length}点</span></div>${gp.box}
            <ul class="g-lines">${ids.map(id => { const l = r.lines[id], n = Object.keys(l.photos || {}).length;
              return `<li>${esc(lineText(l))}${n ? ` <span class="tag">写真${n}枚</span>` : ""}${l.link ? ` <span class="tag">リンクつき</span>` : ""}${azRowHTML(r, sid, id)}</li>`; }).join("")}</ul>
            ${note}
            <div class="row"><button type="button" class="btn primary" data-gapp="${K}">アプリに送る（注文する）</button>
              <button type="button" class="btn" data-gcopy="${K}">注文の文をコピー</button></div>
            <div class="field" data-gfb="${K}" hidden><p class="send-note" role="status" hidden></p><span class="lab">コピーした文（うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
              <textarea class="inp ta copybox" rows="12" readonly></textarea></div>
            <p class="hint">押すと、${esc(s.name)} のアプリに注文がとどいて「注文した」になります。</p>
          </div>`;
        return `
          <div class="group">
            <div class="g-head"><span class="sup">${esc(s.name)}</span><span class="g-tag">${esc(s.to || "御中")}</span>${kTag}${gp.tag}<span class="hint g-n">${ids.length}点</span></div>${gp.box}
            <ul class="g-lines">${ids.map(id => { const l = r.lines[id], n = Object.keys(l.photos || {}).length;
              return `<li>${esc(lineText(l))}${n ? ` <span class="tag">写真${n}枚は別に送る</span>` : ""}${l.link ? ` <span class="tag">リンクつき</span>` : ""}${azRowHTML(r, sid, id)}</li>`; }).join("")}</ul>
            ${note}
            <div class="row"><button type="button" class="btn" data-gcopy="${K}">注文の文をコピー</button>
              ${sendLabel(s) ? `<button type="button" class="btn" data-gsend="${K}">${sendLabel(s)}</button>` : ""}
              <button type="button" class="btn primary" data-gorder="${K}">注文した</button></div>
            <div class="field" data-gfb="${K}" hidden><p class="send-note" role="status" hidden></p><span class="lab">コピーした文（うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
              <textarea class="inp ta copybox" rows="12" readonly></textarea></div>
          </div>`;
      }).join("")}</div>
      ${groups.some(({ sid }) => st.sups[sid].send !== "net" && !isAppSup(st.sups[sid])) ? '<p class="hint">「注文の文をコピー」（または「メールで送る」「LINE で送る」）で材料屋に送ってから、「注文した」を押してください。</p>' : ""}`;
    }
    // 材料屋が決まっていない品物があっても、ほかの品物は先に注文できる（11/10 事務員さん。前は赤い字で、先に注文できないように見えた）
    if (none.length) h += `<p class="hint">材料屋が決まっていない品物が ${none.length}点 あります。ほかの品物は、先に注文できます。決まったら、上の 1. でえらんで注文してください（注文しないときは、品物の下の「注文しない…」）。</p>`;
    if (!groups.length && !none.length) h += "<p>この依頼は、すべて済みました（注文した・注文しない）。</p>";
    return h;
  }

  function orderItemHTML(o) {
    const cx = o.status === "cancelled";
    return `
      <div class="oitem${cx ? " cx" : ""}">
        <div class="oi-head"><b>${esc(o.supplierName)}</b>
          <span class="muted">${md(o.orderedAt)} ${hm(o.orderedAt)} 注文（${esc(o.orderedBy || "")}）</span></div>
        <ul class="g-lines">${Object.values(o.lines || {}).map(l => `<li>${esc(lineText(l) + azkText(l))}</li>`).join("")}</ul>
        ${cx ? `<p class="muted">取り消した（${o.cancelledAt ? `${md(o.cancelledAt)} ${hm(o.cancelledAt)}・` : ""}${esc(o.cancelledBy || "")}）。品物は依頼にもどしました。</p>`
          : o.status === "wait" ? `
            <div class="cx-low" id="ocx-${esc(o.id)}">
              <button type="button" class="linkbtn" data-ocancel="${esc(o.id)}">注文を取り消して依頼にもどす</button>
              <span class="hint">押しまちがえたときや、材料屋を変えたいときに。材料屋に連絡したあとなら、材料屋にも取り消しを伝えてください。</span>
            </div>` : ""}
      </div>`;
  }

  function openReq(id, keepScroll = false) {
    const r = (st.reqs || []).find(x => x.id === id);
    if (!r) return;
    st.sheet = { kind: "req", id };
    const panel = document.getElementById("panel");
    const y = keepScroll && panel ? panel.scrollTop : 0;
    st.openId = id;
    st.openOrderId = "";
    st.openQuoteId = "";
    openSheet(reqHTML(r), p => {
      p.scrollTop = y;
      fillPhotos(p);
      const w = p.querySelector("#reqWrap");
      w.addEventListener("change", e => {
        const kd = e.target.closest("[data-kibdate]");   // 品物の希望日を日付でえらんだ（11/10）
        if (kd) { if (kd.value) { setKib(r, kd.dataset.kibdate, kd.value); st.kibAsk = ""; openReq(r.id, true); } return; }
        const s = e.target.closest("[data-pick]");
        if (!s) return;
        picksOf(r)[s.dataset.pick] = s.value;
        const gb = w.querySelector("#groupsBox");
        if (gb) gb.innerHTML = groupsHTML(r);
      });
      // 材料屋へのひとこと・「注文しない」の理由（11/10）：書いたら覚えておく（かきなおしても消えないように）
      w.addEventListener("input", e => {
        const n = e.target.closest("[data-gnote]");
        if (n) (st.gnote[r.id] || (st.gnote[r.id] = {}))[n.dataset.gnote] = n.value;
        if (e.target.closest("[data-skipwhy]")) st.skipWhy = e.target.value;
        // まとまりの届け先を手で書く（11/27）：書いた字を覚えて、見本と札をかきなおす
        const fp = e.target.closest('[data-freeplace="gbasho"]');
        if (fp) {
          const key = fp.closest("[data-gkey]").dataset.gkey, m = (st.gplace[r.id] = st.gplace[r.id] || {});
          m[key] = { id: FREE_PLACE, free: fp.value };
          onFreeInput(e);
          const tag = w.querySelector(`[data-gplace="${CSS.escape(key)}"]`), v = freePlace(fp.value);
          if (tag) tag.textContent = `届け先 ${v ? v.basho : "（書いてください）"}（変える）`;
        }
      });
      w.addEventListener("click", e => onPanelClick(e, w).catch(ex => toast(errorText(ex))));
      // 預かりから出す数（11/2）：入れたら「のこり○本は新しく用意」を合わせる（かきなおさない）
      w.addEventListener("input", e => {
        const q = e.target.closest("[data-azq]");
        if (!q) return;
        const id = q.dataset.azq, l = r.lines[id], n = azNum(q.value);
        st.azWant[azKey(r, id)] = n ?? 0;
        const h = w.querySelector('[data-azrest="' + CSS.escape(id) + '"]');
        if (h) h.textContent = azRestText(l, n ?? 0);
      });
    }, { side: true });
  }

  /** 中身の画面で押したとき */
  async function onPanelClick(e, w) {
    const t = e.target.closest("[data-redit],[data-gcopy],[data-gsend],[data-gorder],[data-gapp],[data-ocancel],[data-ocyes],[data-ocno],[data-chuban],[data-azw]," +
      "[data-kibask],[data-kibset],[data-kibclose],[data-skipask],[data-skipyes],[data-skipno],[data-unskip],[data-gplace],[data-gbasho]");
    if (!t || t.disabled) return;
    const r = (st.reqs || []).find(x => x.id === st.openId);
    if (!r) return;
    const d = t.dataset;
    if (d.chuban) return copyChuban(d.chuban);   // ネットで買う（10/15）
    // まとまりの届け先を変える（11/27）
    if (d.gplace) { st.placeAsk = st.placeAsk === `${r.id}|${d.gplace}` ? "" : `${r.id}|${d.gplace}`; return openReq(r.id, true); }
    if (d.gbasho) {
      const key = t.closest("[data-gkey]").dataset.gkey, m = (st.gplace[r.id] = st.gplace[r.id] || {}), prev = m[key] || {};
      m[key] = { id: d.gbasho, free: prev.free || "" };
      if (d.gbasho === r.bashoId && !prev.free) delete m[key];   // 依頼の届け先にもどした
      if (d.gbasho !== FREE_PLACE) st.placeAsk = "";
      openReq(r.id, true);
      if (d.gbasho === FREE_PLACE) { const inp = document.querySelector(`[data-gkey="${CSS.escape(key)}"] [data-freeplace]`); if (inp) inp.focus(); }
      return;
    }
    // 品物の希望日を変える（11/10）
    if (d.kibask) { st.kibAsk = st.kibAsk === `${r.id}/${d.kibask}` ? "" : `${r.id}/${d.kibask}`; st.skipAsk = ""; return openReq(r.id, true); }
    if ("kibclose" in d) { st.kibAsk = ""; return openReq(r.id, true); }
    if (d.kibset) { setKib(r, d.kibset, d.v); st.kibAsk = ""; return openReq(r.id, true); }
    // 注文しない（11/10）：小さいボタン → 理由（書かなくてもよい）→「注文しないにする」
    if (d.skipask) { st.skipAsk = `${r.id}/${d.skipask}`; st.skipWhy = ""; st.kibAsk = ""; return openReq(r.id, true); }
    if ("skipno" in d) { st.skipAsk = ""; return openReq(r.id, true); }
    if (d.skipyes) { t.disabled = true; await skipLine(r, d.skipyes, st.skipWhy); st.skipAsk = ""; st.skipWhy = ""; return openReq(r.id, true); }
    if (d.unskip) { t.disabled = true; await unskipLine(r, d.unskip); return openReq(r.id, true); }
    if (d.azw) {   // 預かりから（11/2）：押すたびに切りかえる。数は、注文の数と預かりの残りの少ないほう（直せる）
      const k = azKey(r, d.azw), l = r.lines[d.azw];
      st.azWant = st.azWant || {};
      if (st.azWant[k] != null) delete st.azWant[k];
      else { const m = azMatch(picksOf(r)[d.azw], l); st.azWant[k] = m ? Math.min(Number(l.qty), m.avail) : 0; }
      const gb = w.querySelector("#groupsBox");
      if (gb) gb.innerHTML = groupsHTML(r);
      return;
    }
    if ("redit" in d) {   // 依頼を直す（10/14）
      return navGo(() => { st.sheet = { kind: "form" }; openReqEdit({ r, orders: ordersOf(r.id), places: st.places, units: unitsList(), me, onDone: () => { if (!navBack({ force: true })) openReq(r.id); } }); });   // もどる・保存したあとは、1つ前（依頼の画面）にもどる（11/28）
    }
    // まとまり（材料屋＋希望日。11/10）の注文の形。希望日と、材料屋へのひとことも入れる
    const draftFor = key => {
      const g = groupsOf(r).groups.find(x => x.key === key);
      if (!g) return null;
      const sid = g.sid, az = {};   // 預かりから（11/2）
      for (const id of g.ids) {
        const q = (st.azWant || {})[azKey(r, id)], m = q != null ? azMatch(sid, r.lines[id]) : null;
        if (m && q > 0) az[id] = { iid: m.iid, qty: Math.min(q, Number(r.lines[id].qty)) };
      }
      const pl = gPlaceOf(r, key);   // 届け先（変えたときだけ。11/27）
      if (pl.empty) { toast("届け先を書いてください（「届け先（変える）」の「ほか（手で書く）」）"); return null; }
      return draftOrder(r, sid, st.sups[sid], g.ids, bashoText(r), az, { kibou: g.kibou, memo: st.sups[sid].send === "net" ? r.memo || "" : noteOf(r, key), ...(pl.changed ? { place: { basho: pl.basho, bashoText: pl.bashoText } } : {}) });
    };
    const azCheck = key => {   // 預かりから出す数が、注文の数・預かりの残りより多くないか（11/2）
      const g = groupsOf(r).groups.find(x => x.key === key), sid = g && g.sid;
      for (const id of (g ? g.ids : [])) {
        const q = (st.azWant || {})[azKey(r, id)];
        if (q == null) continue;
        const e = azErr(r.lines[id], q, azMatch(sid, r.lines[id]));
        if (e) return e;
      }
      return "";
    };
    if (d.gcopy || d.gsend) {
      const key = d.gcopy || d.gsend, dr = draftFor(key);
      if (!dr) return;
      await copyOrSend(dr, d.gsend ? st.sups[dr.supplier] : null, w.querySelector(`[data-gfb="${CSS.escape(key)}"]`), st.info);
    } else if (d.gorder || d.gapp) {
      const ae = azCheck(d.gorder || d.gapp);
      if (ae) { toast(ae); return; }
      const dr0 = draftFor(d.gorder || d.gapp);
      if (!dr0) return;
      // アプリに送る（2-2）：注文に、アプリに送った印もつける
      const dr = d.gapp ? { ...dr0, ...appSentFields(me) } : dr0;
      const label = t.textContent;
      t.disabled = true;
      t.textContent = "しまっています…";
      try {
        await placeOrder(r, dr, me);
      } catch (ex) {
        t.disabled = false;
        t.textContent = label;
        throw ex;
      }
      toast(d.gapp ? `${dr.supplierName} のアプリに送りました（材料がまだ届いていない に入りました）` : `${dr.supplierName} に注文しました（材料がまだ届いていない に入りました）`);
      afterSave(w);
    } else if (d.ocancel) {
      const box = w.querySelector(`#ocx-${CSS.escape(d.ocancel)}`);
      box.className = "confirm cxl";
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
      t.closest(".confirm").remove();   // 「本当に？」をしまってから、かきなおす（残すと、かきなおさずに止まって見える）
      afterSave(w);
    }
  }

  /** カードの金額：材料費（請求書の金額。まだなら納品書の金額） */
  function amtHTML(o) {
    const c = cost(o);
    return c != null
      ? `<span class="amt"><span>材料費</span><span class="num">${yen(c)}</span><span class="yen">円</span><span>（${o.seikyu != null ? "請求" : o.withSlip ? `${o.withAt ? `${md(o.withAt)} の注文` : "ほかの注文"}の納品書にまとめて入っている` : o.slips && o.slips.sup ? "納品書・材料屋" : "納品書"}）</span></span>`
      : '<span class="amt"><span>金額はまだ</span></span>';
  }

  /* ---------- 納品書の金額（1つの注文に何枚でも） ---------- */
  function slipBlockHTML(o) {
    const sl = slipsOf(o);
    // 欄は js/kingaku.js（材料屋のアプリと同じ。Kg・¥/kg つき。2-4）
    const form = `
      ${o.status === "wait" ? '<p class="hint">入れると「届いた」になります。</p>' : ""}
      ${slipFormHTML(o, { done: doneOf(o) })}
      <div class="row"><button type="button" class="btn primary" data-slipsave>納品書の金額を入れる</button></div>`;
    const dayText = s => s.slice(5).replace("-", "/").replace(/^0/, "");   // 2026-10-20 → 10/20
    return `
      <div class="block" id="slipBlock"><h3>納品書の金額</h3>
        ${sl.length ? `<ul class="slips">${sl.map(([sid, s]) => st.slipFix === `${o.id}/${sid}` ? `
          <li><div class="sl-top"><span class="sl-lab">納品書を直す</span><span class="suptag">材料屋が入れた</span></div>
            <div data-fixbox>${slipFormHTML(o, { slip: s })}</div>
            <div class="row"><button type="button" class="btn primary" data-slipfixsave>直して入れる</button><button type="button" class="btn" data-slipfixno>やめる</button></div>
          </li>` : `
          <li>
            <div class="sl-top"><span class="sl-lab">納品書${s.no ? "　No." + esc(s.no) : ""}${s.date ? "　" + esc(dayText(s.date)) : ""}${s.pages ? `　（${s.pages}枚つづき）` : ""}</span>
              ${s.src === "sup" ? `<span class="suptag">${s.fixBy ? "材料屋が入れた → 事務所が直した" : "材料屋が入れた"}</span>` : ""}
              ${isReturnSlip(s) ? '<span class="tag ret-tag">返品・交換</span>' : ""}
              ${s.amount != null ? `<span class="money">${yen(s.amount)}</span><span>円</span>` : '<span class="hint">金額なし</span>'}
              ${s.inv ? `<span class="tag">請求ずみ${s.invAmt != null && Number(s.invAmt) !== Number(s.amount) ? `（請求書 ${yen(s.invAmt)}円）` : ""}</span>` : ""}
              ${s.src === "sup" ? `<button type="button" class="linkbtn" data-slipfix="${esc(sid)}">直す</button>` : ""}
              <button type="button" class="linkbtn muted" data-slipdel="${esc(sid)}">消す</button></div>
            ${(sc => sc.map((p, i) => `<button type="button" class="linkbtn" data-phview="${esc(p)}">納品書のスキャンを見る${sc.length > 1 ? `（${i + 1}枚目）` : ""}</button>`).join(""))(slipScans(s))}
            ${rowsHTML(o, sid, s, false)}
            ${(cv => (cv.length ? `<p class="with-note">この納品書には、同じ注番のほかの注文の分も、まとめて入っています：${esc(covText(cv))}（その注文は0円）</p>` : ""))(coveredBy(st.orders, o.id, sid))}
            <span class="hint">入れた人：${esc(s.by || "")}${s.imp ? "（納品書の取りこみ）" : ""}${s.src === "sup" ? "・材料屋のアプリから" : ""}</span>
            ${s.fixBy ? `<span class="hint">直した人：${esc(s.fixBy)}${s.fixAt ? `（${md(s.fixAt)}）` : ""}。材料屋が入れた金額は ${yen(s.supAmount)}円</span>` : ""}
          </li>`).join("")}</ul>
          ${sl.length > 1 ? `<p class="ptotal"><span>納品書の合計</span><span class="money">${yen(o.nouhin)}</span><span>円</span></p>` : ""}
          <div class="row"><button type="button" class="linkbtn" data-slipmore>＋ 納品書をもう1枚入れる</button></div>` : ""}
        ${withNoteHTML(o, dayText)}
        ${npBlockHTML(o, dayText)}
        <div id="slipFormBox"${sl.length || o.withSlip ? " hidden" : ""}>${form}</div>
      </div>`;
  }
  /** ほかの注文の納品書にまとめて入っている注文（11/25）：どの納品書か・0円・「まとめるのをやめる」 */
  function withNoteHTML(o, dayText) {
    const w = withOf(o);
    if (!w) return "";
    const a = (st.orders || []).find(x => x.id === w.oid), s = a && (a.slips || {})[w.sid];
    return `<div class="with-note">
        <p>この注文の品物は、${a ? `${esc(md(a.orderedAt))} 注文（${esc(linesShort(a, 30))}）の` : "ほかの注文の"}納品書${s && s.no ? ` No.${esc(s.no)}` : ""}${s && s.date ? `（${esc(dayText(s.date))}）` : ""}に、まとめて入っています。金額は0円です。請求ずみは、その納品書といっしょになります。</p>
        ${o.status !== "billed" ? '<button type="button" class="linkbtn muted" data-unwith>まとめるのをやめる（金額を「まだ」にもどす）</button>' : ""}
      </div>`;
  }
  /** 手で入れる欄で、もう納品書で入っている品物（11/4 OS26315：2回数えない）→ {品物id: {text, amount}} */
  function doneOf(o) {
    const out = {};
    for (const [lid, l] of Object.entries(o.lines || {})) {
      const x = lineDone(st.orders, o, lid, l);
      if (!x) continue;
      const day = x.s.date ? `${Number(x.s.date.slice(5, 7))}/${Number(x.s.date.slice(8))}` : "";
      out[lid] = { text: [x.s.no ? "No." + x.s.no : "", day, x.o2.id !== o.id ? `${x.o2.chumonsha || x.o2.supplierName}さんの注文` : ""].filter(Boolean).join("・"), amount: x.r.amount };
    }
    return out;
  }
  /** 金額のない紙（送り状・受領書など。11/4）：明細とスキャンだけ。材料費には入らない */
  function npBlockHTML(o, dayText) {
    const ps = npSlipsOf(o);
    if (!ps.length) return "";
    return `<p class="subh">金額のない紙（送り状・受領書など。材料費には入りません）</p>
      <ul class="slips">${ps.map(([pid, p]) => {
        const dup = npDupOf(o, p);
        return `<li>
          <div class="sl-top"><span class="sl-lab">金額のない紙${p.no ? "　No." + esc(p.no) : ""}${p.date ? "　" + esc(dayText(p.date)) : ""}</span>
            <span class="hint">金額なし</span>
            <button type="button" class="linkbtn muted" data-npdel="${esc(pid)}">消す</button></div>
          ${dup ? `<span class="hint">金額のある納品書${dup[1].no ? `（No.${esc(dup[1].no)}）` : ""}と同じ品物です。「納品書で届いた品物」には、納品書のほうだけ出します。</span>` : ""}
          ${p.scan ? `<button type="button" class="linkbtn" data-phview="${esc(p.scan)}">スキャンを見る</button>` : ""}
          ${rowsHTML(o, pid, p, true)}
          <span class="hint">入れた人：${esc(p.by || "")}${p.imp ? "（納品書の取りこみ）" : ""}</span>
        </li>`;
      }).join("")}</ul>`;
  }
  const numText = v => (v == null || v === "" ? "" : Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 3 }));
  /** 「注文にない」「注文の品物」の印（押すと切りかえ。11/4）。加工品・めっきは出さない */
  const ordTag = (o, np, sid, rid, not) => (checksOrd(o)
    ? `<button type="button" class="ordtag${not ? " not" : ""}" data-ord="${np ? "np" : "sl"}|${esc(sid)}|${esc(rid)}" title="押すと「注文の品物」と「注文にない」を切りかえます">${not ? "注文にない" : "注文の品物"}</button>` : "");
  /** 「▼ 明細を見る（5行）」（11/4 事務員さん：前の「明細（5行）」は、ただの字に見えて気づきにくかった）。開くと表 */
  function rowsHTML(o, sid, s, np) {
    const rs = Object.entries(s.rows || {});
    if (!rs.length) return "";
    const key = `${o.id}/${np ? "np" : "sl"}/${sid}`, nNot = rs.filter(([rid, r]) => notInOrder(o, rid, r)).length;
    return `<details class="mrows" data-mkey="${esc(key)}"${st.mOpen.has(key) ? " open" : ""}>
        <summary><span class="ar op">▼</span><span class="op">明細を見る（${rs.length}行）</span><span class="ar cl">▲</span><span class="cl">明細をとじる</span>${nNot ? `<span class="nc">注文にない ${nNot}</span>` : ""}</summary>
        <div class="mtbl-wrap"><table class="mtbl"><thead><tr><th>品名</th><th>数</th><th>単位</th>${np ? "" : "<th>単価</th><th>金額</th>"}</tr></thead><tbody>
          ${rs.map(([rid, r]) => { const not = notInOrder(o, rid, r); return `<tr${not ? ' class="not"' : ""}><td>${esc(r.spec)}${ordTag(o, np, sid, rid, not)}</td><td class="n">${numText(r.qty)}</td><td>${esc(r.unit || "")}</td>${np ? ""
            : `<td class="n">${r.kg != null && r.perKg != null ? `${numText(r.kg)}kg × ${numText(r.perKg)}円/kg` : numText(r.price)}</td><td class="n">${yen(r.amount)}</td>`}</tr>`; }).join("")}
        </tbody>${np ? "" : `<tfoot><tr><td colspan="4">合計（税抜）</td><td class="n">${yen(s.amount)}</td></tr></tfoot>`}</table></div>
        ${checksOrd(o) ? '<p class="hint">「注文の品物」「注文にない」の印は、押すと切りかえられます。</p>' : ""}
      </details>`;
  }
  /** 「注文にない品物が入っています」（11/4）：アプリで頼んだ品物にない、納品書の品物 */
  function notBoxHTML(o, dr) {
    const nots = dr.filter(x => x.not);
    if (!nots.length) return "";
    return `<p class="notbox">注文にない品物が入っています（納品書 ${new Set(nots.map(x => x.sid)).size}枚・${nots.length}品）
      <span>アプリで頼んでいない品物です。引き取りの分などなら、このままでよいです。下の「納品書で届いた品物」で、どれか見られます。</span></p>`;
  }
  /** 届いた品物の表（注文の画面・工事ごと）。cols：表に出す欄 */
  function deliveredTable(rows, { sup = false, who = false, total = null } = {}) {
    const dayText = d => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : "");
    // 注文者は、アプリの注文の注文者（納品書の字ではない）。注文にない品物は、その人が頼んだとは限らないので「—」（11/4 持ち主 A）
    const tr = x => `<tr${x.not ? ' class="not"' : ""}${who ? ` data-open="${esc(x.o.id)}"` : ""}><td>${dayText(x.s.date)}</td>${sup ? `<td>${esc(x.o.supplierName)}</td>` : ""}
      <td>${esc(x.r.spec)}${x.not ? '<span class="nottag">注文にない</span>' : ""}</td><td class="n">${numText(x.r.qty)}${esc(x.r.unit || "")}</td>
      <td class="n">${x.np ? '<span class="hint">金額なし</span>' : yen(x.r.amount)}</td>${who ? `<td>${x.not ? "—" : esc(x.o.chumonsha || "—")}</td>` : `<td>${x.s.no ? esc(x.s.no) : ""}</td>`}</tr>`;
    const head = `<thead><tr><th>届いた日</th>${sup ? "<th>材料屋</th>" : ""}<th>品名</th><th>数</th><th>金額</th><th>${who ? "注文者" : "納品書"}</th></tr></thead>`;
    const foot = total != null ? `<tfoot><tr><td colspan="${sup ? 4 : 3}">納品書の合計（税抜）</td><td class="n">${yen(total)}</td><td></td></tr></tfoot>` : "";
    return `<div class="mtbl-wrap"><table class="mtbl">${head}<tbody>${rows.map(tr).join("")}</tbody>${foot}</table></div>`;
  }
  /** アプリで頼んだ品物が、納品書で届いたか（「届いた 11/2」。11/4）：同じ番号の行か、品名に同じ言葉がある行 */
  /* ---------- 加工品が何回かに分けて届く（11/19 事務員さん。まず加工品だけ） ---------- */
  /** 品物の届いた数の札（12個中 5個） */
  function kakouTag(o, lid) {
    const p = partOf(o).per.find(x => x.lid === lid);
    if (!p || !p.got) return "";
    return p.got >= p.want ? `<span class="oktag">そろった ${p.got}/${p.want}</span>` : `<span class="parttag">${p.want}${esc(p.unit)}中 ${p.got}${esc(p.unit)} 届いた</span>`;
  }
  /** 届いた数の一覧（いつ・何個・どの納品書） */
  function gotListHTML(o) {
    const list = gotList(o);
    if (!list.length) return "";
    const ls = o.lines || {}, pt = partOf(o);
    return `<p class="subh">届いた数（いつ・何個・どの納品書）</p>
      <table class="gotlist"><tbody>${list.map(x => `<tr><td>${x.date ? `${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8))}` : "—"}</td><td>${esc((ls[x.lid] || {}).spec || "")}</td><td class="n">${esc(String(x.qty))}${esc((ls[x.lid] || {}).unit || "")}</td><td>${esc(x.src)}</td></tr>`).join("")}
        ${pt.per.filter(p => p.got < p.want).map(p => `<tr class="rest"><td>のこり</td><td>${esc(p.spec)}</td><td class="n">${p.want - p.got}${esc(p.unit)}</td><td></td></tr>`).join("")}</tbody></table>`;
  }
  /** 加工品の「つぎにやること」（まだ届いていない）：一部届いた数と「届いた」（全部か何個か） */
  function kakouActHTML(o) {
    const pt = partOf(o), rest = pt.per.filter(p => p.got < p.want);
    const now = pt.any ? `<p><b>一部届いた：${pt.want}中 ${pt.got}</b>（のこり ${Math.max(0, pt.want - pt.got)}）。全部そろうまで、ここに残ります。</p>` : "";
    if (st.gotAsk !== o.id) return `${now}<button type="button" class="btn primary big" data-gotask="${esc(o.id)}">届いた（全部か何個か）</button>`;
    return `${now}<div class="gotbox confirm"><b>何が届きましたか？</b>
        <button type="button" class="btn primary" data-gotall="${esc(o.id)}">全部（のこり ${rest.map(p => `${p.want - p.got}${esc(p.unit)}`).join("・") || "なし"}）</button>
        <p class="hint">何個かだけなら、届いた数を入れて「これで入れる」。全部そろったら「届いた」になります。</p>
        ${rest.map(p => `<label class="gotrow"><span>${esc(p.spec)}（のこり ${p.want - p.got}${esc(p.unit)}）</span><input class="inp" data-gotq="${esc(p.lid)}" inputmode="decimal" placeholder="0" aria-label="${esc(p.spec)} の届いた数"><span>${esc(p.unit)}</span></label>`).join("")}
        <div class="row"><button type="button" class="btn" data-gotgo="${esc(o.id)}">これで入れる</button><button type="button" class="linkbtn muted" data-gotno>やめる</button></div>
        <p class="err" data-goterr></p></div>`;
  }
  function gotTag(o, dr, lid, l) {
    if (!checksOrd(o)) return "";
    const x = dr.slice().reverse().find(x => x.r.ord !== false && (x.r.line === lid || x.rid === lid || (!x.r.line && sameThing(l.spec, x.r.spec))));   // 取りこみで合わせた行（line。11/19）を先に
    return x ? `<span class="oktag">届いた${x.s.date ? ` ${Number(x.s.date.slice(5, 7))}/${Number(x.s.date.slice(8))}` : ""}</span>` : "";
  }
  /** 品名・数量の「納品書で届いた品物」（11/4）。はじめは10品まで、のこりは「▼ ほかの n品を見る」 */
  function deliveredHTML(o, dr) {
    const key = `${o.id}/more`, rows = dr.map(x => ({ ...x, o })), more = rows.slice(10);
    return `<p class="subh">納品書で届いた品物（${rows.length}品）</p>
      ${deliveredTable(rows.slice(0, 10), { total: more.length ? null : o.nouhin })}
      ${more.length ? `<details class="mrows" data-mkey="${esc(key)}"${st.mOpen.has(key) ? " open" : ""}><summary><span class="ar op">▼</span><span class="op">ほかの ${more.length}品を見る</span><span class="ar cl">▲</span><span class="cl">とじる</span></summary>
        ${deliveredTable(more, { total: o.nouhin })}</details>` : ""}`;
  }

  /* ---------- 注文の中身（右から出る）：届いた・もどす・コピー・取り消して依頼にもどす ---------- */
  function orderHTML(o) {
    const s = ST[o.status] || ST.wait, late = isLate(o, ymd(0)), cx = o.status === "cancelled";
    const dr = deliveredRows(o);   // 納品書で届いた品物（11/4）
    const osup = st.sups && st.sups[o.supplier], unsent = isUnsent(o), net = !!osup && osup.send === "net";
    const steps = [["注文した", o.orderedAt, true], ["届いた", o.arrivedAt, o.status === "arrived" || o.status === "billed"], ["請求が来た", o.billedAt, o.status === "billed"]];
    if (officeKind(o)) steps.splice(0, 1, ["入れた", o.orderedAt, true], ["送った", o.sentAt, !o.unsent]);   // 加工品・見積から（10/15）
    // 材料屋に送るところ（ネットで買う材料屋は、お店のページ）。まだ送っていない注文は、上の「つぎにやること」に出す
    const sendArea = net ? `
        <div class="block"><h3>お店のページ（ネットで買う）</h3>${netLinesHTML(osup, Object.values(o.lines || {}))}
          <div class="row"><button type="button" class="btn" data-chuban="${esc(o.chuban)}">注番をコピー</button></div></div>` : `
        ${isLineOrder(o) && !cx ? `<label class="chk lnote"><input type="checkbox" data-lnote${o.lineNote === true ? " checked" : ""}><span>この一文を入れる：「${esc(LINE_NOTE)}」<span class="hint">（メール・FAX・PDF に入ります）</span></span></label>` : ""}
        <div class="row"><button type="button" class="btn" data-ocopy="${esc(o.id)}">注文の文をコピー（メール・LINE用）</button>
          ${sendLabel(osup) ? `<button type="button" class="btn" data-osend="${esc(o.id)}">${sendLabel(osup)}</button>` : ""}</div>
        <div class="field" id="oCopyFb" hidden><p class="send-note" role="status" hidden></p><span class="lab">コピーした文（うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
          <textarea class="inp ta copybox" rows="12" readonly></textarea></div>`;
    let act = "";
    const app = isAppSup(osup) && !cx;   // 材料屋のアプリで受ける材料屋（2回目・2-2）
    const appPending = app && (unsent || (o.status === "wait" && !o.supState));
    if (appPending) {   // まだアプリに送っていない：「アプリに送る」でとどく（持ち主 B）
      act = `<div class="block act" style="--c:var(--amber)"><h3>つぎにやること</h3>
          <p class="warn">まだ材料屋のアプリに送っていません。</p>
          <p>「アプリに送る」を押すと、${esc(osup.name)} のアプリに注文がとどきます。</p>
          <button type="button" class="btn primary big" data-oapp="${esc(o.id)}">アプリに送る</button>
          <details class="hidbox"><summary>注文の文（コピー・メール）</summary>${sendArea}</details></div>`;
    } else if (unsent) {   // まだ送っていない（加工品。10/15）：送ってから「送った」
      act = `<div class="block act" style="--c:var(--amber)"><h3>つぎにやること</h3>
          <p class="warn">まだ材料屋に送っていません。</p>
          <p>${net ? "お店のページで買ってから" : osup && osup.send === "mail" ? "「メールで送る」で Gmail を開いて、ファイルをつけて送信してから" : "注文の文を送ってから"}、「送った」を押してください。</p>
          ${sendArea}
          <button type="button" class="btn primary big" data-osent="${esc(o.id)}">送った</button></div>`;
    } else if (o.status === "wait") {
      act = `<div class="block act" style="--c:${s.color}"><h3>つぎにやること</h3>
          ${app && o.supState === "sent" ? (noReply(o) ? '<p class="warn">材料屋のアプリで、まだ受けていません（送った日のつぎの日になりました。土日はのぞく）。電話して、たしかめてください。</p>' : '<p class="hint">材料屋のアプリで、まだ受けていません。</p>') : ""}
          ${deliverPlan(o) ? `<p>材料屋が受けました：<b>${esc(deliverPlan(o))}</b> に届ける予定です。</p>` : ""}
          <p>材料は届きましたか？<br><span class="hint">${app ? "材料屋がアプリで「届けました」を押すと、自動で「届いた」になります。" : ""}納品書が来ていれば、下の「納品書の金額」で入れると「届いた」になります。</span></p>
          ${isKakou(o) ? kakouActHTML(o) : `<button type="button" class="btn primary big" data-arrive="${esc(o.id)}">届いた（金額はあとで）</button>`}</div>`;
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
          <span class="ochip${o.status === "wait" ? " solid" : o.status === "arrived" ? " blue" : ""}">${unsent ? "まだ送っていない" : s.chip}</span>${kindTag(o)}
          <h2 id="panelTitle" class="mt6">${esc(o.supplierName)}</h2>
          <div class="kouji"><span class="chuban">${esc(o.chuban)}</span><span class="kenmei">${esc(zenkana(o.kenmei))}</span></div>
        </div><button type="button" class="x" data-close aria-label="閉じる">×</button></div>
        ${cx ? "" : `<div class="block"><ol class="steps" style="--c:${s.color}">${steps.map(([l, d, done]) => `<li class="${done ? "done" : ""}">${l}<span class="d">${done && d ? md(d) : ""}</span></li>`).join("")}</ol></div>`}
        ${act}
        ${cx ? "" : notBoxHTML(o, dr)}
        ${cx ? "" : slipBlockHTML(o)}
        <div class="block"><h3>品名・数量</h3>
          ${dr.length && !cx ? `<p class="subh">${o.kind === "nouhin" ? "注文の品物（納品書から作った注文）" : "アプリで頼んだ品物"}</p>` : ""}
          <ul class="g-lines">${Object.entries(o.lines || {}).map(([lid, l]) => `<li>${esc(lineText(l) + azkText(l))}${cx ? "" : isKakou(o) ? kakouTag(o, lid) : gotTag(o, dr, lid, l)}${oAzHTML(o, lid, l)}</li>`).join("")}</ul>
          ${!cx && isKakou(o) ? gotListHTML(o) : ""}
          ${dr.length && !cx ? deliveredHTML(o, dr) : ""}
          ${cx ? "" : `<div class="row"><button type="button" class="btn" data-oedit>注文を直す</button></div>`}</div>
        ${fileBlockHTML(o, !cx)}
        ${logHTML(o)}
        ${attachHTML(o.lines, "写真・リンク（材料屋に写真を送るときは、写真を開いて保存してください）")}
        <div class="block"><dl class="dl">
          <dt>希望日</dt><dd${late ? ' class="late"' : ""}>${esc(kibouText(o.kibou))}${late ? "（すぎています）" : ""}</dd>
          <dt>届け先</dt><dd>${esc(o.basho || "—")}</dd>
          <dt>注文者</dt><dd>${esc(o.chumonsha || "—")}</dd>
          <dt>担当者</dt><dd>${esc(o.tantou || "—")}</dd>
          ${o.supState ? `<dt>材料屋のアプリ</dt><dd>${esc(supStateText(o))}${o.supSentAt ? `（${md(o.supSentAt)} ${hm(o.supSentAt)} 送った）` : ""}</dd>` : ""}
          <dt>来たところ</dt><dd>${o.reqId ?`現場のスマホ（${esc(o.chumonsha)}さん）` : o.kind === "kakou" ? "事務所（加工品）" : o.kind === "mekki" ? "事務所（めっき）" : o.kind === "mitsumori" ? `見積から（事務所）${o.quoteId ? ` <button type="button" class="linkbtn" data-oquote="${esc(o.quoteId)}">もとの見積を開く</button>` : ""}` : o.kind === "nouhin" ? "納品書から（アプリで注文していない）" : "LINE・電話"}</dd>
          ${o.quoteTotal != null ? `<dt>見積の金額</dt><dd>${yen(o.quoteTotal)} 円（税抜）</dd>` : ""}
          <dt>${officeKind(o) || o.kind === "nouhin" ? "入れた" : "注文した"}</dt><dd>${md(o.orderedAt)} ${hm(o.orderedAt)}（${esc(o.orderedBy || "")}）</dd>
          ${o.sentAt ? `<dt>送った</dt><dd>${md(o.sentAt)} ${hm(o.sentAt)}（${esc(o.sentBy || "")}）</dd>` : ""}
          ${o.arrivedAt ? `<dt>届いた</dt><dd>${md(o.arrivedAt)} ${hm(o.arrivedAt)}（${esc(o.arrivedBy || "")}）</dd>` : ""}
          ${o.billedAt ? `<dt>請求が来た</dt><dd>${md(o.billedAt)} ${hm(o.billedAt)}（${esc(o.billedBy || "")}）</dd>` : ""}
          <dt>請求書の金額</dt><dd>${o.seikyu != null ? yen(o.seikyu) + " 円" : "—"}</dd>
          ${o.contacted ? `<dt>連絡ずみ</dt><dd>${esc(o.chumonsha)}さんが ${esc(o.supplierName)} に連絡ずみ</dd>` : ""}
          ${o.memo ? `<dt>メモ</dt><dd>${esc(o.memo)}</dd>` : ""}
        </dl></div>
        ${o.src ? `<details class="block hidbox"><summary>LINE の元の文</summary><pre class="src-text">${esc(o.src)}</pre></details>` : ""}
        ${unsent || appPending ? "" : sendArea}
        <button type="button" class="btn big full close-big" data-close>閉じる</button>
        ${o.status === "wait" ? `
          <div class="cx-low" id="ocx-${esc(o.id)}">
            <button type="button" class="linkbtn" data-ocancel="${esc(o.id)}">${o.reqId ? "注文を取り消して依頼にもどす" : "注文を取り消す"}</button>
            <span class="hint">押しまちがえたときや、材料屋を変えたいときに。材料屋に連絡したあとなら、材料屋にも取り消しを伝えてください。</span>
          </div>` : ""}
      </div>`;
  }

  /** 入れたばかりの注文を開く（データが届くまで、少し待つ。3秒たっても来なければやめる） */
  function waitOpen(id, tries = 0, nav = true) {   // nav＝開くのを「画面をうつした」に数える（「← 戻る」。11/28）
    if ((st.orders || []).some(x => x.id === id)) { if (nav) navGo(() => openOrder(id)); else openOrder(id); }
    else if (tries < 30) setTimeout(() => waitOpen(id, tries + 1, nav), 100);
  }

  /* ---------- 見積（10/15。js/mitsumori.js） ---------- */
  /** 見積依頼を作る（q＝null）・直す */
  function openMitsuForm(q) {
    st.sheet = { kind: "form" };
    openQuoteForm({
      q, sups: st.sups, units: unitsList(), me,
      onSaved: id => { if (!q) { st.view = "mitsu"; st.filter = "all"; st.src = ""; draw(); } waitQuote(id); },
    });
  }
  function waitQuote(id, tries = 0) {
    if ((st.quotes || []).some(x => x.id === id)) navGo(() => openQuote(id));
    else if (tries < 30) setTimeout(() => waitQuote(id, tries + 1), 100);
  }
  /** 見積の画面を開く（keepScroll＝かきなおすとき、いまの場所のまま） */
  function openQuote(id, keepScroll = false) {
    const q = (st.quotes || []).find(x => x.id === id);
    if (!q) return;
    st.sheet = { kind: "quote", id };
    const panel = document.getElementById("panel");
    const y = keepScroll && panel ? panel.scrollTop : 0;
    if (st.openQuoteId !== id) st.qui[id] = {};
    st.openQuoteId = id;
    st.openId = "";
    st.openOrderId = "";
    const ui = st.qui[id] || (st.qui[id] = {});
    const ctx = {
      me, sups: st.sups, places: st.places, info: st.info, ui, sendLabel,
      fileBlock: fileBlockHTML(q, isOpenQuote(q), { title: "ファイル（図面など）", hint: "図面など（DXF・DWG・JWW・PDF・Excel）。1つ 200MB まで。「メールで送る」を押すと、ここのファイルをパソコンの「ダウンロード」に出します。" }),
    };
    openSheet(quoteHTML(q, ctx), p => {
      p.scrollTop = y;
      const w = p.querySelector("#quoteWrap");
      const getQuote = () => (st.quotes || []).find(x => x.id === id);
      wireQuote(w, {
        ...ctx, getQuote,
        redraw: () => openQuote(id, true),
        onErr: ex => toast(errorText(ex)),
        copyOrSend: (x, sup, fb, pack) => copyOrSend(x, sup, fb, st.info, pack),
        openOrder: oid => navGo(() => { st.view = "orders"; st.filter = "all"; st.src = ""; draw(); waitOpen(oid, 0, false); }),   // この見積から作った注文（「← 戻る」で見積にもどれる）
        openForm: x => navGo(() => openMitsuForm(x)),
      });
      wireFiles(w, getQuote, me, { base: "zairyo/quotes", onErr: ex => toast(errorText(ex)), redraw: () => openQuote(id, true) });
    }, { side: true });
  }

  function openOrder(id, keepScroll = false, focusSel = "") {
    const o = (st.orders || []).find(x => x.id === id);
    if (!o) return;
    st.sheet = { kind: "order", id };
    const panel = document.getElementById("panel");
    const y = keepScroll && panel ? panel.scrollTop : 0;
    if (!keepScroll) st.slipFix = "";   // 新しく開いたら、納品書を直す欄は閉じておく
    st.openOrderId = id;
    st.openId = "";
    st.openQuoteId = "";
    openSheet(orderHTML(o), p => {
      p.scrollTop = y;
      fillPhotos(p);
      const w = p.querySelector("#orderWrap");
      w.addEventListener("click", e => onOrderClick(e, w).catch(ex => toast(errorText(ex))));
      // 「▼ 明細を見る」を開いた・とじたを覚える（かきなおしても、そのまま。11/4）。toggle は上に伝わらないので、つかまえる
      w.addEventListener("toggle", e => { const k = e.target.dataset && e.target.dataset.mkey; if (k) { if (e.target.open) st.mOpen.add(k); else st.mOpen.delete(k); } }, true);
      // ファイル（注文書・図面）をつける・出す・消す（10/15。js/fairu.js）
      wireFiles(w, () => (st.orders || []).find(x => x.id === id), me, { onErr: ex => toast(errorText(ex)), redraw: () => openOrder(id, true) });
      // 納品書の金額の欄（js/kingaku.js）：入れたら計算。入れかけの欄は、データが変わっても、かきなおさない（data-dirty）
      w.querySelectorAll("[data-slipform]").forEach(box => wireSlipForm(box, () => { box.dataset.dirty = "1"; }));
      // 「この一文を入れる」（LINE・電話の注文。11/5）：はじめはチェックなし（11/11 事務員さん）。チェックすると、メール・FAX・PDF に「先ほどご連絡した分の注文書です。」を入れる（注文に lineNote）
      w.addEventListener("change", e => {
        if (!("lnote" in e.target.dataset)) return;
        const on = e.target.checked;
        update(ref(db, `zairyo/orders/${id}`), { lineNote: on ? true : null })
          .then(() => toast(on ? `「${LINE_NOTE}」を入れます` : `「${LINE_NOTE}」を入れません`), ex => { e.target.checked = !on; toast(errorText(ex)); });
      });
      w.addEventListener("input", e => {
        if (e.target.id === "amtS") w.querySelector("#eBill").textContent = "";
        const q = e.target.closest("[data-oazq]");   // 預かりから出す数（11/2）
        if (q) {
          const o = (st.orders || []).find(x => x.id === id), l = o && o.lines[q.dataset.oazq], n = azNum(q.value);
          st.oazVal = n ?? 0;
          const h = w.querySelector("[data-oazrest]");
          if (h && l) h.textContent = azRestText(l, n ?? 0);
        }
      });
      if (focusSel) {
        const f = w.querySelector(focusSel);
        if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); f.scrollIntoView({ block: "center" }); }, 30);
      }
    }, { side: true });
  }

  async function onOrderClick(e, w) {
    const t = e.target.closest("[data-gotask],[data-gotall],[data-gotgo],[data-gotno],[data-oaz],[data-oazsave],[data-oazoff],[data-oazno],[data-oquote],[data-oedit],[data-arrive],[data-osent],[data-oapp],[data-back],[data-ocopy],[data-osend],[data-ocancel],[data-ocyes],[data-ocno],[data-slipsave],[data-slipdel],[data-npdel],[data-ord],[data-slipmore],[data-slipfix],[data-slipfixsave],[data-slipfixno],[data-billgo],[data-unbill],[data-unwith],[data-chuban]");
    if (!t || t.disabled) return;
    const d = t.dataset, o = (st.orders || []).find(x => x.id === st.openOrderId);
    if (!o) return;
    if (d.chuban) return copyChuban(d.chuban);   // ネットで買う（10/15）
    // 加工品の「届いた」（11/19）：全部か何個か
    if (d.gotask) { st.gotAsk = o.id; return openOrder(o.id, true); }
    if ("gotno" in d) { st.gotAsk = ""; return openOrder(o.id, true); }
    if (d.gotall || d.gotgo) {
      const w = t.closest("#orderWrap"), rest = partOf(o).per.filter(p => p.got < p.want);
      const entries = d.gotall ? rest.map(p => ({ line: p.lid, qty: p.want - p.got }))
        : [...w.querySelectorAll("[data-gotq]")].map(i => ({ line: i.dataset.gotq, qty: toPrice(i.value) })).filter(x => x.qty > 0);
      if (!entries.length) { const er = w.querySelector("[data-goterr]"); if (er) er.textContent = "届いた数を入れてください"; return; }
      t.disabled = true;
      let r;
      try { r = await markGot(o, entries, me); } catch (ex) { t.disabled = false; throw ex; }
      st.gotAsk = "";
      toast(r.done ? "全部そろいました。「届いた」にしました" : "届いた数を入れました（一部届いた）");
      return openOrder(o.id, true);
    }
    if (d.oquote) return navGo(() => openQuote(d.oquote));    // 見積から（10/15）：もとの見積を開く（「← 戻る」で、この注文にもどれる。11/28）
    if ("oedit" in d) {   // 注文を直す（10/14）
      const r = o.reqId ? (st.reqs || []).find(x => x.id === o.reqId) || null : null;
      return navGo(() => { st.sheet = { kind: "form" }; openOrderEdit({ o, r, places: st.places, units: unitsList(), me, onDone: () => { if (!navBack({ force: true })) openOrder(o.id); } }); });
    }
    const busy = async (label, fn) => {
      const old = t.textContent;
      t.disabled = true;
      t.textContent = label;
      try { await fn(); } catch (ex) { t.disabled = false; t.textContent = old; throw ex; }
      // しまい終わったら、欄にカーソルが残っていても（Safari など）・入れかけの印があっても、中身をかきなおす
      w.querySelectorAll("[data-dirty]").forEach(x => { delete x.dataset.dirty; });
      const a = document.activeElement;
      if (a && w.contains(a)) a.blur();
      refreshPanel();
    };
    if (d.oaz || "oazno" in d) {   // 預かりから（11/2）：数の欄を出す・しまう
      st.oazEdit = d.oaz ? o.id + "/" + d.oaz : "";
      st.oazVal = null;
      openOrder(o.id, true);
      const q = document.querySelector("#orderWrap [data-oazq]");
      if (q) { q.focus(); q.select(); }
      return;
    }
    if (d.oazsave || d.oazoff) {   // 預かりから（11/2）：この数にする・外す
      const lid = d.oazsave || d.oazoff, l = (o.lines || {})[lid], off = !!d.oazoff;
      if (!l || o.status !== "wait") return;
      let az = { azk: null, azkQty: null };
      if (!off) {
        const q = azNum((w.querySelector("[data-oazq]") || {}).value), m = azMatch(o.supplier, l, o.id), e = azErr(l, q, m);
        if (e) { toast(e); return; }
        az = { azk: m.iid, azkQty: q };
      }
      const base = "zairyo/orders/" + o.id, upd = {
        [base + "/lines/" + lid + "/azk"]: az.azk, [base + "/lines/" + lid + "/azkQty"]: az.azkQty,
        [base + "/log/" + push(ref(db, base + "/log")).key]: { at: serverTimestamp(), by: me.name || "事務所", what: off ? "預かりから外した：" + l.spec : "預かりから：" + l.spec + " " + fmtQty(az.azkQty) + l.unit },
      };
      if (o.supState) upd[base + "/supEditedAt"] = serverTimestamp();   // 材料屋のアプリに「事務所が直しました」
      st.oazEdit = "";
      st.oazVal = null;
      await busy("しまっています…", () => update(ref(db), upd));
      toast(off ? "預かりから外しました" : "預かりからにしました（届いたときに、預かりの残りから自動でへります）");
    } else if (d.oapp) {   // 材料屋のアプリに送る（2-2）
      await busy("送っています…", () => sendToApp(o, me));
      toast(`${o.supplierName} のアプリに送りました`);
    } else if (d.osent) {   // 加工品：材料屋に送った（10/15）
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
      const f = w.querySelector("#slipFormBox [data-slipform] input");
      f.focus({ preventScroll: true });
      f.scrollIntoView({ block: "nearest" });
    } else if ("slipsave" in d) {
      const box = w.querySelector("#slipFormBox [data-slipform]"), r = readSlipForm(box, o);
      if (r.err) { box.querySelector('[data-s="err"]').textContent = r.err; r.focus.focus(); return; }
      const was = o.status;
      await busy("しまっています…", () => addSlip(o, r.slip, me));
      toast("納品書の金額を入れました" + (was === "wait" ? "（「届いた」にしました）" : ""));
    } else if (d.slipfix) {   // 材料屋が入れた納品書を直す（2-4。持ち主 4A）
      st.slipFix = `${o.id}/${d.slipfix}`;
      openOrder(o.id, true);
      const f = document.querySelector("#orderWrap [data-fixbox] input");
      if (f) { f.focus({ preventScroll: true }); f.scrollIntoView({ block: "nearest" }); }
    } else if ("slipfixno" in d) {
      st.slipFix = "";
      openOrder(o.id, true);
    } else if ("slipfixsave" in d) {
      const box = w.querySelector("[data-fixbox] [data-slipform]"), r = readSlipForm(box, o);
      if (r.err) { box.querySelector('[data-s="err"]').textContent = r.err; r.focus.focus(); return; }
      st.slipFix = "";
      await busy("しまっています…", () => fixSupSlip(o, r.slip, me)).catch(ex => { st.slipFix = `${o.id}/sup`; throw ex; });
      toast("材料屋が入れた納品書の金額を直しました");
    } else if (d.slipdel) {
      if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "もう一度押すと消えます"; return; }   // 消すときは2回押す
      const cov = coveredBy(st.orders, o.id, d.slipdel).filter(c => c.status !== "billed");
      await busy("消しています…", async () => { await removeSlip(o, d.slipdel); for (const c of cov) await unWith(c); });   // まとめて入っていた注文（11/25）は、まとめるのをやめる（届いたのまま・金額はまだ）
      toast(cov.length ? `納品書を消しました（まとめて入っていた注文 ${cov.length}件は、金額「まだ」にもどしました）` : "納品書を消しました");
    } else if ("unwith" in d) {   // まとめて入っている注文（11/25）：まとめるのをやめる
      await busy("しまっています…", () => unWith(o));
      toast("まとめるのをやめました（届いたのまま・金額はまだ）");
    } else if (d.npdel) {   // 金額のない紙を消す（11/4。「届いた」は、そのまま）
      if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "もう一度押すと消えます"; return; }
      await busy("消しています…", () => removeNpSlip(o, d.npdel));
      toast("金額のない紙を消しました");
    } else if (d.ord) {   // 「注文の品物」⇔「注文にない」（11/4）
      const [kind, sid, rid] = d.ord.split("|"), np = kind === "np";
      const r = ((((np ? o.npSlips : o.slips) || {})[sid] || {}).rows || {})[rid];
      if (!r) return;
      const not = notInOrder(o, rid, r);
      await busy("しまっています…", () => setRowOrd(o, np, sid, rid, not));
      toast(not ? "「注文の品物」にしました" : "「注文にない」にしました");
    } else if (d.billgo) {
      const amt = toPrice(w.querySelector("#amtS").value);
      if (amt == null) { w.querySelector("#eBill").textContent = "請求書の金額を入れてください"; return; }
      // この注文の納品書にまとめて入っている、ほかの注文（11/25）も、0円でいっしょに請求ずみ
      const cov = slipsOf(o).flatMap(([sid]) => coveredBy(st.orders, o.id, sid)).filter(c => c.status === "arrived");
      await busy("しまっています…", async () => { await markBilled(o, Math.round(amt), me); for (const c of cov) await markBilled(c, 0, me); });
      toast(cov.length ? `「請求が来た」にしました（まとめて入っていた注文 ${cov.length}件も、いっしょに請求ずみ）` : "「請求が来た」にしました（請求ずみ）");
    } else if (d.unbill) {
      const cov = slipsOf(o).flatMap(([sid]) => coveredBy(st.orders, o.id, sid)).filter(c => c.status === "billed");
      await busy("もどしています…", async () => { await backToArrived(o); for (const c of cov) await backToArrived(c); });
      toast(cov.length ? `「請求まだ」にもどしました（まとめて入っていた注文 ${cov.length}件も）` : "「請求まだ」にもどしました");
    } else if (d.ocopy || d.osend) {
      await copyOrSend(o, d.osend ? st.sups[o.supplier] : null, w.querySelector("#oCopyFb"), st.info);
    } else if (d.ocancel) {
      const box = w.querySelector(`#ocx-${CSS.escape(d.ocancel)}`);
      box.className = "confirm cxl";
      box.innerHTML = `<p class="confirm-q">${o.reqId ? "この注文を取り消して、品物を依頼にもどしますか？" : "この注文を取り消しますか？（消さずに「取り消した」の印で残します）"}</p>
        <div class="confirm-btns"><button type="button" class="btn danger" data-ocyes="${esc(d.ocancel)}">取り消す</button><button type="button" class="btn" data-ocno>やめる</button></div>`;
      box.scrollIntoView({ block: "nearest" });
    } else if ("ocno" in d) {
      openOrder(o.id, true);
    } else if (d.ocyes) {
      const r = o.reqId ? (st.reqs || []).find(x => x.id === o.reqId) : null;
      await busy("取り消しています…", () => cancelOrder(o, r, me));
      toast(`${o.supplierName} への注文を取り消しました${o.reqId ? "。品物は依頼にもどりました" : ""}`);
      t.closest(".confirm").remove();   // 「本当に？」をしまってから、かきなおす（残すと、かきなおさずに止まって見える）
      afterSave(w);
    }
  }

  /* ---------- まとめて請求（材料屋ごとの月の請求書。11章 5-4 の B） ----------
     11/19 持ち主：材料屋ごとに月1回の作業にする。材料屋と月（⚙ 設定の締め日で区切った「○月分」）をえらぶと、その月の
     「請求まだ」の納品書が、はじめから全部チェックされて出る。請求書の合計が同じなら、ボタン1つで全部「請求ずみ」。
     ちがうときだけ、手がかり（ちがいと同じ金額の納品書・ほかの月の同じ金額の納品書・金額でさがす）を出す。請求ずみは納品書ごと（chumon.js billSlips） */
  const bulk = { sup: "", month: "", pick: {}, amt: {}, totalManual: false, armed: false, done: "", find: "", extra: new Set(), total: "", no: "", date: "",   // extra＝この請求書に足した、ほかの月の納品書
    ai: null, aiBusy: false, aiStep: "", aiErr: "" };   // ai＝AI で読んだ請求書と、合わせた結果（11/20）
  const supName = id => ((st.sups || {})[id] || {}).name || ((st.orders || []).find(o => o.supplier === id) || {}).supplierName || id;
  /** その材料屋の「請求まだ」：納品書ごと（slips）と、納品書がない注文（bare）。key＝"注文/納品書"（納品書がない注文は "注文/-"） */
  function unbilledOf(sid) {
    const d = shimeOf((st.sups || {})[sid]), slips = [], bare = [];
    for (const o of (st.orders || []).filter(x => x.status === "arrived" && x.supplier === sid)) {
      const all = slipsOf(o);
      if (!all.length) { if (!o.withSlip) bare.push({ key: `${o.id}/-`, o }); continue; }   // ほかの注文の納品書にまとめて入っている注文（11/25）は、その納品書といっしょ
      for (const [k, s] of all) if (!s.inv) slips.push({ key: `${o.id}/${k}`, o, sid: k, s, month: billMonth(s.date, d) });
    }
    slips.sort((a, b) => (a.s.date || "").localeCompare(b.s.date || "") || (a.s.at || 0) - (b.s.at || 0));
    return { d, slips, bare };
  }
  /** この納品書にまとめて入っている、ほかの注文の短い説明（11/25） */
  const covText = list => list.map(c => `${md(c.orderedAt)} 注文・${linesShort(c, 30)}`).join("／");
  /** 「○月分」の並び（古い順）：[{ month, from, to, n, sum, closed }] */
  function monthsOf(u) {
    const m = new Map();
    for (const x of u.slips) { const g = m.get(x.month) || { month: x.month, n: 0, sum: 0 }; g.n++; g.sum += Number(x.s.amount) || 0; m.set(x.month, g); }
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map(g => ({ ...g, ...billPeriod(g.month, u.d), closed: billPeriod(g.month, u.d).to < ymd(0) }));
  }
  const monthName = g => `${Number(g.month.slice(5))}月分（${md(g.from)}〜${md(g.to)}）`;
  /** 材料屋か月をえらんだら：その月の納品書を全部チェック。金額のはじめは納品書の金額 */
  function bulkPickMonth() {
    bulk.pick = {}; bulk.amt = {}; bulk.totalManual = false; bulk.armed = false; bulk.find = ""; bulk.extra = new Set(); bulk.total = "";
    if (!bulk.sup) return;
    const u = unbilledOf(bulk.sup), ms = monthsOf(u);
    if (!ms.some(g => g.month === bulk.month)) bulk.month = ms.length ? ms[0].month : "";   // はじめは、いちばん古い月
    for (const x of u.slips) { bulk.amt[x.key] = yen(x.s.amount); if (x.month === bulk.month) bulk.pick[x.key] = true; }
    for (const x of u.bare) bulk.amt[x.key] = x.o.nouhin != null ? yen(x.o.nouhin) : "";
  }

  /* ---------- 請求書を AI で読む（11/20 持ち主） ----------
     請求書（PDF・写真）を入れると、AI が納品書ごとの番号と税抜の金額を読み、アプリの納品書と合わせて
     「合う」「金額がちがう」「請求書にない」「アプリにない」に分ける。合うものは、はじめからチェック。
     品物の行を足した金額が御買上額（税抜）と合わないときは、読みまちがいかもしれないので、チェックを入れない（js/seikyu-ai.js） */
  function invAiHTML() {
    return `
      <div class="block b-ai">
        <div class="b-ai-head"><button type="button" class="btn" id="bInvBtn"${bulk.aiBusy ? " disabled" : ""}>${bulk.ai ? "べつの請求書を読む（AI）" : "請求書を読む（AI）"}</button>
          ${bulk.ai && !bulk.aiBusy ? '<button type="button" class="linkbtn muted" id="bInvClear">AI の結果をけす</button>' : ""}</div>
        <input type="file" id="bInvFile" accept=".pdf,application/pdf,image/*" multiple hidden>
        <p class="hint" id="bInvSt">${bulk.aiBusy ? esc(bulk.aiStep) : "材料屋から来た月の請求書（PDF か写真。何ページでも）を入れると、AI が納品書ごとの番号と税抜の金額を読んで、アプリの納品書と合わせます。"}</p>
        ${bulk.aiErr ? `<p class="err">${esc(bulk.aiErr)}</p>` : ""}
      </div>`;
  }
  function invResultHTML(u, row) {
    const a = bulk.ai, byKey = new Map([...u.slips, ...u.bare].map(x => [x.key, x]));
    const cur = p => byKey.get(p.x.key);
    const ok = a.res.ok.filter(cur), diff = a.res.diff.filter(cur), none = a.res.notOnInv.map(x => byKey.get(x.key)).filter(Boolean);
    const chk = a.chk, inv = a.inv;
    const head = [inv.supplier, inv.closeDate ? `${inv.closeDate.replace(/^(\d{4})-0?(\d+)-0?(\d+)$/, "$1/$2/$3")} 締め` : "", inv.invoiceNo ? `No.${inv.invoiceNo}` : ""].filter(Boolean).join("・");
    const sum = !inv.isInvoice
      ? `<p>請求書ではないようです（AI：${esc(inv.kind || "わからない")}）。チェックは入れていません。</p>`
      : chk.ok
        ? `<p>御買上額（税抜）<b>${yen(chk.kaiage)}円</b>・明細を足すと <b>${yen(chk.sum)}円</b>：合っています。</p>`
        : `<p>${chk.kaiage == null ? "御買上額（税抜）が読めませんでした" : `御買上額（税抜）<b>${yen(chk.kaiage)}円</b>`}・明細を足すと <b>${yen(chk.sum)}円</b>：合いません。</p>
           <p>AI の読みまちがいかもしれません。チェックは入れていません。請求書を見ながら、1つずつチェックしてください。</p>`;
    const vline = v => `${v.date ? md(v.date) + "・" : ""}No.${v.no || "（番号なし）"}${v.chubans.length ? "・" + v.chubans.join("・") : ""}`;
    const sec = (title, n, body, hint = "") => `<h4 class="b-sub">${title}（${n}枚）</h4>${hint ? `<p class="hint">${hint}</p>` : ""}${n ? `<div class="brows">${body}</div>` : ""}`;
    return `
      <div class="bai-sum ${inv.isInvoice && chk.ok ? "ok" : "bad"}">
        <p class="bai-head">請求書：${esc(head || "（会社・締め日が読めませんでした）")}</p>
        ${sum}
        ${a.supWarn ? `<p>${esc(a.supWarn)}</p>` : ""}
        ${inv.doubt && inv.doubt.length ? `<p class="bai-doubt">AI が読みにくかった所：${esc(inv.doubt.join("／"))}</p>` : ""}
        <p class="bai-run">${a.pages}ページを AI で ${a.calls}回に分けて読みました</p>
      </div>
      ${sec("合う", ok.length, ok.map(p => row(cur(p), `<span class="b-ok">請求書と合う（${yen(p.v.amount)}円）</span>`)).join(""), chk.ok ? "請求書の番号と金額が、アプリの納品書と合いました。はじめからチェックが入っています。" : "")}
      ${sec("金額がちがう", diff.length, diff.map(p => row(cur(p), `<span class="b-why2">請求書 ${yen(p.v.amount)}円・納品書 ${yen(cur(p).s ? cur(p).s.amount : cur(p).o.nouhin)}円</span>`)).join(""), diff.length ? "チェックすると、請求書の金額で請求ずみにします。" : "")}
      ${sec("請求書にない", none.length, none.map(x => row(x, '<span class="b-why2 mu">請求書にありません（来月の分かもしれません）</span>')).join(""))}
      ${(a.res.billed || []).length ? sec("もう請求ずみ", a.res.billed.length, a.res.billed.map(p => `<div class="brow b-none"><span class="b-top">${esc(vline(p.v))}${p.v.chubans.includes(p.x.o.chuban) ? "" : `・<span class="chuban">${esc(p.x.o.chuban)}</span>`}　請求ずみ${p.x.o.billedAt ? `（${esc(md(p.x.o.billedAt))}）` : ""}</span><span class="money">${yen(p.v.amount)}円</span></div>`).join(""),
        "前に「請求が来た」や「まとめて請求」で、もう請求ずみにした納品書です。チェックには出しません。") : ""}
      ${sec("アプリにない", a.res.notInApp.length, a.res.notInApp.map(v => `<div class="brow b-none"><span class="b-top">${esc(vline(v))}</span><span class="money">${yen(v.amount)}円</span></div>`).join(""),
        a.res.notInApp.length ? "請求書にあるのに、アプリの請求まだの納品書に見つかりません。取りこみがまだの納品書か、アプリを通さない注文かもしれません。" : "")}`;
  }
  /** その材料屋の、もう請求ずみの納品書（注文が請求ずみ＝「請求が来た」・まとめて請求、と、納品書ごとに請求ずみ）。形は unbilledOf と同じ */
  function billedOf(sid) {
    const slips = [], bare = [];
    for (const o of (st.orders || []).filter(x => x.supplier === sid && (x.status === "billed" || x.status === "arrived"))) {
      const all = slipsOf(o);
      if (!all.length) { if (o.status === "billed") bare.push({ key: `${o.id}/-`, o }); continue; }
      for (const [k, s] of all) if (o.status === "billed" || s.inv) slips.push({ key: `${o.id}/${k}`, o, sid: k, s, month: "" });
    }
    return { slips, bare };
  }
  /** 読んだ請求書を、いまえらんでいる材料屋の「請求まだ」の納品書と合わせて、チェック・金額・合計を入れる */
  function applyInvoice(r) {
    const u0 = unbilledOf(bulk.sup), ms = monthsOf(u0), inv = r.inv, chk = checkInvoice(inv);
    if (inv.closeDate) { const m = billMonth(inv.closeDate, u0.d); if (ms.some(g => g.month === m)) bulk.month = m; }
    bulkPickMonth();
    const u = unbilledOf(bulk.sup);
    const res = matchInvoice(invoiceSlips(inv.rows), u.slips, u.bare, bulk.month);
    // アプリの「請求まだ」に見つからない納品書のうち、前に請求ずみにしたもの（「請求が来た」・まとめて請求）は「もう請求ずみ」に分ける（11/20 持ち主）
    const b = billedOf(bulk.sup), again = matchInvoice(res.notInApp, b.slips, b.bare, "");
    res.billed = [...again.ok, ...again.diff]; res.notInApp = again.notInApp;
    bulk.pick = {};
    for (const p of [...res.ok, ...res.diff]) { if (p.x.s && p.x.month !== bulk.month) bulk.extra.add(p.x.key); bulk.amt[p.x.key] = yen(p.v.amount); }
    if (inv.isInvoice && chk.ok) for (const p of res.ok) bulk.pick[p.x.key] = true;
    if (chk.kaiage != null) { bulk.totalManual = true; bulk.total = yen(chk.kaiage); }
    if (inv.invoiceNo) bulk.no = String(inv.invoiceNo).slice(0, 40);
    if (/^\d{4}-\d{2}-\d{2}$/.test(inv.closeDate || "")) bulk.date = inv.closeDate;
    const sm = inv.supplier ? matchSupplier(inv.supplier, Object.entries(st.sups || {})) : { id: "" };
    const supWarn = sm.id && sm.id !== bulk.sup ? `請求書の会社は「${inv.supplier}」です。えらんでいる材料屋（${supName(bulk.sup)}）とちがうようです。`
      : inv.supplier && !sm.id ? `請求書の会社「${inv.supplier}」が、⚙ 設定の材料屋に見つかりませんでした。材料屋がちがわないか見てください。` : "";
    bulk.ai = { inv, chk, res, pages: r.pages, calls: r.calls, supWarn };
  }
  async function bulkReadInv(files) {
    bulk.aiBusy = true; bulk.aiErr = ""; bulk.aiStep = "請求書を絵にしています…"; bulk.done = "";
    openBulk(true);
    try {
      const r = await readInvoiceFiles(files, {
        onStep: (i, n) => { bulk.aiStep = `AI が請求書を読んでいます…（${i}/${n}回め。1回に30秒〜1分ほどかかります）`; const s = document.querySelector("#bInvSt"); if (s) s.textContent = bulk.aiStep; },
      });
      applyInvoice(r);
    } catch (ex) {
      bulk.aiErr = `請求書を読めませんでした（${errorText(ex)}）`;
    }
    bulk.aiBusy = false;
    openBulk(true);
  }

  function bulkHTML() {
    const arrived = (st.orders || []).filter(o => o.status === "arrived");
    const supIds = [...new Set(arrived.map(o => o.supplier))].sort((a, b) => supName(a).localeCompare(supName(b), "ja"));
    const u = bulk.sup ? unbilledOf(bulk.sup) : null, ms = u ? monthsOf(u) : [];
    const rows = u ? u.slips.filter(x => x.month === bulk.month || bulk.extra.has(x.key)) : [];
    // AI で読んだときは、請求書と合わせた納品書がない注文は「合う」「金額がちがう」の所に出すので、ここには出さない（11/20）
    const aiKeys = bulk.ai ? new Set([...bulk.ai.res.ok, ...bulk.ai.res.diff].map(p => p.x.key)) : null;
    const bare = u ? u.bare.filter(x => !aiKeys || !aiKeys.has(x.key)) : [];
    const items = s => Object.values(s.rows || {}).map(r => r.spec).filter(Boolean).join("／");
    const other = x => { const os = u.slips.filter(y => y.o.id === x.o.id && y.month !== x.month).map(y => `${Number(y.month.slice(5))}月分`); return os.length ? `（この注文の ${[...new Set(os)].join("・")} の納品書は、べつ）` : ""; };
    const row = (x, tag = "") => `
      <div class="brow" data-bk="${esc(x.key)}">
        <label class="b-main"><input type="checkbox" data-bpick="${esc(x.key)}"${bulk.pick[x.key] ? " checked" : ""}>
          <span><span class="b-top">${x.s ? `${esc(md(x.s.date))}・No.${esc(x.s.no || "（番号なし）")}・` : "納品書なし・"}<span class="chuban">${esc(x.o.chuban)}</span> ${esc(zenkana(x.o.kenmei))}</span>
            ${tag}
            ${x.s ? (cv => (cv.length ? `<span class="b-cov">＋ この納品書にまとめて入っている注文：${esc(covText(cv))}（0円・いっしょに請求ずみにします）</span>` : ""))(coveredBy(st.orders, x.o.id, x.sid)) : ""}
            <span class="b-items">${x.s && x.month !== bulk.month ? `<span class="tag">${Number(x.month.slice(5))}月分の納品書</span>` : ""}${esc(x.s ? items(x.s) : Object.values(x.o.lines || {}).map(l => lineText(l)).join("／"))}${x.s ? esc(other(x)) : ""}</span>
            <span class="b-why" hidden></span></span></label>
        <div class="yen-in"><input class="inp" data-bamt="${esc(x.key)}" inputmode="numeric" placeholder="金額" value="${esc(bulk.amt[x.key] ?? "")}" aria-label="${esc(x.o.chuban)} の金額"><span>円</span></div>
      </div>`;
    return `
      <div class="pw" id="bulkWrap">
        <div class="panel-head"><div><span class="eyebrow">月の請求書</span><h2 id="panelTitle">まとめて請求</h2></div>
          <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
        <p class="hint">材料屋から来た月の請求書で、その月の納品書をまとめて「請求ずみ」にします。1件ずつのときは、注文の中身の「請求が来た」でもできます。</p>
        ${bulk.done ? `<p class="okmsg">${esc(bulk.done)}</p>` : ""}
        <div class="two">
          <div class="field"><label for="bSup">材料屋</label>
            <select id="bSup" class="inp">
              <option value="">${supIds.length ? "えらんでください" : "「届いた・請求まだ」の注文はありません"}</option>
              ${supIds.map(id => `<option value="${esc(id)}"${id === bulk.sup ? " selected" : ""}>${esc(supName(id))}（${unbilledOf(id).slips.length + unbilledOf(id).bare.length}件）</option>`).join("")}
            </select></div>
          ${u ? `<div class="field"><label for="bMonth">月（締め日：${esc(shimeText(u.d))}）</label>
            <select id="bMonth" class="inp">${ms.length ? ms.map(g => `<option value="${esc(g.month)}"${g.month === bulk.month ? " selected" : ""}>${esc(monthName(g))}・${g.n}枚・${yen(g.sum)}円${g.closed ? "" : "（まだ締め前）"}</option>`).join("") : '<option value="">請求まだの納品書はありません</option>'}</select></div>` : ""}
        </div>
        ${u ? `<p class="hint">締め日は ⚙ 設定 → 材料屋 で変えられます。どの月の分かは、納品書の日付で決めています。</p>` : ""}
        ${u ? invAiHTML() : ""}
        ${u && (rows.length || u.bare.length || bulk.ai) ? `
          <div class="block">
            ${bulk.ai ? invResultHTML(u, row) : `<h3>${bulk.month ? esc(monthName(ms.find(g => g.month === bulk.month) || { month: bulk.month, ...billPeriod(bulk.month, u.d) })) + "の納品書" : "納品書"}（${rows.length}枚）</h3>
            <div class="brows">${rows.map(x => row(x)).join("")}</div>`}
            ${bare.length ? `<h4 class="b-sub">納品書がない注文（${bare.length}件）</h4>
              <p class="hint">納品書の金額が入っていない注文です。この請求書に入っていれば、金額を入れてチェックしてください。</p>
              <div class="brows">${bare.map(x => row(x)).join("")}</div>` : ""}
            <p class="ptotal"><span id="bCount"></span><span class="money" id="bSum"></span><span>円</span></p>
            <p class="hint">金額のはじめは、納品書の金額です。請求書とちがう納品書は、直してください。</p>
          </div>
          <div class="block">
            <div class="ptotal"><label for="bTotal">請求書の合計（税抜）</label><div class="yen-in"><input id="bTotal" class="inp" inputmode="numeric" placeholder="0" value="${esc(bulk.totalManual ? bulk.total : "")}"><span>円</span></div></div>
            <div class="two">
              <div class="field"><label for="bNo">請求書の番号（あれば）</label><input id="bNo" class="inp" maxlength="40" autocomplete="off" value="${esc(bulk.no)}"></div>
              <div class="field"><label for="bDate">請求書の日付</label><input id="bDate" class="inp" type="date" value="${esc(bulk.date || ymd(0))}"></div>
            </div>
            <div class="bdiff" id="bDiff" hidden></div>
            <div class="field b-find"><label for="bFind">金額でさがす（請求書の1行の金額を入れると、同じ金額の納品書に色がつきます）</label>
              <input id="bFind" class="inp" inputmode="numeric" placeholder="例 5,410" value="${esc(bulk.find)}" autocomplete="off"></div>
            <p class="hint" id="bFound" hidden></p>
            <p class="err" id="bErr"></p>
            <button type="button" class="btn primary big full" id="bGo">請求ずみにする</button>
          </div>` : ""}
      </div>`;
  }

  /** えらんだ件数・合計・請求書とのちがいと手がかり・金額でさがす */
  function bulkCalc(w) {
    if (!w.querySelector("#bSum") || !bulk.sup) return;
    const u = unbilledOf(bulk.sup), all = [...u.slips, ...u.bare], amtOf = x => toPrice(bulk.amt[x.key]);
    const picked = all.filter(x => bulk.pick[x.key]);
    const sum = picked.reduce((s, x) => s + (amtOf(x) || 0), 0);
    w.querySelector("#bCount").textContent = `えらんだ ${picked.length}件の合計`;
    w.querySelector("#bSum").textContent = yen(sum);
    const t = w.querySelector("#bTotal");
    if (!bulk.totalManual) t.value = picked.length ? yen(sum) : "";
    const total = toPrice(t.value), diff = w.querySelector("#bDiff");
    const gap = total == null ? 0 : Math.round(total) - Math.round(sum);
    // 色・わけを消してから、つけなおす
    w.querySelectorAll(".brow[data-bk]").forEach(r => { r.classList.remove("b-hit", "b-find"); const y = r.querySelector(".b-why"); y.hidden = true; y.textContent = ""; });   // 「アプリにない」の行（data-bk なし。11/20）はのぞく
    const mark = (x, cls, why) => { const r = w.querySelector(`.brow[data-bk="${CSS.escape(x.key)}"]`); if (!r) return false; r.classList.add(cls); if (why) { const y = r.querySelector(".b-why"); y.textContent = why; y.hidden = false; } return true; };
    const same = (x, n) => amtOf(x) != null && Math.round(amtOf(x)) === Math.round(n);
    const mName = m => `${Number(String(m).slice(5))}月分`;
    if (gap) {
      const g = Math.abs(gap), notes = [];
      if (gap < 0) {   // 請求書のほうが少ない：えらんだ中に、請求書にない納品書があるかも
        const hit = picked.filter(x => same(x, g));
        hit.forEach(x => mark(x, "b-hit", `この1枚が、ちがい（${yen(g)}円）と同じ金額です。請求書に入っていなければ、チェックを外してください`));
        notes.push(`請求書のほうが ${yen(g)}円 少ないです。請求書にない納品書があれば、チェックを外してください。`);
        if (!hit.length) notes.push("ちがいと同じ金額の納品書は、この月にはありません。金額がちがう納品書がないか、1行ずつ「金額でさがす」で見てください。");
      } else {   // 請求書のほうが多い：えらんでいない納品書・ほかの月の納品書・アプリにない納品書かも
        const here = all.filter(x => !bulk.pick[x.key] && (x.month === bulk.month || !x.s) && same(x, g));
        here.forEach(x => mark(x, "b-hit", `チェックしていない この1枚が、ちがい（${yen(g)}円）と同じ金額です`));
        const away = u.slips.filter(x => x.month !== bulk.month && !bulk.extra.has(x.key) && same(x, g));
        notes.push(`請求書のほうが ${yen(g)}円 多いです。`);
        if (away.length) notes.push("ほかの月の納品書に、同じ金額があります。請求書に入っていたら「この請求書に入れる」を押してください：");
        if (!here.length && !away.length) notes.push("ちがいと同じ金額の納品書は、アプリにありません。アプリにまだ入っていない納品書（取りこんでいない・アプリを通さない注文）か、金額がちがう納品書かもしれません。");
      }
      const awayBtns = gap > 0 ? u.slips.filter(x => x.month !== bulk.month && !bulk.extra.has(x.key) && same(x, g)) : [];
      diff.innerHTML = notes.map(s => `<p>${esc(s)}</p>`).join("") + awayBtns.map(x => `<p class="b-away">${esc(`${mName(x.month)} ${md(x.s.date)} No.${x.s.no || "（番号なし）"} ${x.o.chuban}（${yen(x.s.amount)}円）`)} <button type="button" class="btn" data-badd="${esc(x.key)}">この請求書に入れる</button></p>`).join("");
    }
    diff.hidden = !gap;
    // 金額でさがす：この画面の納品書に色・ほかの月は字で
    const f = toPrice(bulk.find), found = w.querySelector("#bFound");
    if (f != null) {
      const here = all.filter(x => (x.month === bulk.month || !x.s) && same(x, f));
      here.forEach(x => mark(x, "b-find"));
      const away = u.slips.filter(x => x.month !== bulk.month && same(x, f));
      found.textContent = `${yen(f)}円：この月に ${here.length}枚${away.length ? `・ほかの月に ${away.map(x => `${mName(x.month)} ${md(x.s.date)} No.${x.s.no || "（番号なし）"}`).join("・")}` : ""}${here.length || away.length ? "" : "（アプリにはありません）"}`;
      found.hidden = false;
    } else found.hidden = true;
    const go = w.querySelector("#bGo");
    go.textContent = bulk.armed ? "ちがいのまま請求ずみにする（もう一度押す）" : `えらんだ ${picked.length}件を請求ずみにする`;
    go.disabled = !picked.length;
  }

  function openBulk(keepScroll = false) {
    st.sheet = { kind: "bulk" };
    const panel = document.getElementById("panel");
    const y = keepScroll && panel ? panel.scrollTop : 0;
    st.openId = "";
    st.openOrderId = "";
    openSheet(bulkHTML(), p => {
      p.scrollTop = y;
      const w = p.querySelector("#bulkWrap");
      bulkCalc(w);
      w.addEventListener("change", e => {
        if (e.target.id === "bSup" || e.target.id === "bMonth") {
          // 材料屋・月をえらんだら、その月の「請求まだ」の納品書を全部えらぶ（金額は納品書の金額から）
          if (e.target.id === "bSup") { bulk.sup = e.target.value; bulk.month = ""; } else bulk.month = e.target.value;
          bulk.done = ""; bulk.ai = null; bulk.aiErr = "";   // 材料屋・月を変えたら、AI で読んだ結果はけす（11/20）
          bulkPickMonth();
          openBulk(true);
        } else if (e.target.dataset.bpick) {
          bulk.pick[e.target.dataset.bpick] = e.target.checked;
          bulk.armed = false;
          bulkCalc(w);
        } else if (e.target.id === "bInvFile") {   // 請求書を AI で読む（11/20）
          const files = [...(e.target.files || [])];
          e.target.value = "";
          if (files.length) bulkReadInv(files);
        }
      });
      w.addEventListener("input", e => {
        if (e.target.dataset.bamt) bulk.amt[e.target.dataset.bamt] = e.target.value;
        if (e.target.id === "bTotal") { bulk.totalManual = !!e.target.value.trim(); bulk.total = e.target.value; }
        if (e.target.id === "bFind") bulk.find = e.target.value;
        if (e.target.id === "bNo") bulk.no = e.target.value;
        if (e.target.id === "bDate") bulk.date = e.target.value;   // かきなおしても、書いた請求書の合計・番号・日付が消えないように（11/19）
        if (e.target.dataset.bamt || e.target.id === "bTotal" || e.target.id === "bFind") { bulk.armed = false; w.querySelector("#bErr").textContent = ""; bulkCalc(w); }
      });
      w.addEventListener("click", e => {
        const add = e.target.closest("[data-badd]");   // ほかの月の納品書を、この請求書に足す（11/19）
        if (add) { bulk.extra.add(add.dataset.badd); bulk.pick[add.dataset.badd] = true; bulk.armed = false; openBulk(true); return; }
        if (e.target.id === "bInvBtn") { w.querySelector("#bInvFile").click(); return; }
        if (e.target.id === "bInvClear") { bulk.ai = null; bulk.aiErr = ""; bulkPickMonth(); openBulk(true); return; }
        if (e.target.id === "bGo") bulkGo(w, e.target).catch(ex => { w.querySelector("#bErr").textContent = errorText(ex); e.target.disabled = false; bulkCalc(w); });
      });
    }, { side: true });
  }

  async function bulkGo(w, btn) {
    const err = w.querySelector("#bErr");
    const u = unbilledOf(bulk.sup), sup = { id: bulk.sup, name: supName(bulk.sup) };
    const picks = [];
    for (const x of [...u.slips, ...u.bare]) {
      if (!bulk.pick[x.key]) continue;
      const a = toPrice(bulk.amt[x.key]);
      if (a == null) { err.textContent = `${x.o.chuban}${x.s ? ` No.${x.s.no || ""}` : ""} の金額を入れてください（入れないなら、チェックを外してください）`; return; }
      picks.push({ o: x.o, sid: x.sid || null, amount: Math.round(a) });
    }
    if (!picks.length) { err.textContent = "請求ずみにする納品書をえらんでください"; return; }
    // えらんだ納品書にまとめて入っている、ほかの注文（11/25）も、0円でいっしょに請求ずみにする（件数・合計には入れない）
    const main = picks.length;
    for (const p of picks.slice()) if (p.sid) coveredBy(st.orders, p.o.id, p.sid).filter(c => c.status === "arrived").forEach(c => picks.push({ o: c, sid: null, amount: 0 }));
    const total = toPrice(w.querySelector("#bTotal").value);
    if (total == null) { err.textContent = "請求書の合計を入れてください"; return; }
    const sum = picks.reduce((s, x) => s + x.amount, 0);
    if (Math.round(total) !== sum && !bulk.armed) { bulk.armed = true; bulkCalc(w); return; }   // ちがうときは、もう一度押してもらう
    btn.disabled = true;
    btn.textContent = "しまっています…";
    const per = bulk.month ? billPeriod(bulk.month, u.d) : {};
    await billSlips(sup, picks, { no: w.querySelector("#bNo").value.trim(), date: w.querySelector("#bDate").value || ymd(0), total: Math.round(total), month: bulk.month, from: per.from, to: per.to }, me);
    bulk.done = `${sup.name}${bulk.month ? ` の ${Number(bulk.month.slice(5))}月分` : ""}：${main}件を請求ずみにしました（合計 ${yen(sum)}円）${picks.length > main ? `。まとめて入っていた注文 ${picks.length - main}件も、いっしょに請求ずみにしました` : ""}`;
    bulk.month = ""; bulk.no = ""; bulk.date = ""; bulk.ai = null;
    bulkPickMonth();   // のこりがあれば、つぎの月を出す
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
      if (a && a.closest && a.closest("#reqWrap") && a.matches("select, textarea, input")) return;   // えらんでいる・数を入れている途中はかきなおさない
      if (document.querySelector("#reqWrap .confirm")) return;   // 「本当に？」を出している途中はかきなおさない
      openReq(st.openId, true);
    } else if (st.openOrderId && document.getElementById("orderWrap")) {
      if (a && a.closest && a.closest("#orderWrap") && a.matches("input, textarea")) return;   // 金額などを入れている途中
      if (document.querySelector("#orderWrap .confirm")) return;   // 「本当に？」を出している途中はかきなおさない
      if (document.querySelector("#orderWrap [data-dirty]")) return;   // 納品書の金額を入れかけ（2-4）
      openOrder(st.openOrderId, true);
    } else if (st.openQuoteId && document.getElementById("quoteWrap")) {   // 見積（10/15）
      const w = document.getElementById("quoteWrap");
      if (a && a.closest && a.closest("#quoteWrap") && a.matches("input, textarea, select")) return;   // 返事などを入れている途中
      if (w.dataset.dirty || w.querySelector(".confirm")) return;   // 書きかけ・「本当に？」の途中はかきなおさない
      openQuote(st.openQuoteId, true);
    }
  }

  /* ---------- 預かりの台帳（11/2。js/azukari.js）：「預かりを使う」の材料屋がいるときだけ「預かり」のボタン ---------- */
  const azSups = () => Object.entries(st.sups || {}).filter(([, s]) => s && s.azukari && !s.hidden).sort(byOrder);
  function drawAzBtn() {
    const b = $("#azBtn", main);
    if (b) b.hidden = !azSups().length;
  }
  function openAz() {
    st.sheet = { kind: "form" };
    const list = azSups(), go = ([id, s]) => openAzukari({ sup: id, supName: s.name, role: "office", by: me.name || "事務所", catalog: st.catalog });
    if (list.length === 1) return go(list[0]);
    openSheet(`<div class="pw" id="azPick"><div class="panel-head"><div><h2 id="panelTitle">預かり：材料屋をえらぶ</h2></div><button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <div class="stack">${list.map(([id, s]) => `<button type="button" class="btn big" data-azsup="${esc(id)}">${esc(s.name)}</button>`).join("")}</div></div>`, p => {
      p.querySelector("#azPick").addEventListener("click", e => { const b = e.target.closest("[data-azsup]"); if (b) go(list.find(([id]) => id === b.dataset.azsup)); });
    }, { side: true });
  }

  /* ---------- 押したとき（一覧） ---------- */
  main.addEventListener("click", e => {
    // カードの中の「取り消し」のたしかめの所（理由の欄など）は、押してもカードを開かない
    if (e.target.closest(".rcx-box") && !e.target.closest("[data-rcxyes],[data-rcxno],[data-rrsyes]")) return;
    const t = e.target.closest("[data-rcx],[data-rcxyes],[data-rcxno],[data-rcxseen],[data-rrs],[data-rrsyes],[data-newbox],[data-mitsubox],[data-filter],[data-src],[data-view],[data-next],[data-bill],[data-kouji],[data-reqopen],[data-req],[data-open],[data-quote],#billBtn,#lineBtn,#kakouBtn,#mitsuBtn,#impBtn,#azBtn,#setBtn,#setBack,#clearQ");
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
    else if (d.rcxseen) seeCx(d.rcxseen, t).catch(ex => { t.disabled = false; toast(errorText(ex)); });
    else if ("newbox" in d) navGo(() => { st.view = "irai"; st.filter = "all"; st.src = ""; draw(); });   // 画面をうつしたら「← 戻る」でもどれる（11/28）
    else if ("mitsubox" in d) navGo(() => { st.view = "mitsu"; st.filter = "all"; st.src = ""; draw(); });
    else if (d.src) navGo(() => { st.src = d.src; draw(); });   // 納品書から作った注文だけ（10/30）
    else if (d.filter) {
      // ようすの箱：その注文だけの一覧。もう一度押すと、しぼりこみをやめる
      const ov = st.view === "orders" || st.view === "kouji";
      navGo(() => {
        st.filter = ov && st.filter === d.filter ? "all" : d.filter;
        if (!ov) st.view = "orders";
        draw();
      });
    }
    else if (d.view) { if (d.view !== st.view) navGo(() => { st.view = d.view; if (d.view !== "orders" && d.view !== "kouji") st.src = ""; draw(); }); }
    else if (d.next) {
      const o = (st.orders || []).find(x => x.id === d.next);
      if (!o) return;
      if (isKakou(o)) { st.gotAsk = o.id; navGo(() => openOrder(o.id)); return; }   // 加工品は「全部か何個か」をえらぶ（11/19）
      t.disabled = true;
      markArrived(o, me).then(() => toast("「届いた」にしました。納品書の金額は、あとで入れられます"), ex => { t.disabled = false; toast(errorText(ex)); });
    }
    else if (d.bill) navGo(() => openOrder(d.bill, false, "#amtS"));
    else if (d.kouji) navGo(() => { st.view = "orders"; st.q = d.kouji; $("#q", main).value = d.kouji; draw(); window.scrollTo({ top: 0 }); });   // 工事ごと → 注番でさがす（「← 戻る」で工事ごとの位置にもどる）
    else if (d.reqopen) navGo(() => openReq(d.reqopen));
    else if (d.req) navGo(() => openReq(d.req));
    else if (d.open) navGo(() => openOrder(d.open));
    else if (d.quote) navGo(() => openQuote(d.quote));
    else if (t.id === "mitsuBtn") navGo(() => openMitsuForm(null));   // 見積依頼を作る（10/15）
    else if (t.id === "billBtn") navGo(() => { bulk.done = ""; openBulk(); });
    else if (t.id === "impBtn") navGo(() => { st.sheet = { kind: "form" }; openImport({ sups: st.sups, getOrders: () => st.orders, me }); });
    else if (t.id === "kakouBtn") {   // 加工品の注文（図面つき）（10/15）
      navGo(() => { st.sheet = { kind: "form" }; openKakouOrder({ sups: st.sups, places: st.places, units: unitsList(), me, onPlaced: id => { st.view = "orders"; st.filter = "all"; st.src = ""; draw(); waitOpen(id); } }); });
    }
    else if (t.id === "lineBtn") {
      navGo(() => { st.sheet = { kind: "form" }; openLineOrder({ sups: st.sups, places: st.places, catalog: st.catalog, me, onPlaced: id => { st.view = "orders"; st.filter = "all"; st.src = ""; draw(); navGo(() => openOrder(id)); } }); });
    }
    else if (t.id === "azBtn") navGo(() => openAz());   // 預かりの台帳（11/2）
    else if (t.id === "setBtn") navGo(() => showSettings(true));
    else if (t.id === "setBack") { if (!navBack()) showSettings(false); }   // 「‹ 依頼・注文の画面にもどる」＝ 1つ前にもどる（11/28）
    else if (t.id === "clearQ") navGo(() => { st.q = ""; st.filter = "all"; st.src = ""; $("#q", main).value = ""; draw(); });
  });
  // 工事ごとの「届いた品物」を開いた・とじたを覚える（一覧をかきなおしても、そのまま。11/4）
  main.addEventListener("toggle", e => { const k = e.target.dataset && e.target.dataset.koji; if (k) st.kojiOpen[k] = e.target.open; }, true);
  main.addEventListener("keydown", e => {
    const c = e.target.closest && e.target.closest("[data-req],[data-open],[data-quote]");
    if (c && e.target === c && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      navGo(() => { if (c.dataset.req) openReq(c.dataset.req); else if (c.dataset.quote) openQuote(c.dataset.quote); else openOrder(c.dataset.open); });
    }
  });
  main.addEventListener("input", e => {
    if (e.target.id === "q") { st.q = e.target.value; draw(); }
    if (e.target.id === "rcxReason") st.cxReason = e.target.value;
  });
  // さがす欄（11/28）：打ちはじめる前のようすをとっておき、打ちおわったら（欄から出た・Enter）「画面をうつした」に数える
  let qSnap = null;
  main.addEventListener("focusin", e => { if (e.target.id === "q") qSnap = snapNow(); });
  main.addEventListener("change", e => { if (e.target.id === "q" && qSnap && qSnap.q !== st.q) { pushSnap(qSnap); qSnap = snapNow(); } });
  // 「← 戻る」とブラウザの戻る（js/modoru.js。11/28）：画面のようす（タブ・しぼりこみ・さがした字・一覧の位置・右に出していた画面）
  const sheetOn = () => { const sh = document.getElementById("sheet"); return !!(sh && !sh.hidden); };
  const reopen = x => {
    if (x.kind === "req" && (st.reqs || []).some(r => r.id === x.id)) openReq(x.id);
    else if (x.kind === "order" && (st.orders || []).some(o => o.id === x.id)) openOrder(x.id);
    else if (x.kind === "quote" && (st.quotes || []).some(q => q.id === x.id)) openQuote(x.id);
    else if (x.kind === "bulk") openBulk();
    else closeSheet();
  };
  initNav({
    snapshot: () => ({
      view: st.view, filter: st.filter, src: st.src, q: st.q, y: window.scrollY, set: !$("#setView", main).hidden,
      sheet: sheetOn() && st.sheet && st.sheet.kind !== "form" ? { ...st.sheet, py: (document.getElementById("panel") || {}).scrollTop || 0 } : null,
    }),
    isForm: () => sheetOn() && !!st.sheet && st.sheet.kind === "form",
    restore: x => {
      if (x.set !== !$("#setView", main).hidden) showSettings(x.set);
      st.view = x.view; st.filter = x.filter; st.src = x.src; st.q = x.q;
      const q = $("#q", main); if (q) q.value = x.q;
      draw();
      if (x.sheet) reopen(x.sheet); else closeSheet();
      const put = () => { window.scrollTo(0, x.y); const p = document.getElementById("panel"); if (x.sheet && p) p.scrollTop = x.sheet.py || 0; };
      put(); requestAnimationFrame(put);
    },
  });

  /** ⚙ 設定：はじめて開くときに作る（そのあとは見せる・かくすだけ） */
  function showSettings(on) {
    $("#home", main).hidden = on;
    $("#setView", main).hidden = !on;
    if (on && !st.settingsOpen) { renderSettings($("#settei", main)); st.settingsOpen = true; }
    window.scrollTo(0, 0);
  }

  // 依頼の通知を押したとき（sw.js が知らせる。11/10）：読みなおさずに「依頼」のタブに切りかえる（書きかけの注文などは、そのまま）
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", e => {
      if (!e.data || e.data.type !== "zairyo-view" || e.data.view !== "irai") return;
      if (!$("#setView", main).hidden) showSettings(false);
      st.view = "irai"; st.filter = "all"; st.src = "";
      if (st.q) { st.q = ""; const q = $("#q", main); if (q) q.value = ""; }   // さがしていた字で、新しい依頼がかくれないように
      draw();
      window.scrollTo({ top: 0 });
    });
    try { navigator.serviceWorker.startMessages(); } catch (err) { }
  }

  /* ---------- データ ---------- */
  onValue(ref(db, "zairyo/requests"), s => {
    st.reqs = Object.entries(s.val() || {}).map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
    draw(true);
    refreshPanel();
  });
  onValue(ref(db, "zairyo/orders"), s => {
    st.orders = Object.entries(s.val() || {}).map(([id, o]) => ({ id, ...o }));
    draw(true);
    refreshPanel();
  }, ex => { st.orders = []; toast("注文を読めませんでした（" + errorText(ex) + "）"); });
  setInterval(() => { if (!document.hidden) draw(true); }, 30 * 60 * 1000);   // 返事なし（日がかわると出る。2-6）を、ときどきかきなおす
  // 見積（10/15）：事務所だけが読める
  onValue(ref(db, "zairyo/quotes"), s => {
    st.quotes = Object.entries(s.val() || {}).map(([id, q]) => ({ id, ...q }));
    draw(true);
    refreshPanel();
  }, ex => { st.quotes = []; toast("見積を読めませんでした（" + errorText(ex) + "）"); });
  onValue(ref(db, "zairyo/master/catalog"), s => { st.catalog = normCatalog(s.val()); });
  // メールで送る材料屋があれば、PDF を作る道具を先に読んでおく（押したときに待たないように。11/2）
  let pdfPre = false;
  const preloadPdf = () => {
    if (pdfPre || !Object.values(st.sups || {}).some(s => s && s.send === "mail")) return;
    pdfPre = true;
    setTimeout(() => loadPdfLibs().catch(() => { pdfPre = false; }), 4000);
  };
  onValue(ref(db, "zairyo/master/suppliers"), s => { st.sups = s.val() || {}; refreshPanel(); drawAzBtn(); preloadPdf(); });
  // 預かり（11/2）：注文するときの「預かりにあり（残り○本）」に使う
  onValue(ref(db, "zairyo/azukari"), s => { st.az = s.val() || {}; refreshPanel(); }, () => { st.az = {}; });
  onValue(ref(db, "zairyo/master/places"), s => { st.places = s.val() || {}; });
  // ⚙ 設定の「会社・注文書」と、注文する人の電話番号（事務所だけ読める。注文の文・FAX に入れる。10/14）
  st.info = {};
  onValue(ref(db, "zairyo/officeInfo"), s => { st.info = s.val() || {}; }, () => { st.info = {}; });

  draw();
}
