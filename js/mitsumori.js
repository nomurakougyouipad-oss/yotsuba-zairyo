// 見積依頼（10/15 事務所の相談「見積依頼 → 注文」の3。4 の相見積もりは、このあと材料屋を足せるようにする）
// - データは /zairyo/quotes/{番号}（事務所だけが読み書き）。最初から、いくつかの材料屋に出せる形（sups/{材料屋の番号}）
//   { chuban, kenmei, tantou（文の「担当者」＝見積を出す事務所の人）, kojiTantou（工事の担当。日報から）, memo（事務所だけ）,
//     kibou（"" 書かない／"最短"／日付）, lines, files（図面など。置き場は zairyo/files/{見積の番号}/）,
//     sups: { 材料屋: { name, to, unsent（まだ送っていない）, sentAt, sentBy,
//             answer: { rows: { 品物: { kg, perKg, price, amount } }, total, nouki, memo, file（見積書）, at, by } } },
//     status: "open" | "ordered" | "closed", orderId, orderSup, orderedAt, closedAt, closedBy, createdAt, createdBy }
// - 見積依頼の文は docs の見本（01見積依頼.txt）の形。決まり文句は「見積金額と納期の回答をお願いいたします」。会社の情報は ⚙ 設定から
// - 送り方は注文と同じ（メール・LINE・FAX・コピー。jimusho-app.js の copyOrSend に、この見積の文などをわたす）。FAX は見積依頼書の表（fax.js）
// - 返事：品物ごとに Kg・¥/kg（書かなくてもよい。入れたら金額と単価が出る）・単価・金額、合計（税抜）・納期・メモ・見積書（PDF など）
// - 「この見積で注文する」：品物・ファイル（図面など。見積書は入れない）・見積の単価（qprice）が入った注文を作る（kind:"mitsumori"・unsent:true。
//   加工品と同じく「送った」で消える）。注文の画面から、もとの見積を開ける（quoteId）
import { ref, push, set, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { esc, zenkana, toast, openSheet, closeSheet } from "./common.js";
import { ymd, kibouText, lineText, fmtQty } from "./tanomu.js";
import { normalizeChuban } from "./kouji.js";
import { CHUBAN_RE } from "./nippo.js";
import { errorText } from "./touroku.js";
import { companyLines, yen, toPrice, COMPANY } from "./chumon.js";
import { filesOf, okFiles, uploadFile, removeUploaded, sizeText, downloadFiles } from "./fairu.js";
import { byOrder, unitsOr, sendWord, itemsFieldHTML, wireItems, readItems, rowsToLines, linesToRows, filePickHTML, wireFilePick, uploadPicked, wireChuban, fillStaff } from "./kakou.js";
import { printHTML, mitsumoriFaxHTML } from "./fax.js";

const DAY = 24 * 60 * 60 * 1000;
const pad = n => String(n).padStart(2, "0");
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** 見積の品物（l01, l02 … の順） */
export const qLines = q => Object.entries(q.lines || {}).sort(([a], [b]) => a.localeCompare(b));
/** 単価など（小数もあるので、カンマだけつけて丸めない） */
const comma = n => (n == null || n === "" ? "" : Number(n).toLocaleString("ja-JP", { maximumFractionDigits: 2 }));
const kibouWord = k => (!k ? "" : k === "最短" ? "最短" : kibouText(k));

/* ---------- ようす ---------- */
/** 材料屋ごと：unsent まだ送っていない／wait 返事待ち／answered 返事が来た */
export const supState = s => (s.answer ? "answered" : s.unsent ? "unsent" : "wait");
/** 見積ぜんたいのようす { key, label, color, solid }。まだ送っていない → 返事待ち → 返事が来た の順に、やることを出す */
export function quoteState(q, now = Date.now()) {
  if (q.status === "ordered") return { key: "ordered", label: "注文した", color: "var(--grey)" };
  if (q.status === "closed") return { key: "closed", label: "やめた", color: "var(--grey)" };
  const ss = Object.values(q.sups || {});
  if (ss.some(s => supState(s) === "unsent")) return { key: "unsent", label: "まだ送っていない", color: "var(--amber)", solid: true };
  const waiting = ss.filter(s => supState(s) === "wait");
  if (waiting.length) {
    const first = Math.min(...waiting.map(s => s.sentAt || now)), d = Math.floor((now - first) / DAY);
    const got = ss.length - waiting.length;
    return { key: "wait", label: `返事待ち・${d ? `${d}日` : "今日"}${got ? `（${got}/${ss.length} 来た）` : ""}`, color: "var(--amber)", solid: true };
  }
  return { key: "answered", label: "返事が来た", color: "var(--blue)" };
}
export const isOpenQuote = q => q.status !== "ordered" && q.status !== "closed";

/* ---------- 見積依頼の文（docs の見本 01見積依頼.txt の形） ---------- */
export function mitsumoriText(q, supId, info = {}) {
  const s = (q.sups || {})[supId] || {}, tels = info.tels || {};
  const who = n => (n && tels[n] ? `${n}(${tels[n]})` : n || "");
  const L = ["------------------------------------------", "　　　　　　　 見　積　依　頼", "------------------------------------------", ""];
  L.push(`見積先　${s.name || ""}　${s.to || "御中"}`, "");
  L.push(`工事件名　${zenkana(q.kenmei || "")}`, `工事番号　${q.chuban || ""}`, "");
  L.push("品名", ...qLines(q).map(([, l]) => lineText(l)));
  const fl = filesOf(q).map(([, f]) => f.name).filter(Boolean);
  if (fl.length) L.push(`※添付ファイル：${fl.join("、")}`);
  L.push("");
  if (q.kibou) L.push("希望納期", kibouWord(q.kibou), "");
  L.push("担当者", who(q.tantou), "");
  L.push("見積金額と納期の回答をお願いいたします", "");
  const f = companyLines(info.company);
  if (f.length) L.push("------------------------------------------", ...f.map(x => "  " + x), "-------------------------------------------");
  return L.join("\n");
}
/** 送るときにわたすもの（jimusho-app.js の copyOrSend）：文・メールや LINE の住所・FAX の印刷・ファイル */
export function quotePack(q, supId, sup, info = {}) {
  const enc = encodeURIComponent, text = mitsumoriText(q, supId, info);
  return {
    text,
    url: s => {
      if (s.send === "mail") {
        const cc = Object.values(s.cc || {}).filter(Boolean);
        return `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(s.email || "")}${cc.length ? `&cc=${enc(cc.join(","))}` : ""}&su=${enc(`見積依頼　${q.chuban}　${zenkana(q.kenmei || "")}（${COMPANY}）`)}&body=${enc(text)}`;
      }
      if (s.send === "line") return `https://line.me/R/share?text=${enc(text)}`;
      return "";
    },
    fax: () => printHTML(mitsumoriFaxHTML(q, supId, sup, info)),
    files: filesOf(q).map(([, f]) => f),
  };
}

/* ---------- 一覧のカード ---------- */
export function quoteCard(q) {
  const s = quoteState(q), sups = Object.values(q.sups || {});
  const ans = sups.filter(x => x.answer);
  const money = x => `${yen(x.answer.total)}円${x.answer.nouki ? `（納期 ${x.answer.nouki}）` : ""}`;
  const chosen = q.status === "ordered" && q.sups && q.sups[q.orderSup];
  const cheap = ans.length ? ans.reduce((m, x) => (x.answer.total < m.answer.total ? x : m)) : null;
  // 相見積もりは「いちばん安い店」、1つの店は見積の金額、注文したら注文した店。返事がまだなら品物
  const items = chosen && chosen.answer ? `注文した：${chosen.name} ${money(chosen)}`
    : cheap && s.key !== "unsent" ? (sups.length > 1 ? `いちばん安い：${cheap.name} ${money(cheap)}` : `見積 ${money(cheap)}`)
    : qLines(q).map(([, l]) => lineText(l)).join("\n");
  return `
    <article class="ocard${isOpenQuote(q) ? "" : " cx"}${s.key === "unsent" ? " unsent" : ""}" tabindex="0" data-quote="${esc(q.id)}" style="--c:${s.color}">
      <div class="card-head"><span class="sup">${esc(sups.map(x => x.name).join("・"))} <span class="tag">見積</span></span>
        <span class="ochip${s.solid ? " solid" : s.key === "answered" ? " blue" : ""}">${esc(s.label)}</span></div>
      <div class="kouji"><span class="chuban">${esc(q.chuban)}</span><span class="kenmei">${esc(zenkana(q.kenmei || ""))}</span></div>
      <div class="items">${esc(items)}</div>
    </article>`;
}

/* ---------- 見積依頼を作る・直す ---------- */
/** opts = { q（直すときの見積。作るときは null）, sups, units, me, onSaved(見積の番号) } */
export function openQuoteForm({ q = null, sups, units, me, onSaved }) {
  const edit = !!q;
  const supList = Object.entries(sups || {}).filter(([, s]) => !s.hidden && s.send !== "net").sort(byOrder);
  const us = unitsOr(units);
  const f = { kibou: edit ? q.kibou || "" : "" };
  const picked = [];
  let stopJobs = null, busy = false;
  const kSel = v => (v === "" ? "none" : v === "最短" ? "最短" : "__date");
  const answered = edit && Object.values(q.sups || {}).some(s => s.answer);

  const html = `
    <div class="pw" id="qformWrap">
      <div class="panel-head"><div><span class="eyebrow">${edit ? "見積" : "事務所から注文を入れる"}</span><h2 id="panelTitle">${edit ? "見積依頼を直す" : "見積依頼を作る"}</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <p class="hint">${edit ? "直したら、もう送った材料屋には、もう一度送ってください（見積の画面の「メールで送る」など）。" : "材料屋に見積を出します。作ったあと、見積の画面の「メールで送る」などで送ります。"}</p>
      ${answered ? '<p class="warn">返事が入っています。品物を直すと、返事の品物ごとの金額と合わなくなることがあります。</p>' : ""}
      <form id="qForm" class="stack" novalidate>
        ${edit ? `<div class="field"><span class="lab">見積を出す材料屋</span><p>${esc(Object.values(q.sups || {}).map(s => s.name).join("・"))}</p></div>` : `
        <div class="field"><span class="lab">見積を出す材料屋<span class="req">必ず</span>（いくつでも）</span>
          <div class="pick" id="qSups">${supList.map(([id, s]) => `<button type="button" data-qsup="${esc(id)}" aria-pressed="false">${esc(s.name)}${sendWord(s) ? `（${sendWord(s)}）` : ""}</button>`).join("")}</div>
          <span class="hint">2つ以上えらぶと「相見積もり」になります。同じ見積依頼を、それぞれの材料屋に送ります。あとから足すこともできます。</span>
          <p class="err" id="eSup"></p></div>`}
        <div class="two">
          <div class="field"><label for="kChuban">注番（工事番号）<span class="req">必ず</span></label>
            <input id="kChuban" class="inp" list="kJobList" placeholder="例 AB26123" autocomplete="off" autocapitalize="characters" maxlength="12" value="${esc(edit ? q.chuban : "")}">
            <datalist id="kJobList"></datalist><span class="hint" id="hChuban"></span></div>
          <div class="field"><label for="kKenmei">工事件名<span class="req">必ず</span></label>
            <textarea id="kKenmei" class="inp oneline" rows="1" maxlength="100" autocomplete="off" data-oneline>${esc(edit ? q.kenmei : "")}</textarea><p class="err" id="eKenmei"></p></div>
        </div>
        <input type="hidden" id="kKoji" value="${esc(edit ? q.kojiTantou || "" : "")}">
        ${itemsFieldHTML(us, "品物", edit ? linesToRows(q.lines) : [])}
        ${edit ? '<p class="hint">ファイル（図面など）は、見積の画面の「ファイル」の欄で、足す・消すができます。</p>'
          : filePickHTML("ファイル（図面など）", "DXF・DWG・JWW・PDF・Excel など。1つ 200MB まで。「見積依頼を作る」を押したときに上げます。")}
        <div class="field"><span class="lab">希望の納期（あれば）</span>
          <div class="pick">
            <button type="button" data-qk="none" aria-pressed="${kSel(f.kibou) === "none"}">書かない</button>
            <button type="button" data-qk="最短" aria-pressed="${kSel(f.kibou) === "最短"}">最短</button>
            <button type="button" data-qk="__date" aria-pressed="${kSel(f.kibou) === "__date"}">日付をえらぶ</button></div>
          <input id="qDate" class="inp" type="date" aria-label="希望の納期"${kSel(f.kibou) === "__date" ? ` value="${esc(f.kibou)}"` : " hidden"}>
          <span class="hint">えらんだときだけ、見積依頼の文に「希望納期」が入ります。</span></div>
        <div class="two">
          <div class="field"><label for="qTan">担当者（文の「担当者」）</label>
            <input id="qTan" class="inp" list="kStaffList" maxlength="20" autocomplete="off" value="${esc(edit ? q.tantou || "" : me.name || "")}"><datalist id="kStaffList"></datalist>
            <span class="hint">⚙ 設定の電話番号があれば、名前のうしろに入ります。</span></div>
          <div class="field"><label for="qMemo">メモ（事務所だけ）</label><textarea id="qMemo" class="inp ta" rows="2" maxlength="500">${esc(edit ? q.memo || "" : "")}</textarea></div>
        </div>
        <p class="hint ok" id="kProg" role="status" hidden></p>
        <p class="err" id="eAll"></p>
        <div class="row"><button type="submit" class="btn primary big" id="qGo">${edit ? "直したところを保存" : "見積依頼を作る"}</button>
          <button type="button" class="btn" data-close>やめる</button></div>
      </form>
    </div>`;

  openSheet(html, panel => {
    const p = panel.querySelector("#qformWrap");
    const g = s => p.querySelector(s);
    stopJobs = wireChuban(p, { chuban: "#kChuban", kenmei: "#kKenmei", tantou: "#kKoji", hint: "#hChuban", list: "#kJobList", kerr: "#eKenmei" });
    fillStaff(g("#kStaffList"));
    wireItems(p, us);
    if (!edit) wireFilePick(p, picked);
    p.addEventListener("click", e => {
      const k = e.target.closest("[data-qk]");
      if (!k) return;
      p.querySelectorAll("[data-qk]").forEach(x => x.setAttribute("aria-pressed", x === k));
      const date = k.dataset.qk === "__date";
      g("#qDate").hidden = !date;
      if (date) { g("#qDate").min = ymd(0); g("#qDate").focus(); }
      f.kibou = date ? g("#qDate").value || null : k.dataset.qk === "最短" ? "最短" : "";
    });
    g("#qDate").addEventListener("change", e => { f.kibou = e.target.value || null; });
    // 見積を出す材料屋：押すたびに、えらぶ・外す（相見積もり。10/15）
    p.addEventListener("click", e => {
      const b = e.target.closest("[data-qsup]");
      if (!b) return;
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      b.textContent = (on ? "✓ " : "") + b.textContent.replace(/^✓ /, "");
      g("#eSup").textContent = "";
    });

    g("#qForm").addEventListener("submit", e => {
      e.preventDefault();
      submit().catch(ex => {
        busy = false;
        g("#qGo").disabled = false;
        g("#qGo").textContent = edit ? "直したところを保存" : "見積依頼を作る";
        g("#kProg").hidden = true;
        g("#eAll").textContent = errorText(ex) + (edit ? "" : "（見積依頼は、まだ作っていません）");
      });
    });
    async function submit() {
      if (busy) return;
      const errs = [];
      const pickedSups = edit ? [] : [...p.querySelectorAll("[data-qsup][aria-pressed=\"true\"]")].map(b => b.dataset.qsup).filter(id => (sups || {})[id]);
      const chuban = normalizeChuban(g("#kChuban").value), kenmei = g("#kKenmei").value.replace(/\s*\n\s*/g, " ").trim();
      if (!edit && !pickedSups.length) { g("#eSup").textContent = "見積を出す材料屋を、1つ以上えらんでください"; errs.push(g("#qSups button")); }
      if (!CHUBAN_RE.test(chuban)) { const h = g("#hChuban"); h.textContent = chuban ? "形がちがいます（例 AB26123）" : "注番を入れてください"; h.className = "hint bad"; errs.push(g("#kChuban")); }
      if (!kenmei) { g("#eKenmei").textContent = "工事件名を入れてください"; errs.push(g("#kKenmei")); }
      const it = readItems(p);
      if (it.err) { g("#eRows").textContent = it.err; errs.push(it.focus); }
      if (f.kibou === null) { toast("希望の納期の日付をえらんでください"); errs.push(g("#qDate")); }
      if (errs.length) {
        const el = errs.find(Boolean);
        if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "center" }); }
        return;
      }
      g("#eAll").textContent = "";
      busy = true;
      const go = g("#qGo");
      go.disabled = true;
      go.textContent = edit ? "保存しています…" : "作っています…";
      const head = {
        chuban, kenmei, kibou: f.kibou || "", tantou: g("#qTan").value.trim().slice(0, 20),
        kojiTantou: g("#kKoji").value.trim().slice(0, 20), memo: g("#qMemo").value.trim().slice(0, 500), lines: rowsToLines(it.rows),
      };
      if (edit) {
        await update(ref(db, `zairyo/quotes/${q.id}`), head);
        busy = false;
        closeSheet();
        toast("見積依頼を直しました");
        if (onSaved) onSaved(q.id);
        return;
      }
      const key = push(ref(db, "zairyo/quotes")).key;
      const { files, paths } = await uploadPicked(key, picked, me, g("#kProg"));
      try {
        g("#kProg").hidden = false;
        g("#kProg").textContent = "見積依頼をしまっています…";
        await set(ref(db, `zairyo/quotes/${key}`), {
          ...head, ...(paths.length ? { files } : {}),
          sups: Object.fromEntries(pickedSups.map(id => [id, { name: sups[id].name, to: sups[id].to || "御中", unsent: true }])),
          status: "open", createdAt: serverTimestamp(), createdBy: me.name, createdByUid: auth.currentUser.uid,
        });
      } catch (ex) {
        await removeUploaded(paths);
        throw ex;
      }
      busy = false;
      closeSheet();
      toast(`${pickedSups.map(id => sups[id].name).join("・")} への見積依頼を作りました。材料屋ごとに「メールで送る」などで送ってください`);
      if (onSaved) onSaved(key);
    }
  }, { side: true, onClose: () => { if (stopJobs) stopJobs(); } });
}

