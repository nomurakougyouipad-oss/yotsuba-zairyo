// 事務所の「⚙ 設定」：材料屋／注番の会社／注文する人／届け先／品物一覧
// - 中身はぜんぶデータベース（/zairyo/master・/common）。ここで変えると、すぐにほかの端末にも出る
// - 名前などの欄は、入れ終わったとき（ほかを押す・Enter）にしまう
// - ほかの端末で変わったときは、入れている途中の欄をこわさないように、欄から出てから画面をかきなおす
import { ref, onValue, set, update, remove, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { $, esc, toast } from "./common.js";
import { errorText } from "./touroku.js";

const TABS = [["sup", "材料屋"], ["kaisha", "注番の会社"], ["staff", "注文する人"], ["place", "届け先"], ["catalog", "品物一覧"]];
const TAB_KEY = "yotsuba-zairyo-settab";
const PATH = {
  sup: "zairyo/master/suppliers",
  kaisha: "common/kaisha",
  kotei: "common/kotei",
  staff: "zairyo/master/staff",
  place: "zairyo/master/places",
  catalog: "zairyo/master/catalog",
  year: "common/chubanYear",      // 注番の年（2けた）。12/20〜25 ごろに事務所が切りかえる（日付からは決めない）
};
const S = {};                 // データベースの中身（読みこむまでは undefined）
let tab = "sup", body = null, waiting = false;
let kQ = "", ask = "";        // 注番の会社のさがす言葉／「本当に消しますか？」を出している行

const LOADING = '<p class="muted">読んでいます…</p>';
const BAD_KEY = /[.#$\[\]\/]/;
const z2h = s => String(s ?? "").normalize("NFKC");
const ja = (a, b) => String(a).localeCompare(String(b), "ja");
const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999) || ja(a.name, b.name);
const entries = v => (Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v || {})).filter(([, x]) => x);
const maxOrder = obj => Object.values(obj || {}).reduce((m, x) => Math.max(m, x.order ?? -1), -1);
const showErr = err => toast(errorText(err));
const yy = () => S.year || "??";   // 注番の年。まだ決めていないときは ??

