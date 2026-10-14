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

/** 印刷の画面を開く（見えない枠で印刷して、終わったら枠を消す） */
export function printFax(o, sup, info = {}) {
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  f.srcdoc = faxHTML(o, sup, info);
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