/* ---------- 見積の画面 ---------- */
/** ctx = { me, sups（いまの材料屋）, places, info, sendLabel, ui（画面だけの状態 { editAns: 材料屋, ordering: 材料屋, askClose }） } */
export function quoteHTML(q, ctx) {
  const s = quoteState(q), open = isOpenQuote(q), ui = ctx.ui || {};
  const sups = sortedSups(q), multi = sups.length > 1;
  if (!ui.openSups) ui.openSups = {};
  const fb = (sid, cur) => `${cur && cur.send === "net" ? "" : `
        <div class="row"><button type="button" class="btn" data-qcopy="${esc(sid)}">見積依頼の文をコピー</button>
          ${ctx.sendLabel(cur) ? `<button type="button" class="btn" data-qsend="${esc(sid)}">${ctx.sendLabel(cur)}</button>` : ""}</div>`}
        <div class="field" id="qFb-${esc(sid)}" hidden><p class="send-note" role="status" hidden></p><span class="lab">コピーした文（うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
          <textarea class="inp ta copybox" rows="12" readonly></textarea></div>`;
  const supCard = ([sid, x]) => {
    const st = supState(x), cur = (ctx.sups || {})[sid] || {}, a = x.answer;
    const editing = ui.editAns === sid || (open && !a);
    // 相見積もりのときは、たためる（まだ送っていない店は、はじめから開いておく）
    const shown = !multi || (sid in ui.openSups ? ui.openSups[sid] : st === "unsent");
    let body = "";
    if (open && editing) {
      body = (st !== "answered" ? fb(sid, cur) : "") +
        (st === "unsent" ? `<p class="hint">送ったら「送った」を押してください（返事を先に入れても、送ったことになります）。</p>
          <div class="row"><button type="button" class="btn primary" data-qsent="${esc(sid)}">送った</button>
            ${multi && !x.sentAt ? `<button type="button" class="linkbtn muted" data-qremove="${esc(sid)}">この材料屋を外す</button>` : ""}</div>` : "") +
        answerFormHTML(q, sid, a);
    } else if (a) {
      body = answerViewHTML(q, x) + (open ? `
        ${multi ? `<div class="row"><button type="button" class="btn" data-qaedit="${esc(sid)}">返事を直す</button></div>`
          : ui.ordering === sid ? orderFormHTML(q, ctx) : `<div class="row"><button type="button" class="btn primary big" data-qgo="${esc(sid)}">この見積で注文する</button>
          <button type="button" class="btn" data-qaedit="${esc(sid)}">返事を直す</button></div>
        <p class="hint">押すと、品物・ファイル（図面など）・見積の単価が入った注文ができます（「まだ送っていない」から。加工品と同じ）。見積書は注文には入りません。</p>`}
        <details class="hidbox"><summary>見積依頼の文・もう一度送る</summary>${fb(sid, cur)}</details>` : "");
    }
    const sent = x.sentAt ? `${md(x.sentAt)} 送った（${esc(x.sentBy || "")}）` : "";
    const lost = q.status === "ordered" && q.orderSup !== sid;
    return `
      <div class="qsup ${st}${lost ? " lost" : ""}" data-qs="${esc(sid)}">
        <div class="qsup-head"><b>${esc(x.name)}</b>${cur.send ? `<span class="tag">${esc(sendWord(cur))}</span>` : ""}
          ${q.status === "ordered" && q.orderSup === sid ? '<span class="ochip blue">注文した</span>' : lost ? '<span class="ochip">見送り</span>'
            : st === "answered" ? '<span class="ochip blue">返事が来た</span>' : st === "unsent" ? '<span class="ochip solid">まだ送っていない</span>' : '<span class="ochip solid">返事待ち</span>'}
          <span class="hint">${sent}${a && a.at ? `・${md(a.at)} 返事` : ""}</span>
          ${multi ? `<button type="button" class="linkbtn" data-qtoggle="${esc(sid)}">${shown ? "とじる" : open && !a ? "ひらく（返事を入れる）" : "ひらく"}</button>` : ""}</div>
        ${shown ? body : ""}
      </div>`;
  };
  const others = q.status === "ordered" ? sups.filter(([sid, x]) => sid !== q.orderSup && x.sentAt) : [];
  return `
    <div class="pw" id="quoteWrap">
      <div class="panel-head"><div>
        <span class="ochip${s.solid ? " solid" : s.key === "answered" ? " blue" : ""}">${esc(s.label)}</span>
        <h2 id="panelTitle" class="mt6">見積　${esc(q.chuban)}${multi ? '<span class="tag" style="margin-left:8px">相見積もり</span>' : ""}</h2>
        <div class="kouji"><span class="kenmei">${esc(zenkana(q.kenmei || ""))}</span></div>
      </div><button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      ${q.status === "ordered" ? `<div class="block act" style="--c:var(--blue)"><h3>${esc(((q.sups || {})[q.orderSup] || {}).name || "")} で注文しました</h3>
          <p>${q.orderedAt ? `${md(q.orderedAt)} ${hm(q.orderedAt)}。` : ""}${others.length ? `ほかの材料屋（${esc(others.map(([, x]) => x.name).join("・"))}）は「見送り」になりました。` : ""}</p>
          <div class="row"><button type="button" class="btn" data-qorder="${esc(q.orderId || "")}">注文の画面を開く</button>
            ${others.map(([sid, x]) => `<button type="button" class="btn" data-qdecline="${esc(sid)}">${others.length > 1 ? `${esc(x.name)} への` : ""}見送りの連絡の文をコピー</button>`).join("")}</div>
          ${others.length ? `<div class="field" id="qDeclineFb" hidden><span class="lab">コピーした文（LINE・メールなどで送ってください。うまくコピーできなかったときは、ここを選んでコピーしてください）</span>
            <textarea class="inp ta copybox" rows="9" readonly></textarea></div>` : ""}</div>` : ""}
      ${q.status === "closed" ? `<div class="block"><p class="warn">この見積依頼はやめました${q.closedAt ? `（${md(q.closedAt)}・${esc(q.closedBy || "")}）` : ""}。</p>
          <button type="button" class="linkbtn" data-qreopen>もとにもどす</button></div>` : ""}
      ${multi && sups.some(([, x]) => x.answer) ? compareHTML(q, sups, open, ui, ctx) : ""}
      <div class="block"><h3>品物</h3><ul class="g-lines">${qLines(q).map(([, l]) => `<li>${esc(lineText(l))}</li>`).join("")}</ul>
        ${open ? '<div class="row"><button type="button" class="btn" data-qedit>見積依頼を直す</button></div>' : ""}</div>
      <div class="block"><dl class="dl">
        <dt>希望の納期</dt><dd>${esc(kibouWord(q.kibou) || "書かない")}</dd>
        <dt>担当者</dt><dd>${esc(q.tantou || "—")}</dd>
        ${q.memo ? `<dt>メモ</dt><dd>${esc(q.memo)}</dd>` : ""}
        <dt>作った</dt><dd>${q.createdAt ? `${md(q.createdAt)} ${hm(q.createdAt)}` : ""}（${esc(q.createdBy || "")}）</dd>
      </dl></div>
      ${ctx.fileBlock}
      <div class="qsups">${sups.map(supCard).join("")}</div>
      ${open ? addSupHTML(q, ui, ctx) : ""}
      ${open ? (ui.askClose ? `<div class="confirm"><p class="confirm-q">この見積依頼をやめますか？（注文はしません。あとで、もとにもどせます）</p>
          <div class="confirm-btns"><button type="button" class="btn danger" data-qcloseyes>やめる</button><button type="button" class="btn" data-qcloseno>やめない</button></div></div>`
        : '<div class="row"><button type="button" class="linkbtn muted" data-qclose>この見積依頼をやめる（注文しない）</button></div>') : ""}
    </div>`;
}

