// 事務所のパソコン（jimusho.html）
// 登録していない → 事務所の合言葉＋このパソコンの名前 → 登録ずみの画面（いまは「⚙ 設定」だけ。依頼・注文の画面は 11章 5）
import { $, esc, initTheme, runChecks } from "./common.js";
import { whoAmI, register, errorText } from "./touroku.js";
import { renderSettings } from "./settei.js";

initTheme();
const main = $("#main");
start();

async function start() {
  main.innerHTML = '<section class="card"><p class="muted">しらべています…</p></section>';
  let me;
  try {
    me = await whoAmI();
  } catch (ex) {
    main.innerHTML = `<section class="card"><h2>つながりません</h2><p class="err">${esc(errorText(ex))}</p>
      <button class="btn big" type="button" id="retry">もう一度</button></section>`;
    $("#retry").addEventListener("click", start);
    return;
  }
  if (me && me.role === "office") return showHome(me);
  showCode(me);
}

/** 事務所の合言葉と、このパソコンの名前を入れる */
function showCode(me) {
  $("#who").textContent = "事務所のパソコン";
  main.innerHTML = `
    <section class="card narrow-card">
      <h2>はじめての登録</h2>
      ${me && me.removed ? '<p class="warn">このパソコンの登録は消されています。もう一度登録してください。</p>' : ""}
      ${me && me.lost ? '<p class="warn">このパソコンに覚えていた登録が、消えていました。もう一度登録してください。</p>' : ""}
      ${me && me.role === "genba" ? '<p class="warn">この端末は、現場のスマホとして登録されています。事務所の合言葉で登録すると、事務所のパソコンに変わります。</p>' : ""}
      <form id="codeForm" class="form" novalidate>
        <div class="field">
          <label for="code">事務所の合言葉</label>
          <input id="code" class="inp" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="pcName">このパソコンの名前</label>
          <input id="pcName" class="inp" type="text" maxlength="20" autocomplete="off" placeholder="例：事務所の窓ぎわのパソコン">
          <p class="hint">登録した端末の一覧で、どのパソコンか分かるようにするためです。</p>
        </div>
        <p class="err" id="err" role="alert"></p>
        <button class="btn primary big full" type="submit" id="go">登録する</button>
      </form>
    </section>`;
  const go = $("#go"), err = $("#err");
  $("#codeForm").addEventListener("submit", async e => {
    e.preventDefault();
    const code = $("#code").value, name = $("#pcName").value.trim();
    if (!code.trim()) { err.textContent = "合言葉を入れてください"; return; }
    if (!name) { err.textContent = "このパソコンの名前を入れてください"; return; }
    go.disabled = true;
    go.textContent = "登録しています…";
    err.textContent = "";
    try {
      await register("office", code, name);
      start();
    } catch (ex) {
      err.textContent = errorText(ex);
      go.disabled = false;
      go.textContent = "登録する";
    }
  });
}

/** 登録ずみ */
function showHome(me) {
  $("#who").textContent = `事務所のパソコン・${me.name}`;
  main.innerHTML = `
    <section class="card" id="settei"></section>
    <section class="card">
      <h2>つながりのたしかめ</h2>
      <ul class="checks" id="checks"></ul>
    </section>`;
  renderSettings($("#settei"));
  runChecks($("#checks"));
}
