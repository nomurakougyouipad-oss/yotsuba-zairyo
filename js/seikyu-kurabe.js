// 請求書を読む AI のモデルをくらべる（ためし用。seikyu-kurabe.html。事務員さんが見る画面には出さない。11/20 持ち主）
// - 見本の請求書（PDF・写真。1ファイル＝1つの請求書）を、Haiku と Sonnet で読んで、横に並べる（サーバーの zairyoAi task "invoice" に model をつける）
// - 自動でたしかめる：品物の行を足した金額が「御買上額（税抜）」と合うか・納品書の数が「伝票枚数」と合うか（書いてあれば）
// - かかった時間・お金（1ドル150円）・AI を使った回数を出す。結果はこのブラウザにだけ覚える（localStorage）。データベースには入れない
// - AI の回数（1日100回）を使うので、事務員さんが AI を使わない時間（17時すぎか土日）にためす
import { $, esc, initTheme } from "./common.js";
import { whoAmI, errorText } from "./touroku.js";
import { readInvoiceFiles, invoiceSlips, checkInvoice } from "./seikyu-ai.js";

const MODELS = [   // [id, 名前, 入力 $/100万トークン, 出力 $/100万トークン]
  ["claude-haiku-5-5", "Haiku 5.5", 0.10, 0.50],
  ["claude-sonnet-5-5", "Sonnet 5.5", 2, 10],
];
const YEN = 150;
const KEY = "yotsuba-zairyo-seikyu-kurabe";

initTheme();
const main = $("#main");
let files = [], busy = false, status = "";
let st = load() || { models: MODELS.map(m => m[0]), res: {} };   // res[ファイル名][モデル] = 結果
function load() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (err) { return null; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (err) { } }

start();
async function start() {
  main.innerHTML = '<section class="card"><p class="muted">しらべています…</p></section>';
  try {
    const me = await whoAmI();
    if (!me || me.role !== "office") { main.innerHTML = '<section class="card"><h2>事務所の端末だけで使えます</h2><p>事務所として登録したパソコンで開いてください。</p></section>'; return; }
  } catch (ex) {
    main.innerHTML = `<section class="card"><h2>つながりません</h2><p class="err">${esc(errorText(ex))}</p></section>`;
    return;
  }
  draw();
}

const yen = (id, runs) => { const m = MODELS.find(x => x[0] === id); return runs.reduce((t, r) => t + ((r.in || 0) * m[2] + (r.out || 0) * m[3]) / 1e6 * YEN, 0); };

async function run() {
  busy = true;
  for (const f of files) {
    for (const id of st.models) {
      const name = MODELS.find(m => m[0] === id)[1];
      status = `${f.name} を ${name} で読んでいます…`; draw();
      const t0 = Date.now();
      try {
        const r = await readInvoiceFiles([f], { model: id, onStep: (i, n) => { status = `${f.name} を ${name} で読んでいます…（${i}/${n}回め）`; const s = $("#kStatus"); if (s) s.textContent = status; } });
        const chk = checkInvoice(r.inv), slips = invoiceSlips(r.inv.rows);
        (st.res[f.name] = st.res[f.name] || {})[id] = {
          ok: r.inv.isInvoice && chk.ok, isInvoice: r.inv.isInvoice, kind: r.inv.kind, supplier: r.inv.supplier, closeDate: r.inv.closeDate,
          kaiage: chk.kaiage, sum: chk.sum, slips: slips.length, slipCount: r.inv.slipCount, pages: r.pages, calls: r.calls,
          sec: Math.round((Date.now() - t0) / 1000), yen: yen(id, r.runs), doubt: r.inv.doubt || [],
        };
      } catch (ex) {
        (st.res[f.name] = st.res[f.name] || {})[id] = { err: errorText(ex), sec: Math.round((Date.now() - t0) / 1000) };
      }
      save();
    }
  }
  busy = false; status = "おわりました"; draw();
}