/** 材料屋（名前の順） [[番号, 材料屋]] */
const sortedSups = q => Object.entries(q.sups || {}).sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || "", "ja"));

/** くらべる表（相見積もり。返事が来た材料屋の単価・金額・合計・納期。安い所に印） */
function compareHTML(q, sups, open, ui, ctx) {
  const lines = qLines(q), ans = sups.filter(([, x]) => x.answer);
  const row = (x, lid) => ((x.answer && x.answer.rows) || {})[lid];
  const minAmt = {};
  for (const [lid] of lines) {
    const v = ans.map(([, x]) => row(x, lid)).filter(r => r && r.amount != null).map(r => r.amount);
    if (v.length > 1) minAmt[lid] = Math.min(...v);
  }
  const minTot = ans.length > 1 ? Math.min(...ans.map(([, x]) => x.answer.total)) : null;
  const wait = x => (supState(x) === "unsent" ? "まだ送っていない" : "返事待ち");
  const best = '<span class="min">安い</span>';
  return `
    <div class="block"><h3>くらべる（返事が来た材料屋）</h3>
      <div class="cmp-wrap"><table class="cmp">
        <thead><tr><th>品物</th>${sups.map(([, x]) => `<th>${esc(x.name)}</th>`).join("")}</tr></thead>
        <tbody>
          ${lines.map(([lid, l], i) => `<tr><td>${esc(lineText(l))}</td>${sups.map(([, x]) => {
            if (!x.answer) return `<td class="muted">${i === 0 ? wait(x) : "—"}</td>`;
            const r = row(x, lid);
            if (!r || (r.price == null && r.amount == null)) return '<td class="muted">—</td>';
            const isBest = r.amount != null && minAmt[lid] === r.amount;
            return `<td${isBest ? ' class="best"' : ""}>${r.price != null ? `@${comma(r.price)}${isBest ? best : ""}<br>` : ""}${r.amount != null ? yen(r.amount) : ""}${r.price == null && isBest ? best : ""}</td>`;
          }).join("")}</tr>`).join("")}
          <tr class="tot"><td>合計（税抜）</td>${sups.map(([, x]) => !x.answer ? '<td class="muted">—</td>'
            : `<td${x.answer.total === minTot ? ' class="best"' : ""}>${yen(x.answer.total)}${x.answer.total === minTot ? '<span class="min">いちばん安い</span>' : ""}</td>`).join("")}</tr>
          <tr><td>納期</td>${sups.map(([, x]) => `<td${x.answer ? "" : ' class="muted"'}>${x.answer ? esc(x.answer.nouki || "—") : "—"}</td>`).join("")}</tr>
          <tr><td>メモ・見積書</td>${sups.map(([sid, x]) => !x.answer ? '<td class="muted">—</td>'
            : `<td data-qs="${esc(sid)}">${esc(x.answer.memo || "")}${x.answer.file ? `${x.answer.memo ? "<br>" : ""}<button type="button" class="linkbtn" data-afdl="1">見積書</button>` : ""}</td>`).join("")}</tr>
          ${open ? `<tr><td></td>${sups.map(([sid, x]) => `<td>${x.answer ? `<button type="button" class="btn${x.answer.total === minTot ? " primary" : ""}" data-qgo="${esc(sid)}">この材料屋で注文</button>` : ""}</td>`).join("")}</tr>` : ""}
        </tbody>
      </table></div>
      <span class="hint">金額がいちばん安い所に印がつきます。納期も見て、えらんでください。押すと、その材料屋の注文ができます（ほかの材料屋は「見送り」になります）。</span>
      ${open && ui.ordering && multi(q) ? `<div class="qorder-for"><b>${esc(((q.sups || {})[ui.ordering] || {}).name || "")} で注文する</b>${orderFormHTML(q, ctx)}</div>` : ""}
    </div>`;
}
const multi = q => Object.keys(q.sups || {}).length > 1;

