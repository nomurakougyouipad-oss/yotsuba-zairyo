// たのむ（現場）：品物の種類 → 品物 → 寸法をえらぶ → 数 → カート。試作の「たのむ」と同じ
// - 品物一覧はデータベース（/zairyo/master/catalog）。書き方のひな形（tpl）に、えらんだ値を入れて品名にする（buildSpec）
// - カートは、この端末にしまう（iPhone はほかのアプリから戻ると、開きなおすことがあるため）
// - 写真・リンク・ネットでさがすは 11章 6 で足す
import { esc, toast, openSheet, closeSheet } from "./common.js";

/* ---------- 品物一覧 ---------- */
const arr = v => (Array.isArray(v) ? v : Object.values(v || {})).filter(x => x != null);

/** データベースの品物一覧を使いやすい形にする → { units, cats, item: Map(キー → 品物) }（キーは "種類:品物" 例 "bolt:hex"） */
export function normCatalog(raw) {
  const units = arr(raw && raw.units);
  const cats = arr(raw && raw.cats).map(c => ({
    ...c,
    items: arr(c.items).map(it => ({ ...it, opts: arr(it.opts).map(o => [o[0], arr(o[1])]) })),
  }));
  const item = new Map();
  cats.forEach(c => c.items.forEach(it => item.set(`${c.id}:${it.id}`, { ...it, cat: c.id, catName: c.name, key: `${c.id}:${it.id}` })));
  return { units, cats, item };
}

