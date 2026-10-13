// AI のモデルをくらべる（ためし用。ai-kurabe.html。事務員さんが見る設定の画面には出さない）
// - 品名の行を、Haiku・Sonnet・Opus の3つで品物一覧に当てて、横に並べる（サーバーの zairyoAi task "match" に model をつける）
// - 「=== 別の注文 ===」の行は注文の区切り（AI にもわたすが、点数には入れない）。多いときは区切りのところで分けて何回かにわたす
// - 3つの答えがそろった行は、そのまま正しいとみなす（ちがえば「どれもちがう」）。答えがちがう行は、正しいものをえらぶ
// - 点数・オレンジにした数・かかった時間・お金・2回目とのちがい（ゆれ）を出す
// - 結果はこのブラウザにだけ覚える（localStorage）。データベースには入れない
import { ref, get } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, call } from "./firebase.js";
import { $, esc, initTheme, toast } from "./common.js";
import { whoAmI, errorText } from "./touroku.js";
import { normCatalog, buildSpec, fmtQty } from "./tanomu.js";
import { splitLine } from "./line-chumon.js";

const MODELS = [   // [id, 名前, 入力 $/100万トークン, 出力 $/100万トークン]
  ["claude-haiku-5-5", "Haiku 5.5", 0.10, 0.50],
  ["claude-sonnet-5-5", "Sonnet 5.5", 2, 10],
  ["claude-opus-5-5", "Opus 5.5", 4, 20],
];
const YEN = 150;              // 1ドル150円で計算する
const CHUNK = 45;             // 1回にわたす行の数（区切りの行もふくむ）
const SEP = /^=+\s*別の注文\s*=+$/;
const KEY = "yotsuba-zairyo-kurabe";

initTheme();
const main = $("#main");
let catalog = null;
let st = load() || { text: "", rounds: 2, models: MODELS.map(m => m[0]), runs: {}, judge: {} };
let busy = false;

function load() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (err) { return null; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (err) { } }

start();
async function start() {
  main.innerHTML = '<section class="card"><p class="muted">しらべています…</p></section>';
  try {
    const me = await whoAmI();
    if (!me || me.role !== "office") {
      main.innerHTML = '<section class="card"><h2>事務所の端末だけで使えます</h2><p>事務所として登録したパソコンで開いてください。</p></section>';
      return;
    }
    catalog = normCatalog((await get(ref(db, "zairyo/master/catalog"))).val());
  } catch (ex) {
    main.innerHTML = `<section class="card"><h2>つながりません</h2><p class="err">${esc(errorText(ex))}</p></section>`;
    return;
  }
  draw();
}

/* ---------- 行 ---------- */
const lineList = text => String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((text, i) => ({ i, text, sep: SEP.test(text) }));
/** 区切りの行のところで、CHUNK 行までのかたまりに分ける */
function chunks(lines) {
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    if (l.sep) { if (cur.length) blocks.push(cur); blocks.push([l]); cur = []; } else cur.push(l);
  }
  if (cur.length) blocks.push(cur);
  const out = [];
  let ch = [];
  for (const b of blocks) {
    if (ch.length && ch.length + b.length > CHUNK) { out.push(ch.filter((l, j) => !(l.sep && (j === 0 || j === ch.length - 1)))); ch = []; }
    ch.push(...b);
  }
  if (ch.length) out.push(ch.filter((l, j) => !(l.sep && (j === 0 || j === ch.length - 1))));
  return out.filter(c => c.length);
}

/** AI の答え → 行ごとの答え {i: {kind, spec, qty, unit, guess}} */
function answersOf(res, lines) {
  const byI = {};
  const text = i => (lines.find(l => l.i === i) || {}).text || "";
  for (const r of res.rows) {
    const last = r.lines[r.lines.length - 1];
    r.lines.slice(0, -1).forEach(i => { byI[i] = { kind: "cont" }; });
    const it = r.key ? catalog.item.get(r.key) : null;
    const spec = it ? buildSpec(it, r.vals) : r.lines.map(i => splitLine(text(i)).spec).filter(Boolean).join(" ");
    byI[last] = { kind: it ? "item" : "free", spec, qty: r.qty, unit: r.unit || (it ? it.unit : ""), guess: r.guess || [] };
  }
  for (const i of res.notes) byI[i] = { kind: "note" };
  return byI;
}
const sig = a => (!a ? "none" : a.kind === "item" || a.kind === "free" ? `${a.kind}|${a.spec}|${a.qty ?? ""}|${a.unit || ""}` : a.kind);
const ansText = a => (!a ? "（答えなし）" : a.kind === "cont" ? "↓ 下の行と1つの品物" : a.kind === "note" ? "品物ではない行（メモ）"
  : `${a.spec}${a.qty != null ? `　×${fmtQty(a.qty)}${a.unit || ""}` : "　（数なし）"}${a.kind === "free" ? "（一覧にない品物）" : ""}`);

