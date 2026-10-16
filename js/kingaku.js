// 納品書の金額を入れる欄（事務所の注文の画面と、材料屋のアプリで同じもの。2-4・10/16）
// - 品物ごとに Kg・¥/kg（書かなくてもよい。入れると金額と単価が自動で出る。見積の返事と同じ）・単価（入れると金額＝単価×数）
// - 合計（税抜）は、手で入れていなければ品物の金額の合計。納品書の番号（あれば）・日付
// - はじめに入れておく値：直すときは前の納品書の値。新しく入れるときは見積の単価（qprice）
import { esc } from "./common.js";
import { lineText, ymd } from "./tanomu.js";
import { toPrice, yen } from "./chumon.js";

const comma = n => (n == null || n === "" ? "" : Number(n).toLocaleString("ja-JP", { maximumFractionDigits: 2 }));
const round2 = n => Math.round(n * 100) / 100;

/** 欄。o＝注文、slip＝前の納品書（直すとき）、date＝はじめの日付（なければ今日） */
export function slipFormHTML(o, { slip = null, date = "" } = {}) {
  const lines = Object.entries(o.lines || {});
  const rows = (slip && slip.rows) || {};
  const qp = !slip && lines.some(([, l]) => l.qprice != null);
  // 直すとき：合計が品物の金額の合計とちがえば、手で入れた合計のまま
  const sum = Object.values(rows).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const manual = slip && slip.amount != null && slip.amount !== sum;
  return `
    <div class="slipform stack" data-slipform>
      ${qp ? '<p class="hint">見積の単価を入れてあります。納品書とちがえば直してください。</p>' : ""}
      <div class="arows">
        <div class="arow head" aria-hidden="true"><span>品物</span><span>Kg</span><span>¥/kg</span><span>単価</span><span>金額</span></div>
        ${lines.map(([lid, l]) => { const r = rows[lid] || {}, pr = slip ? r.price : l.qprice;
          return `<div class="arow" data-lid="${esc(lid)}" data-qty="${esc(String(l.qty))}">
          <span class="a-spec">${esc(lineText(l))}</span>
          <label class="a-cell"><span class="a-lab">Kg</span><input class="inp num" data-s="kg" inputmode="decimal" placeholder="Kg" aria-label="${esc(l.spec)} の重さ（Kg）" value="${esc(r.kg == null ? "" : String(r.kg))}"></label>
          <label class="a-cell"><span class="a-lab">¥/kg</span><input class="inp num" data-s="perKg" inputmode="decimal" placeholder="¥/kg" aria-label="${esc(l.spec)} の kg あたりの値段" value="${esc(comma(r.perKg))}"></label>
          <label class="a-cell"><span class="a-lab">単価</span><input class="inp num" data-s="price" inputmode="decimal" placeholder="単価" aria-label="${esc(l.spec)} の単価" value="${esc(comma(pr))}"></label>
          <span class="num a-amt" data-s="amount"></span></div>`; }).join("")}
      </div>
      <span class="hint">Kg と ¥/kg は、書かなくてもかまいません。入れると、金額と単価が自動で出ます。単価を入れると、金額（単価×数）が出ます。合計だけでもかまいません。</span>
      <div class="atotal"><label>合計（税抜）<span class="req">必ず</span></label>
        <div class="yen-in"><input class="inp num" data-s="total" inputmode="numeric" placeholder="0" aria-label="合計（税抜）" value="${manual ? esc(yen(slip.amount)) : ""}"${manual ? ' data-manual="1"' : ""}><span>円</span></div></div>
      <div class="two">
        <div class="field"><label>納品書の番号（あれば）</label><input class="inp" data-s="no" maxlength="40" autocomplete="off" value="${esc((slip && slip.no) || "")}"></div>
        <div class="field"><label>日付</label><input class="inp" type="date" data-s="date" value="${esc((slip && slip.date) || date || ymd(0))}"></div>
      </div>
      <p class="err" data-s="err" role="alert"></p>
    </div>`;
}

/** 1行：Kg と ¥/kg があれば 金額＝Kg×¥/kg・単価＝金額÷数。なければ 金額＝単価×数。合計は、手で入れていなければ金額の合計 */
export function calcSlipForm(box, changed) {
  let sum = 0, any = false;
  box.querySelectorAll(".arow[data-lid]").forEach(r => {
    const q = Number(r.dataset.qty) || 0, g = a => r.querySelector(`[data-s="${a}"]`);
    const kg = toPrice(g("kg").value), pk = toPrice(g("perKg").value);
    let amount = null;
    if (kg != null && pk != null) {
      amount = Math.round(kg * pk);
      if (changed && r.contains(changed) && (changed.dataset.s === "kg" || changed.dataset.s === "perKg") && q) g("price").value = comma(round2(amount / q));
    } else {
      const pr = toPrice(g("price").value);
      if (pr != null) amount = Math.round(pr * q);
    }
    g("amount").textContent = amount != null ? yen(amount) + "円" : "";
    if (amount != null) { sum += amount; any = true; }
  });
  const t = box.querySelector('[data-s="total"]');
  if (changed === t) { if (t.value.trim()) t.dataset.manual = "1"; else delete t.dataset.manual; }
  if (!t.dataset.manual) t.value = any ? yen(sum) : "";
}

/** 入れたら計算する（はじめにも1回。見積の単価・前の納品書の値で金額を出しておく） */
export function wireSlipForm(box, onInput) {
  calcSlipForm(box);
  box.addEventListener("input", e => {
    if (!e.target.matches("[data-s]")) return;
    calcSlipForm(box, e.target);
    box.querySelector('[data-s="err"]').textContent = "";
    if (onInput) onInput();
  });
}

/** 欄から納品書を読む → { slip: {no, date, amount, rows} } か { err, focus } */
export function readSlipForm(box, o) {
  const rows = {};
  for (const r of box.querySelectorAll(".arow[data-lid]")) {
    const l = (o.lines || {})[r.dataset.lid];
    if (!l) continue;
    const g = a => r.querySelector(`[data-s="${a}"]`), x = {};
    for (const k of ["kg", "perKg", "price"]) {
      const s = g(k).value.trim();
      if (!s) continue;
      const n = toPrice(s);
      if (n == null || n < 0) return { err: "数でない所があります（Kg・¥/kg・単価）", focus: g(k) };
      x[k] = n;
    }
    const at = g("amount").textContent.trim();
    if (!at) continue;   // 金額が出ていない品物は、明細に入れない（Kg だけ、など）
    rows[r.dataset.lid] = { spec: l.spec + (l.note ? " " + l.note : ""), qty: Number(l.qty), unit: l.unit, ...x, amount: toPrice(at) };
  }
  const tEl = box.querySelector('[data-s="total"]'), total = toPrice(tEl.value);
  if (total == null) return { err: "合計（税抜）を入れてください（品物ごとの単価を入れると、自動で出ます）", focus: tEl };
  const date = box.querySelector('[data-s="date"]').value;
  return { slip: { no: box.querySelector('[data-s="no"]').value.trim().slice(0, 40), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ymd(0), amount: Math.round(total), rows } };
}

/** 明細の1行の文（見せるとき）：「SS400 …　×4枚　120kg × 100円/kg　@3,000　12,000円」 */
export const slipRowText = r => `${r.spec}${r.qty != null ? "　×" + comma(r.qty) + (r.unit || "") : ""}${r.kg != null && r.perKg != null ? `　${comma(r.kg)}kg × ${comma(r.perKg)}円/kg` : ""}${r.price != null ? "　@" + comma(r.price) : ""}　${yen(r.amount)}円`;