export function renderSettings(el) {
  try { const t = localStorage.getItem(TAB_KEY); if (TABS.some(([k]) => k === t)) tab = t; } catch (err) { }
  el.innerHTML = `
    <div class="set-head"><h2>⚙ 設定</h2><span class="eyebrow">事務所だけが変えられます</span></div>
    <div class="seg" role="tablist" aria-label="設定の種類">
      ${TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}">${label}</button>`).join("")}
    </div>
    <div id="setBody" class="set-body"></div>`;
  body = $("#setBody", el);

  el.querySelector(".seg").addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    ask = "";
    try { localStorage.setItem(TAB_KEY, tab); } catch (err) { }
    el.querySelectorAll("[data-tab]").forEach(x => x.setAttribute("aria-selected", x === b));
    draw(true);
  });
  body.addEventListener("click", e => onClick(e).catch(showErr));
  body.addEventListener("change", e => onChange(e).catch(showErr));
  body.addEventListener("submit", e => { e.preventDefault(); onSubmit(e.target).catch(showErr); });
  body.addEventListener("input", onInput);
  body.addEventListener("focusout", () => { if (waiting) setTimeout(() => draw(), 0); });

  for (const [key, path] of Object.entries(PATH)) {
    onValue(ref(db, path), snap => { S[key] = key === "year" ? (snap.val() || "") : (snap.val() || {}); draw(); }, showErr);
  }
  draw(true);
}

/** 画面をかきなおす。入れている途中の欄（data-edit）があるときは、欄から出るまで待つ */
function draw(force = false) {
  if (!body) return;
  const a = document.activeElement;
  if (!force && a && body.contains(a) && a.dataset.edit) { waiting = true; return; }
  waiting = false;
  // 足す欄・さがす欄の書きかけの字、いま入れている所、開いている「くわしく」はのこす
  const keep = [...body.querySelectorAll("input[id]:not([data-edit])")].map(i => [i.id, i.value]);
  const open = [...body.querySelectorAll("details[id][open]")].map(d => d.id);
  const focusId = a && body.contains(a) ? a.id : "";
  body.innerHTML = VIEW[tab]();
  for (const [id, v] of keep) { const i = document.getElementById(id); if (i) i.value = v; }
  for (const id of open) { const d = document.getElementById(id); if (d) d.open = true; }
  if (focusId) { const f = document.getElementById(focusId); if (f) f.focus(); }
}

const VIEW = { sup: supHTML, kaisha: kaishaHTML, staff: staffHTML, place: placeHTML, catalog: catalogHTML };

/* ==================== 材料屋 ==================== */
function supHTML() {
  if (!S.sup) return LOADING;
  const list = Object.entries(S.sup).sort(byOrder);
  const shown = list.filter(([, s]) => !s.hidden), hid = list.filter(([, s]) => s.hidden);
  return `
    <p class="hint">宛名は、材料屋への注文の文のいちばん上に書く名前です。読みかえは、LINE の注文にこう書かれていたらこの材料屋にする、という言葉です。</p>
    <div class="sups">${shown.map(supCard).join("")}</div>
    <form class="add" data-form="sup">
      <input id="newSup" class="inp" maxlength="40" autocomplete="off" placeholder="足す材料屋の名前" aria-label="足す材料屋の名前">
      <button class="btn primary">足す</button>
    </form>
    ${hid.length ? `<details class="block hidbox" id="hidSup"><summary>かくしている材料屋（${hid.length}）</summary><div class="sups">${hid.map(supCard).join("")}</div></details>` : ""}`;
}

function supCard([id, s]) {
  const alias = entries(s.alias).map(([, a]) => a);
  return `
    <div class="block supcard${s.hidden ? " hid" : ""}">
      <div class="row-head"><b>${esc(s.name)}</b>
        <button type="button" class="linkbtn muted" data-suphide="${id}">${s.hidden ? "出す" : "かくす"}</button></div>
      <label class="mini">宛名
        <input class="inp" data-edit="to" data-id="${id}" value="${esc(s.to || "御中")}" maxlength="20"></label>
      <div class="mini">読みかえ
        <div class="chips">
          ${alias.map((a, i) => `<span class="chip">${esc(a)}<button type="button" data-aliasdel="${id}" data-i="${i}" aria-label="${esc(a)} を外す">×</button></span>`).join("")}
          <form class="chip-add" data-form="alias" data-id="${id}">
            <input id="al-${id}" class="inp" maxlength="40" autocomplete="off" placeholder="足す言葉" aria-label="${esc(s.name)} の読みかえを足す">
            <button class="btn">足す</button>
          </form>
        </div>
      </div>
      <button type="button" class="sw" data-swaz="${id}" aria-pressed="${!!s.azukari}"><span class="knob" aria-hidden="true"></span>預かりを使う</button>
    </div>`;
}

/* ==================== 注番の会社（固定の注番・会社の頭文字） ==================== */
function kaishaHTML() {
  return `
    <p class="hint">注番＝会社の頭文字2つ＋年2けた＋工事件数3けた（例 OH${yy()}031）。どの会社も件数「000」は応援作業です。</p>
    <input id="kQ" class="inp search" type="search" placeholder="頭文字・会社名でさがす" aria-label="頭文字・会社名でさがす" value="${esc(kQ)}">
    <div id="kList" class="set-body">${kListHTML()}</div>`;
}

function kListHTML() {
  if (!S.kaisha || !S.kotei || S.year === undefined) return LOADING;
  const y = yy();
  const q = z2h(kQ).trim().toLowerCase();
  const ko = Object.entries(S.kotei).map(([key, x]) => ({ ...x, kind: "f", key, label: key.slice(0, 2) + y + key.slice(2) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const ka = Object.entries(S.kaisha).map(([key, x]) => ({ ...x, kind: "k", key, label: key }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const hit = x => !q || [x.label, x.name, x.kana].some(v => String(v || "").toLowerCase().includes(q));
  const fk = ko.filter(hit), kk = ka.filter(hit);
  const hid = [...fk, ...kk].filter(x => x.hidden);
  return `
    <div class="block"><h3>注番の年</h3>
      <div class="row"><span class="kcode">${S.year ? esc(S.year) : "まだ決めていません"}</span>
        <span class="muted">${S.year ? `いまの注番は「OH${esc(S.year)}031」のように、${esc(S.year)} がつきます。` : "下で、いまの注番の年（2けた）を入れてください。"}</span></div>
      <form class="add yr" data-form="year">
        <input id="yNew" class="inp num" maxlength="2" inputmode="numeric" autocomplete="off" placeholder="例 ${S.year ? String((Number(S.year) + 1) % 100).padStart(2, "0") : "26"}" aria-label="注番の年（2けた）">
        <button class="btn">${S.year ? "切りかえる" : "決める"}</button>
      </form>
      <p class="hint">注番の年は、12/20〜25 ごろに切りかわります（1月1日ではありません）。日報で新しい年の注番を出しはじめたら、ここを切りかえてください。固定の注番の年も、いっしょに変わります。</p>
    </div>
    <div class="block"><h3>固定の注番（${ko.filter(x => !x.hidden).length}）</h3>
      <ul class="klist">${fk.filter(x => !x.hidden).map(kRow).join("")}</ul>
      <form class="kadd" data-form="kotei">
        <input id="fNewNo" class="inp num" maxlength="8" autocomplete="off" placeholder="例 MM${y}000" aria-label="固定の注番">
        <input id="fNewName" class="inp" maxlength="40" autocomplete="off" placeholder="名前（例 松前工場）" aria-label="名前">
        <button class="btn">足す</button>
      </form>
      <p class="hint">注番の年（いまは ${y}）は、上の「注番の年」からつきます。年が変わっても、固定の注番を直さなくてだいじょうぶです。</p>
    </div>
    <div class="block"><h3>会社（注番の頭の2文字）（${ka.filter(x => !x.hidden).length}）</h3>
      <ul class="klist">${kk.filter(x => !x.hidden).map(kRow).join("")}</ul>
      <form class="kadd k3" data-form="kaisha">
        <input id="kNewCode" class="inp num" maxlength="2" autocomplete="off" placeholder="例 AB" aria-label="頭の2文字">
        <input id="kNewName" class="inp" maxlength="40" autocomplete="off" placeholder="会社名（新しい取引先）" aria-label="会社名">
        <input id="kNewKana" class="inp" maxlength="40" autocomplete="off" placeholder="よみ（あれば）" aria-label="よみ">
        <button class="btn">足す</button>
      </form>
    </div>
    ${hid.length ? `<details class="block hidbox" id="hidK"><summary>かくしているもの（${hid.length}）</summary>
      <ul class="klist">${hid.map(kRow).join("")}</ul>
      <p class="hint">かくすと、えらぶ一覧には出なくなります。今までの注番の名前は、そのまま出ます。</p></details>` : ""}
    ${q && !fk.length && !kk.length ? `<p class="empty">「${esc(kQ)}」にあてはまるものはありません。</p>` : ""}
    <p class="hint">この表は台帳ぜんたいで使います（あとで、ほかのアプリも同じ表を読みます）。頭文字を変えたいときは、消して足しなおします。</p>`;
}

function kRow(x) {
  const k = `${x.kind}:${x.key}`;
  return `
    <li class="krow${x.hidden ? " hid" : ""}">
      <span class="kcode">${esc(x.label)}</span>
      <span class="kname-wrap">
        <input class="inp kname" data-edit="kname" data-k="${k}" value="${esc(x.name)}" maxlength="40" aria-label="${esc(x.label)} の名前">
        ${x.kind === "k" ? `<input class="inp kkana" data-edit="kkana" data-k="${k}" value="${esc(x.kana || "")}" maxlength="40" placeholder="よみ（あれば）" aria-label="${esc(x.label)} のよみ">` : ""}
      </span>
      <span class="kact">
        <button type="button" class="linkbtn" data-khide="${k}">${x.hidden ? "出す" : "かくす"}</button>
        <button type="button" class="linkbtn muted" data-kdel="${k}">消す</button>
      </span>
      ${ask === k ? `<div class="kask">本当に消しますか？ 消すと、この注番に名前が出なくなります。使わなくなっただけなら「かくす」がおすすめです。
        <span class="row"><button type="button" class="btn danger" data-kdelyes="${k}">消す</button><button type="button" class="btn" data-askno>やめる</button></span></div>` : ""}
    </li>`;
}

/** "k:OH" → common/kaisha/OH、"f:MM000" → common/kotei/MM000 */
function kPath(k) {
  const [kind, key] = k.split(":");
  return { path: `${kind === "k" ? PATH.kaisha : PATH.kotei}/${key}`, x: (kind === "k" ? S.kaisha : S.kotei)[key], key, kind };
}

/* ==================== 注文する人 ==================== */
function staffHTML() {
  if (!S.staff) return LOADING;
  const names = Object.keys(S.staff).sort(ja);
  return `
    <p class="hint">現場のスマホで登録するときに、この中から自分の名前をえらびます。</p>
    <ul class="staff">${names.length ? names.map(n => `
      <li><span class="nm">${esc(n)}</span>${ask === "staff:" + n
        ? `<span class="row"><button type="button" class="btn danger" data-staffdelyes="${esc(n)}">消す</button><button type="button" class="btn" data-askno>やめる</button></span>`
        : `<button type="button" class="btn danger" data-staffdel="${esc(n)}">消す</button>`}</li>`).join("")
      : '<li class="muted">まだだれもいません。下で名前を足してください。</li>'}</ul>
    <form class="add" data-form="staff">
      <input id="newStaff" class="inp" maxlength="20" autocomplete="off" placeholder="足す名前" aria-label="足す名前">
      <button class="btn primary">足す</button>
    </form>
    <p class="hint">消しても、その名前でもう登録したスマホは、そのまま使えます。</p>`;
}

/* ==================== 届け先 ==================== */
function placeHTML() {
  if (!S.place) return LOADING;
  const row = ([id, p]) => `
    <li class="prow${p.hidden ? " hid" : ""}">
      <input class="inp" data-edit="pname" data-id="${id}" value="${esc(p.name)}" maxlength="20" aria-label="届け先の名前">
      <input class="inp" data-edit="ptext" data-id="${id}" value="${esc(p.text || "")}" maxlength="200" placeholder="（書かない）" aria-label="${esc(p.name)} のとき、注文の文に書く言葉">
      <button type="button" class="linkbtn" data-placehide="${id}">${p.hidden ? "出す" : "かくす"}</button>
    </li>`;
  return `
    <p class="hint">現場が「どこに届けるか」でえらぶ場所です。右の欄は、材料屋への注文の文にそのまま入る言葉です（空なら書きません）。</p>
    <ul class="plist">${Object.entries(S.place).sort(byOrder).map(row).join("")}</ul>
    <form class="kadd p2" data-form="place">
      <input id="pNewName" class="inp" maxlength="20" autocomplete="off" placeholder="名前（例 ○○工場）" aria-label="足す届け先の名前">
      <input id="pNewText" class="inp" maxlength="200" autocomplete="off" placeholder="注文の文に書く言葉（あれば）" aria-label="注文の文に書く言葉">
      <button class="btn">足す</button>
    </form>`;
}

/* ==================== 品物一覧（いまは「いつもの材料屋」だけ変えられる） ==================== */
function catalogHTML() {
  if (!S.catalog || !S.sup) return LOADING;
  const cats = entries(S.catalog.cats);
  if (!cats.length) return '<p class="muted">品物一覧が、まだ入っていません。</p>';
  const sups = Object.entries(S.sup).sort(byOrder);
  const supName = id => (S.sup[id] && S.sup[id].name) || "決めない";
  const options = (cur, blank) => `<option value=""${cur ? "" : " selected"}>${blank}</option>` +
    sups.filter(([id, s]) => !s.hidden || id === cur).map(([id, s]) => `<option value="${id}"${id === cur ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  return `
    <p class="hint">品物一覧は、試作から入れました（グループLINEの注文 6/25〜10/5 をもとに作ったもの）。いまは「いつもの材料屋」だけ、ここで変えられます。事務所が注文するとき、この材料屋が最初から入ります。</p>
    ${cats.map(([ci, c]) => `
      <details class="block cat" id="cat-${ci}">
        <summary><b>${esc(c.name)}</b><span class="muted">品物 ${entries(c.items).length}・いつも：${esc(supName(c.sup))}</span></summary>
        <label class="mini">この種類のいつもの材料屋
          <select class="inp" data-edit="catsup" data-ci="${ci}">${options(c.sup, "決めない")}</select></label>
        <ul class="ilist">${entries(c.items).map(([ii, it]) => `
          <li><span class="iname"><b>${esc(it.name)}</b>${it.sub ? ` <span class="muted">${esc(it.sub)}</span>` : ""} <span class="muted">（${esc(it.unit || "")}）</span></span>
            <select class="inp" data-edit="itemsup" data-ci="${ci}" data-ii="${ii}" aria-label="${esc(it.name)} のいつもの材料屋">${options(it.sup, "種類と同じ")}</select></li>`).join("")}
        </ul>
      </details>`).join("")}`;
}

