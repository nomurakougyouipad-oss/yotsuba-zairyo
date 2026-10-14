// LINE の品名を品物一覧に当てる（11章 7-4。試作の「品物一覧に当てる」と同じ動き）
// - 1行ずつ「数」を分けて、覚えた当て方（/zairyo/master/itemMemo）→ なければ AI（サーバーの zairyoAi task "match"）で当てる
// - 書いていない値（材質など）はオレンジの行で「どれですか？」と出し、えらぶまで入れられない。ちがう行は「なおす」
// - 品物ではない行（ミルシートお願いします など）はメモへ。「品物にする」でもどせる
// - 入れたときに、たしかめた当て方を覚える（次から同じ書き方は AI なしで当たる。2行までの品物）
// - AI が使えないときは、品名は文のまま入る（7-1 の形）
import { ref, get, update } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, call } from "./firebase.js";
import { esc } from "./common.js";
import { buildSpec, fmtQty } from "./tanomu.js";
import { errorText } from "./touroku.js";
import { memoDbKey } from "./line-parse.js";

/** box … 表示する入れ物、catalog … normCatalog の品物一覧、splitLine … 1行を {spec, qty, unit} にする、onState() … ようすが変わったとき */
export function createMatcher({ box, catalog, splitLine, onState }) {
  let memo = {}, match = null, seq = 0;
  const memoReady = get(ref(db, "zairyo/master/itemMemo")).then(s => { memo = s.val() || {}; }, () => { });
  const ITEM = catalog.item;
  const units = catalog.units || [];

  const rowSpec = r => (r.key ? buildSpec(ITEM.get(r.key), r.vals) : r.body);
  const rowUnit = r => r.unit || (r.key ? ITEM.get(r.key).unit : "") || "個";
  const mkRow = (ls, key, vals, guess, qty, unit, how) => {
    const it = key && ITEM.get(key) && !ITEM.get(key).free ? ITEM.get(key) : null;
    const body = ls.map(i => match.parts[i].spec).filter(Boolean).join(" ");
    const r = {
      lines: ls, raw: ls.map(i => match.raws[i]).join(" ／ "), body, orig: body,   // orig＝覚えるときの元の書き方（なおしても変えない）
      key: it ? key : null, vals: { ...(vals || {}) }, qty: qty == null ? null : qty, unit: unit || (it ? it.unit : ""), how,
      ask: [...(guess || [])].filter(k => it && it.opts.some(o => o[0] === k && !o[2])),   // 「えらばなくてもよい」行は聞かない
    };
    if (r.qty == null) r.ask.push("数");
    return r;
  };

  /* ---------- 当てる ---------- */
  async function run(text) {
    const raws = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const my = ++seq;
    if (!raws.length) { match = null; render(); return; }
    await memoReady;
    if (my !== seq) return;
    match = { src: text, raws, parts: raws.map(splitLine), rows: [], notes: [], busy: false, err: "" };
    const { parts } = match, todo = [];
    for (let i = 0; i < parts.length; i++) {
      const m = memo[memoDbKey(parts[i].spec)];
      const m2 = !m && i + 1 < parts.length ? memo[memoDbKey(parts[i].spec + " " + parts[i + 1].spec)] : null;   // 見出し＋サイズの2行
      if (m && m.note) match.notes.push(i);
      else if (m) match.rows.push(mkRow([i], m.free ? null : m.key, m.free ? {} : m.vals, [], parts[i].qty, parts[i].unit, "memo"));
      else if (m2 && !m2.note) { match.rows.push(mkRow([i, i + 1], m2.free ? null : m2.key, m2.free ? {} : m2.vals, [], parts[i + 1].qty, parts[i + 1].unit, "memo")); i++; }
      else todo.push(i);
    }
    match.busy = todo.length > 0;
    render();
    if (!todo.length) return;
    try {
      const r = (await call("zairyoAi", { timeout: 180000 })({ task: "match", lines: todo.map(i => ({ i, text: raws[i] })) })).data;
      if (my !== seq) return;
      const covered = new Set(r.notes);
      r.notes.forEach(i => match.notes.push(i));
      r.rows.forEach(x => {
        x.lines.forEach(i => covered.add(i));
        const last = parts[x.lines[x.lines.length - 1]];
        match.rows.push(mkRow(x.lines, x.key, x.vals, x.guess, x.qty != null ? x.qty : last.qty, x.unit || last.unit, x.key ? "ai" : "free"));
      });
      // AI がどこにも入れなかった行は、文のままの品物にする
      todo.filter(i => !covered.has(i)).forEach(i => match.rows.push(mkRow([i], null, {}, [], parts[i].qty, parts[i].unit, "free")));
      match.rows.sort((a, b) => a.lines[0] - b.lines[0]);
      match.busy = false;
    } catch (ex) {
      if (my !== seq) return;
      match = { src: text, raws, parts, rows: [], notes: [], busy: false, err: errorText(ex) };
    }
    render();
  }

  /* ---------- 表示 ---------- */
  const optsOf = r => (r.key ? ITEM.get(r.key).opts : []);
  function rowHTML(r, i) {
    const it = r.key ? ITEM.get(r.key) : null;
    const askHTML = r.ask.map(k => {
      if (k === "数") return '<div class="mtr-ask"><span>数が書いてありません。「なおす」で入れてください</span></div>';
      const ch = (optsOf(r).find(o => o[0] === k) || [k, []])[1];
      const g0 = r.vals[k] || "";
      return `<div class="mtr-ask"><span>${esc(k)}が書いてありません。どれですか？</span><div class="pick sm">` +
        [...new Set([g0, ...ch])].filter(Boolean).map(v => `<button type="button" data-mask="${esc(k)}" data-r="${i}" data-v="${esc(v)}"${v === g0 ? ' class="rec"' : ""}>${esc(v)}${v === g0 ? "<small>おすすめ</small>" : ""}</button>`).join("") +
        "</div></div>";
    }).join("");
    return `
      <li class="mtr${r.ask.length ? " ask" : it ? "" : " free"}" data-r="${i}">
        <div class="mtr-main"><span class="mtr-spec">${esc(rowSpec(r))}</span><span class="mtr-qty num">${r.qty != null ? `×${esc(fmtQty(r.qty))}<small>${esc(rowUnit(r))}</small>` : ""}</span></div>
        ${r.how === "memo" ? '<span class="tag">前にえらんだ品物</span>' : !it ? '<span class="tag">一覧にない品物（文のまま）</span>' : ""}
        <div class="mtr-foot"><span class="mtr-src">LINE：${esc(r.raw)}</span>${r.editing ? "" : `<button type="button" class="linkbtn muted" data-medit="${i}">なおす</button>`}</div>
        ${askHTML}
        ${r.editing ? editorHTML(r, i) : ""}
      </li>`;
  }
  function editorHTML(r, i) {
    const e = r.ed, it = e.key ? ITEM.get(e.key) : null;
    const kind = `<select class="inp" data-mek="${i}" aria-label="品物"><option value="">一覧にない品物（文のまま）</option>` +
      catalog.cats.map(c => `<optgroup label="${esc(c.name)}">` + c.items.filter(x => !x.free).map(x => {
        const k = `${c.id}:${x.id}`;
        return `<option value="${esc(k)}"${e.key === k ? " selected" : ""}>${esc(x.name)}</option>`;
      }).join("") + "</optgroup>").join("") + "</select>";
    const fields = it
      ? it.opts.map(([k, ch], j) => `<label class="mte-f"><span>${esc(k)}</span><input class="inp" data-mev="${esc(k)}" list="mdl${i}_${j}" value="${esc(e.vals[k] || "")}" autocomplete="off">` +
        `<datalist id="mdl${i}_${j}">${ch.map(x => `<option value="${esc(x)}"></option>`).join("")}</datalist></label>`).join("")
      : `<label class="mte-f wide"><span>品名（文のまま）</span><input class="inp" data-mefree value="${esc(e.body)}"></label>`;
    const u0 = e.unit || (it ? it.unit : "個");
    return `<div class="mte"><label class="mte-f wide"><span>品物</span>${kind}</label><div class="mte-grid">${fields}
        <label class="mte-f"><span>数</span><input class="inp" data-meq inputmode="decimal" value="${e.qty == null ? "" : esc(fmtQty(e.qty))}"></label>
        <label class="mte-f"><span>単位</span><select class="inp" data-meu>${[...new Set([u0, ...units])].map(u => `<option${u === u0 ? " selected" : ""}>${esc(u)}</option>`).join("")}</select></label></div>
      <p class="err" data-meerr></p>
      <div class="row"><button type="button" class="btn primary" data-mok="${i}">これでよい</button><button type="button" class="linkbtn muted" data-mcancel="${i}">やめる</button></div></div>`;
  }
  function render() {
    box.hidden = !match;
    if (!match) { box.innerHTML = ""; onState(); return; }
    let st, cls = "";
    if (match.err) { st = `AI で当てられませんでした（${match.err}）。品名は文のまま入ります`; cls = "bad"; }
    else if (match.busy) st = "AI が品物一覧に当てています…（10秒ほど）";
    else {
      const n = match.rows.filter(r => r.ask.length || r.editing).length;
      st = n ? `当てました。オレンジの ${n} 行をたしかめてください` : "当てました。ちがう行は「なおす」で直せます";
      cls = n ? "warn" : "ok";
    }
    box.innerHTML = `
      <div class="mt-head"><span class="lab">品物一覧に当てる</span><span class="hint ${cls}">${esc(st)}</span>
        ${match.err ? '<button type="button" class="linkbtn" data-mretry>もう一度当てる</button>' : ""}</div>
      <ul class="mtl">${match.err ? "" : match.rows.map(rowHTML).join("")}</ul>
      ${!match.err && match.notes.length ? `<div class="mtn"><span class="lab">品物ではない行（メモに入れます）</span>` +
        match.notes.map(i => `<span class="mtn-r"><span>${esc(match.raws[i])}</span><button type="button" class="linkbtn muted" data-mnote="${i}">品物にする</button></span>`).join("") + "</div>" : ""}`;
    onState();
  }

  /* ---------- 押したとき・書いたとき ---------- */
  const rowAt = el => match && match.rows[Number(el.dataset.r ?? el.closest("[data-r]").dataset.r)];
  box.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t || !match) return;
    const d = t.dataset;
    if (d.mask) {
      const r = match.rows[Number(d.r)];
      r.vals[d.mask] = d.v;
      r.ask = r.ask.filter(k => k !== d.mask);
      render();
    } else if (d.medit) {
      const r = match.rows[Number(d.medit)];
      r.editing = true;
      r.ed = { key: r.key, vals: { ...r.vals }, body: r.body, qty: r.qty, unit: rowUnit(r) };
      render();
      const sel = box.querySelector(`[data-mek="${d.medit}"]`);
      if (sel) sel.focus();
    } else if (d.mcancel) {
      match.rows[Number(d.mcancel)].editing = false;
      render();
    } else if (d.mok) {
      const r = match.rows[Number(d.mok)], e2 = r.ed, li = t.closest("li"), err = li.querySelector("[data-meerr]");
      const q = parseFloat(String(li.querySelector("[data-meq]").value).normalize("NFKC"));
      e2.unit = li.querySelector("[data-meu]").value;
      if (!(q > 0 && q < 100000)) { err.textContent = "数を入れてください"; return; }
      const spec = e2.key ? buildSpec(ITEM.get(e2.key), e2.vals) : String(e2.body || "").trim();
      if (!spec) { err.textContent = e2.key ? "値を1つ以上入れてください" : "品名を入れてください"; return; }
      Object.assign(r, { key: e2.key, vals: e2.key ? e2.vals : {}, body: e2.key ? r.body : spec, qty: q, unit: e2.unit, ask: [], editing: false, how: "edit" });
      render();
    } else if (d.mnote) {
      const i = Number(d.mnote), p = match.parts[i];
      match.notes = match.notes.filter(x => x !== i);
      match.rows.push(mkRow([i], null, {}, [], p.qty, p.unit, "free"));
      match.rows.sort((a, b) => a.lines[0] - b.lines[0]);
      render();
    } else if ("mretry" in d) {
      run(match.src);
    }
  });
  box.addEventListener("input", e => {
    const t = e.target, r = t.closest("[data-r]") && rowAt(t);
    if (!r || !r.ed) return;
    if (t.dataset.mev) { const v = t.value.trim(); if (v) r.ed.vals[t.dataset.mev] = v; else delete r.ed.vals[t.dataset.mev]; }
    if ("mefree" in t.dataset) r.ed.body = t.value;
  });
  box.addEventListener("change", e => {
    const t = e.target;
    if (!t.dataset.mek) return;
    const r = match.rows[Number(t.dataset.mek)], old = r.ed.key ? ITEM.get(r.ed.key) : null, it = t.value ? ITEM.get(t.value) : null;
    if (!r.ed.unit || (old && r.ed.unit === old.unit)) r.ed.unit = it ? it.unit : r.ed.unit;
    r.ed.key = t.value || null;
    if (it) { const keep = {}; it.opts.forEach(([k]) => { if (r.ed.vals[k]) keep[k] = r.ed.vals[k]; }); r.ed.vals = keep; }
    render();
    const sel = box.querySelector(`[data-mek="${t.dataset.mek}"]`);
    if (sel) sel.focus();
  });

  return {
    run,
    clear() { seq++; match = null; render(); },
    /** いまの品名の文に当てたものか（品名を書きかえたら、当てたものは使わない） */
    isFor: text => !!(match && !match.err && match.src === text),
    active: () => !!match,
    /** その品名の文のようす："none"（まだ）・"busy"（AI が当てている）・"done"（当てた）・"err"（当てられなかった） */
    state: text => (!match || match.src !== text ? "none" : match.err ? "err" : match.busy ? "busy" : "done"),
    /** 入れられないわけ（なければ ""） */
    problem() {
      if (match.busy) return "AI が品物一覧に当てているところです。少し待ってください";
      const n = match.rows.filter(r => r.ask.length || r.editing).length;
      if (n) return `たしかめていない品物が ${n}行 あります（オレンジの行）`;
      if (!match.rows.length) return "品物がありません。品名・数量を入れてください";
      return "";
    },
    /** 注文の品物の行 */
    lines: () => match.rows.map(r => {
      const it = r.key ? ITEM.get(r.key) : null;
      const l = { spec: rowSpec(r).slice(0, 300), qty: r.qty, unit: rowUnit(r) };
      if (it) Object.assign(l, { key: r.key, cat: it.cat, name: it.name, vals: { ...r.vals } });
      return l;
    }),
    /** 品物ではない行の文（メモに足す） */
    noteTexts: () => match.notes.map(i => match.raws[i]),
    /** たしかめて入れた当て方を覚える（2行までの品物と、品物ではない行） */
    async remember() {
      const upd = {}, at = Date.now();
      match.rows.filter(r => r.lines.length <= 2 && r.orig).forEach(r => {
        upd[memoDbKey(r.orig)] = r.key ? { key: r.key, vals: { ...r.vals }, at } : { free: true, at };
      });
      match.notes.forEach(i => { const k = memoDbKey(match.parts[i].spec); if (k) upd[k] = { note: true, at }; });
      if (Object.keys(upd).length) await update(ref(db, "zairyo/master/itemMemo"), upd);
    },
  };
}
