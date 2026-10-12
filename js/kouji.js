// 「どの工事？」をえらぶ（現場）── 日報の注番から。試作の「どの工事？」と同じ並び
// - 担当でしぼる：「すべて」＋担当者（件数の多い順）。最初は「すべて」（たのむのは、工事の担当以外の人も多いため）
// - さがす欄（注番・件名・会社名）。並びは、自分が最近たのんだ工事 → だれかが最近たのんだ工事 → 注番の新しい順
// - えらんだ工事は、しぼっても上に見える
// - 固定の注番：日報の常設の注番（名前は日報の名前）
// - 日報の件名の半角カナは、画面に出すときだけ全角にする（zenkana。えらんだ工事の件名は、日報のまま持つ）
// - 一覧にない工事：注番と工事件名を手で書く（件名は必ず）。日報にない・終わった注番は「たしかめて」と出す
import { esc, zenkana } from "./common.js";
import { CHUBAN_RE } from "./nippo.js";

/** 手で書いた注番をそろえる：全角→半角、大文字、空白・ハイフンをとる、数字の所の O→0・I/L→1 */
export function normalizeChuban(s) {
  const t = String(s ?? "").normalize("NFKC").toUpperCase().replace(/[\s\-ー－]/g, "");
  return t.slice(0, 2) + t.slice(2).replace(/O/g, "0").replace(/[IL]/g, "1");
}

const agoText = d => {
  if (!d) return "";
  const n = Math.round((Date.now() - new Date(d).getTime()) / 86400000);
  return n <= 0 ? "今日たのんだ" : `${n}日前にたのんだ`;
};

/** el に「どの工事？」を出す
 *  opts = {
 *    me,                         … 注文する人（担当のタブに「自分」と出す）
 *    kaishaName(chuban) → 会社名 … 注番の頭の2文字の会社名（なければ ""）
 *    recent: {注番: {mine, any}}  … 最近たのんだ日（自分・だれか。ISO の日時の文字）。関数でもよい（そのたびに読む）
 *                                   現場は自分の依頼しか読めないので、いまは mine だけ
 *    value: {chuban, kenmei, typed}, onChange(value)
 *  }
 *  返り値：{ setJobs(日報のデータ), value(), check() → まちがいの言葉（なければ ""） } */
