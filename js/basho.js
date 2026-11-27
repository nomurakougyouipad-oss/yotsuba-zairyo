// 届け先のボタン（⚙ 設定の届け先の一覧）＋「ほか（手で書く）」（11/27 事務員さん：たまに他社など）
// - 事務所の画面で使う（依頼から注文する・LINE・電話の注文・加工品・見積から注文する）。現場のスマホの届け先は今のまま
// - 手で書いた字は、届け先の名前（basho）になり、注文の文の納入場所は「○○まで納入お願いいたします」（chumon.js freePlace）
import { esc } from "./common.js";
import { FREE_PLACE, PLACE_MAX, freePlace, listPlace } from "./chumon.js";

const prevText = v => {
  const p = freePlace(v);
  return p ? `注文の文には「納入場所　${esc(p.bashoText)}」と出ます` : `届け先を書いてください（${PLACE_MAX}字まで。住所も書けます）`;
};

/** ボタンの並び＋書く欄。attr＝ボタンの data の名前（例 "basho" → data-basho）、cur＝えらんでいる届け先の番号（手で書く は FREE_PLACE）、free＝書いた字 */
export function placePickHTML(placeList, cur, { attr = "basho", free = "", id = "" } = {}) {
  return `<div class="pick"${id ? ` id="${id}"` : ""}>${placeList.map(([pid, p]) => `<button type="button" data-${attr}="${esc(pid)}" aria-pressed="${pid === cur}">${esc(p.name)}</button>`).join("")}<button type="button" data-${attr}="${FREE_PLACE}" aria-pressed="${cur === FREE_PLACE}">ほか（手で書く）</button></div>
    <div class="free-place" data-freebox="${attr}"${cur === FREE_PLACE ? "" : " hidden"}>
      <input class="inp" data-freeplace="${attr}" maxlength="${PLACE_MAX}" value="${esc(free)}" placeholder="例 ○○株式会社 △△工場" aria-label="届け先を書く" autocomplete="off">
      <p class="hint" data-freeprev="${attr}">${prevText(free)}</p>
    </div>`;
}
/** ボタンを押したとき：えらんだ印をつけかえて、書く欄を出す・かくす */
export function pickPlace(root, attr, val, { focus = true } = {}) {
  root.querySelectorAll(`[data-${attr}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[attr] === val));
  const box = root.querySelector(`[data-freebox="${attr}"]`);
  if (!box) return;
  box.hidden = val !== FREE_PLACE;
  if (!box.hidden && focus) box.querySelector("input").focus();
}
/** 書く欄に書いたとき（input のできごと）：見本をかきなおす。書く欄でなければ false */
export function onFreeInput(e) {
  const t = e.target && e.target.closest ? e.target.closest("[data-freeplace]") : null;
  if (!t) return false;
  const pv = t.parentElement.querySelector("[data-freeprev]");
  if (pv) pv.innerHTML = prevText(t.value);
  return true;
}
/** 書く欄に字を入れる（LINE の届け先が一覧になかったとき など） */
export function setFree(root, attr, text) {
  const inp = root.querySelector(`[data-freeplace="${attr}"]`);
  if (!inp) return;
  inp.value = String(text || "").slice(0, PLACE_MAX);
  onFreeInput({ target: inp });
}
/** えらんだ届け先 → { basho, bashoText }。手で書く で空なら null */
export function placeOf(places, val, root, attr) {
  if (val === FREE_PLACE) {
    const inp = root.querySelector(`[data-freeplace="${attr}"]`);
    return freePlace(inp ? inp.value : "");
  }
  return listPlace((places || {})[val]);
}
