// 事務所：加工品の注文（図面つき）を入れる（10/15 事務所の相談「加工品の材料注文」の2）
// - 1つの画面で、注文の中身（材質・品名・数・単位）と、ファイル（注文書・図面）をいっしょに入れる
// - 品物は注文書（docs の 00注文書）と同じ「材質・品名・数量」の並び。品名は「材質 品名」の形にして、材質は vals.材質 にも残す
// - 「注文を入れる」を押したら、ファイルを置き場に上げてから注文をしまう（上げている途中でしっぱいしたら、上げた分は消して、注文はしまわない）
// - 注文は「材料がまだ届いていない」に入り、kind:"kakou"（一覧に「加工品」の印）・unsent:true（まだ送っていない）。
//   注文の画面の「メールで送る」で送って、Gmail で送信したあとに「送った」を押すと unsent が消える（jimusho-app.js。今の「注文した」と同じ考え方）
import { ref, get, push, set, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { esc, zenkana, toast, openSheet, closeSheet } from "./common.js";
import { ymd } from "./tanomu.js";
import { normalizeChuban } from "./kouji.js";
import { watchJobs, CHUBAN_RE } from "./nippo.js";
import { errorText } from "./touroku.js";
import { okFiles, uploadFile, removeUploaded, sizeText } from "./fairu.js";

const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999);
const MATS = ["SS400", "SUS304", "SUS316L", "SPHC", "SPCC", "SECC", "A5052", "SGP", "STK400", "STKR400"];   // 材質の候補（ほかも書ける）

