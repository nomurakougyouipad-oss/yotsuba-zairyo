// 事務所：LINE・電話で来た注文を入れる（11章 7-1。試作の「LINE・電話の注文を入れる」と同じ欄の並び）
// - 移行のあいだ用。現場の依頼はなく、そのまま注文になる（/zairyo/orders に reqId なしで入る。来たところは「LINE・電話」）
// - 品名・数量は1行に1つ。行のおわりの「20本」「3kg」のような所を数と単位にする。数が読めない行は、入れる前に直してもらう
// - 注番は日報の注番から件名・担当を入れる（日報は読むだけ）。日報にない・終わった注番は「たしかめて」と出す
// - 写真は1つめの品物につける（注文の写真・リンクの欄に出る）。入れずに閉じたら、つけた写真は置き場から消す
// - 7-2：LINE の書き込みをはりつけると、欄に入る（js/line-parse.js）。注文先の名前は登録の名前にそろえる。
//   知らない名前は勝手に足さない（「○○ にする」＝その材料屋の読みかえに足して次から自動でそろう／「新しい材料屋として足す」）。
//   はりつけた元の文は、電話番号を消してから注文の src にのこす（注文の中身の「LINE の元の文」）
// - 品名を品物一覧に当てる（AI）のは 7-4
import { ref, get, push, set, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { esc, zenkana, toast, openSheet, closeSheet } from "./common.js";
import { fmtQty, ymd, kibouText } from "./tanomu.js";
import { normalizeChuban } from "./kouji.js";
import { watchJobs, CHUBAN_RE } from "./nippo.js";
import { photoPicker, deletePhoto } from "./shashin.js";
import { errorText } from "./touroku.js";
import { parseLineText, parseKibou, findPlace, matchSupplier, aliasToLearn, maskTel } from "./line-parse.js";

const SRC_MAX = 5000;   // はりつけた元の文は、ここまでのこす

const byOrder = ([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999);

/* ---------- 品名・数量の行を読む（試作の splitQty と同じ考え方） ---------- */
const UNIT_RE = "本|枚|個|組|箱|缶|巻|式|セット|丁|ケ|コ|ヶ|袋|台|対|足|束|ロール|kg|L";
const QTY_RE = new RegExp(`(?<![0-9.])([0-9]+(?:\\.[0-9]+)?)\\s*(${UNIT_RE})$`);
/** 「キリ φ5.0　×2本」→ { spec: "キリ φ5.0", qty: 2, unit: "本" }。数が読めなければ qty: null */
export function splitLine(raw) {
  const s = String(raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const m = s.match(QTY_RE);
  if (!m) return { spec: s, qty: null, unit: "" };
  // 数の前の「×」「:」などはとる（英字の x は、空白か数字のうしろのときだけ。「BOX」の X はとらない）
  const spec = s.slice(0, m.index).replace(/(?:[\s×*:、,・]|(?<=[\s0-9])[xX])+$/, "").trim();
  return { spec, qty: Number(m[1]), unit: m[2] };
}
const itemLines = text => String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(splitLine);

/** LINE・電話の注文を入れる画面を開く
 *  opts = { sups: 材料屋 {id: {...}}, places: 届け先 {id: {...}}, me: {name}, onPlaced(注文の番号) } */
export function openLineOrder({ sups, places, me, onPlaced }) {
  // この画面で足した材料屋・読みかえも入れるので、写しを持つ
  const supMap = Object.fromEntries(Object.entries(sups || {}).map(([id, s]) => [id, { ...s }]));
  const supList = Object.entries(supMap).filter(([, s]) => !s.hidden).sort(byOrder);
  const placeList = Object.entries(places || {}).filter(([, p]) => !p.hidden).sort(byOrder);
  const f = { basho: placeList.length ? placeList[0][0] : "", kibou: "最短", src: "", supRaw: "" };
  const photos = [];
  let jobs = null, stopJobs = null, staff = [], saved = false, autoKenmei = "", autoTantou = "", picker = null;

  const html = `
    <div class="pw" id="lineWrap">
      <div class="panel-head"><div><span class="eyebrow">移行のあいだ用</span><h2 id="panelTitle">LINE・電話の注文を入れる</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <p class="hint">LINE や電話で来た注文を、そのまま注文として入れます（「材料がまだ届いていない」に入ります）。</p>
      <div class="field paste"><label for="pasteBox">LINE の書き込みをはりつける</label>
        <textarea id="pasteBox" class="inp ta" rows="5" placeholder="グループ LINE の注文の書き込みをコピーして、ここにはりつけてください。下の欄に自動で入ります。" data-autofocus></textarea>
        <div class="row"><button type="button" class="btn" id="doParse">読み取る</button>
          <span class="hint" id="parseHint">電話の注文や、手で入れるときは、そのまま下の欄へ。</span></div></div>
      <form id="lineForm" class="stack" novalidate>
        <div class="field"><label for="fSup">注文先<span class="req">必ず</span></label>
          <select id="fSup" class="inp">
            <option value="">えらんでください</option>
            ${supList.map(([id, s]) => `<option value="${esc(id)}">${esc(s.name)}</option>`).join("")}
          </select>
          <span class="hint" id="hSup">一覧にない材料屋は、⚙ 設定 →「材料屋」で足してください。</span>
          <div class="row" id="supPick" hidden></div><p class="err" id="eSup"></p></div>
        <div class="two">
          <div class="field"><label for="fChuban">注文番号（注番）<span class="req">必ず</span></label>
            <input id="fChuban" class="inp" list="jobList" placeholder="例 AB26123" autocomplete="off" autocapitalize="characters" maxlength="12">
            <datalist id="jobList"></datalist><span class="hint" id="hChuban"></span></div>
          <div class="field"><label for="fKenmei">工事件名<span class="req">必ず</span></label>
            <input id="fKenmei" class="inp" maxlength="100" autocomplete="off"><p class="err" id="eKenmei"></p></div>
        </div>
        <div class="field"><label for="fItems">品名・数量<span class="req">必ず</span></label>
          <textarea id="fItems" class="inp ta" rows="5" placeholder="1行に1つ。行のおわりに数を書きます&#10;例　SUS304 六角ボルト M12×40　20本&#10;例　シールテープ　2箱"></textarea>
          <ul class="li-prev" id="iPrev" hidden></ul><p class="err" id="eItems"></p></div>
        <div class="field"><span class="lab">写真・スクショ（LINE で送られてきた写真など）</span><div class="photos" id="fPhotos"></div>
          <span class="hint">パソコンなら、写真をここにドラッグしてもつけられます。</span></div>
        <div class="field"><span class="lab">納入希望日</span>
          <div class="pick" id="kPick">
            <button type="button" data-kibou="最短" aria-pressed="true">最短</button>
            <button type="button" data-kibou="__date" aria-pressed="false">日付をえらぶ</button>
          </div>
          <input id="fDate" class="inp" type="date" aria-label="納入希望日" hidden></div>
        <div class="field"><span class="lab">届け先</span>
          <div class="pick" id="pPick">${placeList.map(([id, p]) => `<button type="button" data-basho="${esc(id)}" aria-pressed="${id === f.basho}">${esc(p.name)}</button>`).join("")}</div></div>
        <div class="two">
          <div class="field"><label for="fChu">注文者（材料をたのんだ人）</label>
            <input id="fChu" class="inp" list="staffList" maxlength="20" autocomplete="off"><datalist id="staffList"></datalist></div>
          <div class="field"><label for="fTan">担当者（工事の担当）</label>
            <input id="fTan" class="inp" maxlength="20" autocomplete="off"></div>
        </div>
        <div class="field"><label for="fMemo">メモ</label><textarea id="fMemo" class="inp ta" rows="2" maxlength="500"></textarea></div>
        <p class="err" id="eAll"></p>
        <div class="row"><button type="submit" class="btn primary big" id="lineGo">注文を入れる</button>
          <button type="button" class="btn" data-close>やめる</button></div>
      </form>
    </div>`;

  openSheet(html, panel => {
    // 動きは、毎回新しく作る中身（#lineWrap）につける。下から出る画面の入れ物（#panel）は使いまわしなので、
    // そこにつけると、開くたびに動きが積み重なる（2回目に開くと、材料屋が2つ足されていた）
    const p = panel.querySelector("#lineWrap");
    const g = s => p.querySelector(s);

    /* 日報の注番：件名・担当を入れる。えらべる注番を一覧に出す */
    const checkChuban = () => {
      const el = g("#fChuban"), h = g("#hChuban");
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
      // 件名・担当は、空か、前に自動で入れたままのときだけ入れる（手で直した字はこわさない）
      const k = g("#fKenmei"), t = g("#fTan");
      if (!k.value.trim() || k.value === autoKenmei) { k.value = autoKenmei = zenkana(j.kenmei); g("#eKenmei").textContent = ""; }
      if (!t.value.trim() || t.value === autoTantou) t.value = autoTantou = j.tantou || "";
    };
    stopJobs = watchJobs(d => {
      jobs = d;
      g("#jobList").innerHTML = [...d.open, ...d.fixed].map(j => `<option value="${esc(j.chuban)}">${esc(zenkana(j.kenmei))}</option>`).join("");
      checkChuban();
    }, () => { g("#hChuban").textContent = "日報を読めませんでした。件名は手で書いてください"; });
    get(ref(db, "zairyo/master/staff")).then(s => {
      const v = s.val() || {};
      staff = Object.keys(v).filter(n => !(v[n] && v[n].hidden)).sort((a, b) => a.localeCompare(b, "ja"));
      g("#staffList").innerHTML = staff.map(n => `<option value="${esc(n)}"></option>`).join("");
    }, () => { });

    /* 品名・数量：こう入る、を下に出す。数が読めない行はオレンジ */
    const preview = () => {
      const ls = itemLines(g("#fItems").value), ul = g("#iPrev");
      ul.hidden = !ls.length;
      ul.innerHTML = ls.length ? `<li class="lab">こう入ります</li>` + ls.map(l => l.qty
        ? `<li><span>${esc(l.spec)}</span><span class="num">×${esc(fmtQty(l.qty))}${esc(l.unit)}</span></li>`
        : `<li class="ask"><span>${esc(l.spec)}</span><span>数が書いてありません。行のおわりに「20本」のように書いてください（品物でない行は、メモへ）</span></li>`).join("") : "";
      if (!ls.some(l => !l.qty)) g("#eItems").textContent = "";
    };

    picker = photoPicker(g("#fPhotos"), photos);

    /* ---------- 7-2：LINE の書き込みを読む・注文先をそろえる ---------- */
    const supHint = (msg, cls = "") => { const h = g("#hSup"); h.textContent = msg; h.className = "hint" + (cls ? " " + cls : ""); };
    const setKibou = v => {
      const date = v !== "最短";
      p.querySelectorAll("[data-kibou]").forEach(x => x.setAttribute("aria-pressed", (x.dataset.kibou === "__date") === date));
      g("#fDate").hidden = !date;
      g("#fDate").value = date ? v : "";
      f.kibou = v;
    };
    const setPlace = id => {
      f.basho = id;
      p.querySelectorAll("[data-basho]").forEach(x => x.setAttribute("aria-pressed", x.dataset.basho === id));
    };
    /** 知らない注文先のとき：近い材料屋の「○○ にする」と「新しい材料屋として足す」 */
    const showSupPick = m => {
      const pk = g("#supPick");
      f.supRaw = m ? m.raw : "";
      pk.hidden = !m;
      pk.innerHTML = m ? m.near.map(id => `<button type="button" class="btn" data-supset="${esc(id)}">${esc(supMap[id].name)} にする</button>`).join("") +
        `<button type="button" class="linkbtn" data-supnew="${esc(m.clean)}">「${esc(m.clean)}」を新しい材料屋として足す</button>` : "";
    };
    /** えらんだ材料屋の読みかえに、LINE の書き方を足す（次から自動でそろう） */
    const learn = async id => {
      const raw = f.supRaw, s = supMap[id];
      showSupPick(null);
      g("#fSup").value = id;
      const k = aliasToLearn(raw, s, Object.entries(supMap));
      if (!k) { supHint(""); return; }
      const list = [...(Array.isArray(s.alias) ? s.alias : Object.values(s.alias || {})), k];
      await set(ref(db, `zairyo/master/suppliers/${id}/alias`), list);
      s.alias = list;
      supHint(`「${raw}」は、次から「${s.name}」にそろえます`, "ok");
    };
    const addSup = async name => {
      const n = name.trim().slice(0, 40);
      if (!n) return;
      const order = Math.max(-1, ...Object.values(supMap).map(x => x.order ?? -1)) + 1;
      const r = push(ref(db, "zairyo/master/suppliers"));
      const s = { name: n, to: "御中", app: false, azukari: false, alias: [n], order };
      await set(r, s);
      supMap[r.key] = s;
      const opt = document.createElement("option");
      opt.value = r.key;
      opt.textContent = n;
      g("#fSup").append(opt);
      g("#fSup").value = r.key;
      showSupPick(null);
      supHint(`「${n}」を新しい材料屋として足しました（宛名・読みかえは ⚙ 設定 →「材料屋」で直せます）`, "ok");
    };

    const doParse = () => {
      const text = g("#pasteBox").value, hint = g("#parseHint");
      if (!text.trim()) { hint.textContent = "先に LINE の書き込みをはりつけてください。"; hint.className = "hint bad"; return; }
      const r = parseLineText(text);
      f.src = maskTel(text.trim()).slice(0, SRC_MAX);   // 電話番号は消してからのこす（持ち主 10/13）
      const notes = [];
      // 注文先
      showSupPick(null);
      g("#eSup").textContent = "";
      const m = matchSupplier(r.supplier, Object.entries(supMap));
      if (m.id) {
        g("#fSup").value = m.id;
        supHint(m.how === "fixed" ? `LINE の「${m.raw}」を「${supMap[m.id].name}」にそろえました` : "", m.how === "fixed" ? "ok" : "");
      } else if (m.how === "omakase") {
        g("#fSup").value = "";
        supHint(`LINE に「${m.raw}」とあります。注文先をえらんでください`, "bad");
      } else if (m.how === "unknown") {
        g("#fSup").value = "";
        supHint(`LINE の「${m.raw}」は、登録にない材料屋です。下のボタンか、上の一覧でえらんでください`, "bad");
        showSupPick(m);
      }
      // 注番・件名（日報にある注番なら、日報の件名に入れかわる）・担当（LINE に書いてあれば LINE の名前）
      if (r.chuban) g("#fChuban").value = normalizeChuban(r.chuban);
      if (r.kenmei) g("#fKenmei").value = autoKenmei = r.kenmei;
      checkChuban();
      if (r.tantou) g("#fTan").value = r.tantou.slice(0, 20);
      if (r.chumonsha) g("#fChu").value = r.chumonsha.slice(0, 20);
      // 品名・数量
      if (r.items) { g("#fItems").value = r.items; preview(); }
      // 納入希望日
      const k = parseKibou(r.kibou);
      if (k) setKibou(k);
      else if (r.kibou) { setKibou(""); notes.push(`納入希望日「${r.kibou}」を読めませんでした。日付をえらんでください`); }
      // 届け先（書いていなければ、いちばん上の届け先のまま）
      const pl = findPlace([r.basho, r.kibou, r.memo, r.items], placeList);
      if (pl) setPlace(pl);
      else if (r.basho) notes.push(`届け先「${r.basho}」を読めませんでした。えらんでください`);
      g("#fMemo").value = r.memo;
      const got = [g("#fSup").value, r.chuban, r.items].filter(Boolean).length;
      hint.innerHTML = esc(got === 3 ? "読み取りました。下の欄をたしかめてください。" : "一部だけ読み取れました。足りない欄を入れてください。") +
        (k && k !== "最短" ? esc(`（希望日 ${kibouText(k)}）`) : "") + notes.map(n => `<br>${esc(n)}`).join("");
      hint.className = "hint " + (got === 3 && !notes.length ? "ok" : "warn");
    };
    g("#doParse").addEventListener("click", doParse);
    g("#pasteBox").addEventListener("paste", () => setTimeout(doParse, 0));

    p.addEventListener("click", e => {
      const k = e.target.closest("[data-kibou]"), b = e.target.closest("[data-basho]");
      const ss = e.target.closest("[data-supset]"), sn = e.target.closest("[data-supnew]");
      if (ss || sn) {
        e.preventDefault();
        (ss ? learn(ss.dataset.supset) : addSup(sn.dataset.supnew)).catch(ex => toast(errorText(ex)));
        g("#eSup").textContent = "";
      } else if (k) {
        const date = k.dataset.kibou === "__date";
        p.querySelectorAll("[data-kibou]").forEach(x => x.setAttribute("aria-pressed", x === k));
        g("#fDate").hidden = !date;
        if (date) { g("#fDate").min = ymd(0); g("#fDate").focus(); }
        f.kibou = date ? "" : "最短";
      } else if (b) {
        f.basho = b.dataset.basho;
        p.querySelectorAll("[data-basho]").forEach(x => x.setAttribute("aria-pressed", x === b));
      }
    });
    g("#fChuban").addEventListener("change", checkChuban);
    g("#fChuban").addEventListener("input", () => { if (CHUBAN_RE.test(normalizeChuban(g("#fChuban").value))) checkChuban(); });
    g("#fItems").addEventListener("input", preview);
    g("#fSup").addEventListener("change", () => {
      g("#eSup").textContent = "";
      // LINE の知らない名前のあとで、一覧からえらんだときも、その材料屋の読みかえに足す
      if (f.supRaw && g("#fSup").value) learn(g("#fSup").value).catch(ex => toast(errorText(ex)));
    });
    g("#fKenmei").addEventListener("input", () => { g("#eKenmei").textContent = ""; });
    g("#fDate").addEventListener("change", e => { f.kibou = e.target.value; });

    g("#lineForm").addEventListener("submit", async e => {
      e.preventDefault();
      const go = g("#lineGo");
      if (go.disabled) return;
      const errs = [];
      const bad = (sel, msg, focus) => { if (sel) g(sel).textContent = msg; errs.push(focus); };
      const supId = g("#fSup").value, sup = supMap[supId];
      const chuban = normalizeChuban(g("#fChuban").value), kenmei = g("#fKenmei").value.trim();
      const ls = itemLines(g("#fItems").value);
      if (!sup) bad("#eSup", "注文先をえらんでください", "#fSup");
      if (!CHUBAN_RE.test(chuban)) { const h = g("#hChuban"); h.textContent = chuban ? "形がちがいます（例 AB26123）" : "注番を入れてください"; h.className = "hint bad"; errs.push("#fChuban"); }
      if (!kenmei) bad("#eKenmei", "工事件名を入れてください", "#fKenmei");
      if (!ls.length) bad("#eItems", "品名・数量を入れてください", "#fItems");
      else if (ls.some(l => !l.qty)) bad("#eItems", `数が書いてない行が ${ls.filter(l => !l.qty).length}行 あります（オレンジの行）`, "#fItems");
      else if (ls.some(l => !l.spec)) bad("#eItems", "品名のない行があります", "#fItems");
      if (!f.kibou) errs.push("#fDate");
      if (picker.isBusy()) bad("#eAll", "写真を上げています。少し待ってください", "");
      if (errs.length) {
        const first = errs.find(Boolean);
        if (first) { const el = g(first); el.focus({ preventScroll: true }); el.scrollIntoView({ block: "center" }); }
        if (!f.kibou) toast("納入希望日の日付をえらんでください");
        return;
      }
      g("#eAll").textContent = "";

      const place = (places || {})[f.basho] || {};
      const lines = {};
      ls.forEach((l, i) => {
        lines["l" + String(i + 1).padStart(2, "0")] = { spec: l.spec.slice(0, 300), qty: l.qty, unit: l.unit };
      });
      if (photos.length) lines.l01.photos = [...photos];
      const order = {
        supplier: supId, supplierName: sup.name, to: sup.to || "御中",
        chuban, kenmei, tantou: g("#fTan").value.trim(), chumonsha: g("#fChu").value.trim(),
        kibou: f.kibou, basho: place.name || "", bashoText: place.text || "",
        contacted: false, memo: g("#fMemo").value.trim(),
        status: "wait", lines,
        orderedAt: serverTimestamp(), orderedBy: me.name, orderedByUid: auth.currentUser.uid,
      };
      if (f.src) order.src = f.src;   // はりつけた LINE の元の文
      go.disabled = true;
      go.textContent = "入れています…";
      try {
        const r = push(ref(db, "zairyo/orders"));
        await set(r, order);
        saved = true;
        closeSheet();
        toast(`${sup.name} への注文を入れました（「材料がまだ届いていない」に入ります）`);
        if (onPlaced) onPlaced(r.key);
      } catch (ex) {
        go.disabled = false;
        go.textContent = "注文を入れる";
        throw ex;
      }
    });
    preview();
  }, {
    side: true,
    onClose: () => {
      if (stopJobs) stopJobs();
      if (!saved) photos.forEach(deletePhoto);   // 入れずに閉じたら、つけた写真は消す
    },
  });
}