/* ---------- くらべる ---------- */
async function run() {
  if (busy) return;
  const lines = lineList(st.text);
  if (!lines.some(l => !l.sep)) { toast("品名の行を入れてください"); return; }
  if (!st.models.length) { toast("くらべるモデルをえらんでください"); return; }
  busy = true;
  st.runs = {};
  st.judge = {};
  st.lines = lines;
  draw();   // ボタンを「くらべています…」にする
  const parts = chunks(lines);
  for (let r = 1; r <= st.rounds; r++) {
    st.runs[r] = {};
    await Promise.all(st.models.map(async model => {
      const out = { ans: {}, ms: 0, in: 0, out: 0, err: "", calls: 0 };
      st.runs[r][model] = out;
      for (const part of parts) {
        status(`${r}回目：${MODELS.find(m => m[0] === model)[1]} が当てています…（${out.calls + 1}/${parts.length}）`);
        try {
          const res = (await call("zairyoAi", { timeout: 300000 })({ task: "match", model, lines: part.map(l => ({ i: l.i, text: l.text })) })).data;
          Object.assign(out.ans, answersOf(res, lines));
          out.ms += res.run.ms; out.in += res.run.in; out.out += res.run.out;
        } catch (ex) {
          out.err = errorText(ex);
        }
        out.calls++;
        save();
        draw();
      }
    }));
  }
  busy = false;
  save();
  draw();
  status("おわりました。答えがちがう行（オレンジ）で、正しいものをえらんでください");
}
function status(msg) { const s = $("#kStatus"); if (s) s.textContent = msg; }

/* ---------- 点数 ---------- */
function scores() {
  const lines = (st.lines || []).filter(l => !l.sep);
  const r1 = st.runs[1] || {};
  const ids = Object.keys(r1);
  let open = 0;
  const sc = Object.fromEntries(ids.map(id => [id, { ok: 0, guess: 0, note: 0, shake: 0 }]));
  for (const l of lines) {
    const sigs = ids.map(id => sig(r1[id].ans[l.i]));
    const agreed = sigs.every(s => s === sigs[0]);
    const right = st.judge[l.i] ?? (agreed ? sigs[0] : undefined);
    if (right === undefined) open++;
    ids.forEach((id, j) => {
      const a = r1[id].ans[l.i];
      if (right !== undefined && sigs[j] === right) sc[id].ok++;
      if (a && a.guess && a.guess.length) sc[id].guess++;
      if (a && a.kind === "note") sc[id].note++;
      const a2 = st.runs[2] && st.runs[2][id] && st.runs[2][id].ans[l.i];
      if (st.runs[2] && st.runs[2][id] && sig(a2) !== sigs[j]) sc[id].shake++;
    });
  }
  return { sc, open, total: lines.length };
}
const yen = (id, run) => { const m = MODELS.find(x => x[0] === id); return ((run.in * m[2] + run.out * m[3]) / 1e6) * YEN; };