/** 「＋ 材料屋を足す」（相見積もり。まだ入っていない材料屋をえらんで足す） */
function addSupHTML(q, ui, ctx) {
  const rest = Object.entries(ctx.sups || {}).filter(([id, s]) => !s.hidden && s.send !== "net" && !(q.sups || {})[id]).sort(byOrder);
  if (!rest.length) return "";
  if (!ui.addSup) return '<div class="row"><button type="button" class="btn" data-qaddsup>＋ 材料屋を足す（相見積もり）</button></div>';
  return `
    <div class="block"><h3>材料屋を足す</h3>
      <div class="pick">${rest.map(([id, s]) => `<button type="button" data-qaddone="${esc(id)}">${esc(s.name)}${sendWord(s) ? `（${esc(sendWord(s))}）` : ""}</button>`).join("")}</div>
      <span class="hint">押すと、その材料屋が「まだ送っていない」で足されます。そのあと「メールで送る」などで送ってください。</span>
      <div class="row"><button type="button" class="btn" data-qaddno>やめる</button></div></div>`;
}

/** 見送りの連絡の文（注文しなかった材料屋に） */
export function declineText(q, sid, info = {}) {
  const x = (q.sups || {})[sid] || {}, c = (info.company || {}), tels = info.tels || {};
  const who = n => (n && tels[n] ? `${n}(${tels[n]})` : n || "");
  return [
    `${x.name || ""}　${x.to || "御中"}`, "",
    `先日お願いした見積（工事番号 ${q.chuban}　${zenkana(q.kenmei || "")}）は、今回は見送らせていただきます。`,
    "ご対応いただき、ありがとうございました。", "",
    ...(c.name ? [c.name] : []), ...(q.tantou ? [`担当　${who(q.tantou)}`] : []),
  ].join("\n");
}

