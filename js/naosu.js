// 事務所が依頼・注文を直す（10/14 持ち主）
// - 依頼を直す：注番・件名・希望日・届け先・注文者・担当者・メモ・品物（品名・メモ・数・単位、消す、足す）。
//   もう注文した品物は、依頼の側では直さない（注文の中身の「注文を直す」で直す）
// - 注文を直す：注番・件名・希望日・届け先・注文者・担当者・メモ・品物（品名・メモ・数・単位）。品物を足す・消すはしない。
//   依頼から来た品物は、依頼の側の品物も同じに直す（現場の「送ったもの」に新しい中身が出る）。
//   注番を直したら、その注文の単価の記録の注番も直す（材料費が新しい注番に入る）。材料屋には自動で知らせない
// - 保存すると、変わったところだけを記録（log）に1行で残す：だれ（このパソコンの名前）・いつ・何を（前→後）
// - 品名を手で直した品物は、品物一覧の形（key・vals）を外す（★いつもの では別の品物として数える）
import { ref, get, update, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { esc, zenkana, toast, openSheet } from "./common.js";
import { fmtQty, kibouText } from "./tanomu.js";
import { toPrice } from "./chumon.js";
import { getJob } from "./nippo.js";

const CHUBAN = /^[A-Z]{2}\d{5}$/;
const normChuban = s => {
  const t = String(s ?? "").normalize("NFKC").toUpperCase().replace(/[\s\-ー－]/g, "");
  return t.slice(0, 2) + t.slice(2).replace(/O/g, "0").replace(/[IL]/g, "1");
};
const LABEL = { chuban: "注番", kenmei: "件名", kibou: "希望日", basho: "届け先", chumonsha: "注文者", tantou: "担当者", memo: "メモ" };
const show = (f, v) => (f === "kibou" ? kibouText(v) : f === "kenmei" ? zenkana(v || "") : String(v ?? "")) || "（なし）";
const short = s => { const t = String(s || ""); return [...t].length > 24 ? [...t].slice(0, 24).join("") + "…" : t; };

/** 注文する人の一覧（かくした人はのぞく。いまの注文者は残す） */
async function staffList(cur) {
  const v = (await get(ref(db, "zairyo/master/staff"))).val() || {};
  const names = Object.keys(v).filter(n => !(v[n] && v[n].hidden)).sort((a, b) => a.localeCompare(b, "ja"));
  if (cur && !names.includes(cur)) names.unshift(cur);
  return names;
}

/** 上の欄（注番・件名・希望日・届け先・注文者・担当者・メモ）の HTML */
function headHTML(x, places, staff) {
  const plist = Object.entries(places || {}).filter(([id, p]) => p && (!p.hidden || p.name === x.basho)).sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));
  const hasCur = !x.basho || plist.some(([, p]) => p.name === x.basho);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(x.kibou || "") ? x.kibou : "";
  return `
    <div class="ef-grid">
      <label class="mini">注番<input id="eChuban" class="inp" maxlength="12" autocomplete="off" autocapitalize="characters" value="${esc(x.chuban || "")}"></label>
      <label class="mini">件名<input id="eKenmei" class="inp" maxlength="100" autocomplete="off" value="${esc(x.kenmei || "")}"></label>
      <p class="hint" id="eJob"></p>
      <div class="mini">希望日
        <div class="row"><select id="eKibou" class="inp" style="width:auto"><option value="最短"${date ? "" : " selected"}>最短</option><option value="date"${date ? " selected" : ""}>日付をえらぶ</option></select>
          <input id="eDate" class="inp" type="date" style="width:auto" value="${esc(date)}"${date ? "" : " hidden"}></div></div>
      <label class="mini">届け先<select id="eBasho" class="inp">
        <option value=""${x.basho ? "" : " selected"}>（なし）</option>
        ${hasCur ? "" : `<option value="name:${esc(x.basho)}" selected>${esc(x.basho)}</option>`}
        ${plist.map(([id, p]) => `<option value="${esc(id)}"${p.name === x.basho ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      <label class="mini">注文者<select id="eChumon" class="inp">${staff.map(n => `<option${n === x.chumonsha ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <label class="mini">担当者<input id="eTantou" class="inp" maxlength="20" autocomplete="off" value="${esc(x.tantou || "")}"></label>
      <label class="mini">メモ<textarea id="eMemo" class="inp ta" rows="2" maxlength="500">${esc(x.memo || "")}</textarea></label>
    </div>`;
}

/** 品物1行（直せる行） */
function lineHTML(lid, l, units, canDel) {
  const us = units.includes(l.unit) || !l.unit ? units : [l.unit, ...units];
  return `
    <div class="erow" data-lid="${esc(lid)}">
      <div class="erow-head"><span>品名</span>${canDel ? '<button type="button" class="linkbtn muted" data-edel>この品物を消す ×</button>' : ""}</div>
      <textarea class="inp imp-spec" data-ef="spec" rows="1" maxlength="300">${esc(l.spec || "")}</textarea>
      <div class="imp-nums">
        <label class="mini n-amount">メモ<input class="inp" data-ef="note" maxlength="200" value="${esc(l.note || "")}"></label>
        <label class="mini n-qty">数<input class="inp num" data-ef="qty" inputmode="decimal" value="${esc(fmtQty(l.qty))}"></label>
        <label class="mini n-unit">単位<select class="inp" data-ef="unit">${us.map(u => `<option${u === l.unit ? " selected" : ""}>${esc(u)}</option>`).join("")}</select></label>
      </div>
    </div>`;
}

/** 上の欄を読む → { chuban, kenmei, kibou, basho, bashoId, bashoText, chumonsha, tantou, memo } か、まちがいの文 */
function readHead(w, places) {
  const g = s => w.querySelector(s);
  const chuban = normChuban(g("#eChuban").value);
  if (!CHUBAN.test(chuban)) return "注番の形がちがいます（例 AB26123）";
  const kenmei = g("#eKenmei").value.trim();
  if (!kenmei) return "件名を入れてください";
  let kibou = "最短";
  if (g("#eKibou").value === "date") {
    kibou = g("#eDate").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(kibou)) return "希望日の日付をえらんでください";
  }
  const bv = g("#eBasho").value;
  const place = bv && !bv.startsWith("name:") ? (places || {})[bv] : null;
  return {
    chuban, kenmei, kibou,
    basho: place ? place.name : bv.startsWith("name:") ? bv.slice(5) : "",
    bashoId: place ? bv : null, bashoText: place ? (place.text || "") : "",
    chumonsha: g("#eChumon").value, tantou: g("#eTantou").value.trim(), memo: g("#eMemo").value.trim(),
  };
}

/** 品物1行を読む → { spec, note, qty, unit } か、まちがいの文 */
function readLine(row) {
  const v = f => row.querySelector(`[data-ef="${f}"]`).value;
  const spec = v("spec").replace(/\s*\n\s*/g, " ").trim();
  if (!spec) return "品名が空の品物があります";
  const qty = toPrice(v("qty"));
  if (!(qty > 0 && qty < 100000)) return `「${short(spec)}」の数を入れてください`;
  return { spec, note: v("note").trim(), qty, unit: v("unit") };
}

/** 品物の変わったところ → [文…] と、書きこむ欄 { spec?, note?, qty?, unit?, key?, vals? } */
function lineDiff(old, now) {
  const words = [], set = {};
  const name = short(old.spec);
  if (now.spec !== old.spec) { words.push(`品名 ${short(old.spec)}→${short(now.spec)}`); set.spec = now.spec; set.key = null; set.vals = null; }
  if (now.qty !== Number(old.qty) || now.unit !== old.unit) {
    words.push(`数 ${fmtQty(old.qty)}${old.unit}→${fmtQty(now.qty)}${now.unit}（${name}）`); set.qty = now.qty; set.unit = now.unit;
  }
  if (now.note !== (old.note || "")) { words.push(`メモ（${name}）「${old.note || ""}」→「${now.note}」`); set.note = now.note; }
  return { words, set };
}

/** 上の欄の変わったところ → [文…] と、書きこむ欄 */
function headDiff(old, now, fields) {
  const words = [], set = {};
  for (const f of fields) {
    if ((now[f] ?? "") === (old[f] ?? "")) continue;
    words.push(`${LABEL[f]} ${show(f, old[f])}→${show(f, now[f])}`);
    set[f] = now[f];
  }
  return { words, set };
}

/** 注番を入れたら、日報の件名・担当をさがして入れる（件名・担当を手で直していなければ） */
function wireJob(w, x) {
  const g = s => w.querySelector(s);
  let lastAuto = { kenmei: x.kenmei || "", tantou: x.tantou || "" };
  const check = async () => {
    const c = normChuban(g("#eChuban").value), hint = g("#eJob");
    if (!CHUBAN.test(c)) { hint.textContent = c ? "注番の形：英字2文字＋数字5けた（例 AB26123）" : ""; return; }
    if (c === x.chuban) { hint.textContent = ""; return; }
    hint.textContent = "日報をさがしています…";
    let j = null;
    try { j = await getJob(c); } catch (err) { }
    if (normChuban(g("#eChuban").value) !== c) return;
    if (!j) { hint.textContent = "日報にない注番です。件名は手で入れてください"; return; }
    hint.textContent = j.closed ? "日報では、もう終わった工事です。たしかめてください" : "日報の工事です。件名と担当を入れました";
    if (g("#eKenmei").value.trim() === lastAuto.kenmei || !g("#eKenmei").value.trim()) g("#eKenmei").value = zenkana(j.kenmei);
    if (g("#eTantou").value.trim() === lastAuto.tantou || !g("#eTantou").value.trim()) g("#eTantou").value = j.tantou;
    lastAuto = { kenmei: zenkana(j.kenmei), tantou: j.tantou };
  };
  g("#eChuban").addEventListener("change", check);
  g("#eKibou").addEventListener("change", () => { g("#eDate").hidden = g("#eKibou").value !== "date"; });
  // 品名で Enter を押しても改行しない
  w.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches && e.target.matches('[data-ef="spec"]')) e.preventDefault(); });
}

