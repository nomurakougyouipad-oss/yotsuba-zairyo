// よつば材料注文 共通の部品（明るい／暗い・ホーム画面アプリ・つながりのたしかめ）
import { watchConnected, canReadMaster } from "./firebase.js";

export const $ = (sel, el = document) => el.querySelector(sel);

/** 半角カナ（ﾌｧｲﾝｹﾐｶﾙ）だけを全角（ファインケミカル）にする。画面に出すときだけ使う（日報などのデータは変えない）。
 *  英数字・記号など、ほかの字はそのまま */
export const zenkana = s => String(s ?? "").replace(/[｡-ﾟ]+/g, m => m.normalize("NFKC"));

/** 文字を HTML に入れるときに使う（名前などに < > があっても、こわれないように） */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** 下に少しだけ出るお知らせ（「○○をしまいました」など） */
let toastTimer = 0;
export function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    t.setAttribute("role", "status");
    document.body.append(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ---------- 下から出る画面（シート） ----------
   openSheet(html, after, { side }) … after(panel) で中身に動きをつける。× や外側を押す・Esc で閉じる
   side: true … 右から出す（事務所のパソコン用。広い画面で、右に高さいっぱい）
   onClose() … 閉じたとき（×・外側・Esc・closeSheet()。べつの中身に入れかえたときも）に1回だけ呼ぶ
   guard … 入力の画面（11/2 持ち主）。何か書いた（入力・えらぶ・ファイル）あとに ×・やめる・Esc・外側で閉じるときは
           「書いたものが消えます。閉じますか？」と聞く。何も書いていなければ、そのまま閉じる。
           true＝書いたかどうかを画面が見る。関数＝その答えが true のときだけ聞く。guardText＝聞く文（なければ上の文）
           保存したあとの closeSheet() は、聞かずに閉じる */
let lastFocus = null, onCloseNow = null, guardNow = null, dirtyNow = false;
function runOnClose() {
  const f = onCloseNow;
  onCloseNow = null;
  if (f) { try { f(); } catch (err) { } }
}
/** 「閉じますか？」をしまう */
function dropAsk(sh) {
  const a = sh && sh.querySelector(".sheet-ask");
  if (a) a.remove();
}
/** ×・やめる・Esc・外側で閉じるとき：入力の画面で何か書いてあれば、先に聞く */
function askClose(sh) {
  if (!guardNow || !guardNow.test()) { closeSheet(); return; }
  if (sh.querySelector(".sheet-ask")) return;
  const a = document.createElement("div");
  a.className = "sheet-ask";
  a.innerHTML = `<div class="sheet-ask-box" role="alertdialog" aria-modal="true" aria-labelledby="askQ"><p class="confirm-q" id="askQ">${esc(guardNow.text)}</p>
    <div class="confirm-btns"><button type="button" class="btn danger" data-askyes>閉じる</button><button type="button" class="btn" data-askno>閉じない</button></div></div>`;
  sh.append(a);
  a.querySelector("[data-askno]").focus();
}
export function openSheet(html, after, opts = {}) {
  runOnClose();
  onCloseNow = opts.onClose || null;
  dirtyNow = false;
  guardNow = opts.guard ? { test: typeof opts.guard === "function" ? opts.guard : () => dirtyNow, text: opts.guardText || "書いたものが消えます。閉じますか？" } : null;
  let sh = document.getElementById("sheet");
  if (!sh) {
    sh = document.createElement("div");
    sh.id = "sheet";
    sh.className = "sheet";
    sh.hidden = true;
    sh.innerHTML = '<div class="sheet-bg" data-close></div><div class="panel" id="panel" role="dialog" aria-modal="true" aria-labelledby="panelTitle"></div>';
    document.body.append(sh);
    sh.addEventListener("click", e => {
      const a = sh.querySelector(".sheet-ask");
      if (a) {   // 「閉じますか？」が出ているあいだ
        if (e.target.closest("[data-askyes]")) closeSheet();
        else if (e.target.closest("[data-askno]") || e.target === a) { dropAsk(sh); sh.querySelector("#panel").focus(); }
        return;
      }
      if (e.target.closest("[data-close]")) askClose(sh);
    });
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || sh.hidden) return;
      if (sh.querySelector(".sheet-ask")) dropAsk(sh);   // 聞いているときの Esc は「閉じない」
      else askClose(sh);
    });
    // 書いたかどうか（人が書いた・えらんだときだけ。プログラムが入れた字は数えない）
    const p0 = sh.querySelector("#panel");
    p0.tabIndex = -1;
    const mark = e => { if (e.isTrusted) dirtyNow = true; };
    for (const ev of ["input", "change", "drop"]) p0.addEventListener(ev, mark, true);
    p0.addEventListener("click", e => { if (e.isTrusted && e.target.closest("button[aria-pressed]")) dirtyNow = true; }, true);
  }
  dropAsk(sh);
  if (sh.hidden) lastFocus = document.activeElement;
  sh.classList.toggle("side", !!opts.side);
  const p = sh.querySelector("#panel");
  p.innerHTML = html;
  p.scrollTop = 0;
  sh.hidden = false;
  document.body.style.overflow = "hidden";
  if (after) after(p);
  const f = p.querySelector("[data-autofocus]") || p.querySelector(".x");
  if (f) f.focus({ preventScroll: true });
}
export function closeSheet() {
  const sh = document.getElementById("sheet");
  if (!sh || sh.hidden) return;
  runOnClose();
  dropAsk(sh);
  guardNow = null;
  dirtyNow = false;
  sh.hidden = true;
  sh.querySelector("#panel").innerHTML = "";
  document.body.style.overflow = "";
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

/* ---------- 一覧をかきなおしても、見ていた所をのこす（11/2 持ち主「画面が勝手に上に飛ぶ」） ----------
   データが変わるたびに一覧を作りなおす（innerHTML）と、新しいカードが上にふえたとき、見ていたカードの所に べつのカードが来る。
   かきなおす前に、画面に見えているカード（上から6つまで）の高さをおぼえて、かきなおしたあと、のこっているカードが同じ高さに来るようにずらす。
   スクロールしていない（いちばん上）ときは、なにもしない（新しいカードが上に見えるように）。
   box＝一覧の入れ物、sel＝カードのしるし、fn＝かきなおす。データが変わったとき・ボタンのあとだけに使う（タブ・しぼりこみを押したときは使わない） */
const PLACE_ATTRS = ["data-open", "data-req", "data-quote", "data-kouji", "data-o", "data-sent", "data-item"];
const placeKey = c => { for (const a of PLACE_ATTRS) if (c.hasAttribute(a)) return a + "=" + c.getAttribute(a); return ""; };
export function keepPlace(box, sel, fn) {
  const seen = [];
  if (box && window.scrollY > 0) {
    for (const c of box.querySelectorAll(sel)) {
      const r = c.getBoundingClientRect();
      if (r.bottom <= 0 || !r.height) continue;   // 上に出ている・閉じた「くわしく」の中
      if (r.top >= window.innerHeight) break;
      const k = placeKey(c);
      if (k) seen.push([k, r.top]);
      if (seen.length >= 6) break;
    }
  }
  fn();
  if (!seen.length || !box || !box.isConnected) return;
  const now = new Map([...box.querySelectorAll(sel)].map(c => [placeKey(c), c]));
  for (const [k, top] of seen) {
    const c = now.get(k);
    if (!c || !c.getBoundingClientRect().height) continue;   // そのカードは一覧から出た → つぎのカードで合わせる
    const d = c.getBoundingClientRect().top - top;
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
    return;
  }
}

/* ---------- 書きかけの画面（現場） ----------
   iPhone のホーム画面のアプリは、お店のページからもどると開きなおすことがある。
   品物の画面・ネットでさがす の書きかけを端末にしまっておき、開きなおしたらその画面にもどす */
const DRAFT_KEY = "yotsuba-zairyo-draft";
export function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (err) { return null; }
}
export function saveDraft(d) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (err) { }
}
export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (err) { }
}