/** 返事を入れる欄（a＝前の返事。直すとき） */
function answerFormHTML(q, sid, a) {
  const rows = (a && a.rows) || {};
  const v = n => comma(n);
  return `
    <form class="ans stack" data-qans="${esc(sid)}" novalidate>
      <span class="lab">返事を入れる（品物ごとか、合計だけ）</span>
      <div class="arows">
        <div class="arow head" aria-hidden="true"><span>品物</span><span>Kg</span><span>¥/kg</span><span>単価</span><span>金額</span></div>
        ${qLines(q).map(([lid, l]) => { const r = rows[lid] || {};
          return `<div class="arow" data-lid="${esc(lid)}" data-qty="${esc(String(l.qty))}">
            <span class="a-spec">${esc(lineText(l))}</span>
            <input class="inp num" data-a="kg" inputmode="decimal" placeholder="Kg" aria-label="${esc(l.spec)} の重さ（Kg）" value="${esc(r.kg == null ? "" : String(r.kg))}">
            <input class="inp num" data-a="perKg" inputmode="decimal" placeholder="¥/kg" aria-label="${esc(l.spec)} の kg あたりの値段" value="${esc(v(r.perKg))}">
            <input class="inp num" data-a="price" inputmode="decimal" placeholder="単価" aria-label="${esc(l.spec)} の単価" value="${esc(v(r.price))}">
            <span class="num a-amt" data-a="amount">${r.amount != null ? yen(r.amount) : ""}</span></div>`; }).join("")}
      </div>
      <span class="hint">Kg と ¥/kg は、書かなくてもかまいません。入れると、金額と単価が自動で出ます。単価を入れると、金額（単価×数）が出ます。</span>
      <div class="atotal"><label>合計（税抜）<span class="req">必ず</span></label>
        <div class="yen-in"><input class="inp num" data-a="total" inputmode="numeric" placeholder="0" value="${esc(a && a.total != null ? yen(a.total) : "")}"${a && a.total != null ? ' data-manual="1"' : ""}><span>円</span></div></div>
      <div class="two">
        <div class="field"><label>納期</label><input class="inp" data-a="nouki" maxlength="40" placeholder="例 10/24・受注後1週間" value="${esc((a && a.nouki) || "")}"></div>
        <div class="field"><label>メモ</label><input class="inp" data-a="memo" maxlength="200" value="${esc((a && a.memo) || "")}"></div>
      </div>
      <div class="field"><span class="lab">見積書（PDF など。あれば）</span>
        <div class="row afile">${a && a.file ? `<span class="fname">${esc(a.file.name)}<small class="hint">${sizeText(a.file.size)}</small></span><button type="button" class="linkbtn muted" data-afout>外す</button>` : ""}
          <label class="btn">＋ ファイルをえらぶ<input type="file" data-afile hidden></label><span class="hint a-picked"></span></div></div>
      <p class="hint ok a-prog" role="status" hidden></p>
      <p class="err a-err"></p>
      <div class="row"><button type="submit" class="btn primary">返事を入れる</button>${a ? `<button type="button" class="btn" data-qaedno>やめる</button>` : ""}</div>
    </form>`;
}
/** 入れた返事を見せる */
function answerViewHTML(q, x) {
  const a = x.answer, rows = a.rows || {};
  const hasRows = qLines(q).some(([lid]) => rows[lid] && (rows[lid].price != null || rows[lid].amount != null));
  return `
    <div class="atotal" style="justify-content:flex-start"><span>見積</span><span class="big-money">${yen(a.total)}</span><span>円（税抜）</span>
      <span class="hint">${a.nouki ? `納期 ${esc(a.nouki)}` : ""}${a.nouki && a.memo ? "・" : ""}${esc(a.memo || "")}</span></div>
    ${hasRows ? `<ul class="g-lines">${qLines(q).map(([lid, l]) => { const r = rows[lid] || {};
      return `<li>${esc(lineText(l))}　${r.kg != null && r.perKg != null ? `${esc(comma(r.kg))}kg × ${comma(r.perKg)}円/kg　` : ""}${r.price != null ? `@${comma(r.price)}円　` : ""}${r.amount != null ? `${yen(r.amount)}円` : ""}</li>`; }).join("")}</ul>` : ""}
    ${a.file ? `<div class="row"><button type="button" class="linkbtn" data-afdl="1">${esc(a.file.name)} をダウンロード</button></div>` : ""}`;
}
/** 「この見積で注文する」：届け先・納入希望日・注文者をきいて、注文する */
function orderFormHTML(q, ctx) {
  const places = Object.entries(ctx.places || {}).filter(([, p]) => !p.hidden).sort(byOrder);
  const k = /^\d{4}-\d{2}-\d{2}$/.test(q.kibou || "") ? q.kibou : "";
  return `
    <div class="qorder stack">
      <div class="field"><span class="lab">届け先</span>
        <div class="pick">${places.map(([id, p], i) => `<button type="button" data-qbasho="${esc(id)}" aria-pressed="${i === 0}">${esc(p.name)}</button>`).join("")}</div></div>
      <div class="field"><span class="lab">納入希望日</span>
        <div class="pick"><button type="button" data-qok="最短" aria-pressed="${!k}">最短</button><button type="button" data-qok="__date" aria-pressed="${!!k}">日付をえらぶ</button></div>
        <input class="inp" type="date" data-qodate aria-label="納入希望日" value="${esc(k)}"${k ? "" : " hidden"}></div>
      <div class="field"><label>注文者（たのんだ人）</label><input class="inp" data-qochu maxlength="20" value="${esc(ctx.me.name || "")}"></div>
      <p class="err" data-qoerr></p>
      <div class="row"><button type="button" class="btn primary big" data-qgoyes>注文する</button><button type="button" class="btn" data-qgono>やめる</button></div>
    </div>`;
}

