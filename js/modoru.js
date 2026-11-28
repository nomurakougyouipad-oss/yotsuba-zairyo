// 画面のうつり方：「← 戻る」ボタンと、ブラウザの戻る（11/28 持ち主「カード・上の箱・注番でさがしたあとなどに、1つ前の画面にもどりたい」）
// しくみ：
// - アプリの中の「1つ前の画面」を stack にためる（画面のようす＝snapshot。タブ・しぼりこみ・さがした字・一覧の位置・開いていた右／下の画面）
// - ブラウザの履歴には、もどれる画面があるあいだだけ「ふた」を1つ足す。ブラウザの戻る（マウスの戻る・Alt＋←・スマホの戻る）は
//   ふたを使ってアプリの中の戻るになる。もどれる画面がなくなったら、ふたをはずす（いちばんはじめの画面で戻るを押すと、ふつうどおりアプリから出る）
// - 書きかけの画面（右／下から出る画面で「書いたものが消えます」を聞く画面）でもどるときは、同じく「閉じますか？」と聞く
// - 書きかけの画面（form）は stack に入れない（もどったときに、書きかけが空で出ないように）。form からうつったら、form の前の画面にもどる
// - データが変わって画面をかきなおしたときは数えない（go を通さない）
// 使い方：initNav({ snapshot, restore, isForm })、画面をうつすときは go(() => …)、もどるときは back()
import { onSheetClose, onSheetOpen, sheetDirty, askSheet } from "./common.js";

let app = null;
const stack = [];
let lid = false, removing = false, wantLid = false, busy = false;

/** a = { snapshot(): いまの画面のようす, restore(s): そのようすにもどす, isForm(): いまの画面が書きかけの画面か } */
export function initNav(a) {
  app = a;
  // 一覧の位置は、アプリがもどす（ブラウザにまかせると、ふたをはずしたときに、いちばん上に飛ぶ）
  try { history.scrollRestoration = "manual"; } catch (err) { }
  window.addEventListener("popstate", onPop);
  onSheetClose(sheetClosed);
  onSheetOpen(paint);
  const top = document.querySelector("header.top");
  if (top && !top.querySelector("#navBack")) {
    const b = document.createElement("button");
    b.type = "button"; b.id = "navBack"; b.className = "navback"; b.hidden = true;
    b.innerHTML = "← 戻る"; b.setAttribute("aria-label", "1つ前の画面にもどる");
    b.addEventListener("click", () => back());
    top.prepend(b);
    // 下にずらして上のバーが見えなくなったら、左上にうかせて出す
    const fl = () => b.classList.toggle("float", top.getBoundingClientRect().bottom < 0);
    window.addEventListener("scroll", fl, { passive: true });
    fl();
  }
  document.addEventListener("click", e => { if (e.target.closest && e.target.closest("[data-navback]")) back(); });
  paint();
}
/** もどれる画面があるか */
export const canBack = () => stack.length > 0;
/** 1つ前の画面のようす（なければ null） */
export const peek = () => stack[stack.length - 1] || null;
/** いまの画面を stack に入れてから、画面をうつす（書きかけの画面からうつるときは入れない） */
export function go(change) {
  if (!app || busy) return change();
  const s = app.isForm() ? null : app.snapshot();
  const r = change();
  if (s) { stack.push(s); addLid(); }
  paint();
  return r;
}
/** 前にとっておいた画面のようすを stack に入れる（さがす欄：字を打つ前のようす） */
export function pushSnap(s) {
  if (!app || busy || !s) return;
  stack.push(s);
  addLid();
  paint();
}
/** いまの画面のようす（さがす欄に入る前などに、とっておく） */
export const snapNow = () => (app ? app.snapshot() : null);
/** 1つ前にもどる。force＝書きかけでも聞かない（保存したあと・「もどる」ボタン）。fromPop＝ブラウザの戻る */
export function back({ force = false, fromPop = false } = {}) {
  if (!stack.length) return false;
  if (!force && sheetDirty()) {
    if (fromPop) addLid();   // ブラウザの戻るで、ふたが使われた：もどす（「閉じない」なら、この画面のまま）
    askSheet(() => back({ force: true }));
    return true;
  }
  const s = stack.pop();
  busy = true;
  try { app.restore(s); } finally { busy = false; }
  if (stack.length) { if (fromPop) addLid(); }
  else if (!fromPop) removeLid();
  paint();
  return true;
}

function pushLid() { history.pushState({ yzNav: 1 }, ""); lid = true; }
function addLid() { if (removing) { wantLid = true; return; } if (!lid) pushLid(); }
let keepY = 0;
function removeLid() { if (!lid || removing) return; removing = true; lid = false; keepY = window.scrollY; history.back(); }
function onPop() {
  if (removing) {   // ふたをはずしおわった（その間に、また画面をうつしていたら、ふたを足しなおす）
    removing = false;
    if (window.scrollY !== keepY) window.scrollTo(0, keepY);
    if (wantLid || stack.length) pushLid();
    wantLid = false;
    return;
  }
  lid = false;   // ブラウザの戻るで、ふたが使われた
  back({ fromPop: true });
}
/** 右／下から出る画面が、×・保存などで閉じた：その画面のぶん（と、その下の今の画面のぶん）を stack からはずす */
function sheetClosed() {
  if (busy || !app) return;
  while (stack.length && stack[stack.length - 1].sheet) stack.pop();
  if (stack.length) stack.pop();
  if (!stack.length) removeLid();
  paint();
}
/** 「← 戻る」を、もどれるときだけ出す。右／下の画面を、べつの右／下の画面から開いたときは、その画面の上にも出す */
function paint() {
  const b = document.getElementById("navBack");
  if (b) b.hidden = !stack.length;
  const head = document.querySelector("#sheet:not([hidden]) #panel .panel-head");
  if (!head) return;
  const fromPanel = stack.length && stack[stack.length - 1].sheet;
  const pb = head.querySelector("[data-navback]");
  if (fromPanel && !pb) head.insertAdjacentHTML("afterbegin", '<button type="button" class="navback navback-p" data-navback aria-label="1つ前の画面にもどる">← 戻る</button>');
  else if (!fromPanel && pb) pb.remove();
}
