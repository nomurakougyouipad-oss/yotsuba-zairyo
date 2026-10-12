// 事務所のパソコン（jimusho.html）
// 登録していない → 事務所の合言葉＋このパソコンの名前 → 登録ずみの画面（いまは「注文する人」の一覧だけ）
import { ref, onValue, set, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { $, esc, initTheme, runChecks } from "./common.js";
import { whoAmI, register, errorText } from "./touroku.js";

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
    <div class="cols">
      <section class="card">
        <h2>注文する人</h2>
        <p class="muted">現場のスマホで登録するときに、この中から自分の名前をえらびます。</p>
        <ul class="staff" id="staff"><li class="muted">読んでいます…</li></ul>
        <form id="addForm" class="add" novalidate>
          <input id="newName" class="inp" type="text" maxlength="20" autocomplete="off" placeholder="足す名前" aria-label="足す名前">
          <button class="btn primary" type="submit">足す</button>
        </form>
        <p class="err" id="err" role="alert"></p>
      </section>
      <section class="card">
        <h2>つながりのたしかめ</h2>
        <ul class="checks" id="checks"></ul>
      </section>
    </div>`;
  runChecks($("#checks"));
  staffEditor();
}

/** 注文する人の一覧（足す・消す）。なおす・かくすは 11章 3 で足す */
function staffEditor() {
  const list = $("#staff"), err = $("#err"), input = $("#newName");
  let names = [];

  onValue(ref(db, "zairyo/master/staff"), snap => {
    names = Object.keys(snap.val() || {}).sort((a, b) => a.localeCompare(b, "ja"));
    list.innerHTML = names.length
      ? names.map(n => `<li><span class="nm">${esc(n)}</span><button type="button" class="btn danger" data-del="${esc(n)}">消す</button></li>`).join("")
      : '<li class="muted">まだだれもいません。下で名前を足してください。</li>';
  }, ex => {
    list.innerHTML = `<li class="err">${esc(errorText(ex))}</li>`;
  });

  // 消すときは2回押す（まちがえて消さないように）
  list.addEventListener("click", async e => {
    const b = e.target.closest("[data-del]");
    if (!b) return;
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "もう一度押すと消えます";
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ""; b.textContent = "消す"; } }, 4000);
      return;
    }
    err.textContent = "";
    try {
      await remove(ref(db, `zairyo/master/staff/${b.dataset.del}`));
    } catch (ex) {
      err.textContent = errorText(ex);
    }
  });

  $("#addForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = input.value.trim();
    err.textContent = "";
    if (!name) { err.textContent = "名前を入れてください"; return; }
    if ([...name].length > 20) { err.textContent = "名前は20文字までにしてください"; return; }
    if (/[.#$\[\]\/]/.test(name)) { err.textContent = "名前に . # $ [ ] / は使えません"; return; }
    if (names.includes(name)) { err.textContent = "もう入っています"; return; }
    try {
      await set(ref(db, `zairyo/master/staff/${name}`), { addedAt: serverTimestamp() });
      input.value = "";
    } catch (ex) {
      err.textContent = errorText(ex);
    }
  });
}