/* ---------- 計算（返事の欄） ---------- */
const num = v => toPrice(v);
const round2 = n => Math.round(n * 100) / 100;
/** 1行：Kg と ¥/kg があれば 金額＝Kg×¥/kg・単価＝金額÷数。なければ 金額＝単価×数。合計は、手で入れていなければ金額の合計 */
export function calcAnswer(form, changed) {
  let sum = 0, any = false;
  form.querySelectorAll(".arow[data-lid]").forEach(r => {
    const q = Number(r.dataset.qty) || 0, g = a => r.querySelector(`[data-a="${a}"]`);
    const kg = num(g("kg").value), pk = num(g("perKg").value);
    let amount = null;
    if (kg != null && pk != null) {
      amount = Math.round(kg * pk);
      if (changed && r.contains(changed) && (changed.dataset.a === "kg" || changed.dataset.a === "perKg") && q) g("price").value = comma(round2(amount / q));
    } else {
      const pr = num(g("price").value);
      if (pr != null) amount = Math.round(pr * q);
    }
    g("amount").textContent = amount != null ? yen(amount) : "";
    if (amount != null) { sum += amount; any = true; }
  });
  const t = form.querySelector('[data-a="total"]');
  if (changed === t) { if (t.value.trim()) t.dataset.manual = "1"; else delete t.dataset.manual; }
  if (!t.dataset.manual) t.value = any ? yen(sum) : "";
}
/** 欄から返事を読む → { answer } か { err } */
function readAnswer(form, q) {
  const rows = {};
  for (const r of form.querySelectorAll(".arow[data-lid]")) {
    const g = a => r.querySelector(`[data-a="${a}"]`), x = {};
    for (const k of ["kg", "perKg", "price"]) {
      const s = g(k).value.trim();
      if (!s) continue;
      const n = num(s);
      if (n == null || n < 0) return { err: "数でない所があります（Kg・¥/kg・単価）", focus: g(k) };
      x[k] = n;
    }
    const at = g("amount").textContent.trim();
    if (at) x.amount = num(at);
    if (Object.keys(x).length) rows[r.dataset.lid] = x;
  }
  const tEl = form.querySelector('[data-a="total"]'), total = num(tEl.value);
  if (total == null) return { err: "合計（税抜）を入れてください（品物ごとの単価を入れると、自動で出ます）", focus: tEl };
  return { answer: { rows, total: Math.round(total), nouki: form.querySelector('[data-a="nouki"]').value.trim().slice(0, 40), memo: form.querySelector('[data-a="memo"]').value.trim().slice(0, 200) } };
}