const logKey = path => push(ref(db, path)).key;

/* ==================== 依頼を直す ==================== */
/** r＝依頼、orders＝この依頼から作った注文（取り消しもふくむ）、places・units＝届け先・単位、me＝このパソコン、onDone()＝おわったら */
export async function openReqEdit({ r, orders, places, units, me, onDone }) {
  const staff = await staffList(r.chumonsha);
  const active = new Set(orders.filter(o => o.status !== "cancelled").map(o => o.id));
  const ordered = lid => { const l = r.lines[lid]; return !!(l && l.orderId && active.has(l.orderId)); };
  const lines = Object.entries(r.lines || {});
  const supOf = lid => (orders.find(o => o.id === r.lines[lid].orderId) || {}).supplierName || "";
  const html = `
    <div class="pw" id="editWrap">
      <div class="panel-head"><div><span class="eyebrow">依頼を直す</span>
        <h2 id="panelTitle">${esc(r.chumonsha)}さんから ${lines.length}点</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <div class="block">${headHTML(r, places, staff)}
        <p class="hint">注文者を変えると、この依頼は新しい注文者のスマホの「送ったもの」に移ります。</p></div>
      <div class="block"><h3>品物</h3>
        <div class="erows">${lines.map(([lid, l]) => ordered(lid)
          ? `<div class="erow done"><b>${esc(l.spec)}${l.note ? " " + esc(l.note) : ""}</b>　×${esc(fmtQty(l.qty))}${esc(l.unit)}<span class="hint">注文ずみ（${esc(supOf(lid))}）。直すのは、注文の中身の「注文を直す」で</span></div>`
          : lineHTML(lid, l, units, true)).join("")}</div>
        <button type="button" class="btn" id="eAdd">＋ 品物を足す</button>
      </div>
      <p class="err" id="eErr" role="alert"></p>
      <div class="row"><button type="button" class="btn primary big" id="eSave">直したところを保存</button><button type="button" class="btn" id="eBack">やめる</button></div>
    </div>`;
  openSheet(html, p => {
    const w = p.querySelector("#editWrap"), err = w.querySelector("#eErr");
    wireJob(w, r);
    let n = 0;
    w.addEventListener("click", async e => {
      const del = e.target.closest("[data-edel]");
      if (del) {
        const row = del.closest(".erow");
        if (row.classList.toggle("gone")) del.textContent = "消すのをやめる"; else del.textContent = "この品物を消す ×";
        return;
      }
      if (e.target.closest("#eAdd")) {
        w.querySelector(".erows").insertAdjacentHTML("beforeend", lineHTML(`new${++n}`, { spec: "", qty: 1, unit: units[0] || "個" }, units, true));
        w.querySelector(".erows .erow:last-child [data-ef='spec']").focus();
        return;
      }
      if (e.target.closest("#eBack")) { onDone(); return; }
      if (!e.target.closest("#eSave")) return;
      // 読んで、くらべる
      const head = readHead(w, places);
      if (typeof head === "string") { err.textContent = head; return; }
      const hd = headDiff(r, head, ["chuban", "kenmei", "kibou", "basho", "chumonsha", "tantou", "memo"]);
      const upd = { ...hd.set }, words = [...hd.words];
      if ("basho" in hd.set) upd.bashoId = head.bashoId;
      const keep = [];
      for (const row of w.querySelectorAll(".erow[data-lid]")) {
        const lid = row.dataset.lid, isNew = lid.startsWith("new"), old = r.lines[lid];
        if (row.classList.contains("gone")) {
          if (!isNew) { upd[`lines/${lid}`] = null; words.push(`品物を消した（${short(old.spec)}）`); }
          continue;
        }
        const now = readLine(row);
        if (typeof now === "string") { err.textContent = now; return; }
        if (isNew) {
          const id = "e" + Date.now().toString(36) + lid.slice(3);
          upd[`lines/${id}`] = { spec: now.spec, qty: now.qty, unit: now.unit, ...(now.note ? { note: now.note } : {}) };
          words.push(`品物を足した（${short(now.spec)} ×${fmtQty(now.qty)}${now.unit}）`);
          keep.push(false);
          continue;
        }
        const ld = lineDiff(old, now);
        for (const [f, v] of Object.entries(ld.set)) upd[`lines/${lid}/${f}`] = v;
        words.push(...ld.words);
        keep.push(false);
      }
      const orderedLeft = lines.filter(([lid]) => ordered(lid)).length;
      if (!keep.length && !orderedLeft) { err.textContent = "品物が1つもなくなります。依頼をやめるときは「取り消し」を使ってください"; return; }
      if (!words.length) { err.textContent = "直したところがありません"; return; }
      // 注文していない品物が残る・ふえるときは「一部注文ずみ」にもどす。全部注文ずみなら「注文した」
      if (r.status !== "cancelled") upd.status = keep.length ? "sent" : "ordered";
      const what = "直した：" + words.join("・");
      upd[`log/${logKey(`zairyo/requests/${r.id}/log`)}`] = { at: serverTimestamp(), by: me.name || "事務所", what: what.slice(0, 2000) };
      const btn = w.querySelector("#eSave");
      btn.disabled = true; btn.textContent = "保存しています…";
      try {
        await update(ref(db, `zairyo/requests/${r.id}`), upd);
      } catch (ex) {
        btn.disabled = false; btn.textContent = "直したところを保存";
        err.textContent = "保存できませんでした（" + (ex.message || ex) + "）";
        return;
      }
      toast("依頼を直しました。記録にも残しました");
      onDone();
    });
  }, { side: true });
}

