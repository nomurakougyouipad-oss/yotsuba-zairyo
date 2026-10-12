// よつば材料注文 共通の部品（明るい／暗い・ホーム画面アプリ・つながりのたしかめ）
import { watchConnected, isLocked } from "./firebase.js";

export const $ = (sel, el = document) => el.querySelector(sel);

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

/* ---------- つながりのたしかめ（1回目の「土台」用） ----------
   ○＝よい、×＝こまる、…＝たしかめ中 */
function checkRow(listEl, what) {
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

  const lock = checkRow(listEl, "鍵がかかっている");
  lock("wait", "たしかめています…");
  isLocked().then(
    locked => locked
      ? lock("ok", "登録していない人は読めません（これで正しい）")
      : lock("bad", "鍵がかかっていません。すぐ知らせてください"),
    err => lock("bad", "たしかめられませんでした（" + ((err && err.message) || err) + "）")
  );

  if (sw) {
    const home = checkRow(listEl, "ホーム画面に追加するじゅんび");
    home("wait", "じゅんびしています…");
    registerSW().then(ok => ok
      ? home("ok", "できました")
      : home("bad", "このブラウザではできません"));
  }
}
