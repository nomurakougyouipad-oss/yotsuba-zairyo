// FAX 用の注文書を印刷する（10/14 持ち主）
// - A4 縦。上に「注文書」、日付と送り先の FAX 番号、中身はいまの注文の文（orderText。決まり文句・電話番号も入る）、
//   いちばん下に会社の名前・住所・TEL・FAX・メール・ホームページ（⚙ 設定の「会社・注文書」）
// - 印刷の画面で、FAX 用のプリンターをえらんで送る（このページの中に見えない枠を作って、そこを印刷する）
// - FAX は白黒なので、色は使わない。字は大きめ
import { esc } from "./common.js";
import { orderText, companyLines } from "./chumon.js";

const today = () => { const d = new Date(); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };

/** 注文書の HTML（印刷用の1ページ） */
export function faxHTML(o, sup, info = {}) {
  const body = orderText(o, info);
  const foot = companyLines(info.company);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>注文書 ${esc(o.chuban || "")} ${esc(o.supplierName || "")}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #000; }
  body { font-family: "Yu Gothic", "YuGothic", "Meiryo", "MS Gothic", sans-serif; font-size: 13.5pt; line-height: 1.65; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { min-height: 268mm; display: flex; flex-direction: column; }
  .title { border-top: 2.5px solid #000; border-bottom: 2.5px solid #000; text-align: center; font-size: 26pt; font-weight: 700; letter-spacing: .8em; padding: 3mm 0 3mm .8em; }
  .meta { display: flex; justify-content: space-between; gap: 8mm; font-size: 11.5pt; margin: 3mm 0 6mm; }
  .body { white-space: pre-wrap; word-break: break-all; margin: 0; font: inherit; }
  .foot { margin-top: auto; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; padding: 2.5mm 4mm; font-size: 11.5pt; line-height: 1.55; }
  @media screen { body { padding: 14mm 16mm; } }
</style></head><body><div class="sheet">
  <div class="title">注文書</div>
  <div class="meta"><span>${esc(today())}</span><span>${sup && sup.fax ? `送り先 FAX：${esc(sup.fax)}` : "送り先 FAX：（⚙ 設定の材料屋で入れてください）"}</span></div>
  <pre class="body">${esc(body)}</pre>
  ${foot.length ? `<div class="foot">${foot.map(esc).join("<br>")}</div>` : ""}
</div></body></html>`;
}

/** 見積依頼書の HTML（10/15。見本の A0見積依頼書 と同じ欄の表。金額などの欄は空けて、材料屋が書いて返せるように）
 *  q＝見積、supId＝出す材料屋、info＝⚙ 設定の「会社・注文書」と電話番号 */
export function mitsumoriFaxHTML(q, supId, sup, info = {}) {
  const s = (q.sups || {})[supId] || {}, c = info.company || {}, tels = info.tels || {};
  const who = n => (n && tels[n] ? `${n}（${tels[n]}）` : n || "");
  const lines = Object.entries(q.lines || {}).sort(([a], [b]) => a.localeCompare(b)).map(([, l]) => {
    const mat = (l.vals && l.vals.材質) || "";
    return { mat, spec: mat && String(l.spec).startsWith(mat + " ") ? l.spec.slice(mat.length + 1) : l.spec, qty: `${l.qty} ${l.unit || ""}` };
  });
  const blank = Math.max(0, 6 - lines.length);   // 空の行（材料屋が書き足せるように。行が少ないときだけ）
  const files = Object.values(q.files || {}).map(f => f.name).filter(Boolean);
  const k = !q.kibou ? "" : q.kibou === "最短" ? "最短" : (() => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.kibou); return m ? `${+m[2]}/${+m[3]}` : q.kibou; })();
  const foot = companyLines(c);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>見積依頼書 ${esc(q.chuban || "")} ${esc(s.name || "")}</title>
<style>
  @page { size: A4 portrait; margin: 12mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #000; }
  body { font-family: "Yu Gothic", "YuGothic", "Meiryo", "MS Gothic", sans-serif; font-size: 11pt; line-height: 1.5; }
  .sheet { min-height: 271mm; display: flex; flex-direction: column; gap: 3.5mm; }
  .title { border-top: 2.5px solid #000; border-bottom: 2.5px solid #000; text-align: center; font-size: 24pt; font-weight: 700; letter-spacing: .6em; padding: 2mm 0 2mm .6em; }
  .meta { display: flex; justify-content: space-between; gap: 6mm; }
  .who { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; }
  .to { font-size: 15pt; font-weight: 700; border-bottom: 1.5px solid #000; padding: 0 2mm 1mm; min-width: 80mm; }
  .co { text-align: right; font-size: 10pt; line-height: 1.55; }
  .co b { font-size: 12.5pt; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { border: 1px solid #000; padding: 1.5mm; vertical-align: top; word-break: break-all; }
  th { font-weight: 700; background: #eee; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td.b { height: 9mm; }
  .ask { font-size: 12.5pt; font-weight: 700; text-align: center; margin-top: 2mm; }
  .foot { margin-top: auto; border-top: 1.5px solid #000; padding-top: 2mm; font-size: 10pt; }
  @media screen { body { padding: 12mm 14mm; } }
</style></head><body><div class="sheet">
  <div class="title">見積依頼書</div>
  <div class="meta"><span>見積依頼番号（注番）：${esc(q.chuban || "")}</span><span>${esc(today())}</span></div>
  <div class="meta"><span></span><span>${sup && sup.fax ? `送り先 FAX：${esc(sup.fax)}` : "送り先 FAX：（⚙ 設定の材料屋で入れてください）"}</span></div>
  <div class="who"><div class="to">${esc(s.name || "")}　${esc(s.to || "御中")}</div>
    <div class="co">${c.name ? `<b>${esc(c.name)}</b><br>` : ""}${c.zip || c.addr ? `${c.zip ? `〒${esc(c.zip)} ` : ""}${esc(c.addr || "")}<br>` : ""}${c.tel || c.fax ? `${c.tel ? `TEL ${esc(c.tel)}` : ""}${c.tel && c.fax ? "　" : ""}${c.fax ? `FAX ${esc(c.fax)}` : ""}<br>` : ""}担当者　${esc(who(q.tantou))}</div></div>
  <div>工事件名　${esc(q.kenmei || "")}</div>
  <div>下記の内容の見積金額と納期の回答をお願いいたします${k ? `（希望納期：${esc(k)}）` : ""}</div>
  <table>
    <tr><th style="width:14%">材質</th><th>品名</th><th style="width:10%">数量</th><th style="width:11%">単価</th><th style="width:12%">合計金額</th><th style="width:8%">Kg</th><th style="width:9%">¥/kg</th><th style="width:10%">納期</th></tr>
    ${lines.map(l => `<tr><td>${esc(l.mat)}</td><td>${esc(l.spec)}</td><td>${esc(l.qty)}</td><td></td><td></td><td></td><td></td><td></td></tr>`).join("")}
    ${"<tr><td class=\"b\"></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>".repeat(blank)}
    <tr><td colspan="4" style="text-align:right;font-weight:700">合計</td><td></td><td colspan="3"></td></tr>
  </table>
  ${files.length ? `<div>※添付ファイル：${esc(files.join("、"))}（別に送ります）</div>` : ""}
  <div class="ask">見積金額と納期の回答をお願いいたします</div>
  ${foot.length ? `<div class="foot">${foot.map(esc).join("　")}</div>` : ""}
</div></body></html>`;
}

/** 注文書を印刷する */
export const printFax = (o, sup, info = {}) => printHTML(faxHTML(o, sup, info));

/** 印刷の画面を開く（見えない枠で印刷して、終わったら枠を消す） */
export function printHTML(html) {
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  f.srcdoc = html;
  f.onload = () => {
    const win = f.contentWindow;
    const done = () => setTimeout(() => f.remove(), 500);
    win.addEventListener("afterprint", done);
    setTimeout(done, 10 * 60 * 1000);   // afterprint が来ないときも、10分で消す
    win.focus();
    win.print();
  };
  document.body.append(f);
}