/* ==================== 注文を直す ==================== */
/** o＝注文、r＝もとの依頼（LINE・電話の注文は null）、places・units、me、onDone() */
export async function openOrderEdit({ o, r, places, units, me, onDone }) {
  const staff = await staffList(o.chumonsha);
  const lines = Object.entries(o.lines || {});
  const html = `
    <div class="pw" id="editWrap">
      <div class="panel-head"><div><span class="eyebrow">注文を直す（${esc(o.supplierName)}）</span>
        <h2 id="panelTitle">${esc(o.chuban)} ${esc(zenkana(o.kenmei || ""))}</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <p class="warn">材料屋には、アプリから知らせません。もう送った注文なら、直したあとに「注文の文をコピー」（または「メールで送る」）で、もう一度送ってください。</p>
      <div class="block">${headHTML(o, places, staff)}
        <p class="hint">注番を直すと、この注文の金額（納品書・単価の記録）は、新しい注番の材料費に入ります。${o.reqId ? "注番・希望日などは、この注文だけが変わります（現場の依頼は品物だけそろえます）。" : ""}</p></div>
      <div class="block"><h3>品物</h3>
        <div class="erows">${lines.map(([lid, l]) => lineHTML(lid, l, units, false)).join("")}</div>
        ${o.reqId ? '<p class="hint">品名・数・単位・メモを直すと、現場の依頼の品物も同じに直ります。品物を足す・消すときは「注文を取り消して依頼にもどす」から。</p>' : ""}
      </div>
      <p class="err" id="eErr" role="alert"></p>
      <div class="row"><button type="button" class="btn primary big" id="eSave">直したところを保存</button><button type="button" class="btn" id="eBack">やめる</button></div>
    </div>`;
  openSheet(html, p => {
    const w = p.querySelector("#editWrap"), err = w.querySelector("#eErr");
    wireJob(w, o);
    w.addEventListener("click", async e => {
      if (e.target.closest("#eBack")) { onDone(); return; }
      if (!e.target.closest("#eSave")) return;
      const head = readHead(w, places);
      if (typeof head === "string") { err.textContent = head; return; }
      const hd = headDiff(o, head, ["chuban", "kenmei", "kibou", "basho", "chumonsha", "tantou", "memo"]);
      const base = `zairyo/orders/${o.id}`, upd = {}, words = [...hd.words], reqWords = [];
      for (const [f, v] of Object.entries(hd.set)) upd[`${base}/${f}`] = v;
      if ("basho" in hd.set) upd[`${base}/bashoText`] = head.bashoText;
      for (const row of w.querySelectorAll(".erow[data-lid]")) {
        const lid = row.dataset.lid, old = o.lines[lid];
        const now = readLine(row);
        if (typeof now === "string") { err.textContent = now; return; }
        const ld = lineDiff(old, now);
        if (!ld.words.length) continue;
        for (const [f, v] of Object.entries(ld.set)) upd[`${base}/lines/${lid}/${f}`] = v;
        words.push(...ld.words);
        // 依頼から来た品物は、依頼の品物も同じに直す
        if (r && r.lines && r.lines[lid]) {
          for (const [f, v] of Object.entries(ld.set)) upd[`zairyo/requests/${r.id}/lines/${lid}/${f}`] = v;
          reqWords.push(...ld.words);
        }
      }
      if (!words.length) { err.textContent = "直したところがありません"; return; }
      // 注番を直したら、この注文の単価の記録の注番も直す
      if ("chuban" in hd.set) {
        const ps = (await get(ref(db, "zairyo/prices"))).val() || {};
        for (const [pid, pr] of Object.entries(ps)) if (pr && pr.orderId === o.id) upd[`zairyo/prices/${pid}/chuban`] = head.chuban;
      }
      const by = me.name || "事務所";
      upd[`${base}/log/${logKey(`${base}/log`)}`] = { at: serverTimestamp(), by, what: ("直した：" + words.join("・")).slice(0, 2000) };
      if (r && reqWords.length) {
        upd[`zairyo/requests/${r.id}/log/${logKey(`zairyo/requests/${r.id}/log`)}`] = { at: serverTimestamp(), by, what: (`注文（${o.supplierName}）を直した：` + reqWords.join("・")).slice(0, 2000) };
      }
      const btn = w.querySelector("#eSave");
      btn.disabled = true; btn.textContent = "保存しています…";
      try {
        await update(ref(db), upd);
      } catch (ex) {
        btn.disabled = false; btn.textContent = "直したところを保存";
        err.textContent = "保存できませんでした（" + (ex.message || ex) + "）";
        return;
      }
      toast(o.reqId && reqWords.length ? "注文を直しました。現場の依頼の品物も、同じに直しました" : "注文を直しました。記録にも残しました");
      onDone();
    });
  }, { side: true });
}