function cell(r) {
  if (!r) return '<td class="muted">—</td>';
  if (r.err) return `<td class="bad">読めませんでした（${esc(r.err)}）・${r.sec}秒</td>`;
  const cnt = r.slipCount ? `納品書 ${r.slips}枚／伝票枚数 ${r.slipCount}${r.slips === r.slipCount ? "" : "（ちがう）"}` : `納品書 ${r.slips}枚`;
  return `<td class="${r.ok ? "ok" : "bad"}">${!r.isInvoice ? `請求書ではない（${esc(r.kind || "")}）` : r.ok ? `合う ${r.kaiage.toLocaleString()}円` : `合わない：足すと ${r.sum.toLocaleString()}円・御買上額 ${r.kaiage == null ? "読めない" : r.kaiage.toLocaleString() + "円"}`}
    <small>${esc(r.supplier || "")}・${cnt}・${r.pages}ページ・${r.calls}回・${r.sec}秒・${r.yen.toFixed(1)}円${r.doubt.length ? "・あやしい所：" + esc(r.doubt.join("／")) : ""}</small></td>`;
}

function draw() {
  const names = Object.keys(st.res), ids = st.models;
  const tot = id => {
    const rs = names.map(n => st.res[n][id]).filter(Boolean);
    return { n: rs.length, ok: rs.filter(r => r.ok).length, sec: rs.reduce((t, r) => t + (r.sec || 0), 0), yen: rs.reduce((t, r) => t + (r.yen || 0), 0), calls: rs.reduce((t, r) => t + (r.calls || 0), 0) };
  };
  main.innerHTML = `
    <section class="card stack">
      <p class="hint">ためし用のページです（事務員さんがふだん見る画面には出ません）。見本の請求書（1ファイル＝1つの請求書）を、モデルごとに読んで、品物の行を足した金額が「御買上額（税抜）」と合うかを数えます。</p>
      <p class="hint">AI の回数（1日100回）を使います。2ページで1回、モデルごとに数えます。事務員さんが AI を使わない時間（17時すぎか土日）にためしてください。</p>
      <label class="field"><span class="lab">見本の請求書（何個でも）</span><input type="file" id="kFiles" accept=".pdf,application/pdf,image/*" multiple${busy ? " disabled" : ""}></label>
      <p class="hint">${files.length ? `${files.length}ファイルをえらびました` : "まだえらんでいません"}</p>
      <div class="row">${MODELS.map(([id, name]) => `<label class="chk"><input type="checkbox" data-model="${id}"${ids.includes(id) ? " checked" : ""}${busy ? " disabled" : ""}> ${name}</label>`).join("")}</div>
      <div class="row"><button type="button" class="btn primary big" id="kRun"${busy || !files.length || !ids.length ? " disabled" : ""}>${busy ? "くらべています…" : "くらべる"}</button>
        <span class="hint" id="kStatus">${esc(status)}</span></div>
    </section>
    ${names.length ? `
    <section class="card stack">
      <h2>くらべた結果</h2>
      <div class="kscore">${ids.map(id => { const t = tot(id); return `<div class="block"><h3>${MODELS.find(m => m[0] === id)[1]}</h3><p>合った請求書 ${t.ok}／${t.n}・${t.sec}秒・AI ${t.calls}回・${t.yen.toFixed(0)}円</p></div>`; }).join("")}</div>
      <div class="tblwrap"><table class="ktbl"><thead><tr><th>請求書</th>${ids.map(id => `<th>${MODELS.find(m => m[0] === id)[1]}</th>`).join("")}</tr></thead>
        <tbody>${names.map(n => `<tr><th>${esc(n)}</th>${ids.map(id => cell(st.res[n][id])).join("")}</tr>`).join("")}</tbody></table></div>
      <button type="button" class="linkbtn muted" id="kClear"${busy ? " disabled" : ""}>結果をけす</button>
    </section>` : ""}`;
}

main.addEventListener("change", e => {
  if (e.target.id === "kFiles") { files = [...(e.target.files || [])]; draw(); }
  else if (e.target.dataset.model) { st.models = MODELS.map(m => m[0]).filter(id => (id === e.target.dataset.model ? e.target.checked : st.models.includes(id))); save(); draw(); }
});
main.addEventListener("click", e => {
  if (e.target.id === "kRun" && !busy) run();
  else if (e.target.id === "kClear" && !busy) { st.res = {}; save(); status = ""; draw(); }
});
