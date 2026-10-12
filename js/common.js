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
   side: true … 右から出す（事務所のパソコン用。広い画面で、右に高さいっぱい） */
let lastFocus = null;
export function openSheet(html, after, opts = {}) {
  let sh = document.getElementById("sheet");
  if (!sh) {
    sh = document.createElement("div");
    sh.id = "sheet";
    sh.className = "sheet";
    sh.hidden = true;
    sh.innerHTML = '<div class="sheet-bg" data-close></div><div class="panel" id="panel" role="dialog" aria-modal="true" aria-labelledby="panelTitle"></div>';
    document.body.append(sh);
    sh.addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !sh.hidden) closeSheet(); });
  }
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
  sh.hidden = true;
  sh.querySelector("#panel").innerHTML = "";
  document.body.style.overflow = "";
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
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