/* ==================== 押したとき ==================== */
async function onClick(e) {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;

  if (d.swaz) {
    const s = S.sup[d.swaz];
    await update(ref(db, `${PATH.sup}/${d.swaz}`), { azukari: !s.azukari });
    toast(`${s.name} の預かりを${s.azukari ? "使わないように" : "使うように"}しました`);
  } else if (d.suphide) {
    const s = S.sup[d.suphide];
    await update(ref(db, `${PATH.sup}/${d.suphide}`), { hidden: !s.hidden });
    toast(`${s.name} を${s.hidden ? "出しました" : "かくしました"}`);
  } else if (d.aliasdel) {
    const s = S.sup[d.aliasdel];
    const list = entries(s.alias).map(([, a]) => a);
    const gone = list.splice(Number(d.i), 1)[0];
    await set(ref(db, `${PATH.sup}/${d.aliasdel}/alias`), list.length ? list : null);
    toast(`${s.name} の読みかえから「${gone}」を外しました`);
  } else if (d.khide) {
    const k = kPath(d.khide);
    await update(ref(db, k.path), { hidden: !k.x.hidden });
    toast(`${k.key}（${k.x.name}）を${k.x.hidden ? "出しました" : "かくしました"}`);
  } else if (d.kdel || d.staffdel) {
    ask = d.kdel || "staff:" + d.staffdel;
    draw(true);
  } else if ("askno" in d) {
    ask = "";
    draw(true);
  } else if (d.kdelyes) {
    const k = kPath(d.kdelyes);
    ask = "";
    await remove(ref(db, k.path));
    toast(`${k.key}（${k.x.name}）を消しました`);
  } else if (d.staffdelyes) {
    ask = "";
    await remove(ref(db, `${PATH.staff}/${d.staffdelyes}`));
    toast(`${d.staffdelyes} を消しました`);
  } else if (d.placehide) {
    const p = S.place[d.placehide];
    await update(ref(db, `${PATH.place}/${d.placehide}`), { hidden: !p.hidden });
    toast(`${p.name} を${p.hidden ? "出しました" : "かくしました"}`);
  }
}