/* ---------- データを書く ---------- */
/** 材料屋に送った（「まだ送っていない」を消す） */
export const markQuoteSent = (q, sid, me) => update(ref(db, `zairyo/quotes/${q.id}/sups/${sid}`), { unsent: null, sentAt: serverTimestamp(), sentBy: me.name });
/** 返事を入れる（まだ「送った」を押していなければ、送ったことにする）。file＝新しい見積書（なければ null）、dropOld＝前の見積書を外す */
async function saveAnswer(q, sid, ans, file, dropOld, me) {
  const x = q.sups[sid], old = x.answer && x.answer.file;
  let entry = null;
  if (file) entry = (await uploadFile(q.id, file, me, () => { })).entry;
  const keepFile = !dropOld && !file && old ? old : null;
  const upd = { answer: { ...ans, ...(entry ? { file: entry } : keepFile ? { file: keepFile } : {}), at: serverTimestamp(), by: me.name } };
  if (x.unsent || !x.sentAt) Object.assign(upd, { unsent: null, sentAt: x.sentAt || serverTimestamp(), sentBy: x.sentBy || me.name });
  try {
    await update(ref(db, `zairyo/quotes/${q.id}/sups/${sid}`), upd);
  } catch (ex) {
    if (entry) await removeUploaded([entry.path]);
    throw ex;
  }
  if (old && (file || dropOld)) await removeUploaded([old.path]);   // 前の見積書は、置き場からも消す
}
/** この見積で注文する（注文を作って、見積を「注文した」にする。1回の書きこみ）。返り値：注文の番号 */
export async function orderFromQuote(q, sid, sups, opt, me) {
  const x = q.sups[sid], a = x.answer || {}, sup = (sups || {})[sid] || {};
  const key = push(ref(db, "zairyo/orders")).key;
  const lines = {};
  for (const [lid, l] of qLines(q)) {
    const r = (a.rows || {})[lid] || {};
    lines[lid] = { spec: l.spec, qty: l.qty, unit: l.unit, ...(l.vals ? { vals: l.vals } : {}), ...(r.price != null ? { qprice: r.price } : {}) };
  }
  const place = opt.place || {};
  const order = {
    supplier: sid, supplierName: sup.name || x.name, to: sup.to || x.to || "御中",
    chuban: q.chuban, kenmei: q.kenmei, tantou: q.kojiTantou || "", chumonsha: opt.chumonsha,
    kibou: opt.kibou, basho: place.name || "", bashoText: place.text || "",
    contacted: false, memo: a.nouki ? `見積の納期：${a.nouki}`.slice(0, 500) : "",
    status: "wait", kind: "mitsumori", unsent: true, quoteId: q.id, quoteTotal: a.total ?? 0, lines,
    ...(q.files ? { files: q.files } : {}),   // 図面など（置き場は見積のまま。見積書は入れない）
    orderedAt: serverTimestamp(), orderedBy: me.name, orderedByUid: auth.currentUser.uid,
  };
  await update(ref(db), {
    [`zairyo/orders/${key}`]: order,
    [`zairyo/quotes/${q.id}/status`]: "ordered",
    [`zairyo/quotes/${q.id}/orderId`]: key,
    [`zairyo/quotes/${q.id}/orderSup`]: sid,
    [`zairyo/quotes/${q.id}/orderedAt`]: serverTimestamp(),
  });
  return key;
}

