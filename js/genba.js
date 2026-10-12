// 現場のスマホ（index.html）
// 登録していない → 会社の合言葉 → 名前をえらぶ → 登録ずみの画面（材料をたのむ画面は 11章 4 で作る）
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase.js";
import { $, esc, initTheme, registerSW, runChecks, checkRow } from "./common.js";
import { whoAmI, register, errorText, isIPhoneBrowser } from "./touroku.js";
import { watchJobs } from "./nippo.js";
import { jobPicker } from "./kouji.js";

initTheme();
registerSW();
const main = $("#main");
start();

async function start() {
  main.innerHTML = '<section class="card"><p class="muted">しらべています…</p></section>';
  let me;
  try {
    me = await whoAmI();
  } catch (ex) {
    main.innerHTML = `<section class="card"><h2>つながりません</h2><p class="err">${esc(errorText(ex))}</p>
      <button class="btn big full" type="button" id="retry">もう一度</button></section>`;
    $("#retry").addEventListener("click", start);
    return;
  }
  if (me && me.role === "genba") return showHome(me);
  if (me && me.role === "office") return showOfficeDevice();
  showCode(me);
}

const IPHONE_NOTE = `
  <section class="card notice">
    <h2>iPhone の人は、先にホーム画面に追加してください</h2>
    <ol class="steps">
      <li>［共有］ボタン（□から↑が出ている形）を押す</li>
      <li>「ホーム画面に追加」を押す</li>
      <li>ホーム画面にできた「材料注文」を開いて、そこで登録する</li>
    </ol>
    <p class="muted">Safari のまま登録すると、ホーム画面のアプリでは登録が消えてしまいます。</p>
  </section>`;

/** 会社の合言葉を入れる */
function showCode(me) {
  $("#who").textContent = "現場のスマホ";
  main.innerHTML = `
    ${isIPhoneBrowser() ? IPHONE_NOTE : ""}
    <section class="card">
      <h2>はじめての登録</h2>
      ${me && me.removed ? '<p class="warn">このスマホの登録は消されています。もう一度登録してください。</p>' : ""}
      ${me && me.lost ? '<p class="warn">このスマホに覚えていた登録が、消えていました。もう一度登録してください。何度もこうなるときは、事務所に知らせてください。</p>' : ""}
      <form id="codeForm" class="form" novalidate>
        <div class="field">
          <label for="code">会社の合言葉</label>
          <input id="code" class="inp" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
        </div>
        <p class="err" id="err" role="alert"></p>
        <button class="btn primary big full" type="submit" id="go">次へ</button>
      </form>
    </section>`;
  const go = $("#go"), err = $("#err");
  $("#codeForm").addEventListener("submit", async e => {
    e.preventDefault();
    const code = $("#code").value;
    if (!code.trim()) { err.textContent = "合言葉を入れてください"; return; }
    go.disabled = true;
    go.textContent = "たしかめています…";
    err.textContent = "";
    try {
      const res = await register("genba", code);
      showNames(code, res.staff || []);
    } catch (ex) {
      err.textContent = errorText(ex);
      go.disabled = false;
      go.textContent = "次へ";
    }
  });
}

/** 注文する人（自分の名前）をえらぶ */
function showNames(code, staff) {
  main.innerHTML = `
    <section class="card">
      <h2>あなたの名前をえらんでください</h2>
      ${staff.length ? `
        <p class="muted">えらんだ名前で、注文が送られます。</p>
        <div class="names" role="group" aria-label="注文する人">
          ${staff.map(n => `<button type="button" class="name" aria-pressed="false" data-name="${esc(n)}">${esc(n)}</button>`).join("")}
        </div>
        <p class="err" id="err" role="alert"></p>
        <button class="btn primary big full" type="button" id="ok" disabled>名前をえらんでください</button>` : `
        <p class="warn">注文する人の一覧が、まだありません。事務所で名前を足してもらってから、もう一度ためしてください。</p>`}
      <button class="btn ghost full" type="button" id="back">もどる</button>
    </section>`;
  $("#back").addEventListener("click", () => showCode(null));
  if (!staff.length) return;

  let chosen = "";
  const ok = $("#ok"), err = $("#err");
  main.querySelectorAll(".name").forEach(b => b.addEventListener("click", () => {
    chosen = b.dataset.name;
    main.querySelectorAll(".name").forEach(x => x.setAttribute("aria-pressed", x === b));
    ok.disabled = false;
    ok.textContent = `${chosen}さんで登録する`;
  }));
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    ok.textContent = "登録しています…";
    err.textContent = "";
    try {
      await register("genba", code, chosen);
      start();
    } catch (ex) {
      err.textContent = errorText(ex);
      ok.disabled = false;
      ok.textContent = `${chosen}さんで登録する`;
    }
  });
}

/** 登録ずみ（いまは 11章 4-1「工事をえらぶ」のためし。カートの「送る」に組みこむのは 4-3） */
function showHome(me) {
  $("#who").textContent = `現場のスマホ・${me.name}さん`;
  main.innerHTML = `
    <section class="card">
      <h2>登録ずみです</h2>
      <p><b>${esc(me.name)}</b>さんで登録されています。</p>
      <p class="muted">材料をたのむ画面は、このあと作ります。下は「どの工事？」のためしです（えらんでも、まだどこにも送りません）。</p>
    </section>
    <section class="card">
      <div id="kouji"></div>
      <p class="sel-now" id="selNow">まだえらんでいません</p>
    </section>
    <section class="card">
      <h2>つながりのたしかめ</h2>
      <ul class="checks" id="checks"></ul>
    </section>`;

  let jobs = null, kaisha = {};
  const picker = jobPicker($("#kouji"), {
    me: me.name,
    kaishaName: ch => (kaisha[String(ch).slice(0, 2)] || {}).name || "",
    onChange: v => {
      const err = picker.check();
      $("#selNow").textContent = err || `えらんでいる工事：${v.chuban}　${v.kenmei}`;
      $("#selNow").classList.toggle("warn", !!err);
    },
  });

  // 注番の頭の2文字の会社名（台帳ぜんたいの表 /common/kaisha）
  onValue(ref(db, "common/kaisha"), s => { kaisha = s.val() || {}; if (jobs) picker.setJobs(jobs); });

  runChecks($("#checks"), { sw: true });
  const row = checkRow($("#checks"), "日報の注番を読める");
  row("wait", "読んでいます…");
  watchJobs(d => {
    jobs = d;
    picker.setJobs(d);
    row("ok", `えらべる工事 ${d.open.length}件・工場で使う物 ${d.fixed.length}件`);
  }, ex => row("bad", "読めません（" + errorText(ex) + "）"));
}

/** 事務所で登録した端末が、現場の画面を開いたとき */
function showOfficeDevice() {
  $("#who").textContent = "現場のスマホ";
  main.innerHTML = `
    <section class="card">
      <h2>この端末は、事務所で登録されています</h2>
      <p class="muted">事務所の画面を開いてください。</p>
      <a class="btn primary big full" href="jimusho.html">事務所の画面へ</a>
    </section>`;
}
