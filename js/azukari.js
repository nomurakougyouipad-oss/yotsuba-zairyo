// 預かり（⚙ 設定で「預かりを使う」の材料屋。いまは小野建さんだけ）── シンプル版（11/2 持ち主。10/19 に決めた形）
// - /zairyo/azukari/{材料屋}/items/{番号} = { spec, key?, vals?, unit, qty（残り）, at, by }
//   /zairyo/azukari/{材料屋}/log/{番号}   = { at, by, role（office＝事務所｜server＝サーバーの係）, kind（add 預かった｜fix 数を直した｜use 使った）,
//                                            iid, spec, unit, from, to, reason?, orderId?, chuban?, kenmei? }（記録は消さない・書きかえない）
// - 台帳（足す・数を直す）は事務所だけ。材料屋のアプリは見るだけ（数がちがうときは電話 → 事務所が直す）
// - 品名は品物一覧から現場と同じ画面でえらぶ。ないときだけ手で書く（注文の「預かりにあり」が当たりやすいように）。同じ品名・単位がもうあれば、その数に足す
// - 数を直すときは理由（書かなくてもよい）。記録には だれが・いつ・何本→何本
// - 使った分は、注文が「届いた」になったときにサーバーの係（functions/azukari.js）がへらして記録する
// - 前の作りかけ（枝 zairyoya-2-7。材料屋も足す・直す・届けるときにえらぶ）から、事務所の台帳だけを使った
import { ref, push, update, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { esc, toast, openSheet } from "./common.js";
import { openItem, fmtQty } from "./tanomu.js";

const pad = n => String(n).padStart(2, "0");
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const num = v => { const n = parseFloat(String(v ?? "").normalize("NFKC").replace(/[,，\s]/g, "")); return Number.isFinite(n) ? n : null; };
const KIND = { add: "預かった", fix: "数を直した", use: "使った" };

export const azPath = sup => `zairyo/azukari/${sup}`;
/** 預かりの品物（品名の順）[[番号, 品物]] */
export const azItems = az => Object.entries((az && az.items) || {}).filter(([, x]) => x && x.spec).sort(([, a], [, b]) => a.spec.localeCompare(b.spec, "ja"));
/** 注文の品物の名前（品名＋メモ）。預かりの品名とくらべるとき */
export const lineSpec = l => (l.spec + (l.note ? " " + l.note : "")).trim();

/* サーバーとつながっているか（10/17：Edge で足した預かりがサーバーに届かず、画面にだけ出ていた。
   つながっていない間に押すと、Firebase は先にこの端末の画面にだけ出すため）。つながっていないときは書かずに知らせる */
let online = true;
onValue(ref(db, ".info/connected"), s => { online = s.val() === true; });
const OFFLINE = "サーバーとつながっていません。電波やネットをたしかめて、もう一度押してください";
const SLOW_MS = 8000;   // これだけ待っても届かなければ「まだ届いていません」

/** 台帳を開く。opts = { sup, supName, role: "office"|"sup", by（事務所のパソコンの名前）, catalog?（事務所の品物一覧） }
 *  role "sup"（材料屋のアプリ）は見るだけ。ui は、品物一覧の画面からもどってきたときの続き */
export function openAzukari(opts, ui = {}) {
  const st = { az: null, ui: { edit: "", adding: false, cat: "", line: null, manual: false, ...ui } };
  const office = opts.role === "office";
  let off = () => { };
  openSheet('<div class="pw" id="azWrap"><p class="muted">読んでいます…</p></div>', p => {
    const w = p.querySelector("#azWrap");
    const draw = (force = false) => {
      // 数を入れている途中・足す品物を書いている途中は、データが変わってもかきなおさない（入れた字が消えないように）
      const typing = w.querySelector("#azVal, #azQty, #azSpec");
      if (!force && typing && w.dataset.dirty) return;
      delete w.dataset.dirty;
      w.innerHTML = ledgerHTML(opts, st);
    };
    off = onValue(ref(db, azPath(opts.sup)), s => { st.az = s.val() || {}; draw(); },
      ex => { w.innerHTML = `<p class="err">預かりを読めませんでした（${esc(ex.message || ex)}）</p>`; });
    if (!office) return;
    w.addEventListener("input", e => {
      if (e.target.closest("#azVal, #azQty, #azSpec, #azWhy")) w.dataset.dirty = "1";
      if (e.target.id === "azVal") preview(w);
    });
    w.addEventListener("click", e => onClick(e, w, opts, st, draw).catch(ex => {
      const er = w.querySelector(".az-err");
      if (er) er.textContent = `うまくいきませんでした（${ex.message || ex}）`; else toast(`うまくいきませんでした（${ex.message || ex}）`);
    }));
  }, { side: office, onClose: () => off() });
}

/* ---------- 画面 ---------- */
const whoText = x => (x.role === "server" ? "自動（届いた）" : `事務所（${x.by || ""}）`);
function amountText(x) {
  const u = esc(x.unit || "");
  if (x.kind === "fix") return `${fmtQty(x.from)}→${fmtQty(x.to)}${u}`;
  const d = Number(x.to) - Number(x.from);
  return `${d >= 0 ? "＋" : "−"}${fmtQty(Math.abs(d))}${u}`;
}
function logLi(x) {
  return `<li><span class="d">${md(x.at)}</span>
    <span>${KIND[x.kind] || ""}：${esc(x.spec)}${x.chuban ? `（${esc(x.chuban)} ${esc(x.kenmei || "")}）` : ""}${x.reason ? `<br><span class="why">理由：${esc(x.reason)}</span>` : ""}
      <br><span class="who">${esc(whoText(x))}・${hm(x.at)}</span></span>
    <span class="n">${amountText(x)}</span></li>`;
}

function ledgerHTML(opts, st) {
  const { az, ui } = st, office = opts.role === "office", items = azItems(az);
  const logs = Object.values((az && az.log) || {}).filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 60);
  return `
    <div class="panel-head"><div><span class="eyebrow">${office ? esc(opts.supName) : "よつば建設工業さまの材料"}</span>
      <h2 id="panelTitle" class="mt6">${office ? "預かり" : "預かっている材料"}</h2></div>
      <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
    <div class="az-cols">
      <div class="stack">
        ${items.length ? `<ul class="azl">${items.map(([iid, x]) => `
          <li><div class="az-top"><span class="az-name">${esc(x.spec)}</span><span class="az-num">${esc(fmtQty(x.qty))}<small>${esc(x.unit)}</small></span></div>
            ${!office ? "" : ui.edit === iid ? editHTML(x) : `<div class="row"><button type="button" class="btn" data-az="edit" data-iid="${esc(iid)}">数を直す</button></div>`}</li>`).join("")}</ul>`
          : `<p class="empty">${office ? "まだ預かりの品物はありません。「＋ 預かりに足す」で入れてください。" : "いま、預かっている材料はありません。"}</p>`}
        ${office ? addHTML(opts, st) : '<p class="hint">数がちがうときは、よつば建設工業に電話してください（事務所が直します）。</p>'}
        ${office ? `<p class="hint">足す・数を直すのは事務所だけです。${esc(opts.supName)}さんのアプリでは見るだけです。「預かりから」で注文した分は、届いたときに自動でへります。</p>` : ""}
      </div>
      <div class="block"><h3>出し入れの記録</h3>
        ${logs.length ? `<ul class="alog">${logs.map(logLi).join("")}</ul>` : '<p class="hint">まだありません。</p>'}</div>
    </div>`;
}
function editHTML(x) {
  return `
    <div class="az-edit"><button type="button" class="btn step" data-az="minus" aria-label="へらす">−</button>
      <input id="azVal" class="inp" inputmode="decimal" value="${esc(fmtQty(x.qty))}" aria-label="残りの数" data-from="${esc(String(x.qty))}" data-unit="${esc(x.unit)}">
      <button type="button" class="btn step" data-az="plus" aria-label="ふやす">＋</button><span>${esc(x.unit)}</span></div>
    <div class="field"><label for="azWhy">理由（書かなくてもよい）</label><input id="azWhy" class="inp" maxlength="100" autocomplete="off" placeholder="例 数を合わせた・こわれていた"></div>
    <p class="hint" id="azPrev">${esc(fmtQty(x.qty))}${esc(x.unit)} のままです。</p>
    <p class="err az-err" role="alert"></p>
    <div class="row"><button type="button" class="btn primary" data-az="fixyes">この数にする</button><button type="button" class="btn" data-az="cancel">やめる</button></div>`;
}
function preview(w) {
  const inp = w.querySelector("#azVal"), pv = w.querySelector("#azPrev");
  if (!inp || !pv) return;
  const to = num(inp.value), from = Number(inp.dataset.from), u = inp.dataset.unit;
  pv.textContent = to == null || to < 0 ? "数を入れてください" : to === from ? `${fmtQty(from)}${u} のままです。` : `${fmtQty(from)}${u} → ${fmtQty(to)}${u} にします。記録に残ります。`;
}
function addHTML(opts, st) {
  const ui = st.ui, c = opts.catalog;
  if (!ui.adding) return '<div class="row"><button type="button" class="btn primary" data-az="add">＋ 預かりに足す</button></div>';
  if (!ui.line && !ui.manual) {   // 品物一覧からえらぶ
    const cats = c ? c.cats.filter(x => x.items.length) : [];
    const cat = cats.find(x => x.id === ui.cat) || cats[0];
    return `<div class="block az-add"><h3>預かりに足す：品物をえらぶ</h3>
      ${!c ? '<p class="muted">品物の一覧を読んでいます…（読めないときは、下の「一覧にない品物」から手で書いてください）</p>'
        : `<div class="pick az-cats">${cats.map(x => `<button type="button" data-az="cat" data-cat="${esc(x.id)}" aria-pressed="${cat && x.id === cat.id}">${esc(x.name)}</button>`).join("")}</div>
          <div class="az-items">${cat ? cat.items.filter(it => !it.hidden).map(it => `<button type="button" class="btn" data-az="item" data-key="${esc(`${cat.id}:${it.id}`)}">${esc(it.name)}</button>`).join("") : ""}</div>`}
      <div class="row"><button type="button" class="linkbtn" data-az="manual">一覧にない品物（手で書く）</button><button type="button" class="btn" data-az="cancel">やめる</button></div></div>`;
  }
  const units = (c && c.units.length ? c.units : ["本", "枚", "個", "組", "kg", "m"]);
  const unit0 = (ui.line && ui.line.unit) || units[0];
  const allUnits = units.includes(unit0) ? units : [...units, unit0];
  return `<div class="block az-add"><h3>預かりに足す</h3>
    ${ui.line ? `<p><b>${esc(lineSpec(ui.line))}</b>　<button type="button" class="linkbtn" data-az="rechoose">えらびなおす</button></p>`
      : `<div class="field"><label for="azSpec">品名・寸法<span class="req">必ず</span></label><textarea id="azSpec" class="inp ta" rows="2" maxlength="300" placeholder="例 SS400 FB-6×50 L=5500"></textarea>
         <span class="hint">品物一覧にあるものは、一覧からえらんでください（注文のときに「預かりにあり」が出やすくなります）。</span></div>`}
    <div class="qtyrow"><span class="lab">足す数</span>
      <input id="azQty" class="inp az-qty" inputmode="decimal" value="${esc(ui.line ? fmtQty(ui.line.qty) : "")}" aria-label="足す数">
      <select id="azUnit" class="unit-sel" aria-label="単位">${allUnits.map(u => `<option${u === unit0 ? " selected" : ""}>${esc(u)}</option>`).join("")}</select></div>
    <div class="field"><label for="azWhy">理由・メモ（書かなくてもよい）</label><input id="azWhy" class="inp" maxlength="100" autocomplete="off" placeholder="例 前の工事の残りを預けた"></div>
    <p class="hint">同じ品名・単位の品物がもうあるときは、その数に足します。</p>
    <p class="err az-err" role="alert"></p>
    <div class="row"><button type="button" class="btn primary" data-az="addyes">預かりに足す</button><button type="button" class="btn" data-az="cancel">やめる</button></div></div>`;
}