/* ---------- 画面 ---------- */
function draw() {
  const r1 = st.runs[1] || {}, ids = Object.keys(r1);
  const { sc, open, total } = ids.length ? scores() : { sc: {}, open: 0, total: 0 };
  main.innerHTML = `
    <section class="card stack">
      <p class="hint">ためし用のページです（事務員さんがふだん見る画面には出ません）。品名の行を貼って、3つのモデルで品物一覧に当てて、くらべます。注文の区切りは「=== 別の注文 ===」の行にします。AI を使うので、お金が少しかかります（品名86行・2回で、ぜんぶで100円くらい）。</p>
      <label class="field"><span class="lab">品名の行（1行に1つ）</span>
        <textarea id="kText" class="inp ta" rows="8" ${busy ? "disabled" : ""}>${esc(st.text)}</textarea></label>
      <div class="row">${MODELS.map(([id, name]) => `<label class="chk"><input type="checkbox" data-model="${id}"${st.models.includes(id) ? " checked" : ""}${busy ? " disabled" : ""}> ${name}</label>`).join("")}
        <label class="chk">回数 <select id="kRounds" class="inp"${busy ? " disabled" : ""}>${[1, 2].map(n => `<option${n === st.rounds ? " selected" : ""}>${n}</option>`).join("")}</select></label></div>
      <div class="row"><button type="button" class="btn primary big" id="kRun"${busy ? " disabled" : ""}>${busy ? "くらべています…" : "くらべる"}</button>
        <span class="hint" id="kStatus"></span></div>
    </section>
    ${ids.length ? `
    <section class="card stack">
      <h2>点数（1回目）</h2>
      <p class="hint">${total}行のうち、正しいものをまだえらんでいない行：${open}行。3つの答えがそろった行は、正しいとみなしています（ちがうときは「どれもちがう」）。</p>
      <div class="kscore">${ids.map(id => {
        const m = MODELS.find(x => x[0] === id), run = r1[id], run2 = st.runs[2] && st.runs[2][id];
        const cost = yen(id, run) + (run2 ? yen(id, run2) : 0);
        return `<div class="block"><h3>${m[1]}</h3>
          <p><span class="money">${sc[id].ok}</span> / ${total} 行 正しい</p>
          <p class="muted">オレンジにした行 ${sc[id].guess}・メモにした行 ${sc[id].note}${run2 ? `・2回目とちがう行 ${sc[id].shake}` : ""}</p>
          <p class="muted">時間 ${(run.ms / 1000).toFixed(0)}秒・入力 ${run.in}・出力 ${run.out} トークン・お金 約${cost.toFixed(1)}円${run2 ? "（2回分）" : ""}</p>
          ${run.err ? `<p class="warn">まちがい：${esc(run.err)}</p>` : ""}</div>`;
      }).join("")}</div>
      <button type="button" class="btn" id="kCopy">結果をコピー</button>
    </section>
    <section class="card stack">
      <h2>行ごとの答え</h2>
      <div class="ktable">${(st.lines || []).filter(l => !l.sep).map(l => rowHTML(l, ids)).join("")}</div>
    </section>` : ""}`;
}

function rowHTML(l, ids) {
  const r1 = st.runs[1];
  const sigs = ids.map(id => sig(r1[id].ans[l.i]));
  const agreed = sigs.every(s => s === sigs[0]);
  const right = st.judge[l.i] ?? (agreed ? sigs[0] : undefined);
  return `
    <div class="krow2${agreed ? "" : " diff"}${right === undefined ? " open" : ""}">
      <div class="kline">${l.i + 1}. ${esc(l.text)}</div>
      <div class="kans">${ids.map((id, j) => {
        const a = r1[id].ans[l.i], a2 = st.runs[2] && st.runs[2][id] && st.runs[2][id].ans[l.i];
        const shake = st.runs[2] && st.runs[2][id] && sig(a2) !== sigs[j];
        return `<button type="button" class="kcell${right === sigs[j] ? " right" : ""}" data-pick="${l.i}" data-sig="${esc(sigs[j])}">
          <span class="kname">${MODELS.find(m => m[0] === id)[1]}</span>
          <span>${esc(ansText(a))}</span>
          ${a && a.guess && a.guess.length ? `<span class="kguess">オレンジ：${esc(a.guess.join("・"))}</span>` : ""}
          ${shake ? `<span class="kshake">2回目：${esc(ansText(a2))}</span>` : ""}</button>`;
      }).join("")}
        <button type="button" class="kcell none${right === "none-of-them" ? " right" : ""}" data-pick="${l.i}" data-sig="none-of-them">どれもちがう</button></div>
    </div>`;
}

/* ---------- 押したとき ---------- */
main.addEventListener("click", async e => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.id === "kRun") { st.text = $("#kText").value; save(); await run(); }
  else if (t.dataset.pick) { st.judge[t.dataset.pick] = t.dataset.sig; save(); draw(); }
  else if (t.id === "kCopy") {
    const { sc, open, total } = scores();
    const r1 = st.runs[1];
    const txt = [`AI モデルくらべ（品名 ${total}行・えらんでいない行 ${open}）`, ...Object.keys(r1).map(id => {
      const m = MODELS.find(x => x[0] === id), run = r1[id], run2 = st.runs[2] && st.runs[2][id];
      return `${m[1]}：正しい ${sc[id].ok}/${total}・オレンジ ${sc[id].guess}・メモ ${sc[id].note}${run2 ? `・ゆれ ${sc[id].shake}` : ""}・${(run.ms / 1000).toFixed(0)}秒・約${(yen(id, run) + (run2 ? yen(id, run2) : 0)).toFixed(1)}円`;
    })].join("\n");
    try { await navigator.clipboard.writeText(txt); toast("結果をコピーしました"); } catch (err) { toast("コピーできませんでした"); }
  }
});
main.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.model) {
    st.models = MODELS.map(m => m[0]).filter(id => id === t.dataset.model ? t.checked : st.models.includes(id));
    save();
  } else if (t.id === "kRounds") { st.rounds = Number(t.value); save(); }
});
main.addEventListener("input", e => { if (e.target.id === "kText") { st.text = e.target.value; save(); } });
