// LINE の注文の書き込みを読む（11章 7-2。試作の parseLine・matchSup と同じ考え方）
// - 「注文先」「注番」「品名」「納入希望日」「納品場所」「注文者」「担当者」などの見出しで分ける。見出しのない行はメモ
// - 注文先の名前は、登録の材料屋の名前と読みかえ（設定の材料屋 → 読みかえ）でそろえる。知らない名前は勝手に足さない
// - 届け先・材料屋の名前はコードに書かない（データベースの表から読む）
// - このファイルは画面を持たない（js/line-chumon.js から使う）

const nfkc = s => String(s ?? "").normalize("NFKC");
const clean = s => nfkc(s).replace(/[\t　]/g, " ").replace(/\s+/g, " ").trim();

/** 「佐藤（090-1234-5678）」→ 名前だけ。電話番号は名前に入れない（元の文には残る） */
const nameOnly = v => v.replace(/[(（]\s*[0-9\-－ー‐ ]{6,}\s*[)）]/g, " ").replace(/\b0[0-9]{1,4}-?[0-9]{1,4}-?[0-9]{3,4}\b/g, " ").replace(/\s+/g, " ").trim();

/* ---------- 電話番号を消す（のこす「LINE の元の文」から。持ち主 10/13） ----------
   0 ではじまる10〜11けた（+81 ではじまるものも）。区切りの「-」「ー」・空白・かっこ、全角の数字も見る。
   日付（2026-10-13）や注番（AB26123）、寸法などは 0 ではじまらないか、けたが合わないので消さない */
const TEL_CAND = /[+＋]?[(（]?[0-9０-９][0-9０-９\s\-－ー‐―−()（）]{7,20}[0-9０-９]/g;
export function maskTel(text) {
  return String(text ?? "").replace(TEL_CAND, m => {
    const d = m.normalize("NFKC").replace(/[^0-9+]/g, "");
    const n = d.startsWith("+81") ? "0" + d.slice(3) : d;
    if (!/^0[0-9]{9,10}$/.test(n)) return m;
    // 「佐藤（090-…）」のかっこは、閉じかっこが番号のうしろに残るので、開きかっこも残す。「(089)123-…」は番号の中で閉じる
    const lead = /^[(（]/.test(m) ? m[0] : "";
    return lead && !/[)）]/.test(m.slice(1)) ? lead + "電話番号" : "（電話番号）";
  });
}

// どの欄にも入れない、あいさつだけの行
const GREET = /^(お疲れ様です|おつかれさまです|お世話になっております|お世話になります|よろしくお願いします|宜しくお願いします|よろしくお願いいたします|宜しくお願い致します|お願いします|以上です?)[。.!！ ]*$/;

const LABELS = [
  ["supplier", /^(注文先|発注先)/], ["kenmei", /^(工事件名|工事名|件名)/], ["chuban", /^(注文番号|注番)/],
  ["items", /^(品名|品目)/], ["kibou", /^(納入希望日|希望納期|納入希望|納期|希望日)/],
  ["basho", /^(納品場所|納入場所|納品先|納入先|届け先)/], ["chumonsha", /^注文者/], ["tantou", /^担当者?/],
];

/** LINE の書き込み → { supplier, kenmei, chuban, items, kibou, basho, chumonsha, tantou, memo }（どれも文字） */
export function parseLineText(text) {
  const f = { supplier: [], kenmei: [], chuban: [], items: [], kibou: [], basho: [], chumonsha: [], tantou: [], memo: [] };
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) { if (cur && f[cur].length) cur = null; continue; }
    if (/^(午前|午後)?\s*\d{1,2}:\d{2}$/.test(line)) continue;   // LINE の時刻だけの行
    if (GREET.test(line)) continue;                               // あいさつだけの行は、どの欄にも入れない
    const hit = LABELS.find(([, re]) => re.test(line));
    if (hit) {
      cur = hit[0];
      const rest = line.replace(hit[1], "").replace(/^[\s:：・]+/, "").trim();
      if (rest) f[cur].push(rest);
      continue;
    }
    // 品名は何行でも。ほかの欄は1行だけ（見出しの次の行に書く人もいるので、1行目はその欄。2行目からはメモ）
    if (cur && cur !== "items" && f[cur].length) cur = null;
    (cur ? f[cur] : f.memo).push(line);
  }
  const chubanText = f.chuban.join(" ").toUpperCase();
  return {
    supplier: f.supplier.join(" ").replace(/\s*(御中|様)\s*$/, "").trim(),
    kenmei: f.kenmei.join(" "),
    chuban: (chubanText.match(/[A-Z]{2}\s*[0-9OIL]{5}/) || [chubanText])[0].replace(/\s/g, ""),
    items: f.items.join("\n"),
    kibou: f.kibou.join(" "),
    basho: f.basho.join(" "),
    chumonsha: nameOnly(f.chumonsha.join(" ")),
    tantou: nameOnly(f.tantou.join(" ")),
    memo: f.memo.join("\n"),
  };
}