/* ---------- 押したとき（事務所だけ） ---------- */
async function onClick(e, w, opts, st, draw) {
  const t = e.target.closest("[data-az]");
  if (!t || t.disabled) return;
  const a = t.dataset.az, ui = st.ui;
  const base = azPath(opts.sup);
  const busy = async (label, upd, msg) => {
    if (!online) throw new Error(OFFLINE);
    const old = t.textContent;
    t.disabled = true; t.textContent = label;
    // 届くまで待つ。おそいときは「まだ届いていません」と出す（届いたら「…しました」と出て、かきなおす）
    const slow = setTimeout(() => {
      const er = w.querySelector(".az-err");
      const say = "まだサーバーに届いていません。この画面を開いたまま少し待ってください（届くと「しました」と出ます）";
      if (er) er.textContent = say; else toast(say);
    }, SLOW_MS);
    try { await update(ref(db, base), upd); } catch (ex) { t.disabled = false; t.textContent = old; throw ex; } finally { clearTimeout(slow); }
    toast(msg);
    draw(true);
  };
  const by = String(opts.by || "").slice(0, 60) || "事務所";
  const logEntry = (x, iid, from, to, kind, reason) => ({
    at: serverTimestamp(), by, role: "office", kind, iid, spec: x.spec, unit: x.unit, from, to,
    ...(reason ? { reason: reason.slice(0, 100) } : {}),
  });
  if (a === "edit") { ui.edit = t.dataset.iid; ui.adding = false; draw(true); w.querySelector("#azVal").focus(); return; }
  if (a === "cancel") { Object.assign(ui, { edit: "", adding: false, line: null, manual: false }); draw(true); return; }
  if (a === "minus" || a === "plus") {
    const inp = w.querySelector("#azVal"), n = num(inp.value) ?? Number(inp.dataset.from);
    inp.value = fmtQty(Math.max(0, n + (a === "plus" ? 1 : -1)));
    w.dataset.dirty = "1";
    preview(w);
    return;
  }
  if (a === "fixyes") {
    const iid = ui.edit, x = (st.az.items || {})[iid], err = w.querySelector(".az-err");
    if (!x) return;
    const to = num(w.querySelector("#azVal").value);
    if (to == null || to < 0 || to >= 100000) { err.textContent = "数を入れてください（0 より小さい数はだめです）"; return; }
    if (to === Number(x.qty)) { err.textContent = "数が同じです（直すときは数を変えてください）"; return; }
    const reason = w.querySelector("#azWhy").value.trim(), lid = push(ref(db, `${base}/log`)).key;
    ui.edit = "";
    return busy("しまっています…", {
      [`items/${iid}/qty`]: to, [`items/${iid}/at`]: serverTimestamp(), [`items/${iid}/by`]: by,
      [`log/${lid}`]: logEntry(x, iid, Number(x.qty), to, "fix", reason),
    }, `${x.spec}：${fmtQty(x.qty)}${x.unit} → ${fmtQty(to)}${x.unit} にしました`).catch(ex => { ui.edit = iid; throw ex; });
  }
  if (a === "add") { Object.assign(ui, { adding: true, edit: "", line: null, manual: false }); draw(true); return; }
  if (a === "cat") { ui.cat = t.dataset.cat; draw(true); return; }
  if (a === "manual") { ui.manual = true; draw(true); w.querySelector("#azSpec").focus(); return; }
  if (a === "rechoose") { ui.line = null; ui.manual = false; draw(true); return; }
  if (a === "item") {   // 現場と同じ「品物をえらぶ」画面。えらんだら、この台帳にもどる
    const back = line => openAzukari(opts, { ...ui, adding: true, line: line || null });
    openItem(opts.catalog, t.dataset.key, null, line => back(line), null, { label: "これにする", noDraft: true, noWeb: true, onCancel: () => back(ui.line) });
    return;
  }
  if (a === "addyes") {
    const err = w.querySelector(".az-err");
    const spec = ui.line ? lineSpec(ui.line) : (w.querySelector("#azSpec").value || "").replace(/\s*\n\s*/g, " ").trim();
    const qty = num(w.querySelector("#azQty").value), unit = w.querySelector("#azUnit").value;
    if (!spec) { err.textContent = "品名・寸法を書いてください"; return; }
    if (!(qty > 0 && qty < 100000)) { err.textContent = "足す数を入れてください"; w.querySelector("#azQty").focus(); return; }
    const reason = w.querySelector("#azWhy").value.trim(), lid = push(ref(db, `${base}/log`)).key;
    const same = azItems(st.az).find(([, x]) => x.spec === spec && x.unit === unit);   // 同じ品物があれば、その数に足す
    let upd;
    if (same) {
      const [iid, x] = same, to = Number(x.qty) + qty;
      upd = { [`items/${iid}/qty`]: to, [`items/${iid}/at`]: serverTimestamp(), [`items/${iid}/by`]: by, [`log/${lid}`]: logEntry(x, iid, Number(x.qty), to, "add", reason) };
    } else {
      const iid = push(ref(db, `${base}/items`)).key;
      const x = { spec, unit, qty, at: serverTimestamp(), by, ...(ui.line && ui.line.key ? { key: ui.line.key } : {}), ...(ui.line && ui.line.vals && Object.keys(ui.line.vals).length ? { vals: ui.line.vals } : {}) };
      upd = { [`items/${iid}`]: x, [`log/${lid}`]: logEntry(x, iid, 0, qty, "add", reason) };
    }
    const was = { ...ui };
    Object.assign(ui, { adding: false, line: null, manual: false });
    return busy("しまっています…", upd, `預かりに足しました（${spec} ＋${fmtQty(qty)}${unit}）`).catch(ex => { Object.assign(ui, was); throw ex; });
  }
}