/* ---------- 明るい／暗い ----------
   最初はスマホ・パソコンの設定どおり。☀／☾ を押したら覚えます（覚える名前は試作と同じ yotsuba-theme）
   覚えた方を画面が出る前に当てるのは、各ページの <head> の小さなスクリプトです */
const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const BAR = { dark: "#0F1418", light: "#F3F5F7" };   // スマホの上の帯の色（--bg と同じ）

function currentTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark" || t === "light") return t;
  return mq && mq.matches ? "dark" : "light";
}
function paintTheme() {
  const t = currentTheme();
  $("#thLight").setAttribute("aria-pressed", t === "light");
  $("#thDark").setAttribute("aria-pressed", t === "dark");
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", BAR[t]);
}
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("yotsuba-theme", t); } catch (err) { }
  paintTheme();
}
export function initTheme() {
  $("#thLight").addEventListener("click", () => setTheme("light"));
  $("#thDark").addEventListener("click", () => setTheme("dark"));
  if (mq && mq.addEventListener) mq.addEventListener("change", paintTheme);
  paintTheme();
}

/* ---------- ホーム画面アプリ ---------- */
export async function registerSW() {
  if (!("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register("sw.js");
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------- つながりのたしかめ（登録ずみの端末で出す。作っているあいだの目印） ----------
   ○＝よい、×＝こまる、…＝たしかめ中 */
export function checkRow(listEl, what) {
  const li = document.createElement("li");
  li.innerHTML = '<span class="mk" aria-hidden="true"></span><div><div class="what"></div><div class="say"></div></div>';
  li.querySelector(".what").textContent = what;
  listEl.append(li);
  return (state, say) => {
    li.dataset.state = state;
    li.querySelector(".mk").textContent = state === "ok" ? "○" : state === "bad" ? "×" : "…";
    li.querySelector(".say").textContent = say;
  };
}

export function runChecks(listEl, { sw = false } = {}) {
  const conn = checkRow(listEl, "Firebase につながる");
  conn("wait", "つないでいます…");
  let connected = false;
  const late = setTimeout(() => {
    if (!connected) conn("bad", "つながりません。電波やネットをたしかめてください");
  }, 10000);
  watchConnected(on => {
    if (on) {
      connected = true;
      clearTimeout(late);
      conn("ok", "つながりました");
    } else if (connected) {
      conn("wait", "とぎれました。つなぎなおしています…");
    }
  });

  const read = checkRow(listEl, "登録が使える");
  read("wait", "たしかめています…");
  canReadMaster().then(
    ok => ok
      ? read("ok", "登録した端末だけが読める所を、読めました")
      : read("bad", "読めません。登録しなおしてください"),
    err => read("bad", "たしかめられませんでした（" + ((err && err.message) || err) + "）")
  );

  if (sw) {
    const home = checkRow(listEl, "ホーム画面に追加するじゅんび");
    home("wait", "じゅんびしています…");
    registerSW().then(ok => ok
      ? home("ok", "できました")
      : home("bad", "このブラウザではできません"));
  }
}