/** えらんだ値から品名を作る（例 "SUS304 六角ボルト M12×50(B,N)"）。えらんでいない所は詰める */
export function buildSpec(it, vals) {
  if (it.free) return String(vals.__free || "").trim();
  let s = String(it.tpl || "").replace(/\{(.+?)\}/g, (_, k) => vals[k] || "");
  s = s.replace(/（\s*）|\(\s*\)/g, "");
  return s.split(/\s+/)
    .map(t => t.replace(/×{2,}/g, "×").replace(/^×+/, "").replace(/×+(?=[（(]|$)/, "").replace(/^-+|-+$/g, ""))
    .filter(Boolean).join(" ");
}

export const fmtQty = n => { const x = Number(n); return Number.isFinite(x) ? String(x) : String(n || ""); };
/** 1行の書き方（例 "SUS304 六角ボルト M12×50(B,N)　×10組"） */
export const lineText = l => l.spec + (l.note ? " " + l.note : "") + "　×" + fmtQty(l.qty) + l.unit;

/* ---------- 日付 ---------- */
const pad = n => String(n).padStart(2, "0");
/** この端末の日付で YYYY-MM-DD（days 日あと） */
export function ymd(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** ほしい日の書き方：最短 ／ 本日（10/12）／ 10/13（火） */
export function kibouText(k) {
  if (!k || k === "最短") return "最短";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  if (!m) return String(k);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const md = `${+m[2]}/${+m[3]}`;
  return k === ymd(0) ? `本日（${md}）` : `${md}（${"日月火水木金土"[d.getDay()]}）`;
}

/* ---------- カート（この端末にしまう） ---------- */
const CART_KEY = "yotsuba-zairyo-cart";
/** { lines: [{uid, key, cat, name, vals, spec, note, qty, unit}], job: {chuban, kenmei, typed} | null,
 *    form: {kibou, bashoId, contactOn, contacted, memo} } */
export const newForm = () => ({ kibou: "最短", bashoId: "", contactOn: false, contacted: "", memo: "" });
export function loadCart() {
  try {
    const v = JSON.parse(localStorage.getItem(CART_KEY) || "null");
    if (v && Array.isArray(v.lines)) return { lines: v.lines, job: v.job || null, form: { ...newForm(), ...(v.form || {}) } };
  } catch (err) { }
  return { lines: [], job: null, form: newForm() };
}
export function saveCart(cart) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (err) { }
}
const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- 品物の画面（下から出る） ---------- */
/** 品物をえらんだときの画面。src = なおすカートの行（uid あり）か、前と同じ内容（uid なし）。onSave(行) で返す */
export function openItem(catalog, key, src, onSave) {
  const it = catalog.item.get(key);
  if (!it) { toast("この品物は、もう一覧にありません"); return; }
  const vals = src ? { ...src.vals } : {};
  const qty0 = src ? src.qty : 1, unit0 = src ? src.unit : it.unit, note0 = src ? src.note || "" : "";
  const units = catalog.units.includes(unit0) ? catalog.units : [...catalog.units, unit0];

  const optHTML = it.opts.map(([k, choices]) => {
    const v = vals[k] || "", other = !!v && !choices.includes(v);
    return `
      <div class="opt" data-opt="${esc(k)}"><span class="lab">${esc(k)}</span>
        <div class="opt-chips">
          ${choices.map(c => `<button type="button" data-v="${esc(c)}" aria-pressed="${v === c}">${esc(c)}</button>`).join("")}
          <button type="button" class="oth" data-oth aria-pressed="${other}">ほか…</button>
        </div>
        <input class="inp" data-othin placeholder="${esc(k)}を書く" aria-label="${esc(k)}を書く" value="${other ? esc(v) : ""}"${other ? "" : " hidden"}>
      </div>`;
  }).join("");

  const html = `
    <div class="pw" id="itemWrap">
      <div class="panel-head"><div><span class="eyebrow">${esc(it.catName)}</span><h2 id="panelTitle">${esc(it.name)}</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      ${it.free ? `
        <div class="field"><label for="iFree">品名・寸法<span class="req">必ず</span></label>
          <textarea id="iFree" class="inp ta" rows="3" placeholder="例　キャスター 100mm 自在 ストッパー付き" data-autofocus>${esc(vals.__free || "")}</textarea></div>` : optHTML}
      <div class="field"><label for="iNote">${it.free ? "メモ（あれば）" : "寸法・メモ（あれば）"}</label>
        <input id="iNote" class="inp" value="${esc(note0)}" placeholder="${esc(it.notePh || (it.free ? "" : "例　切り寸 L=1700／ミルシート"))}"></div>
      <div class="qtyrow"><span class="lab">数</span>
        <div class="stepper"><button type="button" id="qMinus" aria-label="へらす">−</button><input id="iQty" inputmode="decimal" value="${esc(fmtQty(qty0))}" aria-label="数"><button type="button" id="qPlus" aria-label="ふやす">＋</button></div>
        <select id="iUnit" class="unit-sel" aria-label="単位">${units.map(u => `<option${u === unit0 ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>
      </div>
      <div class="sheet-foot">
        <div class="preview"><span class="lab">こう書いて送ります</span><p id="iPrev"></p></div>
        <p class="err" id="iErr" role="alert"></p>
        <button type="button" class="btn primary big full" id="addCart">${src && src.uid ? "なおす" : "カートに入れる"}</button>
      </div>
    </div>`;

  openSheet(html, p => {
    const w = p.querySelector("#itemWrap");
    const g = s => w.querySelector(s);
    const readQty = () => { const n = parseFloat(String(g("#iQty").value).normalize("NFKC")); return Number.isFinite(n) && n > 0 ? n : 0; };
    const preview = () => {
      const spec = buildSpec(it, vals), n = g("#iNote").value.trim(), q = readQty();
      g("#iPrev").textContent = spec || n
        ? `${(spec + (n ? " " + n : "")).trim()}　${q ? fmtQty(q) : "?"}${g("#iUnit").value}`
        : "（まだ何もえらんでいません）";
    };

    w.addEventListener("click", e => {
      const chip = e.target.closest("[data-v]"), oth = e.target.closest("[data-oth]");
      if (chip || oth) {
        const grp = e.target.closest("[data-opt]"), k = grp.dataset.opt, inp = grp.querySelector("[data-othin]");
        if (chip) {
          const v = chip.dataset.v;
          if (vals[k] === v) delete vals[k]; else vals[k] = v;   // もう一度押すと、えらぶのをやめる
          inp.hidden = true;
          inp.value = "";
        } else {
          const open = inp.hidden;
          inp.hidden = !open;
          if (open) {
            inp.focus({ preventScroll: true });
            inp.scrollIntoView({ block: "nearest" });
            if (inp.value.trim()) vals[k] = inp.value.trim(); else delete vals[k];
          } else {
            inp.value = "";
            delete vals[k];
          }
        }
        grp.querySelectorAll("[data-v]").forEach(b => b.setAttribute("aria-pressed", vals[k] === b.dataset.v));
        grp.querySelector("[data-oth]").setAttribute("aria-pressed", !inp.hidden);
        preview();
        return;
      }
      if (e.target.closest("#qMinus")) { g("#iQty").value = fmtQty(Math.max(1, (readQty() || 1) - 1)); preview(); return; }
      if (e.target.closest("#qPlus")) { g("#iQty").value = fmtQty((readQty() || 0) + 1); preview(); return; }
      if (e.target.closest("#addCart")) {
        if (it.free) vals.__free = g("#iFree").value;
        const spec = buildSpec(it, vals), n = g("#iNote").value.trim(), q = readQty(), err = g("#iErr");
        if (it.free && !spec) { err.textContent = "品名・寸法を書いてください"; g("#iFree").focus(); return; }
        if (!it.free && !Object.keys(vals).length && !n) { err.textContent = "材質や大きさを1つ以上えらぶか、寸法・メモを書いてください"; return; }
        if (!q) { err.textContent = "数を入れてください"; g("#iQty").focus(); return; }
        const line = { uid: (src && src.uid) || newUid(), key, cat: it.cat, name: it.name, vals: { ...vals }, spec, note: n, qty: q, unit: g("#iUnit").value };
        closeSheet();
        onSave(line, !!(src && src.uid));
      }
    });
    w.addEventListener("input", e => {
      const inp = e.target.closest("[data-othin]");
      if (inp) {
        const k = inp.closest("[data-opt]").dataset.opt, v = inp.value.trim();
        if (v) vals[k] = v; else delete vals[k];
      }
      if (e.target.id === "iFree") vals.__free = e.target.value;
      preview();
    });
    w.addEventListener("change", e => { if (e.target.id === "iUnit") preview(); });
    preview();
  });
}
