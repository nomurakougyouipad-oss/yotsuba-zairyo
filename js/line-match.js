// LINE の品名を品物一覧に当てる（11章 7-4。試作の「品物一覧に当てる」と同じ動き）
// - 1行ずつ「数」を分けて、覚えた当て方（/zairyo/master/itemMemo）→ なければ AI（サーバーの zairyoAi task "match"）で当てる
// - 書いていない値（材質など）はオレンジの行で「どれですか？」と出し、えらぶまで入れられない。ちがう行は「なおす」
// - 品物ではない行（ミルシートお願いします など）はメモへ。「品物にする」でもどせる
// - 入れたときに、たしかめた当て方を覚える（次から同じ書き方は AI なしで当たる。2行までの品物）
// - AI が使えないときは、品名は文のまま入る（7-1 の形）
// - 11/5（事務員さん）：品名は、出さない行（FSGP のときの厚さ など）の値を入れずに作る（前は覚えた当て方・AI の s40 が FSGP に付いた）。
//   溶接継手（エルボ・チーズ・レジューサ）で SS400 と来たら、オレンジで「FSGP か PT370 か、えらんでください」。
//   品名の行のあとに、サイズ・数だけの行がつづくときは、その行の数だけ品物に分ける。LINE の型番（T/#9010-A-5-S T2.8 など）は品名に残す
// - 11/6（事務員さん）：溶接継手の FSGP は「FSGP（黒）」（SGP・FSGP と書いてあれば FSGP（黒））。「白」と書いてあれば黒にしないで、文のまま
// - 11/9（事務員さん・持ち主）：「なおす」は、行ごとにボタンでえらびなおせる（前は字の欄だけで、書いてある字に合う候補しか出なかった）。
//   どの行にも入らない言葉（SOH・ハブ付・WN など。AI が extra で返す）は、品名のおわりに残す（前は消えて、まちがった注文になった）。
//   溶接フランジは、LINE に書いていない「種類・形・規格」を、はじめからえらんでおくボタン（SOP・FF・10K）で入れて聞かない（材質はいつも聞く）
// - 11/19（事務員さん）：「キャッチクリップTL-11F（栃木屋）」が「タキゲン キャッチクリップ TL-11F(栃木屋)」になった（AI が書いていないメーカーを入れた）。
//   「えらばなくてもよい」行（メーカー・異径の枝・FB の種類）は、AI が「書いていない」と言った値を入れない（空のまま）。メーカーは、LINE の文にその名前がなければ入れない。
//   メーカーが空で、LINE にメーカーのボタンの名前が書いてあれば、それを入れる。メーカーに入れた名前は、品名のおわりに足す字からのぞく
// - 11/24（事務員さん・大岡産業の表）：ねじ込み継手の材質は SUS304・FCMB（黒）・FCMB（白）・S25C（高圧）。「316」「316L」「PT370」は書いてあるまま。
//   「高圧」「S25C」は S25C（高圧）（高圧がない品物ならオレンジ）。S25C（高圧）のときは厚さ（高圧）（Sch80・Sch160）も（fixNeji）
import { ref, get, update } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, call } from "./firebase.js";
import { esc } from "./common.js";
import { buildSpec, fmtQty, rowShown, rowDef, dropHidden, chipHint } from "./tanomu.js";
import { errorText } from "./touroku.js";
import { memoDbKey, headsOf } from "./line-parse.js";