/* ==================== 欄を入れ終わったとき ==================== */
async function onChange(e) {
  const t = e.target, d = t.dataset;
  if (!d.edit) return;
  const v = t.value.trim();

  if (d.edit === "to") {
    const s = S.sup[d.id];
    await update(ref(db, `${PATH.sup}/${d.id}`), { to: v || "御中" });
    toast(`${s.name} の宛名を「${v || "御中"}」にしました`);
  } else if (d.edit === "kname" || d.edit === "kkana") {
    const k = kPath(d.k);
    if (d.edit === "kname" && !v) { t.value = k.x.name; toast("名前は空にできません"); return; }
    await update(ref(db, k.path), d.edit === "kname" ? { name: v } : { kana: v });
    toast(d.edit === "kname" ? `${k.key} の名前を「${v}」にしました` : `${k.key} のよみを直しました`);
  } else if (d.edit === "pname" || d.edit === "ptext") {
    const p = S.place[d.id];
    if (d.edit === "pname" && !v) { t.value = p.name; toast("名前は空にできません"); return; }
    await update(ref(db, `${PATH.place}/${d.id}`), d.edit === "pname" ? { name: v } : { text: v });
    toast(d.edit === "pname" ? `届け先の名前を「${v}」にしました` : `${p.name} の注文の文を直しました`);
  } else if (d.edit === "catsup" || d.edit === "itemsup") {
    const path = d.edit === "catsup"
      ? `${PATH.catalog}/cats/${d.ci}/sup`
      : `${PATH.catalog}/cats/${d.ci}/items/${d.ii}/sup`;
    await set(ref(db, path), v || null);
    toast(`いつもの材料屋を「${v ? S.sup[v].name : (d.edit === "catsup" ? "決めない" : "種類と同じ")}」にしました`);
  }
  if (t === document.activeElement) t.blur();   // Enter で決めたときも、画面をかきなおせるように
}