/* ---------- 納入希望日 ---------- */
const pad = n => String(n).padStart(2, "0");
const ymdOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 「最短」「至急」→ "最短"、「10月8日」「10/8」「明日」→ "YYYY-MM-DD"、読めなければ null。today は Date */
export function parseKibou(text, today = new Date()) {
  const s = clean(text);
  if (!s) return null;
  if (/最短|至急|急ぎ|早急|早め|なるべく早く|できるだけ早く|ASAP/i.test(s)) return "最短";
  const plus = n => { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n); return ymdOf(d); };
  if (/明後日|あさって/.test(s)) return plus(2);
  if (/明日|あした|あす/.test(s)) return plus(1);
  if (/今日|本日|きょう/.test(s)) return plus(0);
  const m = s.match(/(\d{1,2})\s*[月/]\s*(\d{1,2})/);
  if (!m) return null;
  const mo = Number(m[1]), da = Number(m[2]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  // 年は書かれないので、今日から見て近いほう（2か月より前なら来年）
  let d = new Date(today.getFullYear(), mo - 1, da);
  if (d.getMonth() !== mo - 1) return null;
  if (d < new Date(today.getFullYear(), today.getMonth() - 2, today.getDate())) d = new Date(today.getFullYear() + 1, mo - 1, da);
  return ymdOf(d);
}

/* ---------- 届け先 ---------- */
/** 届け先の名前から、さがす言葉（「○○工場」→「○○工場」「○○」、「取りに行く」→「取りに行く」「取り」） */
const placeWords = name => {
  const n = clean(name), w = [n];
  const short = n.replace(/(工場|現場|事務所|に行く|へ行く|行く)$/, "");
  if (short && short !== n && short.length >= 2) w.push(short);
  return w;
};
/** 文の中から届け先をさがす。places = [[id, {name}]]（並び順）。見つからなければ "" */
export function findPlace(texts, places) {
  for (const t of texts.map(clean).filter(Boolean)) {
    const hit = places.find(([, p]) => placeWords(p.name).some(w => t.includes(w)));
    if (hit) return hit[0];
  }
  return "";
}

/* ---------- 注文先の名前をそろえる ---------- */
/** 比べる形：会社の種類・御中・様・さんをとる */
export const supKey = s => nfkc(s).replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲|御中|様|さん/g, " ").replace(/\s+/g, " ").trim();
const bigrams = s => { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a.length ? a : [s]; };
const sim = (a, b) => { const A = bigrams(a), B = new Set(bigrams(b)); return A.filter(x => B.has(x)).length / Math.max(A.length, B.size); };
const aliasList = s => (Array.isArray(s.alias) ? s.alias : Object.values(s.alias || {})).map(a => supKey(a).replace(/\s/g, "")).filter(Boolean);

/** LINE の注文先 → { id, how, raw, clean, near: [id] }
 *  how: "same"（そのまま）・"fixed"（そろえた）・"omakase"（任せます）・"unknown"（知らない）・"empty"
 *  sups = [[id, {name, alias, hidden}]]。かくした材料屋には当てない */
export function matchSupplier(raw, sups) {
  const orig = clean(raw);
  const s = supKey(orig);
  if (!s) return { id: "", how: "empty", raw: orig };
  if (/任せ|まかせ|おまかせ|どこでも/.test(s)) return { id: "", how: "omakase", raw: orig };
  const words = s.split(" "), flat = s.replace(/\s/g, "");
  const live = sups.filter(([, x]) => !x.hidden);
  const byName = n => live.find(([, x]) => supKey(x.name).replace(/\s/g, "") === n);
  for (const t of [flat, words[0]]) {
    const hit = byName(t);
    if (hit) return { id: hit[0], how: clean(hit[1].name) === orig ? "same" : "fixed", raw: orig };
  }
  const al = live.find(([, x]) => aliasList(x).some(a => a.length >= 2 && flat.includes(a)));
  if (al) return { id: al[0], how: "fixed", raw: orig };
  const part = live.filter(([, x]) => { const n = supKey(x.name).replace(/\s/g, ""); return flat.includes(n) || (words[0].length >= 2 && n.startsWith(words[0])); });
  if (part.length === 1) return { id: part[0][0], how: "fixed", raw: orig };
  const near = live.map(([id, x]) => [id, sim(words[0], supKey(x.name).replace(/\s/g, ""))]).filter(x => x[1] >= 0.25)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  return { id: "", how: "unknown", raw: orig, clean: words[0], near };
}

/** えらんだ材料屋の読みかえに足す言葉（足さなくてよいときは ""） */
export function aliasToLearn(raw, sup, sups) {
  const k = supKey(raw).replace(/\s/g, "");
  if (!k || k.length < 2 || k === supKey(sup.name).replace(/\s/g, "")) return "";
  if (sups.some(([, x]) => aliasList(x).includes(k))) return "";   // もうどこかの読みかえにある
  return k;
}

/* ---------- 覚えた当て方（7-4） ----------
   一度たしかめて入れた品名の書き方は /zairyo/master/itemMemo に覚えて、次から AI なしで当てる。
   くらべる形は、全角半角・大文字小文字・空白・「×」「x」「*」のちがいをそろえたもの */
export const memoKey = s => nfkc(s).toUpperCase().replace(/\s+/g, "").replace(/[×X*]/g, "x");
/** データベースのキーに使える形（. # $ [ ] / を使わない） */
export const memoDbKey = s => encodeURIComponent(memoKey(s)).replace(/\./g, "%2E").slice(0, 300);