/** 加工品の注文を入れる画面を開く。opts = { sups, places, units, me, onPlaced(注文の番号) } */
export function openKakouOrder({ sups, places, units, me, onPlaced }) {
  const supList = Object.entries(sups || {}).filter(([, s]) => !s.hidden).sort(byOrder);
  const placeList = Object.entries(places || {}).filter(([, p]) => !p.hidden).sort(byOrder);
  const us = units && units.length ? units : ["個", "本", "枚", "組", "m", "kg", "式", "セット"];
  const f = { basho: placeList.length ? placeList[0][0] : "", kibou: "最短" };
  const picked = [];   // えらんだファイル（「注文を入れる」まで、パソコンの中だけ）
  let jobs = null, stopJobs = null, autoKenmei = "", autoTantou = "", busy = false;
  const sendWord = s => (s.send === "mail" ? "メール" : s.send === "line" ? "LINE" : s.send === "fax" ? "FAX" : s.send === "net" ? "ネットで買う" : "");

  const rowHTML = () => `
    <div class="krow">
      <input class="inp k-mat" list="matList" maxlength="30" placeholder="材質" aria-label="材質" autocomplete="off">
      <textarea class="inp oneline k-spec" rows="1" maxlength="250" placeholder="品名・寸法・加工" aria-label="品名・寸法・加工" data-oneline></textarea>
      <input class="inp num k-qty" inputmode="decimal" placeholder="数" aria-label="数">
      <select class="inp k-unit" aria-label="単位">${us.map(u => `<option>${esc(u)}</option>`).join("")}</select>
      <button type="button" class="k-del" data-kdel aria-label="この行を外す">×</button>
    </div>`;

  const html = `
    <div class="pw" id="kakouWrap">
      <div class="panel-head"><div><span class="eyebrow">事務所から注文を入れる</span><h2 id="panelTitle">加工品の注文（図面つき）</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <p class="hint">注文の中身と、注文書・図面のファイルを、いっしょに入れます。入れたあと、注文の画面の「メールで送る」で材料屋に送ります。</p>
      <form id="kakouForm" class="stack" novalidate>
        <div class="field"><label for="kSup">注文先<span class="req">必ず</span></label>
          <select id="kSup" class="inp" data-autofocus>
            <option value="">えらんでください</option>
            ${supList.map(([id, s]) => `<option value="${esc(id)}">${esc(s.name)}${sendWord(s) ? `（${sendWord(s)}）` : ""}</option>`).join("")}
          </select>
          <span class="hint">送り方が「メール」の材料屋なら、送るときにファイルを「ダウンロード」に出します。一覧にない材料屋は、⚙ 設定 →「材料屋」で足してください。</span>
          <p class="err" id="eSup"></p></div>
        <div class="two">
          <div class="field"><label for="kChuban">注文番号（注番）<span class="req">必ず</span></label>
            <input id="kChuban" class="inp" list="kJobList" placeholder="例 AB26123" autocomplete="off" autocapitalize="characters" maxlength="12">
            <datalist id="kJobList"></datalist><span class="hint" id="hChuban"></span></div>
          <div class="field"><label for="kKenmei">工事件名<span class="req">必ず</span></label>
            <textarea id="kKenmei" class="inp oneline" rows="1" maxlength="100" autocomplete="off" data-oneline></textarea><p class="err" id="eKenmei"></p></div>
        </div>
        <div class="field"><span class="lab">品物（加工品）<span class="req">必ず</span></span>
          <div class="krows" id="kRows">
            <div class="krow head" aria-hidden="true"><span>材質</span><span>品名・寸法・加工</span><span>数</span><span>単位</span><span></span></div>
            ${rowHTML()}
          </div>
          <datalist id="matList">${MATS.map(m => `<option value="${m}"></option>`).join("")}</datalist>
          <div class="row"><button type="button" class="btn" id="kAdd">＋ 行を足す</button></div>
          <span class="hint">注文書の「材質・品名・数量」と同じ並びです。材質は、空でもかまいません。長い品名は折りかえして全部見えます。</span>
          <p class="err" id="eRows"></p></div>
        <div class="field"><span class="lab">ファイル（注文書・図面）</span>
          <ul class="flist" id="kFiles" hidden></ul>
          <div class="drop" id="kDrop">ここにファイルをドラッグ、または
            <label class="btn">＋ ファイルをえらぶ<input type="file" multiple id="kFileIn" hidden></label></div>
          <span class="hint">Excel・DXF・DWG・JWW・PDF など。1つ 200MB まで。「注文を入れる」を押したときに上げます。</span></div>
        <div class="field"><span class="lab">納入希望日</span>
          <div class="pick"><button type="button" data-kibou="最短" aria-pressed="true">最短</button><button type="button" data-kibou="__date" aria-pressed="false">日付をえらぶ</button></div>
          <input id="kDate" class="inp" type="date" aria-label="納入希望日" hidden></div>
        <div class="field"><span class="lab">届け先</span>
          <div class="pick">${placeList.map(([id, p]) => `<button type="button" data-basho="${esc(id)}" aria-pressed="${id === f.basho}">${esc(p.name)}</button>`).join("")}</div></div>
        <div class="two">
          <div class="field"><label for="kChu">注文者（たのんだ人）</label>
            <input id="kChu" class="inp" list="kStaffList" maxlength="20" autocomplete="off" value="${esc(me.name || "")}"><datalist id="kStaffList"></datalist></div>
          <div class="field"><label for="kTan">担当者（工事の担当）</label>
            <input id="kTan" class="inp" maxlength="20" autocomplete="off"></div>
        </div>
        <div class="field"><label for="kMemo">メモ</label><textarea id="kMemo" class="inp ta" rows="2" maxlength="500"></textarea></div>
        <p class="hint ok" id="kProg" role="status" hidden></p>
        <p class="err" id="eAll"></p>
        <div class="row"><button type="submit" class="btn primary big" id="kGo">注文を入れる</button>
          <button type="button" class="btn" data-close>やめる</button></div>
        <p class="hint">入れると「材料がまだ届いていない」に「まだ送っていない」の印つきで入って、その注文の画面が開きます。つぎに「メールで送る」で送って、送信したら「送った」を押してください。</p>
      </form>
    </div>`;

  openSheet(html, panel => {
    const p = panel.querySelector("#kakouWrap");
    const g = s => p.querySelector(s);

    /* 注番：日報の工事なら、件名・担当を入れる（日報は読むだけ） */
    const checkChuban = () => {
      const el = g("#kChuban"), h = g("#hChuban");
      const v = normalizeChuban(el.value);
      if (el.value && el.value !== v) el.value = v;
      h.className = "hint";
      h.textContent = "";
      if (!v) return;
      if (!CHUBAN_RE.test(v)) { h.textContent = "形がちがうかも（例 AB26123）"; h.classList.add("bad"); return; }
      if (!jobs) { h.textContent = "日報を読んでいます…"; return; }
      const j = jobs.all.get(v);
      if (!j) { h.textContent = "日報にない注番です。たしかめてください"; h.classList.add("warn"); return; }
      h.textContent = j.closed ? "日報では終わった工事です。たしかめてください" : "日報の工事です";
      h.classList.add(j.closed ? "warn" : "ok");
      const k = g("#kKenmei"), t = g("#kTan");
      if (!k.value.trim() || k.value === autoKenmei) { k.value = autoKenmei = zenkana(j.kenmei); g("#eKenmei").textContent = ""; }
      if (!t.value.trim() || t.value === autoTantou) t.value = autoTantou = j.tantou || "";
    };
    stopJobs = watchJobs(d => {
      jobs = d;
      g("#kJobList").innerHTML = [...d.open, ...d.fixed].map(j => `<option value="${esc(j.chuban)}">${esc(zenkana(j.kenmei))}</option>`).join("");
      checkChuban();
    }, () => { g("#hChuban").textContent = "日報を読めませんでした。件名は手で書いてください"; });
    get(ref(db, "zairyo/master/staff")).then(s => {
      const v = s.val() || {};
      g("#kStaffList").innerHTML = Object.keys(v).filter(n => !(v[n] && v[n].hidden)).sort((a, b) => a.localeCompare(b, "ja"))
        .map(n => `<option value="${esc(n)}"></option>`).join("");
    }, () => { });

    /* ファイル：えらぶ・ドラッグ・外す（上げるのは「注文を入れる」のとき） */
    const drawFiles = () => {
      const ul = g("#kFiles");
      ul.hidden = !picked.length;
      ul.innerHTML = picked.map((x, i) => `<li><span class="fname">${esc(x.name)}<small class="hint">${sizeText(x.size)}</small></span>
        <span class="fbtns"><button type="button" class="linkbtn muted" data-fout="${i}">外す</button></span></li>`).join("");
    };
    const addPicked = list => {
      for (const x of okFiles(list)) if (!picked.some(y => y.name === x.name && y.size === x.size)) picked.push(x);
      drawFiles();
    };
    g("#kFileIn").addEventListener("change", e => { addPicked(e.target.files || []); e.target.value = ""; });
    const drop = g("#kDrop");
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer && e.dataTransfer.files) addPicked(e.dataTransfer.files); });

    p.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches && e.target.matches("[data-oneline]")) e.preventDefault(); });
    p.addEventListener("click", e => {
      const k = e.target.closest("[data-kibou]"), b = e.target.closest("[data-basho]");
      if (k) {
        const date = k.dataset.kibou === "__date";
        p.querySelectorAll("[data-kibou]").forEach(x => x.setAttribute("aria-pressed", x === k));
        g("#kDate").hidden = !date;
        if (date) { g("#kDate").min = ymd(0); g("#kDate").focus(); }
        f.kibou = date ? (g("#kDate").value || "") : "最短";
      } else if (b) {
        f.basho = b.dataset.basho;
        p.querySelectorAll("[data-basho]").forEach(x => x.setAttribute("aria-pressed", x === b));
      } else if (e.target.closest("#kAdd")) {
        g("#kRows").insertAdjacentHTML("beforeend", rowHTML());
        const rows = p.querySelectorAll(".krow:not(.head)");
        rows[rows.length - 1].querySelector(".k-mat").focus();
      } else if (e.target.closest("[data-kdel]")) {
        const rows = p.querySelectorAll(".krow:not(.head)"), row = e.target.closest(".krow");
        if (rows.length > 1) row.remove();
        else row.querySelectorAll("input, textarea").forEach(x => { x.value = ""; });   // 1行だけのときは、中を空にする
      } else if (e.target.closest("[data-fout]")) {
        picked.splice(Number(e.target.closest("[data-fout]").dataset.fout), 1);
        drawFiles();
      }
    });
    g("#kDate").addEventListener("change", e => { f.kibou = e.target.value; });
    g("#kChuban").addEventListener("change", checkChuban);
    g("#kChuban").addEventListener("input", () => { if (CHUBAN_RE.test(normalizeChuban(g("#kChuban").value))) checkChuban(); });
    g("#kKenmei").addEventListener("input", () => { g("#eKenmei").textContent = ""; });
    g("#kSup").addEventListener("change", () => { g("#eSup").textContent = ""; });
    p.addEventListener("input", e => { if (e.target.closest(".krow")) g("#eRows").textContent = ""; });

    /* 入れる */
    g("#kakouForm").addEventListener("submit", e => {
      e.preventDefault();
      submit().catch(ex => {
        busy = false;
        g("#kGo").disabled = false;
        g("#kGo").textContent = "注文を入れる";
        g("#kProg").hidden = true;
        g("#eAll").textContent = errorText(ex) + "（注文は、まだ入っていません）";
      });
    });
    async function submit() {
      if (busy) return;
      const errs = [];
      const supId = g("#kSup").value, sup = (sups || {})[supId];
      const chuban = normalizeChuban(g("#kChuban").value), kenmei = g("#kKenmei").value.replace(/\s*\n\s*/g, " ").trim();
      if (!sup) { g("#eSup").textContent = "注文先をえらんでください"; errs.push("#kSup"); }
      if (!CHUBAN_RE.test(chuban)) { const h = g("#hChuban"); h.textContent = chuban ? "形がちがいます（例 AB26123）" : "注番を入れてください"; h.className = "hint bad"; errs.push("#kChuban"); }
      if (!kenmei) { g("#eKenmei").textContent = "工事件名を入れてください"; errs.push("#kKenmei"); }
      // 品物の行：材質も品名も数も空の行は、とばす
      const rows = [...p.querySelectorAll(".krow:not(.head)")].map(r => ({
        el: r, mat: r.querySelector(".k-mat").value.trim(), spec: r.querySelector(".k-spec").value.replace(/\s*\n\s*/g, " ").trim(),
        qtyRaw: r.querySelector(".k-qty").value.trim(), unit: r.querySelector(".k-unit").value,
      })).filter(x => x.mat || x.spec || x.qtyRaw);
      const qtyOf = s => { const n = parseFloat(String(s).normalize("NFKC").replace(/[,，]/g, "")); return Number.isFinite(n) && n > 0 && n < 100000 ? n : 0; };
      if (!rows.length) { g("#eRows").textContent = "品物を1つ以上入れてください"; errs.push(".k-spec"); }
      else if (rows.some(x => !x.spec)) { g("#eRows").textContent = "品名がない行があります"; errs.push(".k-spec"); }
      else if (rows.some(x => !qtyOf(x.qtyRaw))) { g("#eRows").textContent = "数がない（か、数でない）行があります"; errs.push(".k-qty"); }
      if (!f.kibou) { toast("納入希望日の日付をえらんでください"); errs.push("#kDate"); }
      if (errs.length) {
        const el = errs[0] === ".k-spec" ? (rows.find(x => !x.spec) || { el: p }).el.querySelector(".k-spec") || g(".k-spec")
          : errs[0] === ".k-qty" ? rows.find(x => !qtyOf(x.qtyRaw)).el.querySelector(".k-qty") : g(errs[0]);
        if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "center" }); }
        return;
      }
      g("#eAll").textContent = "";
      busy = true;
      const go = g("#kGo");
      go.disabled = true;
      go.textContent = "入れています…";

      const key = push(ref(db, "zairyo/orders")).key;
      // ファイルを上げる（1つずつ。しっぱいしたら、上げた分を消して、注文はしまわない）
      const files = {}, paths = [];
      const prog = g("#kProg");
      try {
        for (const [i, x] of picked.entries()) {
          const show = pct => { prog.hidden = false; prog.textContent = `ファイルを上げています（${picked.length > 1 ? `${i + 1}/${picked.length}つめ・` : ""}${x.name}）… ${pct}%`; };
          show(0);
          const { fid, entry } = await uploadFile(key, x, me, show);
          files[fid] = entry;
          paths.push(entry.path);
        }
        const place = (places || {})[f.basho] || {};
        const lines = {};
        rows.forEach((x, i) => {
          lines["l" + String(i + 1).padStart(2, "0")] = {
            spec: (x.mat ? `${x.mat} ${x.spec}` : x.spec).slice(0, 300), qty: qtyOf(x.qtyRaw), unit: x.unit,
            ...(x.mat ? { vals: { 材質: x.mat.slice(0, 200) } } : {}),
          };
        });
        const order = {
          supplier: supId, supplierName: sup.name, to: sup.to || "御中",
          chuban, kenmei, tantou: g("#kTan").value.trim().slice(0, 20), chumonsha: g("#kChu").value.trim().slice(0, 20),
          kibou: f.kibou, basho: place.name || "", bashoText: place.text || "",
          contacted: false, memo: g("#kMemo").value.trim().slice(0, 500),
          status: "wait", kind: "kakou", unsent: true, lines,
          orderedAt: serverTimestamp(), orderedBy: me.name, orderedByUid: auth.currentUser.uid,
          ...(paths.length ? { files } : {}),
        };
        prog.textContent = "注文をしまっています…";
        await set(ref(db, `zairyo/orders/${key}`), order);
      } catch (ex) {
        await removeUploaded(paths);
        throw ex;
      }
      busy = false;
      closeSheet();
      toast(`${sup.name} への加工品の注文を入れました。「メールで送る」で送ってください`);
      if (onPlaced) onPlaced(key);
    }
  }, {
    side: true,
    onClose: () => { if (stopJobs) stopJobs(); },
  });
}