/* ==================== 足すとき ==================== */
async function onSubmit(form) {
  const kind = form.dataset.form;
  const val = id => $(`#${id}`, form).value.trim();
  const clear = (...ids) => ids.forEach(id => { $(`#${id}`, form).value = ""; });

  if (kind === "sup") {
    const name = val("newSup").replace(/\s*(御中|様)\s*$/, "");
    if (!name) return toast("材料屋の名前を入れてください");
    if (Object.values(S.sup).some(s => s.name === name)) return toast(`${name} はもうあります`);
    clear("newSup");
    await push(ref(db, PATH.sup), { name, to: "御中", app: false, azukari: false, alias: [name], order: maxOrder(S.sup) + 1 });
    toast(`${name} を足しました`);
  } else if (kind === "alias") {
    const id = form.dataset.id, s = S.sup[id];
    const word = val(`al-${id}`);
    if (!word) return toast("足す言葉を入れてください");
    const list = entries(s.alias).map(([, a]) => a);
    if (list.includes(word)) return toast(`「${word}」はもう入っています`);
    const other = Object.values(S.sup).find(x => x !== s && entries(x.alias).some(([, a]) => a === word));
    if (other) return toast(`「${word}」は ${other.name} の読みかえに入っています`);
    clear(`al-${id}`);
    await set(ref(db, `${PATH.sup}/${id}/alias`), [...list, word]);
    toast(`${s.name} の読みかえに「${word}」を足しました`);
  } else if (kind === "kaisha") {
    const code = z2h(val("kNewCode")).toUpperCase().replace(/[^A-Z]/g, "");
    const name = val("kNewName"), kana = val("kNewKana");
    if (code.length !== 2) return toast("頭文字は、アルファベット2文字にしてください");
    if (!name) return toast("会社名を入れてください");
    const dup = S.kaisha[code];
    if (dup) return toast(`${code} はもうあります（${dup.name}${dup.hidden ? "・かくしている" : ""}）`);
    clear("kNewCode", "kNewName", "kNewKana");
    await set(ref(db, `${PATH.kaisha}/${code}`), { name, kana, hidden: false });
    const same = Object.entries(S.kotei).find(([key]) => key.slice(0, 2) === code);
    toast(`${code}（${name}）を足しました` + (same ? `。固定の注番 ${same[0].slice(0, 2)}${yy()}${same[0].slice(2)}（${same[1].name}）と同じ頭文字です` : ""));
  } else if (kind === "kotei") {
    const no = z2h(val("fNewNo")).toUpperCase().replace(/\s/g, "");
    const name = val("fNewName");
    if (!/^[A-Z]{2}(\d{2})?\d{3}$/.test(no)) return toast(`注番は、英字2文字＋数字にしてください（例 MM${yy()}000）`);
    if (!name) return toast("名前を入れてください");
    const key = no.slice(0, 2) + no.slice(-3);
    const dup = S.kotei[key];
    if (dup) return toast(`${no} はもうあります（${dup.name}）`);
    clear("fNewNo", "fNewName");
    await set(ref(db, `${PATH.kotei}/${key}`), { name, hidden: false });
    toast(`${key.slice(0, 2)}${yy()}${key.slice(2)}（${name}）を足しました`);
  } else if (kind === "year") {
    const y = z2h(val("yNew")).replace(/\D/g, "");
    if (!/^\d{2}$/.test(y)) return toast("注番の年は、数字2けたで入れてください（例 27）");
    if (y === S.year) return toast(`注番の年は、もう ${y} です`);
    clear("yNew");
    await set(ref(db, PATH.year), y);
    toast(`注番の年を ${y} にしました`);
  } else if (kind === "staff") {
    const name = val("newStaff");
    if (!name) return toast("名前を入れてください");
    if ([...name].length > 20) return toast("名前は20文字までにしてください");
    if (BAD_KEY.test(name)) return toast("名前に . # $ [ ] / は使えません");
    if (S.staff[name]) return toast("もう入っています");
    clear("newStaff");
    await set(ref(db, `${PATH.staff}/${name}`), { addedAt: serverTimestamp() });
    toast(`${name} を足しました`);
  } else if (kind === "place") {
    const name = val("pNewName"), text = val("pNewText");
    if (!name) return toast("届け先の名前を入れてください");
    if (Object.values(S.place).some(p => p.name === name)) return toast(`${name} はもうあります`);
    clear("pNewName", "pNewText");
    await push(ref(db, PATH.place), { name, text, order: maxOrder(S.place) + 1 });
    toast(`${name} を足しました`);
  }
}

/* さがす欄は、打つたびに一覧だけかきなおす（欄から出ないように） */
function onInput(e) {
  if (e.target.id !== "kQ") return;
  kQ = e.target.value;
  ask = "";
  const list = $("#kList", body);
  if (list) list.innerHTML = kListHTML();
}