/** 見積の画面を動かす。ctx = { me, getQuote, sups, places, info, ui, redraw, copyOrSend, openOrder, onErr } */
export function wireQuote(w, ctx) {
  const ui = ctx.ui;
  w.addEventListener("input", e => {
    const form = e.target.closest("[data-qans]");
    if (form) { w.dataset.dirty = "1"; calcAnswer(form, e.target); form.querySelector(".a-err").textContent = ""; }
  });
  w.addEventListener("change", e => {
    const fi = e.target.closest("[data-afile]");
    if (!fi) return;
    const ok = okFiles(fi.files || []);
    fi.closest("form")._file = ok[0] || null;
    fi.closest(".afile").querySelector(".a-picked").textContent = ok[0] ? `${ok[0].name}（${sizeText(ok[0].size)}）を入れます` : "";
    w.dataset.dirty = "1";
  });
  w.addEventListener("submit", e => {
    const form = e.target.closest("[data-qans]");
    if (!form) return;
    e.preventDefault();
    const q = ctx.getQuote(), sid = form.dataset.qans;
    if (!q) return;
    const r = readAnswer(form, q);
    const err = form.querySelector(".a-err");
    if (r.err) { err.textContent = r.err; if (r.focus) r.focus.focus(); return; }
    const btn = form.querySelector('button[type="submit"]'), prog = form.querySelector(".a-prog");
    btn.disabled = true; btn.textContent = "しまっています…";
    if (form._file) { prog.hidden = false; prog.textContent = `見積書を上げています（${form._file.name}）…`; }
    saveAnswer(q, sid, r.answer, form._file || null, !!form._dropOld, ctx.me).then(() => {
      ui.editAns = "";
      delete w.dataset.dirty;
      toast("返事を入れました");
      ctx.redraw();
    }, ex => { btn.disabled = false; btn.textContent = "返事を入れる"; prog.hidden = true; err.textContent = errorText(ex); });
  });
  w.addEventListener("click", e => {
    const t = e.target.closest("[data-qcopy],[data-qsend],[data-qsent],[data-qaedit],[data-qaedno],[data-afout],[data-afdl],[data-qgo],[data-qgono],[data-qgoyes],[data-qbasho],[data-qok],[data-qedit],[data-qclose],[data-qcloseyes],[data-qcloseno],[data-qreopen],[data-qorder],[data-qtoggle],[data-qremove],[data-qaddsup],[data-qaddone],[data-qaddno],[data-qdecline]");
    if (!t || t.disabled) return;
    const q = ctx.getQuote();
    if (!q) return;
    const d = t.dataset;
    if (d.qcopy || d.qsend) {
      const sid = d.qcopy || d.qsend, sup = (ctx.sups || {})[sid] || {};
      ctx.copyOrSend(q, d.qsend ? sup : null, w.querySelector(`#qFb-${CSS.escape(sid)}`), quotePack(q, sid, sup, ctx.info)).catch(ctx.onErr);
    } else if (d.qsent) {
      t.disabled = true;
      markQuoteSent(q, d.qsent, ctx.me).then(() => { toast("「送った」にしました（返事待ち）"); ctx.redraw(); }, ex => { t.disabled = false; ctx.onErr(ex); });
    } else if (d.qaedit) { ui.editAns = d.qaedit; ui.ordering = ""; ctx.redraw(); }
    else if ("qaedno" in d) { ui.editAns = ""; delete w.dataset.dirty; ctx.redraw(); }
    else if ("afout" in d) {
      const form = t.closest("form");
      form._dropOld = true;
      t.previousElementSibling.remove();
      t.remove();
      w.dataset.dirty = "1";
    } else if ("afdl" in d) {
      const sid = t.closest("[data-qs]").dataset.qs, f = q.sups[sid] && q.sups[sid].answer && q.sups[sid].answer.file;
      if (f) downloadFiles([f]).then(() => toast("「ダウンロード」に入れました"), ctx.onErr);
    } else if (d.qgo) { ui.ordering = d.qgo; ui.editAns = ""; ctx.redraw(); }
    else if ("qgono" in d) { ui.ordering = ""; ctx.redraw(); }
    else if (d.qbasho || d.qok) {
      const box = t.closest(".pick");
      box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === t));
      if (d.qok) { const di = w.querySelector("[data-qodate]"); di.hidden = d.qok !== "__date"; if (!di.hidden) { di.min = ymd(0); di.focus(); } }
    } else if ("qgoyes" in d) {
      const sid = ui.ordering, box = t.closest(".qorder");
      const bid = (box.querySelector("[data-qbasho][aria-pressed=\"true\"]") || {}).dataset;
      const dateOn = box.querySelector('[data-qok="__date"]').getAttribute("aria-pressed") === "true";
      const dv = box.querySelector("[data-qodate]").value;
      const er = box.querySelector("[data-qoerr]");
      if (dateOn && !dv) { er.textContent = "納入希望日の日付をえらんでください"; return; }
      t.disabled = true; t.textContent = "注文を作っています…";
      orderFromQuote(q, sid, ctx.sups, {
        place: bid ? (ctx.places || {})[bid.qbasho] : null, kibou: dateOn ? dv : "最短",
        chumonsha: box.querySelector("[data-qochu]").value.trim().slice(0, 20),
      }, ctx.me).then(oid => {
        ui.ordering = "";
        toast("注文を作りました。「メールで送る」などで送って、送信したら「送った」を押してください");
        ctx.openOrder(oid);
      }, ex => { t.disabled = false; t.textContent = "注文する"; er.textContent = errorText(ex); });
    } else if ("qedit" in d) ctx.openForm(q);
    else if ("qclose" in d) { ui.askClose = true; ctx.redraw(); }
    else if ("qcloseno" in d) { ui.askClose = false; ctx.redraw(); }
    else if ("qcloseyes" in d) {
      t.disabled = true;
      update(ref(db, `zairyo/quotes/${q.id}`), { status: "closed", closedAt: serverTimestamp(), closedBy: ctx.me.name })
        .then(() => { ui.askClose = false; toast("見積依頼をやめました"); ctx.redraw(); }, ex => { t.disabled = false; ctx.onErr(ex); });
    } else if ("qreopen" in d) {
      update(ref(db, `zairyo/quotes/${q.id}`), { status: "open", closedAt: null, closedBy: null })
        .then(() => { toast("見積依頼を、もとにもどしました"); ctx.redraw(); }, ctx.onErr);
    } else if (d.qorder) ctx.openOrder(d.qorder);
    /* 相見積もり（10/15） */
    else if (d.qtoggle) { ui.openSups = ui.openSups || {}; ui.openSups[d.qtoggle] = t.textContent.trim() !== "とじる"; ctx.redraw(); }
    else if (d.qremove) {   // まだ送っていない材料屋を外す
      t.disabled = true;
      update(ref(db, `zairyo/quotes/${q.id}/sups`), { [d.qremove]: null }).then(() => { toast("材料屋を外しました"); ctx.redraw(); }, ex => { t.disabled = false; ctx.onErr(ex); });
    } else if ("qaddsup" in d) { ui.addSup = true; ctx.redraw(); }
    else if ("qaddno" in d) { ui.addSup = false; ctx.redraw(); }
    else if (d.qaddone) {
      const sp = (ctx.sups || {})[d.qaddone];
      if (!sp) return;
      t.disabled = true;
      update(ref(db, `zairyo/quotes/${q.id}/sups/${d.qaddone}`), { name: sp.name, to: sp.to || "御中", unsent: true }).then(() => {
        ui.addSup = false;
        ui.openSups = { ...(ui.openSups || {}), [d.qaddone]: true };
        toast(`${sp.name} を足しました。「メールで送る」などで送ってください`);
        ctx.redraw();
      }, ex => { t.disabled = false; ctx.onErr(ex); });
    } else if (d.qdecline) {   // 見送りの連絡の文をコピー
      const text = declineText(q, d.qdecline, ctx.info), box = w.querySelector("#qDeclineFb");
      if (box) { box.hidden = false; box.querySelector("textarea").value = text; }
      navigator.clipboard.writeText(text).then(() => toast("見送りの連絡の文をコピーしました。LINE・メールなどにはりつけて送ってください"),
        () => { toast("コピーできませんでした。下の文を選んでコピーしてください"); if (box) box.querySelector("textarea").select(); });
    }
  });
  // はじめに、入っている数で計算しておく（直すとき）
  w.querySelectorAll("[data-qans]").forEach(f => calcAnswer(f, null));
}