/** box … 表示する入れ物、catalog … normCatalog の品物一覧、splitLine … 1行を {spec, qty, unit} にする、onState() … ようすが変わったとき */
export function createMatcher({ box, catalog, splitLine, onState }) {
  let memo = {}, match = null, seq = 0;
  const memoReady = get(ref(db, "zairyo/master/itemMemo")).then(s => { memo = s.val() || {}; }, () => { });
  const ITEM = catalog.item;
  const units = catalog.units || [];

  /** 出さない行（「この行を出すとき」に合わない行）の値をのぞいた値（品名・注文の行・覚える当て方に使う。11/5） */
  const shownVals = (it, vals) => { const v = { ...(vals || {}) }; dropHidden(it, v); return v; };
  /** 品名に残す型番（11/5）：「#」と英字が入った言葉（T/#9010-A-5-S など）か No.○○ と、すぐあとの厚さ（T2.8 など）。#240 のような数だけのものは残さない */
  const modelOf = s => {
    const m = String(s || "").match(/(?:^|\s)((?:\S*[A-Za-z]\S*#\S*|\S*#\S*[A-Za-z]\S*|No\.\s?\S+)(?:\s+[Tt]\d+(?:\.\d+)?)?)/);
    return m ? m[1].trim() : "";
  };
  /** どの行にも入らない言葉を、覚えた当て方にしまう名前（vals の中。11/9） */
  const EXTRA = "書いたまま";
  /** LINE に書いていなければ、はじめからえらんでおくボタンで入れて聞かない行（11/9 持ち主：溶接フランジの種類・形・規格だけ。材質はいつも聞く） */
  const LINE_DEF = { "tsugite:flange": ["種類", "形", "規格"] };
  const normU = s => String(s || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  /** 品名：品物一覧のひな形 ＋ 型番 ＋ どの行にも入らない言葉（もう品名に入っていれば足さない） */
  const rowSpec = r => {
    if (!r.key) return r.body;
    let s = buildSpec(ITEM.get(r.key), shownVals(ITEM.get(r.key), r.vals));
    for (const add of [r.model, r.extra]) if (add && !normU(s).includes(normU(add))) s = `${s} ${add}`;
    return s;
  };
  const rowUnit = r => r.unit || (r.key ? ITEM.get(r.key).unit : "") || "個";
  /** 突き合わせ溶接の継手（11/5 事務員さん）：SS400 と来たら、FSGP（黒）（SGP の管）か PT370（STPG・STPT の管）かをえらんでもらう */
  const WELD = new Set(["tsugite:elbow", "tsugite:tee", "tsugite:reducer"]);
  /** FSGP のボタンは「FSGP（黒）」だけ（11/6 事務員さん：小野建に色を言うため。白はあまり頼まない） */
  const FSGP = "FSGP（黒）";
  const WELD_ASK = `SS400 と書いてあります。${FSGP} か PT370 か、えらんでください`;
  /** FSGP・SGP・FSGP黒・FSGP(黒) など → FSGP（黒）にそろえる材質か（白は入れない） */
  const isFsgp = v => /^F?SGP\s*[(（]?\s*黒?\s*[)）]?$/i.test(String(v || "").normalize("NFKC").trim());
  /** 厚さ（スケジュール）が書いてあるか：s40・S40・Sch40・SCH.80・40S・10s・25A10s など。90ES 80A・SS400・SUS304 は厚さではない */
  const hasThick = s => {
    const t = String(s || "").normalize("NFKC");
    return /(?<![A-Z])S(?:CH)?\.?\s?(?:5|10|20|40|80|160)(?![\d.A-Z])/i.test(t) || /(?<![\d.])(?:5|10|20|40|80|160)\s?S(?![A-Z])/i.test(t);
  };
  /** extra … どの行にも入らない言葉（AI の答え。覚えた当て方では vals の「書いたまま」） */
  const mkRow = (ls, key, vals0, guess, qty, unit, how, extra) => {
    const body = ls.map(i => match.parts[i].spec).filter(Boolean).join(" ");
    const vals = { ...(vals0 || {}) };
    const ex = String(extra || vals[EXTRA] || "").trim().slice(0, 200);
    delete vals[EXTRA];
    // 溶接継手で LINE に「白」と書いてあるときは、FSGP（黒）にしないで、書いたまま（文のまま）入れる（11/6 事務員さん）。
    // SUS304・PT370 など、ほかの材質がはっきりしているときは今まで通り
    const white = WELD.has(key) && /白/.test(body) && (!vals["材質"] || isFsgp(vals["材質"]) || vals["材質"] === "SS400");
    const it = key && !white && ITEM.get(key) && !ITEM.get(key).free ? ITEM.get(key) : null;
    const r = {
      lines: ls, raw: ls.map(i => match.raws[i]).join(" ／ "), body, orig: body,   // orig＝覚えるときの元の書き方（なおしても変えない）
      key: it ? key : null, vals: { ...vals }, qty: qty == null ? null : qty, unit: unit || (it ? it.unit : ""), how,
      ask: [...(guess || [])].filter(k => it && it.opts.some(o => o[0] === k && !o[2]) && rowShown(it, k, vals)),   // 「えらばなくてもよい」行・出さない行（10/21）は聞かない
      askNote: {}, model: it ? modelOf(body) : "", white, extra: it ? ex : "",
    };
    if (it) fixOptional(r, it, body, guess);
    // 溶接フランジの種類・形・規格は、LINE に書いていなければ（AI が guess にした・値がない）はじめからえらんでおくボタンで入れて聞かない（11/9 持ち主）
    const quiet = it ? (LINE_DEF[r.key] || []).filter(k => rowDef(it, k)) : [];
    quiet.forEach(k => { if (!r.vals[k] || (guess || []).includes(k)) r.vals[k] = rowDef(it, k); });
    r.ask = r.ask.filter(k => !quiet.includes(k));
    // 溶接継手の材質のよび方をそろえる：管の名前（STPT・STPG → PT370、SGP・FSGP → FSGP（黒）。事務員さんの見分け方 11/5・11/6）
    if (it && WELD.has(r.key) && /^(STPT|STPG)/i.test(r.vals["材質"] || "")) r.vals["材質"] = "PT370";
    if (it && WELD.has(r.key) && isFsgp(r.vals["材質"])) r.vals["材質"] = FSGP;
    if (it && WELD.has(r.key) && r.vals["材質"] === "SS400") {
      delete r.vals["材質"];
      if (!r.ask.includes("材質")) r.ask.unshift("材質");
      r.askNote["材質"] = WELD_ASK;
    }
    // 溶接継手の厚さは、LINE に書いてあるときだけ入れる。書いていなければ AI・覚えた当て方の厚さは使わずに聞く（11/5 持ち主）
    if (it && WELD.has(r.key) && !hasThick(body)) Object.keys(r.vals).filter(k => /^厚さ/.test(k)).forEach(k => delete r.vals[k]);
    if (it && WELD.has(r.key) && r.vals["材質"]) askMore(r);
    if (it && r.key === NEJI) fixNeji(r, body, guess);
    if (r.qty == null) r.ask.push("数");
    return r;
  };
  /** くらべるための書き方のゆれをそろえる（11/19 持ち主：半角カナ・英字の大文字小文字・ひらがなとカタカナ・かっこ・「磨き」と「ミガキ」など）。品名には使わない */
  const SAME_WORDS = [["磨き", "ミガキ"], ["磨", "ミガキ"], ["黒皮", "クロカワ"]];
  const fold = s => {
    let t = String(s || "").normalize("NFKC").toUpperCase().replace(/[\s()（）「」［］[\]・]/g, "");
    t = t.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));   // ひらがな → カタカナ
    for (const [a, b] of SAME_WORDS) t = t.split(a).join(b);
    return t;
  };
  /** LINE の文に、その値が書いてあるか（書き方がちがうだけも、書いてあるにする。「ホット材」は「ホット」でもよい） */
  const written = (body, v) => {
    const b = fold(body), x = fold(v);
    return !!x && (b.includes(x) || (x.length > 2 && x.endsWith("材") && b.includes(x.slice(0, -1))));
  };
  /** 「えらばなくてもよい」行は、LINE に書いてあるときだけ入れる（11/19 事務員さん：キャッチクリップ TL-11F（栃木屋）が「タキゲン」になった）。
   *  AI の当てで、その行に値が入っているとき：
   *  - LINE の文に書いてある（書き方がちがうだけも）→ そのまま
   *  - メーカーで、AI のとちがうボタンの名前が書いてある → そのボタン
   *  - AI も「書いていない」と言い（guess）、文にもない → 入れない（空のまま）
   *  - AI は「書いてある」と言うのに、文に見つからない → 消さずに、オレンジで聞く（11/19 持ち主「あやしいときは聞く」）
   *  メーカーが空で、LINE にメーカーのボタンの名前が書いてあれば入れる（2つ書いてあればオレンジで聞く）。
   *  覚えた当て方は、事務員さんがえらんだ値なので、そのまま。メーカーに入れた名前は、品名のおわりに足す字からのぞく */
  const MAKER = "メーカー";
  function fixOptional(r, it, body, guess) {
    const ask = (k, note) => { if (!r.ask.includes(k)) r.ask.push(k); r.askNote[k] = note; r.optAsk = { ...(r.optAsk || {}), [k]: true }; };
    if (r.how === "ai") {
      it.opts.filter(o => o[2] && r.vals[o[0]]).forEach(([k, ch]) => {
        const v = r.vals[k];
        if (written(body, v)) return;
        const other = k === MAKER ? ch.filter(c => c && c !== v && written(body, c)) : [];
        if (other.length === 1) { r.vals[k] = other[0]; return; }
        if (!other.length && (guess || []).includes(k)) { delete r.vals[k]; return; }
        ask(k, `「${v}」が LINE に見つかりません。${k}はどれですか？（えらばなくてもよい）`);
      });
    }
    const mk = it.opts.find(o => o[0] === MAKER);
    if (!mk) return;
    if (r.how === "ai" && !r.vals[MAKER]) {
      const hits = mk[1].filter(v => v && written(body, v));
      if (hits.length === 1) r.vals[MAKER] = hits[0];
      else if (hits.length > 1) ask(MAKER, `メーカーが ${hits.join("・")} と2つ以上書いてあります。どれですか？（えらばなくてもよい）`);
    }
    const v = String(r.vals[MAKER] || "").trim();
    if (v && r.extra) {
      const e = v.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), x = r.extra.normalize("NFKC");
      const y = x.replace(new RegExp(`\\(\\s*${e}\\s*\\)|${e}`, "g"), " ").replace(/\s+/g, " ").trim();
      if (y !== x.replace(/\s+/g, " ").trim()) r.extra = y;
    }
  }
  /** ねじ込み継手の材質（11/19 事務員さん）：SUS304・SUS316L・FCMB（黒）・FCMB（白）・PT370。ソケットだけ SS400 も（「材質（ソケット）」の行）。
   *  「白」「黒」は FCMB（白）・FCMB（黒）。ソケット以外で SS400 なら、オレンジで「FCMB（黒）・FCMB（白）・PT370 のどれか」を聞く（黒・白が書いてあれば、それをおすすめに）。
   *  ソケットで LINE に SS400 と書いてあれば SS400。覚えた当て方は、その値（SS400黒 などの前の値もそろえる） */
  // 11/24（事務員さん・大岡産業の表）：材質は SUS304・FCMB（黒）・FCMB（白）・S25C（高圧）。SUS316L・PT370 はボタンから外した（PT370 はねじ込みにない）。
  //   S25C（高圧）は、高圧がある品物（エルボ・45°エルボ・チーズ・ソケット・六角ニップル・プラグ）の「材質」「材質（ソケット）」の行だけ。
  //   ほかの品物（ユニオン・ニップル・キャップ・ブッシング）は「材質（高圧なし）」の行。どの行を出すかは品物一覧の「この行を出すとき」で決める。
  //   S25C（高圧）のときだけ「厚さ（高圧）」（Sch80・Sch160）。LINE の「316」「316L」「PT370」は、ほかの材質にしないで書いてあるまま。
  //   「高圧」「S25C」は S25C（高圧）。高圧がない品物で「高圧」と書いてあれば、オレンジで聞く
  const NEJI = "tsugite:neji", NEJI_SOCK = "材質（ソケット）", NEJI_LOW = "材質（高圧なし）", NEJI_ROWS = ["材質", NEJI_LOW, NEJI_SOCK];
  const HIGH = "S25C（高圧）", NEJI_THICK = "厚さ（高圧）";
  /** LINE に書いてある、ボタンにない材質（316・316L・PT370）を、書いてあるまま */
  const nejiWritten = t => { const m = t.match(/SUS\s*316L?|(?<![\dA-Z])316L?(?![\d])|PT\s*370/i); return m ? m[0].toUpperCase().replace(/\s+/g, "") : ""; };
  const nejiMat = v => {
    const m = String(v || "").normalize("NFKC").trim();
    if (/316/.test(m) || /PT\s*370/i.test(m)) return m;   // 書いてあるまま（11/24）
    if (/S\s*25\s*C|高圧/i.test(m)) return HIGH;
    if (/SUS/i.test(m)) return "SUS304";
    if (/白/.test(m)) return "FCMB（白）";
    if (/黒/.test(m)) return "FCMB（黒）";
    if (/FCMB/i.test(m)) return "FCMB（黒）";
    if (/SS\s*400/i.test(m)) return "SS400";
    return m;
  };
  function fixNeji(r, body, guess) {
    const it = ITEM.get(r.key), name = r.vals["品名"];
    if (!name || !it.opts.some(o => o[0] === NEJI_SOCK)) return;   // 品名がまだ・前の品物一覧（行が1つ）のときは、そのまま
    const has = k => it.opts.some(o => o[0] === k);
    // この品名で出る材質の行（品物一覧の「この行を出すとき」）。前の品物一覧（高圧なしの行がない）は 材質／材質（ソケット）
    const row = NEJI_ROWS.find(k => has(k) && rowShown(it, k, { 品名: name })) || (name === "ソケット" ? NEJI_SOCK : "材質");
    const btns = (it.opts.find(o => o[0] === row) || [row, []])[1];
    const t = String(body || "").normalize("NFKC"), memo = r.how === "memo";
    let v = nejiMat(NEJI_ROWS.map(k => r.vals[k]).find(Boolean));
    NEJI_ROWS.forEach(k => { if (k !== row) delete r.vals[k]; });
    const asked = (guess || []).some(k => NEJI_ROWS.includes(k));
    r.ask = r.ask.filter(k => !NEJI_ROWS.includes(k));
    if (!memo) {   // LINE に書いてある材質を先に（覚えた当て方は、事務員さんがえらんだ値のまま）
      // SUS304 と「高圧」が両方書いてあるときは、S25C（高圧）にしないで書いてあるまま（11/24 持ち主：大岡さんの表には SUS304 の高圧もある。316 と同じあつかい）
      const w = nejiWritten(t) || (/SUS\s*304/i.test(t) && /高圧/.test(t) ? "SUS304" : "");
      if (w) v = /高圧/.test(t) ? withHigh(t, w) : w;
      else if (/高圧|S\s*25\s*C/i.test(t)) v = HIGH;
      else if (/SS\s*400/i.test(t)) v = "SS400";   // ソケットは SS400 のまま・ほかは下で聞く
    }
    const ask = note => { r.ask.unshift(row); r.askNote[row] = note; };
    const pick = btns.filter(b => /FCMB|S25C/.test(b)).join("・");
    if (row !== NEJI_SOCK && v === "SS400") {   // ソケット以外の SS400 は聞く
      const rec = /白/.test(t) ? "FCMB（白）" : /黒/.test(t) ? "FCMB（黒）" : "";
      if (rec) r.vals[row] = rec; else delete r.vals[row];
      ask(memo && !/SS\s*400/i.test(t) ? `前は「SS400」で覚えていました。${pick} のどれですか？` : `SS400 と書いてあります。${pick} のどれですか？`);
      return;
    }
    if (v === HIGH && !btns.includes(HIGH)) {   // 高圧がない品物（ユニオン・キャップ など）
      delete r.vals[row];
      ask(`「高圧」と書いてありますが、高圧の${name}はボタンにありません。どれですか？（ほかの材質なら「なおす」で書けます）`);
      return;
    }
    if (v) r.vals[row] = v; else delete r.vals[row];
    if (asked && !memo && !/SUS|316|PT\s*370|高圧|S\s*25\s*C|白|黒|FCMB|SS\s*400/i.test(t)) r.ask.unshift(row);   // 材質が書いていなければ聞く
    // 厚さ（高圧）：LINE の Sch80・S80・80S などを Sch80・Sch160 に。書いていなければ、えらぶまで入れられない（askMore）
    const m = t.match(/S(?:CH)?\.?\s?(80|160)(?![\d])|(?<![\d])(80|160)\s?S(?![A-Z])/i);
    if (has(NEJI_THICK) && rowShown(it, NEJI_THICK, r.vals)) {
      const hit = m ? `Sch${m[1] || m[2]}` : nejiThick(r.vals[NEJI_THICK]);
      if (hit) r.vals[NEJI_THICK] = hit; else delete r.vals[NEJI_THICK];
    } else {
      delete r.vals[NEJI_THICK];
      // 厚さの行が出ない材質（SUS304 高圧・316 など書いたままの材質）で厚さが書いてあれば、品名のおわりに残す（消えないように）
      if (m && !normU(`${r.extra || ""}`).includes(normU(m[0]))) r.extra = `${r.extra || ""} ${m[0]}`.trim();
    }
    askMore(r);
  }
  /** 書いたままの材質に「高圧」をつける：LINE の「SUS304高圧」「高圧 SUS304」などはその字のまま、はなれていれば「SUS304 高圧」 */
  const withHigh = (t, w) => {
    const core = w.replace(/^SUS/i, "").replace(/L$/i, "");
    const re = new RegExp(`(?:SUS\\s*)?${core}L?\\s*[（(]?\\s*高圧\\s*[)）]?|高圧\\s*(?:SUS\\s*)?${core}L?`, "i");
    const hit = t.match(re);
    return hit ? hit[0].replace(/\s+/g, " ").trim() : `${w} 高圧`;
  };
  const nejiThick = v => { const n = (String(v || "").match(/80|160/) || [])[0]; return n ? `Sch${n}` : ""; };
  /** 溶接継手の厚さ：書いてある厚さ（s40・40S・Sch40 など）を、いまの材質で出ている厚さの行にうつす。
   *  PT370 は「厚さ（PT370）」の s40・s80 だけ、SUS304 は今まで通りの行（11/5）。合うボタンがないときは聞く */
  const fixThick = r => {
    const it = r.key && WELD.has(r.key) ? ITEM.get(r.key) : null;
    if (!it || !r.vals["材質"]) return;
    const shown = it.opts.find(([k]) => /^厚さ/.test(k) && rowShown(it, k, r.vals));
    if (!shown || r.vals[shown[0]]) return;
    const was = Object.keys(r.vals).filter(k => /^厚さ/.test(k) && k !== shown[0] && r.vals[k]).map(k => r.vals[k])[0];
    if (!was) return;
    const num = s => (String(s).match(/\d+/) || [])[0];
    const hit = shown[1].find(b => num(b) === num(was));
    if (hit) r.vals[shown[0]] = hit;
    else r.askNote[shown[0]] = `${was} と書いてあります。${r.vals["材質"]} は ${shown[1].join("・")} です。どれですか？`;
  };
  /** えらんだら出てくる行（PT370 にしたら厚さ など）で、まだ値がない行も聞く（11/5） */
  const askMore = r => {
    const it = r.key ? ITEM.get(r.key) : null;
    if (!it) return;
    fixThick(r);
    it.opts.forEach(([k, , opt]) => { if (!opt && !r.vals[k] && !r.ask.includes(k) && rowShown(it, k, r.vals)) r.ask.splice(r.ask.includes("数") ? r.ask.indexOf("数") : r.ask.length, 0, k); });
    r.ask = r.ask.filter(k => k === "数" || rowShown(it, k, r.vals));   // えらんで出なくなった行は聞かない
  };

  /* ---------- 当てる ---------- */
  async function run(text) {
    const raws = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const my = ++seq;
    if (!raws.length) { match = null; render(); return; }
    await memoReady;
    if (my !== seq) return;
    match = { src: text, raws, parts: raws.map(splitLine), rows: [], notes: [], busy: false, err: "" };
    const { parts } = match, todo = [];
    // 品名の行（数なし）のあとに、サイズ・数だけの行がつづくときは、その行の数だけ品物に分ける（11/5。line-parse.js headsOf）。
    // 例「テフロンサンド リングパッキン T/#9010-A-5-S T2.8」「5k×100A ×1枚」「10k×100A ×6枚」→ 2つ（どちらも品名の行つき）
    const head = headsOf(parts), heads = new Set(Object.values(head));   // head[サイズの行] ＝ その上の品名の行
    const specOf = i => (head[i] != null ? `${parts[head[i]].spec} ${parts[i].spec}` : parts[i].spec);
    const linesOf = i => (head[i] != null ? [head[i], i] : [i]);
    for (let i = 0; i < parts.length; i++) {
      if (heads.has(i)) continue;   // 品名の行は、下のサイズの行といっしょに当てる
      const m = memo[memoDbKey(specOf(i))];
      const m2 = !m && head[i] == null && i + 1 < parts.length && head[i + 1] == null ? memo[memoDbKey(parts[i].spec + " " + parts[i + 1].spec)] : null;   // 見出し＋サイズの2行
      if (m && m.note) match.notes.push(...linesOf(i));
      else if (m) match.rows.push(mkRow(linesOf(i), m.free ? null : m.key, m.free ? {} : m.vals, [], parts[i].qty, parts[i].unit, "memo"));
      else if (m2 && !m2.note) { match.rows.push(mkRow([i, i + 1], m2.free ? null : m2.key, m2.free ? {} : m2.vals, [], parts[i + 1].qty, parts[i + 1].unit, "memo")); i++; }
      else todo.push(i);
    }
    match.notes = [...new Set(match.notes)];
    match.busy = todo.length > 0;
    render();
    if (!todo.length) return;
    try {
      // 品名の行につづくサイズの行は、品名の行をつけた文で当てる（番号はサイズの行）
      const r = (await call("zairyoAi", { timeout: 180000 })({ task: "match", lines: todo.map(i => ({ i, text: head[i] != null ? `${raws[head[i]]} ${raws[i]}` : raws[i] })) })).data;
      if (my !== seq) return;
      const covered = new Set(r.notes);
      r.notes.forEach(i => match.notes.push(i));
      r.rows.forEach(x => {
        x.lines.forEach(i => covered.add(i));
        const last = parts[x.lines[x.lines.length - 1]];
        const ls = [...new Set(x.lines.flatMap(linesOf))].sort((a, b) => a - b);
        match.rows.push(mkRow(ls, x.key, x.vals, x.guess, x.qty != null ? x.qty : last.qty, x.unit || last.unit, x.key ? "ai" : "free", x.extra));
      });
      // AI がどこにも入れなかった行は、文のままの品物にする
      todo.filter(i => !covered.has(i)).forEach(i => match.rows.push(mkRow(linesOf(i), null, {}, [], parts[i].qty, parts[i].unit, "free")));
      match.rows.sort((a, b) => a.lines[0] - b.lines[0]);
      match.busy = false;
    } catch (ex) {
      if (my !== seq) return;
      match = { src: text, raws, parts, rows: [], notes: [], busy: false, err: errorText(ex) };
    }
    render();
  }

  /* ---------- 表示 ---------- */
  const optsOf = r => (r.key ? ITEM.get(r.key).opts : []);
  function rowHTML(r, i) {
    const it = r.key ? ITEM.get(r.key) : null;
    const askHTML = r.ask.map(k => {
      if (k === "数") return '<div class="mtr-ask"><span>数が書いてありません。「なおす」で入れてください</span></div>';
      const ch = (optsOf(r).find(o => o[0] === k) || [k, []])[1];
      const g0 = r.vals[k] || "";
      // ボタンの下の小さい字（⚙ 設定の「ボタンの下の字」。FSGP「SGP の管用・スケジュールなし」など。11/5）
      // 「えらばなくてもよい」行で聞くとき（11/19）：AI の値は「おすすめ」にしないで「AI の当て」。「書かない（空のまま）」もえらべる
      const opt = !!(r.optAsk && r.optAsk[k]);
      const sub = v => (v === g0 ? (opt ? "AI の当て" : "おすすめ") : chipHint(it, k, v));
      return `<div class="mtr-ask"><span>${esc(r.askNote[k] || `${k}が書いてありません。どれですか？`)}</span><div class="pick sm">` +
        [...new Set([g0, ...ch])].filter(Boolean).map(v => `<button type="button" data-mask="${esc(k)}" data-r="${i}" data-v="${esc(v)}"${v === g0 && !opt ? ' class="rec"' : ""}>${esc(v)}${sub(v) ? `<small>${esc(sub(v))}</small>` : ""}</button>`).join("") +
        (opt ? `<button type="button" data-mask="${esc(k)}" data-r="${i}" data-v="">書かない<small>空のまま</small></button>` : "") +
        "</div></div>";
    }).join("");
    return `
      <li class="mtr${r.ask.length ? " ask" : it ? "" : " free"}" data-r="${i}">
        <div class="mtr-main"><span class="mtr-spec">${esc(rowSpec(r))}</span><span class="mtr-qty num">${r.qty != null ? `×${esc(fmtQty(r.qty))}<small>${esc(rowUnit(r))}</small>` : ""}</span></div>
        ${r.white && !it ? `<span class="tag">文のまま（「白」なので ${FSGP} にしていません）</span>` : r.how === "memo" ? '<span class="tag">前にえらんだ品物</span>' : !it ? '<span class="tag">一覧にない品物（文のまま）</span>' : ""}
        ${it && r.extra ? `<span class="tag">「${esc(r.extra)}」は、どの行にも入らないので品名に残しました</span>` : ""}
        <div class="mtr-foot"><span class="mtr-src">LINE：${esc(r.raw)}</span>${r.editing ? "" : `<button type="button" class="linkbtn muted" data-medit="${i}">なおす</button>`}</div>
        ${askHTML}
        ${r.editing ? editorHTML(r, i) : ""}
      </li>`;
  }
  function editorHTML(r, i) {
    const e = r.ed, it = e.key ? ITEM.get(e.key) : null;
    const kind = `<select class="inp" data-mek="${i}" aria-label="品物"><option value="">一覧にない品物（文のまま）</option>` +
      catalog.cats.map(c => `<optgroup label="${esc(c.name)}">` + c.items.filter(x => !x.free).map(x => {
        const k = `${c.id}:${x.id}`;
        return `<option value="${esc(k)}"${e.key === k ? " selected" : ""}>${esc(x.name)}</option>`;
      }).join("") + "</optgroup>").join("") + "</select>";
    // 行ごとに、スマホと同じボタン（えらんでいるものは色つき。もう一度押すとやめる）と、ボタンにない値を書く欄（11/9）。
    // 前は字の欄（候補つき）だけで、字が入っている行は、その字に合う候補しか出なかった（呼び径しかえらべないように見えた）
    const fields = it
      ? it.opts.filter(([k]) => rowShown(it, k, e.vals)).map(([k, ch, opt]) => {
        const v = e.vals[k] || "", other = !!v && !ch.includes(v);
        return `<div class="mte-f wide"><span>${esc(k)}${opt ? "（えらばなくてもよい）" : ""}</span><div class="pick sm">` +
          ch.map(c => { const h = chipHint(it, k, c); return `<button type="button" data-mepick="${esc(k)}" data-r="${i}" data-v="${esc(c)}" aria-pressed="${v === c}">${esc(c)}${h ? `<small>${esc(h)}</small>` : ""}</button>`; }).join("") +
          `<button type="button" class="oth" data-meoth aria-pressed="${other}">ほか…</button>` +
          `</div><input class="inp" data-mev="${esc(k)}" value="${other ? esc(v) : ""}" placeholder="${esc(k)}を書く" aria-label="${esc(k)}を書く" autocomplete="off"${other ? "" : " hidden"}></div>`;
      }).join("") + `<label class="mte-f wide"><span>品名のおわりに足す字（どの行にも入らない言葉。なければ空）</span><input class="inp" data-meextra value="${esc(e.extra || "")}" autocomplete="off"></label>`
      : `<label class="mte-f wide"><span>品名（文のまま）</span><input class="inp" data-mefree value="${esc(e.body)}"></label>`;
    const u0 = e.unit || (it ? it.unit : "個");
    return `<div class="mte"><label class="mte-f wide"><span>品物</span>${kind}</label><div class="mte-grid">${fields}
        <label class="mte-f"><span>数</span><input class="inp" data-meq inputmode="decimal" value="${e.qtyText != null ? esc(e.qtyText) : e.qty == null ? "" : esc(fmtQty(e.qty))}"></label>
        <label class="mte-f"><span>単位</span><select class="inp" data-meu>${[...new Set([u0, ...units])].map(u => `<option${u === u0 ? " selected" : ""}>${esc(u)}</option>`).join("")}</select></label></div>
      <p class="err" data-meerr></p>
      <div class="row"><button type="button" class="btn primary" data-mok="${i}">これでよい</button><button type="button" class="linkbtn muted" data-mcancel="${i}">やめる</button></div></div>`;
  }
  function render() {
    box.hidden = !match;
    if (!match) { box.innerHTML = ""; onState(); return; }
    let st, cls = "";
    if (match.err) { st = `AI で当てられませんでした（${match.err}）。品名は文のまま入ります`; cls = "bad"; }
    else if (match.busy) st = "AI が品物一覧に当てています…（10秒ほど）";
    else {
      const n = match.rows.filter(r => r.ask.length || r.editing).length;
      st = n ? `当てました。オレンジの ${n} 行をたしかめてください` : "当てました。ちがう行は「なおす」で直せます";
      cls = n ? "warn" : "ok";
    }
    box.innerHTML = `
      <div class="mt-head"><span class="lab">品物一覧に当てる</span><span class="hint ${cls}">${esc(st)}</span>
        ${match.err ? '<button type="button" class="linkbtn" data-mretry>もう一度当てる</button>' : ""}</div>
      <ul class="mtl">${match.err ? "" : match.rows.map(rowHTML).join("")}</ul>
      ${!match.err && match.notes.length ? `<div class="mtn"><span class="lab">品物ではない行（メモに入れます）</span>` +
        match.notes.map(i => `<span class="mtn-r"><span>${esc(match.raws[i])}</span><button type="button" class="linkbtn muted" data-mnote="${i}">品物にする</button></span>`).join("") + "</div>" : ""}`;
    onState();
  }

  /* ---------- 押したとき・書いたとき ---------- */
  const rowAt = el => match && match.rows[Number(el.dataset.r ?? el.closest("[data-r]").dataset.r)];
  box.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t || !match) return;
    const d = t.dataset;
    if (d.mask) {
      const r = match.rows[Number(d.r)];
      if (d.v) r.vals[d.mask] = d.v; else delete r.vals[d.mask];   // 「書かない（空のまま）」（11/19）
      r.ask = r.ask.filter(k => k !== d.mask);
      askMore(r);   // えらんだら出てくる行も聞く（PT370 にしたら厚さ。11/5）
      render();
    } else if (d.medit) {
      const r = match.rows[Number(d.medit)];
      r.editing = true;
      r.ed = { key: r.key, vals: { ...r.vals }, body: r.body, qty: r.qty, unit: rowUnit(r), extra: r.extra || "" };
      render();
      const sel = box.querySelector(`[data-mek="${d.medit}"]`);
      if (sel) sel.focus();
    } else if (d.mepick) {
      // 「なおす」の行のボタン（11/9）：押したボタンにする。もう一度押すと、えらぶのをやめる
      const r = match.rows[Number(d.r)], v = r.ed.vals;
      if (v[d.mepick] === d.v) delete v[d.mepick]; else v[d.mepick] = d.v;
      render();
    } else if ("meoth" in d) {
      // 「ほか…」：ボタンにない値を書く欄を出す（スマホと同じ）
      const inp = t.closest(".mte-f").querySelector("[data-mev]");
      inp.hidden = false;
      t.setAttribute("aria-pressed", "true");
      inp.focus();
    } else if (d.mcancel) {
      match.rows[Number(d.mcancel)].editing = false;
      render();
    } else if (d.mok) {
      const r = match.rows[Number(d.mok)], e2 = r.ed, li = t.closest("li"), err = li.querySelector("[data-meerr]");
      const q = parseFloat(String(li.querySelector("[data-meq]").value).normalize("NFKC"));
      e2.unit = li.querySelector("[data-meu]").value;
      if (!(q > 0 && q < 100000)) { err.textContent = "数を入れてください"; return; }
      const spec = e2.key ? buildSpec(ITEM.get(e2.key), shownVals(ITEM.get(e2.key), e2.vals)) : String(e2.body || "").trim();
      if (!spec) { err.textContent = e2.key ? "値を1つ以上入れてください" : "品名を入れてください"; return; }
      Object.assign(r, { key: e2.key, vals: e2.key ? e2.vals : {}, body: e2.key ? r.body : spec, qty: q, unit: e2.unit, ask: [], editing: false, how: "edit",
        extra: e2.key ? String(e2.extra || "").trim().slice(0, 200) : "" });
      render();
    } else if (d.mnote) {
      const i = Number(d.mnote), p = match.parts[i];
      match.notes = match.notes.filter(x => x !== i);
      match.rows.push(mkRow([i], null, {}, [], p.qty, p.unit, "free"));
      match.rows.sort((a, b) => a.lines[0] - b.lines[0]);
      render();
    } else if ("mretry" in d) {
      run(match.src);
    }
  });
  box.addEventListener("input", e => {
    const t = e.target, r = t.closest("[data-r]") && rowAt(t);
    if (!r || !r.ed) return;
    if (t.dataset.mev) {
      const v = t.value.trim();
      if (v) r.ed.vals[t.dataset.mev] = v; else delete r.ed.vals[t.dataset.mev];
      // ボタンにない値を書いたら、その行のボタンの色を消す（書いた値が品名に入る）
      if (v) t.closest(".mte-f").querySelectorAll("[data-mepick]").forEach(b => b.setAttribute("aria-pressed", "false"));
    }
    if ("mefree" in t.dataset) r.ed.body = t.value;
    if ("meextra" in t.dataset) r.ed.extra = t.value;
    if ("meq" in t.dataset) r.ed.qtyText = t.value;   // ボタンを押して書きなおしても、書いた数がのこるように（11/9）
  });
  box.addEventListener("change", e => {
    const t = e.target;
    if ("meu" in t.dataset) { const r = rowAt(t); if (r && r.ed) r.ed.unit = t.value; return; }
    if (!t.dataset.mek) return;
    const r = match.rows[Number(t.dataset.mek)], old = r.ed.key ? ITEM.get(r.ed.key) : null, it = t.value ? ITEM.get(t.value) : null;
    if (!r.ed.unit || (old && r.ed.unit === old.unit)) r.ed.unit = it ? it.unit : r.ed.unit;
    r.ed.key = t.value || null;
    if (it) { const keep = {}; it.opts.forEach(([k]) => { if (r.ed.vals[k]) keep[k] = r.ed.vals[k]; }); r.ed.vals = keep; }
    // 品物をかえたら、聞かずに入れる行（溶接フランジの種類・形・規格）は、はじめからえらんでおくボタンにしておく（11/9）
    if (it) (LINE_DEF[t.value] || []).forEach(k => { if (!r.ed.vals[k] && rowDef(it, k)) r.ed.vals[k] = rowDef(it, k); });
    render();
    const sel = box.querySelector(`[data-mek="${t.dataset.mek}"]`);
    if (sel) sel.focus();
  });

  return {
    run,
    clear() { seq++; match = null; render(); },
    /** いまの品名の文に当てたものか（品名を書きかえたら、当てたものは使わない） */
    isFor: text => !!(match && !match.err && match.src === text),
    active: () => !!match,
    /** その品名の文のようす："none"（まだ）・"busy"（AI が当てている）・"done"（当てた）・"err"（当てられなかった） */
    state: text => (!match || match.src !== text ? "none" : match.err ? "err" : match.busy ? "busy" : "done"),
    /** 入れられないわけ（なければ ""） */
    problem() {
      if (match.busy) return "AI が品物一覧に当てているところです。少し待ってください";
      const n = match.rows.filter(r => r.ask.length || r.editing).length;
      if (n) return `たしかめていない品物が ${n}行 あります（オレンジの行）`;
      if (!match.rows.length) return "品物がありません。品名・数量を入れてください";
      return "";
    },
    /** 注文の品物の行 */
    lines: () => match.rows.map(r => {
      const it = r.key ? ITEM.get(r.key) : null;
      const l = { spec: rowSpec(r).slice(0, 300), qty: r.qty, unit: rowUnit(r) };
      if (it) Object.assign(l, { key: r.key, cat: it.cat, name: it.name, vals: shownVals(it, r.vals) });
      return l;
    }),
    /** 品物ではない行の文（メモに足す） */
    noteTexts: () => match.notes.map(i => match.raws[i]),
    /** たしかめて入れた当て方を覚える（2行までの品物と、品物ではない行） */
    async remember() {
      const upd = {}, at = Date.now();
      match.rows.filter(r => r.lines.length <= 2 && r.orig).forEach(r => {
        // 出さない行の値は覚えない（11/5）。どの行にも入らない言葉は「書いたまま」で覚える（次も品名に残す。11/9）
        upd[memoDbKey(r.orig)] = r.key ? { key: r.key, vals: { ...shownVals(ITEM.get(r.key), r.vals), ...(r.extra ? { [EXTRA]: r.extra } : {}) }, at } : { free: true, at };
      });
      match.notes.forEach(i => { const k = memoDbKey(match.parts[i].spec); if (k) upd[k] = { note: true, at }; });
      if (Object.keys(upd).length) await update(ref(db, "zairyo/master/itemMemo"), upd);
    },
  };
}
