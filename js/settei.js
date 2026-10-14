// 事務所の「⚙ 設定」：材料屋／注番の会社／注文する人／届け先／品物一覧／登録した端末／覚えた当て方／バックアップ／AI
// - 中身はぜんぶデータベース（/zairyo/master・/common）。ここで変えると、すぐにほかの端末にも出る
// - 名前などの欄は、入れ終わったとき（ほかを押す・Enter）にしまう
// - ほかの端末で変わったときは、入れている途中の欄をこわさないように、欄から出てから画面をかきなおす
import { ref, onValue, set, update, remove, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth, call } from "./firebase.js";
import { $, esc, toast } from "./common.js";
import { errorText } from "./touroku.js";
import { watchJobs, watchWorkers } from "./nippo.js";
import { BACKUP_PATHS, countText, readAll, saveBackup, lastBackup } from "./backup.js";
import { pushState, enablePush, disablePush, testPush } from "./tsuuchi.js";
import { printFax } from "./fax.js";
import { SHOPS } from "./shashin.js";
import { normCatalog, buildSpec } from "./tanomu.js";

const TABS = [["sup", "材料屋"], ["kaisha", "注番の会社"], ["staff", "注文する人"], ["place", "届け先"], ["catalog", "品物一覧"], ["dev", "登録した端末"], ["memo", "覚えた当て方"], ["notify", "通知"], ["company", "会社・注文書"], ["backup", "バックアップ"], ["ai", "AI"]];
const TAB_KEY = "yotsuba-zairyo-settab";
const PATH = {
  sup: "zairyo/master/suppliers",
  kaisha: "common/kaisha",
  kotei: "common/kotei",
  staff: "zairyo/master/staff",
  place: "zairyo/master/places",
  catalog: "zairyo/master/catalog",
  dev: "zairyo/devices",          // 登録した端末（事務所だけ読める。消す・合言葉を変えるのはサーバーのプログラム）
  blog: "zairyo/backupLog",       // 自動の保存の結果（サーバーのプログラム zairyoBackup が書く）
  memo: "zairyo/master/itemMemo",  // LINE の品名の、覚えた当て方（7-4）
  notify: "zairyo/notify/tokens",  // 通知がオンのパソコン（10/14。js/tsuuchi.js）
  reqs: "zairyo/requests",        // 依頼（品物一覧の「手で書いた品物」を数えるため。10/14）
  info: "zairyo/officeInfo",      // 会社の名前・住所など・決まり文句・注文する人の電話番号（事務所だけ読める。注文の文・FAX。10/14）
  year: "common/chubanYear",      // 注番の年（2けた）。12/20〜25 ごろに事務所が切りかえる（日付からは決めない）
};
const S = {};                 // データベースの中身（読みこむまでは undefined）
let tab = "sup", body = null, waiting = false;
let kQ = "", ask = "";        // 注番の会社のさがす言葉／「本当に消しますか？」を出している行
let codeKind = "genba";       // 合言葉を変える：現場 / 事務所
const pickOwners = new Set();  // 日報の人から足す人（えらんでいるところ）

const LOADING = '<p class="muted">読んでいます…</p>';
const BAD_KEY = /[.#$\[\]\/]/;
const TEL_RE = /^[0-9()+\- ]{1,20}$/;   // 電話番号・FAX 番号（データベースのルールと同じ形）
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;   // 材料屋のメールアドレス（データベースのルールと同じ形）
// 人の名前でないもの（日報の担当の欄の「その他」「なし」「よつば」など、数字やローマ字の入ったもの、会社や班の名前）は、足す候補に出さない
const NOT_PERSON = /^(その他|そのた|他|ほか|なし|無し|ナシ|未定|不明|共通|全員|全体|全社|みんな|事務所|事務|会社|本社|営業|工務|現場|[ー－\-―]+)$|よつば|ヨツバ|四つ葉|四葉|テスト|[0-9０-９A-Za-zＡ-Ｚａ-ｚ]|(会社|工業|建設|産業|商事|商会|農園|工場|班|組|課|係)$/;
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
    if (tab === "backup") readBk();
    if (tab === "ai") readAi();
  });
  body.addEventListener("click", e => onClick(e).catch(showErr));
  body.addEventListener("change", e => onChange(e).catch(showErr));
  body.addEventListener("submit", e => { e.preventDefault(); onSubmit(e.target).catch(showErr); });
  body.addEventListener("input", onInput);
  body.addEventListener("focusout", () => { if (waiting) setTimeout(() => draw(), 0); });

  for (const [key, path] of Object.entries(PATH)) {
    onValue(ref(db, path), snap => { S[key] = key === "year" ? (snap.val() || "") : (snap.val() || {}); draw(); }, showErr);
  }
  // 日報の注番（読むだけ）：注番の年の切りかえどき・日報の人から足す に使う
  watchJobs(d => { S.nippo = d; draw(); }, showErr);
  // 日報の作業者の名簿（読むだけ）：日報の人から足す に使う
  watchWorkers(w => { S.workers = w; draw(); }, showErr);
  draw(true);
  if (tab === "backup") readBk();
  if (tab === "ai") readAi();
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

const VIEW = { sup: supHTML, kaisha: kaishaHTML, staff: staffHTML, place: placeHTML, catalog: catalogHTML, dev: devHTML, memo: memoHTML, notify: notifyHTML, company: companyHTML, backup: backupHTML, ai: aiHTML };

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

/** 材料屋の送り方（「ネットで買う」は 10/15。モノタロウなどのお店のページを開いて買う） */
const SEND_BY = [["mail", "メール"], ["line", "LINE"], ["fax", "FAX"], ["net", "ネットで買う"], ["", "決めない"]];