export function jobPicker(el, opts) {
  const st = { chuban: "", kenmei: "", typed: false, owner: "", q: "", more: false, ...(opts.value || {}) };
  const FIRST = 8;
  let data = null;
  // 会社名：注番の会社の表 → なければ、日報の常設の注番（頭の2文字が同じで件数000）の名前
  const kaisha = ch => (opts.kaishaName && opts.kaishaName(ch)) ||
    ((data && data.fixed.find(f => f.chuban.slice(0, 2) === String(ch).slice(0, 2) && f.chuban.endsWith("000"))) || {}).kenmei || "";
  const show = s => esc(zenkana(s));   // 画面に出す件名
  const recent = () => (typeof opts.recent === "function" ? opts.recent() : opts.recent) || {};

  el.innerHTML = `
    <section class="ph-sec">
      <h3>どの工事？<span class="req">必ず</span></h3>
      <div class="owners" id="kjOwners" aria-label="担当でしぼる"></div>
      <input id="kjQ" class="inp" type="search" placeholder="注番・件名・会社名でさがす" autocomplete="off" aria-label="注番・件名・会社名でさがす">
      <div class="jobs" id="kjList" role="radiogroup" aria-label="工事"><p class="muted">日報の注番を読んでいます…</p></div>
      <span class="jobs-label">固定の注番</span>
      <div class="jobs fixed" id="kjFixed" role="radiogroup" aria-label="固定の注番"></div>
      <span class="jobs-label">一覧にない工事</span>
      <div class="newjob">
        <div class="field"><label for="kjNo">注番</label>
          <input id="kjNo" class="inp num" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="英字2文字＋数字5けた"></div>
        <div class="field"><label for="kjName">工事件名</label>
          <input id="kjName" class="inp" autocomplete="off" placeholder="例 ○○ポンプ据付工事"></div>
      </div>
      <p class="hint" id="kjNote"></p>
    </section>`;
  const $ = s => el.querySelector(s);
  if (st.typed) {   // 前に手で書いた注番・件名を、欄にもどす
    $("#kjNo").value = st.chuban;
    $("#kjName").value = st.kenmei;
  }

  function changed() { if (opts.onChange) opts.onChange(value()); }
  function value() { return { chuban: st.chuban, kenmei: st.kenmei, typed: st.typed }; }

  function ownersHTML() {
    const oc = {};
    data.open.forEach(j => { if (j.tantou) oc[j.tantou] = (oc[j.tantou] || 0) + 1; });
    const owners = Object.keys(oc).sort((a, b) => (oc[b] - oc[a]) || a.localeCompare(b, "ja"));
    return `<button type="button" data-owner="" aria-pressed="${st.owner === ""}">すべて<span class="n">${data.open.length}</span></button>` +
      owners.map(o => `<button type="button" data-owner="${esc(o)}" aria-pressed="${st.owner === o}">${esc(o)}${o === opts.me ? "<small>（自分）</small>" : ""}<span class="n">${oc[o]}</span></button>`).join("");
  }

  function listHTML() {
    const q = st.q.trim().normalize("NFKC").toUpperCase();
    let list = data.open
      .filter(j => !st.owner || j.tantou === st.owner)
      .filter(j => !q || `${j.chuban} ${j.kenmei} ${kaisha(j.chuban)}`.normalize("NFKC").toUpperCase().includes(q));   // 半角カナ・全角カナは同じとみなす
    const sel = !st.typed && data.open.find(j => j.chuban === st.chuban);
    if (sel && !list.includes(sel)) list = [sel, ...list];   // えらんだ工事は、しぼっても見えるように
    const r = recent();
    list = list.map(j => ({ j, mine: (r[j.chuban] || {}).mine || "", any: (r[j.chuban] || {}).any || "" }))
      .sort((a, b) => b.mine.localeCompare(a.mine) || b.any.localeCompare(a.any) || b.j.chuban.slice(2).localeCompare(a.j.chuban.slice(2)));
    if (!list.length) return '<p class="hint">あてはまる工事がありません。下の「一覧にない工事」に書いてください。</p>';
    // ふだんは上の FIRST 件だけ出す（画面が長くならないように）。さがす字を入れたときは全部出す
    const rest = q || st.more ? 0 : Math.max(0, list.length - FIRST);
    return list.slice(0, list.length - rest).map(({ j, mine }) => `
      <button type="button" role="radio" data-job="${j.chuban}" aria-checked="${!st.typed && st.chuban === j.chuban}">
        <span class="chuban">${j.chuban}</span><span class="kenmei">${show(j.kenmei)}</span>
        <span class="jmeta">${kaisha(j.chuban) ? show(kaisha(j.chuban)) + "・" : ""}担当 ${esc(j.tantou || "―")}${mine ? "・" + agoText(mine) : ""}</span>
      </button>`).join("") +
      (rest ? `<button type="button" class="more" data-more>ほかの工事も見る（あと ${rest}件）</button>` : "");
  }

  function fixedHTML() {
    return data.fixed.slice().sort((a, b) => a.chuban.localeCompare(b.chuban)).map(j => `
      <button type="button" role="radio" data-job="${j.chuban}" aria-checked="${!st.typed && st.chuban === j.chuban}">
        <span class="chuban">${j.chuban}</span><span class="kenmei">${show(j.kenmei)}</span>
      </button>`).join("");
  }

  function draw() {
    if (!data) return;
    $("#kjOwners").innerHTML = ownersHTML();
    $("#kjList").innerHTML = listHTML();
    $("#kjFixed").innerHTML = fixedHTML();
    note();
  }

  /** 手で書いた注番を、日報とくらべて知らせる */
  function note() {
    const n = $("#kjNote");
    n.className = "hint";
    if (!st.typed || !st.chuban) { n.textContent = ""; return; }
    if (!CHUBAN_RE.test(st.chuban)) { n.textContent = "注番は、英字2文字＋数字5けたです"; n.classList.add("warn"); return; }
    const j = data && data.all.get(st.chuban);
    if (!j) { n.textContent = "日報にない注番です。まちがいがないか、たしかめてください。"; n.classList.add("warn"); return; }
    if (j.closed) { n.textContent = `日報では終わった注番です（${zenkana(j.kenmei)}）。まちがいがないか、たしかめてください。`; n.classList.add("warn"); return; }
    n.textContent = `日報の工事です：${zenkana(j.kenmei)}`;
  }

  el.addEventListener("click", e => {
    const o = e.target.closest("[data-owner]");
    if (o) { st.owner = o.dataset.owner; st.more = false; draw(); return; }
    if (e.target.closest("[data-more]")) { st.more = true; $("#kjList").innerHTML = listHTML(); return; }
    const b = e.target.closest("[data-job]");
    if (b && data) {
      const j = data.all.get(b.dataset.job);
      Object.assign(st, { chuban: j.chuban, kenmei: j.kenmei, typed: false });
      $("#kjNo").value = "";
      $("#kjName").value = "";
      draw();
      changed();
    }
  });
  el.addEventListener("input", e => {
    if (e.target.id === "kjQ") { st.q = e.target.value; if (data) $("#kjList").innerHTML = listHTML(); return; }
    if (e.target.id === "kjNo" || e.target.id === "kjName") {
      const no = normalizeChuban($("#kjNo").value), name = $("#kjName").value.trim();
      if (!no && !name) { Object.assign(st, { chuban: "", kenmei: "", typed: false }); }
      else {
        // 日報にある注番を書いたら、件名が空のときは日報の件名を使う
        const j = data && data.all.get(no);
        Object.assign(st, { chuban: no, kenmei: name || (j ? j.kenmei : ""), typed: true });
      }
      draw();
      changed();
    }
  });
  el.addEventListener("change", e => {
    // 欄から出たら、そろえた注番を見せる
    if (e.target.id === "kjNo" && st.typed) e.target.value = st.chuban;
  });

  return {
    setJobs(d) { data = d; draw(); },
    value,
    check() {
      if (!st.chuban) return "どの工事の材料か、えらんでください";
      if (st.typed && !CHUBAN_RE.test(st.chuban)) return "注番は、英字2文字＋数字5けたで書いてください";
      if (st.typed && !st.kenmei) return "工事件名も書いてください";
      return "";
    },
  };
}