function supCard([id, s]) {
  const alias = entries(s.alias).map(([, a]) => a);
  return `
    <div class="block supcard${s.hidden ? " hid" : ""}">
      <div class="row-head"><b>${esc(s.name)}</b>
        <button type="button" class="linkbtn muted" data-suphide="${id}">${s.hidden ? "出す" : "かくす"}</button></div>
      <label class="mini">宛名
        <input class="inp" data-edit="to" data-id="${id}" value="${esc(s.to || "御中")}" maxlength="20"></label>
      <div class="mini">送り方（注文のところに、送り方に合わせたボタンが出ます）
        <div class="seg sendby" role="radiogroup" aria-label="${esc(s.name)} の送り方">
          ${SEND_BY.map(([v, l]) => `<button type="button" role="radio" data-supsend="${id}" data-v="${v}" aria-checked="${(s.send || "") === v}">${l}</button>`).join("")}
        </div>
      </div>
      ${s.send === "net" ? `<div class="mini">お店（現場のリンクがこのお店のページなら、最初からこの材料屋になります。リンクがない品物は、このお店で品名をさがします）
        <div class="seg sendby" role="radiogroup" aria-label="${esc(s.name)} のお店">
          ${SHOPS.map(sh => `<button type="button" role="radio" data-supshop="${id}" data-v="${sh.id}" aria-checked="${s.shop === sh.id}">${esc(sh.name)}</button>`).join("")}
        </div>
      </div>` : ""}
      ${s.send === "mail" ? `<label class="mini">メールアドレス（宛先。消すときは空にする）
        <input class="inp" type="email" data-edit="email" data-id="${id}" value="${esc(s.email || "")}" maxlength="100" autocomplete="off" placeholder="例 order@example.co.jp"></label>
      <div class="mini">CC（なくてもよい。いくつでも）
        <div class="chips">
          ${entries(s.cc).map(([, a], i) => `<span class="chip">${esc(a)}<button type="button" data-ccdel="${id}" data-i="${i}" aria-label="${esc(a)} を CC から外す">×</button></span>`).join("")}
          <form class="chip-add" data-form="cc" data-id="${id}">
            <input id="cc-${id}" class="inp" type="email" maxlength="100" autocomplete="off" placeholder="CC のアドレス" aria-label="${esc(s.name)} の CC を足す">
            <button class="btn">足す</button>
          </form>
        </div>
      </div>` : ""}
      ${s.send === "fax" ? `<label class="mini">FAX 番号（注文書の上に出します）
        <input class="inp" data-edit="faxno" data-id="${id}" value="${esc(s.fax || "")}" maxlength="20" inputmode="tel" autocomplete="off" placeholder="例 089-000-0000"></label>` : ""}
      ${s.send === "line" ? `<label class="mini">LINE の送り先（友だちやグループの名前。LINE ボタンを押したときに「○○ をえらんでください」と出ます）
        <input class="inp" data-edit="lineto" data-id="${id}" value="${esc(s.lineTo || "")}" maxlength="40" autocomplete="off" placeholder="例 ○○商店（グループ）"></label>` : ""}
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
      ${yearNotice()}
      <p class="hint">注番の年は、12/20〜25 ごろに切りかわります（1月1日ではありません）。日報で新しい年の注番を出しはじめたら、ここを切りかえてください。固定の注番の年も、いっしょに変わります。</p>
    </div>
    <div class="block"><h3>固定の注番（${ko.filter(x => !x.hidden).length}）</h3>
      <ul class="klist">${fk.filter(x => !x.hidden).map(kRow).join("")}</ul>
      <form class="kadd" data-form="kotei">
        <input id="fNewNo" class="inp num" maxlength="8" autocomplete="off" placeholder="例 MM${y}000" aria-label="固定の注番">
        <input id="fNewName" class="inp" maxlength="40" autocomplete="off" placeholder="名前（例 ○○工場）" aria-label="名前">
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

/** 日報に、次の年の注番が出ていたら知らせる */
function yearNotice() {
  if (!S.nippo || !S.year) return "";
  const next = String((Number(S.year) + 1) % 100).padStart(2, "0");
  const n = [...S.nippo.all.keys()].filter(c => c.slice(2, 4) === next).length;
  return n ? `<p class="warn">日報に「${next}」の注番が ${n}件 出ています。新しい年の注番を出しはじめたら、ここを ${next} に切りかえてください。</p>` : "";
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
  const all = Object.entries(S.staff).sort(([a], [b]) => ja(a, b));
  const row = ([n, x]) => `
      <li${x.hidden ? ' class="hid"' : ""}><span class="nm">${esc(n)}</span>
        <input class="inp tel" data-edit="tel" data-name="${esc(n)}" value="${esc(((S.info || {}).tels || {})[n] || "")}" maxlength="20" inputmode="tel" autocomplete="off" placeholder="電話番号（あれば）" aria-label="${esc(n)} の電話番号">${ask === "staff:" + n
        ? `<span class="row"><button type="button" class="btn danger" data-staffdelyes="${esc(n)}">消す</button><button type="button" class="btn" data-askno>やめる</button></span>`
        : `<span class="row"><button type="button" class="linkbtn" data-staffhide="${esc(n)}">${x.hidden ? "出す" : "かくす"}</button><button type="button" class="btn danger" data-staffdel="${esc(n)}">消す</button></span>`}</li>`;
  const shown = all.filter(([, x]) => !x.hidden), hid = all.filter(([, x]) => x.hidden);
  return `
    <p class="hint">現場のスマホで登録するときに、この中から自分の名前をえらびます。かくした人は、えらぶ一覧に出ません。電話番号を入れた人は、注文の文（LINE・メール・FAX）の注文者・担当者の名前のうしろに出ます（電話番号は事務所だけが見られます）。</p>
    <ul class="staff">${shown.length ? shown.map(row).join("") : '<li class="muted">まだだれもいません。下で名前を足してください。</li>'}</ul>
    <form class="add" data-form="staff">
      <input id="newStaff" class="inp" maxlength="20" autocomplete="off" placeholder="足す名前" aria-label="足す名前">
      <button class="btn primary">足す</button>
    </form>
    ${ownersBlock()}
    ${hid.length ? `<details class="block hidbox" id="hidStaff"><summary>かくしている人（${hid.length}）</summary><ul class="staff">${hid.map(row).join("")}</ul></details>` : ""}
    <p class="hint">かくしても消しても、その名前でもう登録したスマホは、そのまま使えます。</p>`;
}

/** 日報の工事の担当者と、日報の作業者の名簿の人で、まだ「注文する人」にいない人。押してえらんで、まとめて足す（全部いっぺんには入れない）
 *  協力会社の人は、たたんだ所に分けて出す（ごちゃつかないように）。日報に書いただけの手伝いの人（名簿にない名前）は出さない */
function ownersBlock() {
  const head = '<div class="block"><h3>日報の人から足す</h3>';
  if (!S.nippo || !S.workers) return head + '<p class="muted">日報を読んでいます…</p></div>';
  const ok = n => n && !S.staff[n] && !BAD_KEY.test(n) && !NOT_PERSON.test(n) && [...n].length <= 20;
  const owners = [...S.nippo.open, ...S.nippo.fixed].map(j => String(j.tantou || "").trim());
  const jisha = S.workers.filter(w => w.kubun === "自社").map(w => w.name);
  const main = [...new Set([...owners, ...jisha])].filter(ok).sort(ja);
  const kyo = new Map();   // 協力会社の人 → 会社の名前
  for (const w of S.workers) if (w.kubun !== "自社" && ok(w.name) && !main.includes(w.name) && !kyo.has(w.name)) kyo.set(w.name, w.shozoku);
  const partner = [...kyo.keys()].sort(ja);
  for (const n of [...pickOwners]) if (!main.includes(n) && !kyo.has(n)) pickOwners.delete(n);
  if (!main.length && !partner.length) return head + '<p class="muted">日報の人は、みんな入っています。</p></div>';
  const btn = (n, co) => `<button type="button" data-pickowner="${esc(n)}" aria-pressed="${pickOwners.has(n)}">${esc(n)}${co ? ` <small>${esc(co)}</small>` : ""}</button>`;
  return `${head}
      <p class="hint">日報の工事の担当者と、日報の名簿の人で、まだここにいない人です（${main.length}人）。材料をたのむ人を押してえらんでください。</p>
      ${main.length ? `<div class="owners">${main.map(n => btn(n)).join("")}</div>` : '<p class="muted">よつばの人は、みんな入っています。</p>'}
      ${partner.length ? `<details class="kyo" id="ownersKyo"><summary>協力会社の人（${partner.length}人）</summary><div class="owners">${partner.map(n => btn(n, kyo.get(n))).join("")}</div></details>` : ""}
      <button type="button" class="btn primary" data-addowners${pickOwners.size ? "" : " disabled"}>${pickOwners.size ? `えらんだ ${pickOwners.size}人を足す` : "足す人を押してください"}</button>
    </div>`;
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
  const units = entries(S.catalog.units).map(([, u]) => u);
  return `
    ${freeBlock(cats, units)}
    <p class="hint">スマホの「たのむ」の種類（タブ）と品物です。種類を開くと、いつもの材料屋（事務所が注文するとき最初から入る材料屋）と、品物ごとの「ボタンを直す」（スマホに出るボタンを足す・外す、行を足す、かくす）があります。直しても、前の依頼・注文の品名は変わりません。</p>
    ${cats.map(([ci, c]) => `
      <details class="block cat" id="cat-${ci}">
        <summary><b>${esc(c.name)}</b><span class="muted">品物 ${entries(c.items).filter(([, it]) => !it.hidden).length}・いつも：${esc(supName(c.sup))}</span></summary>
        <label class="mini">この種類のいつもの材料屋
          <select class="inp" data-edit="catsup" data-ci="${ci}">${options(c.sup, "決めない")}</select></label>
        <ul class="ilist">${entries(c.items).map(([ii, it]) => `
          <li class="${it.hidden ? "hid" : ""}"><span class="iname"><b>${esc(it.name)}</b>${it.sub ? ` <span class="muted">${esc(it.sub)}</span>` : ""} <span class="muted">（${esc(it.unit || "")}）</span>${it.hidden ? ' <span class="tag">かくしている</span>' : ""}</span>
            <select class="inp" data-edit="itemsup" data-ci="${ci}" data-ii="${ii}" aria-label="${esc(it.name)} のいつもの材料屋">${options(it.sup, "種類と同じ")}</select>
            ${it.free ? "" : btnEditor(ci, ii, it)}</li>`).join("")}
        </ul>
        <form class="kadd" data-form="itemadd" data-ci="${ci}">
          <input id="ia-${ci}" class="inp" maxlength="30" autocomplete="off" placeholder="足す品物の名前" aria-label="${esc(c.name)} に足す品物の名前">
          <select id="iu-${ci}" class="inp" aria-label="単位">${units.map(u => `<option>${esc(u)}</option>`).join("")}</select>
          <button class="btn">品物を足す</button>
        </form>
      </details>`).join("")}`;
}

/* ---------- 手で書いた品物（スマホの「自由に書く」。10/14） ----------
   依頼の行のうち「自由に書く」の品物を、書いた名前ごとに数える（取り消した依頼は数えない）。
   空白・全角半角のちがいは同じものにする。書き方のちがうもの（キャスター／キャスタ）は別に数える。
   「タブに足す」で、えらんだ種類に、その名前のボタンなしの品物を足す */
let freePick = "";   // 「タブに足す」を開いている名前
const normName = s => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

function freeList(cats) {
  const freeKeys = new Set(), have = new Set();
  for (const [, c] of cats) for (const [, it] of entries(c.items)) {
    if (it.free) freeKeys.add(`${c.id}:${it.id}`);
    else have.add(normName(it.name));
  }
  const m = new Map();
  for (const r of Object.values(S.reqs || {})) {
    if (!r || r.status === "cancelled") continue;
    for (const l of Object.values(r.lines || {})) {
      if (!l || !freeKeys.has(l.key)) continue;
      const name = normName(l.spec);
      if (!name) continue;
      const x = m.get(name) || { name, n: 0, at: 0, unit: "", cat: "" };
      x.n++;
      if ((r.sentAt || 0) >= x.at) Object.assign(x, { at: r.sentAt || 0, unit: l.unit || x.unit, cat: String(l.key).split(":")[0] });
      m.set(name, x);
    }
  }
  return [...m.values()].map(x => ({ ...x, have: have.has(x.name) })).sort((a, b) => b.n - a.n || b.at - a.at).slice(0, 30);
}

function freeBlock(cats, units) {
  if (!S.reqs) return '<div class="block"><h3>手で書いた品物</h3><p class="muted">読んでいます…</p></div>';
  const list = freeList(cats);
  const md = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const row = x => {
    const open = freePick === x.name;
    const ciOf = (cats.find(([, c]) => c.id === x.cat) || cats[cats.length - 1])[0];
    return `
      <li><span class="iname"><b>${esc(x.name)}</b> <span class="muted">${x.n}回・最後 ${md(x.at)}</span></span>
        ${x.have ? '<span class="tag">タブにあります</span>'
          : open ? `<form class="row" data-form="freeadd">
              <select id="fcat" class="inp" aria-label="足す種類（タブ）">${cats.map(([ci, c]) => `<option value="${ci}"${ci === ciOf ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
              <select id="funit" class="inp" aria-label="単位">${units.map(u => `<option${u === (x.unit || "個") ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>
              <button class="btn primary">足す</button><button type="button" class="btn" data-freeno>やめる</button></form>`
          : `<button type="button" class="btn" data-freepick="${esc(x.name)}">タブに足す</button>`}</li>`;
  };
  return `
    <div class="block"><h3>手で書いた品物（スマホの「自由に書く」）</h3>${list.length ? `
      <p class="hint">現場がスマホの「自由に書く」に書いて送った品物です（多い順）。よく使うものは「タブに足す」で、えらんだ種類のタブに足せます。</p>
      <ul class="ilist">${list.map(row).join("")}</ul>`
      : '<p class="muted">まだありません。現場がスマホの「自由に書く」に書いて送ると、ここに出ます。</p>'}
    </div>`;
}

/** 品物一覧の品物 → { it, base（データベースの場所） }（ci・ii はデータベースの番号） */
function itemOf(ci, ii) {
  return { it: S.catalog.cats[ci].items[ii], base: `${PATH.catalog}/cats/${ci}/items/${ii}` };
}
/** 品物の行 → [[行の名前, [ボタン…]], …]（データベースの形のちがいをならす） */
const optRows = it => entries(it.opts).map(([, o]) => [o[0], entries(o[1]).map(([, v]) => v), o[2] === true]);
/** 行をデータベースの形にする（「えらばなくてもよい」の行だけ3つめに true） */
const rowsForDb = rows => rows.map(([l, v, free]) => (free ? [l, v, true] : [l, v]));

/** 種類 ci に、ボタンなしの品物を足す（品名は名前そのまま）。番号は、いまのいちばん大きい番号の次 */
async function addItem(ci, name, unit) {
  const c = S.catalog.cats[ci];
  const next = entries(c.items).reduce((m, [k]) => Math.max(m, Number(k)), -1) + 1;
  await set(ref(db, `${PATH.catalog}/cats/${ci}/items/${next}`), { id: "u" + Date.now().toString(36), name, tpl: name, unit: unit || "個" });
}

/** 品物の「ボタンを直す」：行（材質・サイズなど）ごとにボタンを足す・外す、行を足す、品物の下の小さい字、かくす（10/14） */
function btnEditor(ci, ii, it) {
  const opts = entries(it.opts).map(([oi, o]) => [oi, o[0], entries(o[1]).map(([, v]) => v), o[2] === true]);
  return `
    <details class="ibtns" id="ib-${ci}-${ii}"><summary>ボタンを直す</summary>
      <label class="mini">品物の下の小さい字
        <input class="inp" data-edit="isub" data-ci="${ci}" data-ii="${ii}" value="${esc(it.sub || "")}" maxlength="30" placeholder="（書かない）"></label>
      ${opts.map(([oi, label, vals, free]) => `
        <div class="mini">${esc(label)}
          <button type="button" class="sw sm" data-optfree="${ci}" data-ii="${ii}" data-oi="${oi}" aria-pressed="${free}"><span class="knob" aria-hidden="true"></span>えらばなくてもよい</button>
          <div class="chips">
            ${vals.map((v, k) => `<span class="chip">${esc(v)}<button type="button" data-optdel="${ci}" data-ii="${ii}" data-oi="${oi}" data-k="${k}" aria-label="${esc(label)} の ${esc(v)} を外す">×</button></span>`).join("")}
            <form class="chip-add" data-form="optadd" data-ci="${ci}" data-ii="${ii}" data-oi="${oi}">
              <input id="oa-${ci}-${ii}-${oi}" class="inp" maxlength="30" autocomplete="off" placeholder="足すボタン" aria-label="${esc(it.name)} の ${esc(label)} に足す">
              <button class="btn">足す</button>
            </form>
          </div>
          ${vals.length ? "" : `<button type="button" class="linkbtn" data-rowdel="${ci}" data-ii="${ii}" data-oi="${oi}">「${esc(label)}」の行を外す</button>`}
        </div>`).join("")}
      <form class="chip-add" data-form="rowadd" data-ci="${ci}" data-ii="${ii}">
        <input id="ra-${ci}-${ii}" class="inp" maxlength="12" autocomplete="off" placeholder="足す行の名前（例 種類）" aria-label="${esc(it.name)} に足す行の名前">
        <button class="btn">行を足す</button>
      </form>
      <button type="button" class="linkbtn" data-ihide="${ci}" data-ii="${ii}">${it.hidden ? "スマホに出す" : "この品物をかくす（スマホに出さない）"}</button>
    </details>`;
}

/* ==================== 登録した端末・合言葉（11章 8） ==================== */
const when = ms => { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

/* ==================== 会社・注文書（10/14） ==================== */
/** 会社の名前・住所など（FAX の注文書とメールのいちばん下）と、決まり文句（LINE・メール・FAX のいちばん下） */
function companyHTML() {
  if (!S.info) return LOADING;
  const c = S.info.company || {};
  const f = (k, label, ph, extra = "") => `<label class="mini">${label}<input class="inp" data-edit="co" data-k="${k}" value="${esc(c[k] || "")}" placeholder="${esc(ph)}" autocomplete="off" ${extra}></label>`;
  return `
    <p class="hint">ここに入れたものは、プログラムには書かずに、データベースにしまいます（事務所だけが見られます）。会社の名前・住所などは、FAX の注文書とメールのいちばん下に出ます（LINE には出しません）。決まり文句は、LINE・メール・FAX のいちばん下に出ます。</p>
    <div class="block"><h3>会社の名前・住所など</h3><div class="ef-grid">
      ${f("name", "会社の名前", "例 株式会社○○", 'maxlength="60"')}
      ${f("zip", "郵便番号", "例 000-0000", 'maxlength="8" inputmode="numeric"')}
      ${f("addr", "住所", "例 ○○県○○市…", 'maxlength="120"')}
      ${f("tel", "TEL", "例 089-000-0000", 'maxlength="20" inputmode="tel"')}
      ${f("fax", "FAX", "例 089-000-0000", 'maxlength="20" inputmode="tel"')}
      ${f("email", "メール", "例 info@example.co.jp", 'maxlength="100" type="email"')}
      ${f("url", "ホームページ", "例 https://example.co.jp/", 'maxlength="200" type="url"')}
    </div></div>
    <div class="block"><h3>決まり文句（1行に1つ）</h3>
      <textarea class="inp ta" data-edit="phrases" rows="4" maxlength="1000">${esc(S.info.phrases || "")}</textarea></div>
    <div class="block"><h3>FAX の注文書の見本</h3>
      <p class="hint">見本の注文で、印刷の画面を開きます（送らずに、見るだけにできます）。</p>
      <button type="button" class="btn" data-faxtest>ためしに印刷の画面を開く</button></div>`;
}
function faxTest() {
  const place = Object.values(S.place || {}).find(p => p && !p.hidden && !/^取りに/.test(p.name || "")) || {};
  const staff = Object.keys(S.staff || {})[0] || "";
  printFax({
    supplierName: "（見本）材料屋", to: "御中", chuban: "AB26123", kenmei: "（見本）ポンプ配管修理",
    lines: { a: { spec: "SUS304 六角ボルト M12×55(B,N,SW,2FW)", qty: 20, unit: "組" }, b: { spec: "SUS304 六角ボルト M12×35(B,N,SW,2FW)", qty: 30, unit: "組" } },
    kibou: "最短", basho: place.name || "", bashoText: place.text || "", chumonsha: staff, tantou: staff, memo: "",
  }, { fax: "000-000-0000" }, S.info || {});
}

/* ==================== 通知（10/14） ==================== */
let pushBusy = "", pushNote = null;   // いましていること（on・test・off）／前の結果 { ok, text }

/** このパソコンの通知（オン・オフ・ためし）と、通知がオンのパソコンの一覧 */
function notifyHTML() {
  const st = pushState();
  const note = pushNote ? `<p class="${pushNote.ok ? "ok-note" : "err"}" role="status">${esc(pushNote.text)}</p>` : "";
  let mine;
  if (st === "unsupported") mine = '<p class="warn">このブラウザでは、通知を使えません。Edge か Chrome で開いてください。</p>';
  else if (st === "blocked") mine = `<p class="warn">このパソコンでは、通知が止められています。</p>
      <p class="hint">アドレスバーの左のマーク（鍵など）を押して →「通知」を「許可」にしてから、このページを開きなおしてください。</p>`;
  else if (st === "on") mine = `<p><b>このパソコン：通知はオンです</b></p>
      <div class="row">
        <button type="button" class="btn" data-pushtest${pushBusy ? " disabled" : ""}>${pushBusy === "test" ? "送っています…" : "ためしに通知を送る"}</button>
        <button type="button" class="btn" data-pushoff${pushBusy ? " disabled" : ""}>${pushBusy === "off" ? "オフにしています…" : "オフにする"}</button>
      </div>`;
  else mine = `<button type="button" class="btn primary big full" data-pushon${pushBusy ? " disabled" : ""}>${pushBusy === "on" ? "オンにしています…" : "通知をオンにする"}</button>
      <p class="hint">押すと、ブラウザが「通知を許可しますか」とたずねます。「許可」を押してください。</p>`;
  const pcs = Object.values(S.notify || {}).filter(Boolean);
  const names = [...new Set(pcs.map(t => t.name || "?"))].sort(ja);
  return `
    <p class="hint">現場から新しい依頼が来たら、パソコンの右下に知らせます。このページを閉じていても届きます（パソコンの電源が入っていて、Edge や Chrome が裏で動いているとき）。オンにするのは、パソコン1台ずつです。</p>
    <div class="block"><h3>このパソコンの通知</h3>${mine}${note}</div>
    <div class="block"><h3>通知がオンのパソコン（${names.length}台）</h3>${names.length
      ? `<ul class="plain">${names.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : '<p class="muted">まだありません</p>'}</div>
    <p class="hint">右下に出ないとき：Windows の「応答不可（集中モード）」がオンになっていないか、Windows の設定 → システム → 通知 で、Edge（Chrome）の通知がオンかを見てください。</p>`;
}

async function pushDo(what) {
  if (pushBusy) return;
  pushBusy = what; pushNote = null; draw(true);
  try {
    if (what === "on") {
      await enablePush();
      pushNote = { ok: true, text: "通知をオンにしました。「ためしに通知を送る」で、右下に出るかたしかめてください。" };
    } else if (what === "off") {
      await disablePush();
      pushNote = { ok: true, text: "このパソコンの通知を、オフにしました。" };
    } else {
      const r = await testPush();
      pushNote = r.ok ? { ok: true, text: "送りました。右下に「ためしの通知」が出れば、だいじょうぶです。" }
        : { ok: false, text: `送れませんでした（${r.error}）` };
    }
  } catch (err) {
    console.error("[通知]", what, err);
    pushNote = { ok: false, text: `${what === "on" ? "オンにできませんでした" : what === "off" ? "オフにできませんでした" : "送れませんでした"}（${err.code === "denied" || err.code === "default" ? err.message : errorText(err)}）` };
  } finally {
    pushBusy = ""; draw(true);
  }
}

function devHTML() {
  if (!S.dev) return LOADING;
  const meUid = auth.currentUser ? auth.currentUser.uid : "";
  const list = Object.entries(S.dev).sort(([, a], [, b]) => ja(a.name || "", b.name || "") || (a.registeredAt || 0) - (b.registeredAt || 0));
  const group = (role, title) => {
    const xs = list.filter(([, d]) => d.role === role);
    const names = xs.map(([, d]) => d.name);
    const twice = names.some((n, i) => names.indexOf(n) !== i);
    return `
      <div class="block"><h3>${title}（${xs.length}台）</h3>
        ${xs.length ? `<ul class="devs">${xs.map(([uid, d]) => devRow(uid, d, uid === meUid)).join("")}</ul>` : '<p class="muted">まだありません。</p>'}
        ${twice ? `<p class="hint">同じ名前が2つ以上あるときは、登録した日時で見分けてください。使わなくなった${role === "genba" ? "スマホ" : "端末"}は消します。${role === "genba" ? "iPhone では、Safari とホーム画面の「よつば資材便」が、別々の端末として登録されます。" : ""}</p>` : ""}
      </div>`;
  };
  return `
    <p class="hint">合言葉で登録した端末です。なくしたスマホや、やめた人のスマホは、ここで消してください。消すと、その端末ではよつば資材便がすぐに使えなくなります（写真だけは、最大1時間見られることがあります）。</p>
    <p class="hint">機種（例 iPhone・ホーム画面）と最後に開いた日は、その端末でアプリを開いたときに入ります（前から登録してある端末は、次に開いたときから）。</p>
    ${group("genba", "現場のスマホ")}
    ${group("office", "事務所のパソコン")}
    ${codeHTML()}`;
}

/** 最後に開いた日：今日 9:05／きのう 18:30／3日前（10/9） */
function lastOpen(ms) {
  const d = new Date(ms), t = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.round((day(t) - day(d)) / 86400000);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return n <= 0 ? `今日 ${hm}` : n === 1 ? `きのう ${hm}` : `${n}日前（${d.getMonth() + 1}/${d.getDate()}）`;
}
const OLD_DAYS = 30;   // これより長く開いていない端末は、目立たせる

function devRow(uid, d, me) {
  const k = "dev:" + uid;
  const old = d.seenAt && Date.now() - d.seenAt > OLD_DAYS * 86400000;
  return `
    <li>
      <span class="dev-name"><span><b>${esc(d.name || "（名前なし）")}</b>${d.kiki ? ` <span class="kiki">${esc(d.kiki)}</span>` : ""}</span>
        ${me ? '<span><span class="tag">いま使っているこのパソコン</span></span>' : ""}
        <span class="muted">登録 ${d.registeredAt ? when(d.registeredAt) : "—"}</span>
        <span class="${old ? "hint warn" : "muted"}">最後に開いた ${d.seenAt ? lastOpen(d.seenAt) : "（まだ記録なし）"}${old ? `・${OLD_DAYS}日以上使っていません` : ""}</span></span>
      ${me ? '<span class="muted">ここからは消せません</span>'
        : ask === k ? `<span class="kask">本当に消しますか？ この端末では、よつば資材便が使えなくなります。もう一度使うときは、合言葉で登録しなおします。
          <span class="row"><button type="button" class="btn danger" data-devdelyes="${esc(uid)}">消す</button><button type="button" class="btn" data-askno>やめる</button></span></span>`
        : `<button type="button" class="btn danger" data-devdel="${esc(uid)}">消す</button>`}
    </li>`;
}

function codeHTML() {
  const which = codeKind === "genba" ? "現場" : "事務所";
  return `
    <div class="block"><h3>合言葉を変える</h3>
      <div class="seg" role="radiogroup" aria-label="どちらの合言葉を変えるか">
        ${[["genba", "現場の合言葉"], ["office", "事務所の合言葉"]].map(([k, l]) => `<button type="button" role="radio" data-codekind="${k}" aria-checked="${k === codeKind}">${l}</button>`).join("")}
      </div>
      <form class="codeform" data-form="code" autocomplete="off">
        <label class="mini">新しい${which}の合言葉（6文字以上）
          <input id="cNew1" class="inp" type="password" autocomplete="off" maxlength="64"></label>
        <label class="mini">もう一度、同じ合言葉
          <input id="cNew2" class="inp" type="password" autocomplete="off" maxlength="64"></label>
        <button class="btn primary">${which}の合言葉を変える</button>
      </form>
      <p class="hint">変えても、もう登録した端末はそのまま使えます。新しい合言葉は、これから登録する端末だけに使います。全角・半角、大文字・小文字のちがいは同じとみなします。合言葉は LINE やメールに書かず、口で伝えてください。</p>
    </div>`;
}

/* ==================== 覚えた当て方（11章 7-4） ==================== */
// LINE・電話の注文で、品物一覧に当てて入れた品名の書き方。キーは書き方をそろえて URL の形にしたもの（line-parse.js の memoDbKey）
let mQ = "";
/** キー → 画面に出す書き方（そろえた形。大文字・空白なし・「×」は x） */
function memoText(k) {
  try { return decodeURIComponent(String(k).replace(/%2E/g, ".")); } catch (err) { return String(k); }
}
/** 覚えた答え → 画面に出す言葉 */
function memoAnswer(m, cat) {
  if (m.note) return "品物ではない行（メモに入れる）";
  if (m.free) return "一覧にない品物（文のまま）";
  const it = cat && cat.item.get(m.key);
  return it ? buildSpec(it, m.vals || {}) || it.name : `品物一覧にない品物（${m.key}）`;
}

function memoHTML() {
  return `
    <p class="hint">LINE・電話の注文で、品物一覧に当てて入れた品名の書き方を覚えています。次から同じ書き方は、AI を使わずにこの品物に当てます。まちがって覚えたものは、ここで消してください（消すと、次は AI でもう一度当てます）。</p>
    <input id="mQ" class="inp search" type="search" placeholder="書き方・品物でさがす" aria-label="書き方・品物でさがす" value="${esc(mQ)}">
    <div id="mList" class="set-body">${memoListHTML()}</div>`;
}

function memoListHTML() {
  if (!S.memo || !S.catalog) return LOADING;
  const cat = S.catalog.cats ? normCatalog(S.catalog) : null;
  const q = z2h(mQ).trim().toLowerCase();
  const all = Object.entries(S.memo).map(([k, m]) => ({ k, m, text: memoText(k), ans: memoAnswer(m, cat) }))
    .sort((a, b) => (b.m.at || 0) - (a.m.at || 0));
  const list = all.filter(x => !q || [x.text, x.ans].some(v => z2h(v).toLowerCase().includes(q)));
  if (!all.length) return '<p class="muted">まだ覚えていません。LINE・電話の注文で品物一覧に当てて入れると、ここにたまります。</p>';
  return `
    <p class="muted">${all.length}件${q ? `（「${esc(mQ)}」にあてはまるもの ${list.length}件）` : ""}</p>
    <ul class="staff memos">${list.map(({ k, m, text, ans }) => `
      <li><span class="memo-txt"><b>${esc(text)}</b><span class="muted">→ ${esc(ans)}${m.at ? `・${when(m.at)}` : ""}</span></span>
        ${ask === "memo:" + k
          ? `<span class="row"><button type="button" class="btn danger" data-memodelyes="${esc(k)}">消す</button><button type="button" class="btn" data-askno>やめる</button></span>`
          : `<button type="button" class="btn danger" data-memodel="${esc(k)}">消す</button>`}
      </li>`).join("")}</ul>`;
}

/* ==================== バックアップ（11章 8-2） ==================== */
let bk = null, bkBusy = false;   // いまのデータ（中身の数を出すため）／保存しているところ

/** タブを開いたときに、いまのデータを読む（中身の数を出す） */
function readBk() {
  readAll().then(d => { bk = d; draw(); }, showErr);
}

function backupHTML() {
  const last = lastBackup();
  return `
    <p class="hint">いまのデータを、このパソコンに1つのファイルで保存します。パソコンがこわれたり、まちがえて消したりしたときに、このファイルから元にもどせます。</p>
    <div class="block"><h3>入るもの</h3>
      <ul class="bk-list">${BACKUP_PATHS.map(([p, label]) => `
        <li><span>${esc(label)}</span><span class="muted">${bk ? esc(countText(p, bk[p])) : "読んでいます…"}</span></li>`).join("")}
      </ul>
      <p class="hint">写真と合言葉は入りません。写真は、下の「自動の保存」で週に1回、別の置き場に保存しています。</p>
    </div>
    <div class="block"><h3>今すぐ保存</h3>
      <button type="button" class="btn primary big" data-backup${bkBusy ? " disabled" : ""}>${bkBusy ? "保存しています…" : "今すぐバックアップを保存"}</button>
      <p class="muted">${last ? `このパソコンで前に保存したのは ${when(last.at)}（${esc(last.name)}）` : "このパソコンでは、まだ保存していません"}</p>
      <p class="hint">ファイルは、パソコンの「ダウンロード」に入ります。人の名前や金額が入っているので、LINE やメールで外に送らないでください。</p>
    </div>
    ${autoHTML()}
    <div class="block"><h3>元にもどすとき</h3>
      <p class="hint">もどすのは、持ち主のパソコンで行います（まちがえて今のデータを上書きしないように、この画面からはもどせません）。こまったときは、保存したファイルを持って持ち主に知らせてください。</p>
    </div>`;
}

/** 自動の保存（夜中3時。データは毎日・写真は週1回）の、前の結果 */
const kb = b => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
function autoHTML() {
  if (!S.blog) return "";
  const { data: d, photos: p } = S.blog;
  const late = !d || !d.ok || Date.now() - d.at > 2 * 86400000;   // 2日より前のまま
  const row = (label, x, ok) => `
    <li><span>${label}</span><span class="${!x ? "muted" : x.ok ? "muted" : "hint warn"}">${!x ? "まだ動いていません"
      : x.ok ? `○ ${when(x.at)}　${ok(x)}` : `× ${when(x.at)}　うまくいきませんでした`}</span></li>`;
  return `
    <div class="block"><h3>自動の保存（毎日 夜中3時）</h3>
      <ul class="bk-list">
        ${row("データ（毎日）", d, x => `依頼 ${x.requests}件・注文 ${x.orders}件（${kb(x.bytes)}）`)}
        ${row("写真（週1回・日曜）", p, x => (x.count ? `写真 ${x.count}枚（${kb(x.bytes)}）` : "写真 0枚（写真がまだありません）"))}
      </ul>
      ${d && late ? '<p class="hint warn">自動の保存が、2日以上うまくいっていません。持ち主に知らせてください。</p>' : ""}
      ${p && !p.ok ? '<p class="hint warn">写真の保存がうまくいきませんでした。次の日の夜中に、もう一度ためします。</p>' : ""}
      <p class="hint">保存先は、東京にある別の置き場です。12週（約3か月）たったものは、自動で消えます。</p>
    </div>`;
}

async function doBackup() {
  if (bkBusy) return;
  bkBusy = true;
  draw(true);
  try {
    const me = S.dev && auth.currentUser && S.dev[auth.currentUser.uid];
    const r = await saveBackup((me && me.name) || "");
    bk = r.data;
    toast(`保存しました（${r.name}・${Math.max(1, Math.round(r.size / 1024))}KB）`);
  } finally {
    bkBusy = false;
    draw(true);
  }
}

/* ==================== AI（11章 7-3） ==================== */
// AI はサーバーのプログラム zairyoAi を通して使う（APIキーはサーバーにだけある）
const ai = { usage: null, err: "", test: null, busy: false };

function readAi() {
  call("zairyoAi")({ task: "usage" }).then(r => { ai.usage = r.data; ai.err = ""; draw(); }, ex => { ai.err = errorText(ex); draw(); });
}

function aiHTML() {
  const u = ai.usage, t = ai.test;
  return `
    <p class="hint">AI（Claude）は、LINE の品名を品物一覧に当てるときと、納品書を読むときに使います（これから作ります）。使えるのは事務所の端末だけです。</p>
    <div class="block"><h3>今日つかった回数</h3>
      ${u ? `<p><span class="money">${u.used}</span> / ${u.limit} 回</p>` : ai.err ? `<p class="warn">${esc(ai.err)}</p>` : '<p class="muted">読んでいます…</p>'}
      <p class="hint">1日 ${u ? u.limit : "100"} 回までにしています。Claude Console でも、月のお金の上限を決めてあります。</p></div>
    <div class="block"><h3>AI につながるかためす</h3>
      <button type="button" class="btn" data-aiping${ai.busy ? " disabled" : ""}>${ai.busy ? "ためしています…" : "ためす"}</button>
      ${t ? (t.ok ? `<p class="okmsg">○ つながりました（${(t.ms / 1000).toFixed(1)}秒・AI の答え「${esc(t.reply)}」）</p>` : `<p class="warn">× ${esc(t.msg)}</p>`) : ""}
      <p class="hint">押すと AI を1回呼びます（1回 1円もかかりません）。このためしは Claude Opus 5.5 を使います。LINE の品名の当ては Claude Sonnet 5.5 です（くらべて決めました）。</p></div>`;
}

async function pingAi() {
  if (ai.busy) return;
  ai.busy = true;
  draw(true);
  try {
    const r = (await call("zairyoAi")({ task: "ping" })).data;
    ai.usage = r;
    ai.test = r.ok ? { ok: true, ms: r.ms, reply: r.reply } : { ok: false, msg: "AI に断られました" };
  } catch (ex) {
    ai.test = { ok: false, msg: errorText(ex) };
  } finally {
    ai.busy = false;
    draw(true);
  }
}

/* ==================== 押したとき ==================== */
async function onClick(e) {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;

  if ("backup" in d) return doBackup();
  if ("aiping" in d) return pingAi();
  if ("pushon" in d) return pushDo("on");
  if ("faxtest" in d) return faxTest();
  if ("pushtest" in d) return pushDo("test");
  if ("pushoff" in d) return pushDo("off");

  if (d.supsend) {
    const s = S.sup[d.supsend], v = d.v || null;
    await update(ref(db, `${PATH.sup}/${d.supsend}`), { send: v });
    toast(`${s.name} の送り方を「${(SEND_BY.find(([x]) => x === (v || "")) || [, "決めない"])[1]}」にしました`);
    return;
  }
  if (d.supshop) {
    const s = S.sup[d.supshop], sh = SHOPS.find(x => x.id === d.v);
    if (!sh) return;
    await update(ref(db, `${PATH.sup}/${d.supshop}`), { shop: sh.id });
    toast(`${s.name} のお店を「${sh.name}」にしました`);
    return;
  }
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
  } else if (d.freepick) {
    freePick = d.freepick;
    draw(true);
  } else if ("freeno" in d) {
    freePick = "";
    draw(true);
  } else if (d.optfree) {
    // 行ごとの「えらばなくてもよい」（10/14）。オフの行は、現場がえらばないとカートに入れられない
    const { it, base } = itemOf(d.optfree, d.ii), [label, , free] = optRows(it)[Number(d.oi)];
    await set(ref(db, `${base}/opts/${d.oi}/2`), free ? null : true);
    toast(free ? `${it.name} の「${label}」を、必ずえらぶ行にしました` : `${it.name} の「${label}」を、えらばなくてもよい行にしました`);
  } else if (d.optdel) {
    const { it, base } = itemOf(d.optdel, d.ii), [label, vals] = optRows(it)[Number(d.oi)];
    const gone = vals.splice(Number(d.k), 1)[0];
    await set(ref(db, `${base}/opts/${d.oi}/1`), vals.length ? vals : null);
    toast(`${it.name} の「${label}」から「${gone}」を外しました`);
  } else if (d.rowdel) {
    const { it, base } = itemOf(d.rowdel, d.ii), rows = optRows(it);
    const [label] = rows.splice(Number(d.oi), 1)[0];
    const tpl = String(it.tpl || "").replace(`{${label}}`, "").replace(/\s{2,}/g, " ").trim();
    await update(ref(db, base), { opts: rows.length ? rowsForDb(rows) : null, tpl });
    toast(`${it.name} の「${label}」の行を外しました`);
  } else if (d.ihide) {
    const { it, base } = itemOf(d.ihide, d.ii);
    await update(ref(db, base), { hidden: it.hidden ? null : true });
    toast(it.hidden ? `${it.name} をスマホに出しました` : `${it.name} をかくしました（スマホに出ません）`);
  } else if (d.ccdel) {
    const s = S.sup[d.ccdel];
    const list = entries(s.cc).map(([, a]) => a);
    const gone = list.splice(Number(d.i), 1)[0];
    await set(ref(db, `${PATH.sup}/${d.ccdel}/cc`), list.length ? list : null);
    toast(`${s.name} の CC から ${gone} を外しました`);
  } else if (d.khide) {
    const k = kPath(d.khide);
    await update(ref(db, k.path), { hidden: !k.x.hidden });
    toast(`${k.key}（${k.x.name}）を${k.x.hidden ? "出しました" : "かくしました"}`);
  } else if (d.kdel || d.staffdel || d.devdel || d.memodel) {
    ask = d.kdel || (d.staffdel ? "staff:" + d.staffdel : d.devdel ? "dev:" + d.devdel : "memo:" + d.memodel);
    draw(true);
  } else if (d.memodelyes) {
    const k = d.memodelyes;
    ask = "";
    await remove(ref(db, `${PATH.memo}/${k}`));
    toast(`「${memoText(k)}」の覚えた当て方を消しました。次は AI でもう一度当てます`);
  } else if (d.devdelyes) {
    const x = S.dev[d.devdelyes] || {};
    t.disabled = true;
    try {
      await call("zairyoRemoveDevice")({ uid: d.devdelyes });
    } catch (err) {
      t.disabled = false;
      throw err;
    }
    ask = "";
    draw(true);
    toast(`${x.name || ""}（${x.kiki || (x.role === "office" ? "事務所" : "現場")}）の端末を消しました`);
  } else if (d.codekind) {
    codeKind = d.codekind;
    draw(true);
  } else if ("askno" in d) {
    ask = "";
    draw(true);
  } else if (d.kdelyes) {
    const k = kPath(d.kdelyes);
    ask = "";
    await remove(ref(db, k.path));
    toast(`${k.key}（${k.x.name}）を消しました`);
  } else if (d.staffhide) {
    const n = d.staffhide, x = S.staff[n];
    await update(ref(db, `${PATH.staff}/${n}`), { hidden: !x.hidden });
    toast(`${n} を${x.hidden ? "出しました" : "かくしました"}`);
  } else if (d.pickowner) {
    if (pickOwners.has(d.pickowner)) pickOwners.delete(d.pickowner);
    else pickOwners.add(d.pickowner);
    draw(true);
  } else if ("addowners" in d) {
    const names = [...pickOwners];
    if (!names.length) return;
    pickOwners.clear();
    await update(ref(db, PATH.staff), Object.fromEntries(names.map(n => [n, { addedAt: serverTimestamp() }])));
    toast(`${names.join("・")} を足しました`);
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
  } else if (d.edit === "email") {
    const s = S.sup[d.id];
    if (v && !EMAIL_RE.test(v)) { toast("メールアドレスの形がちがいます（例 order@example.co.jp）"); return; }
    await update(ref(db, `${PATH.sup}/${d.id}`), { email: v || null });
    toast(v ? `${s.name} のメールアドレスを入れました` : `${s.name} のメールアドレスを消しました`);
  } else if (d.edit === "tel" || d.edit === "faxno") {
    // 電話番号・FAX 番号（全角は半角に。数字・ハイフン・かっこ・空白だけ）
    const tel = z2h(v).replace(/[ー－―]/g, "-").trim();
    if (tel && !TEL_RE.test(tel)) { toast("番号の形がちがいます（例 090-0000-0000）"); return; }
    if (d.edit === "tel") {
      await set(ref(db, `${PATH.info}/tels/${d.name}`), tel || null);
      toast(tel ? `${d.name} の電話番号を入れました` : `${d.name} の電話番号を消しました`);
    } else {
      const s = S.sup[d.id];
      await update(ref(db, `${PATH.sup}/${d.id}`), { fax: tel || null });
      toast(tel ? `${s.name} の FAX 番号を入れました` : `${s.name} の FAX 番号を消しました`);
    }
  } else if (d.edit === "co" || d.edit === "phrases") {
    // 会社の名前・住所など／決まり文句（1行に1つ）
    const k = d.edit === "phrases" ? "phrases" : d.k;
    let val = d.edit === "phrases" ? t.value.split("\n").map(x => x.trim()).filter(Boolean).join("\n") : v;
    if (["tel", "fax", "zip"].includes(k)) val = z2h(val).replace(/[ー－―]/g, "-").trim();
    const bad = { email: x => !EMAIL_RE.test(x), url: x => !/^https?:\/\/\S+$/.test(x), tel: x => !TEL_RE.test(x), fax: x => !TEL_RE.test(x), zip: x => !/^\d{3}-?\d{4}$/.test(x) }[k];
    if (val && bad && bad(val)) { toast("形がちがいます。たしかめてください"); return; }
    await set(ref(db, k === "phrases" ? `${PATH.info}/phrases` : `${PATH.info}/company/${k}`), val || null);
    toast("会社・注文書の設定を直しました");
  } else if (d.edit === "isub") {
    const { it, base } = itemOf(d.ci, d.ii);
    await set(ref(db, `${base}/sub`), v || null);
    toast(`${it.name} の下の小さい字を直しました`);
  } else if (d.edit === "lineto") {
    const s = S.sup[d.id];
    await update(ref(db, `${PATH.sup}/${d.id}`), { lineTo: v || null });
    toast(v ? `${s.name} の LINE の送り先を「${v}」にしました` : `${s.name} の LINE の送り先を消しました`);
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
  } else if (kind === "freeadd") {
    const name = freePick, ci = $("#fcat", form).value, unit = $("#funit", form).value, c = S.catalog.cats[ci];
    if (!name || !c) return;
    if (entries(c.items).some(([, it]) => normName(it.name) === name)) return toast(`${name} は「${c.name}」にもうあります`);
    freePick = "";
    await addItem(ci, name.replace(/[{}]/g, "").slice(0, 60), unit);
    toast(`「${name}」を ${c.name} のタブに足しました（ボタンなし。「ボタンを直す」で足せます）`);
  } else if (kind === "optadd") {
    const { ci, ii, oi } = form.dataset, { it, base } = itemOf(ci, ii), [label, vals] = optRows(it)[Number(oi)];
    const v = val(`oa-${ci}-${ii}-${oi}`);
    if (!v) return toast("足すボタンの字を入れてください");
    if (/[{}]/.test(v)) return toast("{ } は使えません");
    if (vals.includes(v)) return toast(`「${v}」はもうあります`);
    clear(`oa-${ci}-${ii}-${oi}`);
    await set(ref(db, `${base}/opts/${oi}/1`), [...vals, v]);
    toast(`${it.name} の「${label}」に「${v}」を足しました`);
  } else if (kind === "rowadd") {
    const { ci, ii } = form.dataset, { it, base } = itemOf(ci, ii), rows = optRows(it);
    const label = val(`ra-${ci}-${ii}`);
    if (!label) return toast("足す行の名前を入れてください（例 種類）");
    if (/[{}.#$\[\]\/]/.test(label)) return toast("{ } . # $ [ ] / は使えません");
    if (rows.some(([l]) => l === label)) return toast(`「${label}」の行はもうあります`);
    clear(`ra-${ci}-${ii}`);
    // 品名のひな形（tpl）の、いちばん後ろに {行の名前} を足す（えらんだボタンが品名に入るように）
    const tpl = String(it.tpl || it.name).includes(`{${label}}`) ? it.tpl : `${it.tpl || it.name} {${label}}`.trim();
    await update(ref(db, base), { opts: rowsForDb([...rows, [label, [], false]]), tpl });
    toast(`${it.name} に「${label}」の行を足しました。ボタンを足してください`);
  } else if (kind === "itemadd") {
    const ci = form.dataset.ci, c = S.catalog.cats[ci];
    const name = val(`ia-${ci}`), unit = $(`#iu-${ci}`, form).value;
    if (!name) return toast("足す品物の名前を入れてください");
    if (/[{}]/.test(name)) return toast("{ } は使えません");
    if (entries(c.items).some(([, it]) => it.name === name)) return toast(`${name} は「${c.name}」にもうあります`);
    clear(`ia-${ci}`);
    await addItem(ci, name, unit);
    toast(`${c.name} に「${name}」を足しました（ボタンなし。「ボタンを直す」で足せます）`);
  } else if (kind === "cc") {
    const id = form.dataset.id, s = S.sup[id];
    const addr = val(`cc-${id}`);
    if (!addr) return toast("CC のアドレスを入れてください");
    if (!EMAIL_RE.test(addr)) return toast("メールアドレスの形がちがいます（例 order@example.co.jp）");
    const list = entries(s.cc).map(([, a]) => a);
    if (list.includes(addr)) return toast(`${addr} はもう入っています`);
    if (list.length >= 10) return toast("CC は10までです");
    clear(`cc-${id}`);
    await set(ref(db, `${PATH.sup}/${id}/cc`), [...list, addr]);
    toast(`${s.name} の CC に ${addr} を足しました`);
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
  } else if (kind === "code") {
    // サーバーと同じ見方（全角・半角、前後の空白、大文字・小文字）でくらべる
    const norm = id => z2h($(`#${id}`, form).value).trim().toLowerCase();
    const a = norm("cNew1"), b = norm("cNew2");
    if ([...a].length < 6) return toast("合言葉は6文字以上にしてください");
    if (a !== b) return toast("2つの欄の合言葉がちがいます。もう一度入れてください");
    const which = codeKind === "genba" ? "現場" : "事務所";
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      await call("zairyoChangeCode")({ kind: codeKind, code: $("#cNew1", form).value });
    } finally {
      btn.disabled = false;
    }
    clear("cNew1", "cNew2");
    toast(`${which}の合言葉を変えました。これから登録する端末は、新しい合言葉を使います`);
  }
}

/* さがす欄は、打つたびに一覧だけかきなおす（欄から出ないように） */
function onInput(e) {
  if (e.target.id === "mQ") {
    mQ = e.target.value;
    ask = "";
    const ml = $("#mList", body);
    if (ml) ml.innerHTML = memoListHTML();
    return;
  }
  if (e.target.id !== "kQ") return;
  kQ = e.target.value;
  ask = "";
  const list = $("#kList", body);
  if (list) list.innerHTML = kListHTML();
}
