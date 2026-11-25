// 注文（事務所）：注文の文を作る・材料屋に注文する・注文を取り消して依頼にもどす
// - 注文は /zairyo/orders/{id}。依頼（/zairyo/requests）には、品物ごとの材料屋（supplier）と注文の番号（orderId）、
//   1つでも注文したら ordered:true、全部注文したら status:"ordered" をつける（注文と依頼は1回の書きこみでいっしょに変える）
// - 注文を取り消すときは消さずに status:"cancelled"（いつ・だれが）。その品物は依頼にもどる（材料屋を変えて注文しなおせる）
import { ref, push, get, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { zenkana } from "./common.js";
import { lineText, kibouText, fmtQty } from "./tanomu.js";
import { attachOf } from "./shashin.js";

const linesArr = o => Object.values(o.lines || {});
/** 預かり（11/2 シンプル版）：事務所が「預かりから」とした数（azk＝預かりの品物の番号・azkQty＝預かりから出す数）。
 *  全部なら「（預かりより）」、一部なら「（うち5本は預かりより）」。注文の文・事務所の一覧・金額の欄に出す */
export const azkText = l => (!l || !(l.azkQty > 0) ? "" : l.azkQty >= l.qty ? "（預かりより）" : `（うち${fmtQty(l.azkQty)}${l.unit}は預かりより）`);

/** 材料屋への注文の文（試作の orderText と同じ形。LINE・メール・FAX）。日報の件名の半角カナは全角にする
 *  info＝事務所の情報（⚙ 設定の「会社・注文書」と「注文する人」の電話番号。/zairyo/officeInfo）{ company, phrases, tels }
 *  - 「納入希望日／最短希望（日付なら 11/5（木）希望）」と「納入場所／届け先の文（⚙ 設定。例 松前工場まで納入お願いいたします・取りに伺います）」に分ける。
 *    届け先の文が空なら届け先の名前、届け先がなければ納入場所は出さない。「○○さんに連絡済みです」は、その下（11/2 事務員さん）
 *  - 注文者・担当者の名前のうしろに電話番号（入れてある人だけ）。決まり文句は、いちばん下（LINE・メール・FAX ぜんぶ）
 *  - footer：会社の名前・住所など（メールだけ。FAX は印刷の紙の下に別に出す。LINE には出さない）（10/14 持ち主） */
export function orderText(o, info = {}, { footer = false } = {}) {
  const tels = info.tels || {};
  const who = n => (n && tels[n] ? `${n}(${tels[n]})` : n || "");
  const L = [];
  L.push(`注文先　${o.supplierName}　${o.to || "御中"}`, "");
  L.push(`工事件名　${zenkana(o.kenmei || "")}`);
  L.push(`注文番号　${o.chuban}`, "");
  L.push("品名", ...linesArr(o).map(l => lineText(l) + azkText(l)));   // 預かりから（11/2）は「（預かりより）」
  const at = attachOf(o.lines);
  at.links.forEach(h => L.push("参考：" + h));
  if (at.photos.length) L.push("※品物の写真を別に送ります");
  const fl = Object.values(o.files || {}).sort((a, b) => (a.at || 0) - (b.at || 0)).map(f => f.name).filter(Boolean);
  if (fl.length) L.push(`※添付ファイル：${fl.join("、")}`);   // 注文につけた注文書・図面（10/15）
  L.push("");
  // 前は「松前工場へ最短希望」＋届け先の文で、届け先が2回出ていた（11/2 事務員さん）
  L.push("納入希望日", `${kibouText(o.kibou)}希望`);
  const place = o.bashoText || o.basho || "";
  if (place) L.push("納入場所", place);
  if (o.contacted) L.push(`${o.supplierName}さんに連絡済みです`);
  L.push("");
  if (o.memo) L.push(o.memo, "");
  L.push("注文者", who(o.chumonsha));
  if (o.tantou) L.push("担当者", who(o.tantou));
  const ph = String(info.phrases || "").split("\n").map(s => s.trim()).filter(Boolean);
  if (ph.length) L.push("", ...ph);
  if (footer) {
    const f = companyLines(info.company);
    if (f.length) L.push("", "------------------------------------------", ...f.map(s => "  " + s), "------------------------------------------");
  }
  return L.join("\n");
}

/** 会社の名前・住所などの行（⚙ 設定の「会社・注文書」。入れていない所はとばす） */
export function companyLines(c = {}) {
  const tf = [c.tel ? `TEL: ${c.tel}` : "", c.fax ? `FAX: ${c.fax}` : ""].filter(Boolean).join(" ");
  return [c.name || "", c.zip ? `〒${c.zip}` : "", c.addr || "", tf, c.email ? `Email: ${c.email}` : "", c.url ? `URL: ${c.url}` : ""].filter(Boolean);
}

/* ---------- メール・LINE で送る（10/14 持ち主） ----------
   材料屋ごとに ⚙ 設定で「送り方」（send: "mail" | "line"）、メールアドレス（email）と CC（cc。並び）、
   LINE の送り先のメモ（lineTo）を決める。メールアドレスはプログラムに書かない
   - メール：Gmail（ブラウザ）の新しいメールの画面を、宛先・件名・本文が入った形で開く
   - LINE：スマホでは、LINE の「送る」画面を文が入った形で開く（https://line.me/R/share。line:// は古いのでやめる予定と LINE の説明にある）。
     パソコン版の LINE では使えない（LINE の説明・10/14 ためし）ので、パソコンでは開かずに、コピーと「○○ をえらんで、貼り付けて」だけ
     （jimusho-app.js の copyOrSend）。送り先は、LINE の決まりで毎回自分でえらぶ
   どちらも、押したときに文のコピーもする（うまく入らなかったときに、はりつけられるように）
   - メールに注文書の PDF をつける（11/2 事務員さん。js/pdf.js・jimusho-app.js の copyOrSend）：本文のいちばん上に「注文書（PDF）を添付しております。」。
     LINE・電話で入れた注文で「この一文を入れる」にチェックしたものは、その上（と PDF・FAX の紙）に「先ほどご連絡した分の注文書です。」（11/11 文を変えた・はじめはチェックなし）。加工品・めっきは PDF をつけない */
export const COMPANY = "よつば建設工業";

/** メールの件名「注文　注番　件名（よつば建設工業）」 */
export function mailSubject(o) {
  return `注文　${o.chuban}　${zenkana(o.kenmei || "")}（${COMPANY}）`;
}

/** LINE・電話で入れた注文か（依頼なし・加工品などでもない。事務所の「来たところ」が「LINE・電話」の注文） */
export const isLineOrder = o => !!o && !o.reqId && !o.kind;
/** LINE・電話で入れた注文を、あとから注文書で送るときの一言（材料屋さんが2回用意しないように。メールの本文のいちばん上・PDF・FAX の紙に。11/2 持ち主）。
 *  電話か LINE かは見分けない（はりつけた文があるかでは、まちがうことがあるため。1つの言い方にする 11/2 持ち主）。ほかの注文は ""
 *  注文の画面の「この一文を入れる」をはずした注文（noLineNote）には入れない（いつもそうとは限らないため。11/5 事務員さん）
 *  11/11 事務員さん：文を「先ほどご連絡した分の注文書です。」にした。はじめは入れない（チェックなし）。
 *  「この一文を入れる」にチェックした注文（lineNote: true）だけに入れる（前の noLineNote は、もう見ない。前の注文の記録はそのまま） */
export const LINE_NOTE = "先ほどご連絡した分の注文書です。";
export const lineOrderNote = o => (isLineOrder(o) && o.lineNote === true ? LINE_NOTE : "");
/** メールに注文書の PDF をつける注文か（加工品・めっきは、自分で作った注文書をつけているので、つけない。11/2） */
export const orderPdf = o => !!o && o.kind !== "kakou" && o.kind !== "mekki";
/** メールで PDF をつけるときの、本文のいちばん上の1行（PDF・LINE・コピーには入れない。11/2 持ち主 C） */
export const pdfLine = what => `${what}（PDF）を添付しております。`;

/** 材料屋 sup に o を送る住所（Gmail か LINE）。送り方を決めていなければ ""。
 *  pdf＝メールに注文書の PDF をつけるか（つけるときは、本文のいちばん上に「注文書（PDF）を添付しております。」。11/2） */
export function sendUrl(sup, o, info = {}, { pdf = orderPdf(o) } = {}) {
  const enc = encodeURIComponent;
  if (sup && sup.send === "mail") {
    const head = [lineOrderNote(o), pdf ? pdfLine("注文書") : ""].filter(Boolean);   // LINE・電話で入れた注文は「先ほど…」も
    const text = (head.length ? head.join("\n") + "\n\n" : "") + orderText(o, info, { footer: true });   // メールは、いちばん下に会社の名前・住所など
    const cc = Object.values(sup.cc || {}).filter(Boolean);   // CC は、なくてもよい・いくつでも（カンマでつなぐ）
    return `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(sup.email || "")}${cc.length ? `&cc=${enc(cc.join(","))}` : ""}&su=${enc(mailSubject(o))}&body=${enc(text)}`;
  }
  if (sup && sup.send === "line") return `https://line.me/R/share?text=${enc(orderText(o, info))}`;
  return "";
}

/** ボタンの名前 */
export const sendLabel = sup => (sup && sup.send === "mail" ? "メールで送る" : sup && sup.send === "line" ? "LINE で送る" : sup && sup.send === "fax" ? "FAX 用に印刷" : "");

/** 依頼のうち、材料屋（supId）にたのむ品物（lineIds）で、注文の形を作る（まだしまわない。文のコピーにも使う）
 *  ex（11/10 事務員さん）：kibou＝この注文の希望日（品物ごとに希望日を変えたとき。なければ依頼の希望日）、
 *  memo＝材料屋へのひとこと（事務所が書く。はじめは現場のメモ。なければ依頼のメモ） */
export function draftOrder(r, supId, sup, lineIds, bashoText, az = {}, ex = {}) {   // az＝{品物の番号: {iid, qty}}（事務所が「預かりから」とした。11/2）
  const lines = {};
  for (const id of lineIds) {
    const l = r.lines[id];
    lines[id] = { key: l.key || "", cat: l.cat || "", name: l.name || "", vals: l.vals || {}, spec: l.spec, note: l.note || "", qty: l.qty, unit: l.unit };
    if (l.photos) lines[id].photos = Object.values(l.photos);   // 写真・リンクも注文についていく
    if (l.link) lines[id].link = l.link;
    if (az[id]) Object.assign(lines[id], { azk: az[id].iid, azkQty: az[id].qty });
  }
  return {
    reqId: r.id, supplier: supId, supplierName: sup.name, to: sup.to || "御中",
    chuban: r.chuban, kenmei: r.kenmei, tantou: r.tantou || "", chumonsha: r.chumonsha || "",
    kibou: ex.kibou || r.kibou || "最短", basho: r.basho || "", bashoText: bashoText || "",
    contacted: r.contacted === supId, memo: String(ex.memo != null ? ex.memo : r.memo || "").trim().slice(0, 500),
    status: "wait", lines,
  };
}

/** 注文した（注文を作って、依頼の品物に材料屋と注文の番号をつける）。me = 事務所の端末 {name} */
export async function placeOrder(r, draft, me) {
  if (r.status === "cancelled") throw new Error("この依頼は、現場が取り消しました");
  const key = push(ref(db, "zairyo/orders")).key;
  const ids = Object.keys(draft.lines);
  const upd = {
    [`zairyo/orders/${key}`]: { ...draft, orderedAt: serverTimestamp(), orderedBy: me.name, orderedByUid: auth.currentUser.uid },
    [`zairyo/requests/${r.id}/ordered`]: true,
  };
  for (const id of ids) {
    upd[`zairyo/requests/${r.id}/lines/${id}/supplier`] = draft.supplier;
    upd[`zairyo/requests/${r.id}/lines/${id}/orderId`] = key;
  }
  // ほかに、まだ注文していない品物がなければ、依頼ぜんぶ注文した（「注文しない」にした品物は数えない。11/10）
  const rest = Object.entries(r.lines || {}).filter(([id, l]) => !ids.includes(id) && !l.orderId && !l.skip);
  if (!rest.length) upd[`zairyo/requests/${r.id}/status`] = "ordered";
  await update(ref(db), upd);
  return key;
}

/** 注文のようす（試作の ST と同じ。箱は上の縁に色：オレンジ＝待ち、青＝届いた、灰色＝おわり） */
export const ST = {
  wait: { label: "材料がまだ届いていない", chip: "待ち", color: "var(--amber)" },
  arrived: { label: "届いた・請求まだ", chip: "届いた", color: "var(--blue)" },
  billed: { label: "請求ずみ", chip: "請求ずみ", color: "var(--grey)" },
  cancelled: { label: "取り消した", chip: "取り消した", color: "var(--grey)" },
};

/** 希望日がすぎているか（まだ届いていない注文で、希望日が日付のとき。最短はすぎない） */
export function isLate(o, today) {
  return o.status === "wait" && /^\d{4}-\d{2}-\d{2}$/.test(o.kibou || "") && o.kibou < today;
}

/** 届いた（金額はあとで）。me = 事務所の端末 {name} */
export async function markArrived(o, me) {
  await update(ref(db, `zairyo/orders/${o.id}`), { status: "arrived", arrivedAt: serverTimestamp(), arrivedBy: me.name });
}

/* ---------- 品物ごとの届いた数（11/19 事務員さん「加工品が何回かに分けて届く」。まず加工品だけ） ----------
   - 納品書の行が、どの注文の品物か：rows/{r}/line（取りこみで合わせた）。手で入れた金額は、行の番号＝品物の番号。
     加工品で品物が1つなら、その品物（送料・運賃・値引きの行はのぞく）
   - 「届いた」を押して何個か入れた分：got/{g} = { line, qty, date, by, at }
   - 全部そろうまでは「材料がまだ届いていない」のまま（カードに「一部届いた 5/12」）。そろったら「届いた」。台帳が読む status の意味は前と同じ */
export const isKakou = o => !!o && o.kind === "kakou";
export const NOT_ITEM = /送料|運賃|配送|梱包|値引/;
/** 納品書（金額のない紙も）の行の、注文の品物の番号（なければ ""） */
export function rowLineOf(o, key, r) {
  const ls = (o && o.lines) || {};
  if (!r) return "";
  if (r.line && ls[r.line]) return r.line;
  if (key && ls[key]) return key;
  const ids = Object.keys(ls);
  if (isKakou(o) && ids.length === 1 && r.qty != null && !NOT_ITEM.test(String(r.spec || "")) && !(Number(r.amount) < 0 && Number(r.qty) > 0)) return ids[0];
  return "";
}
/** 届いた記録 [{ date, lid, qty, src, sid?, gid? }]（日付の順） */
export function gotList(o) {
  const out = [];
  const rowsOf = (list, label) => {
    for (const [sid, s] of list) for (const [k, r] of Object.entries(s.rows || {})) {
      const lid = rowLineOf(o, k, r);
      if (lid && r.qty != null) out.push({ date: s.date || "", lid, qty: Number(r.qty) || 0, src: `${label}${s.no ? " No." + s.no : ""}`, sid });
    }
  };
  rowsOf(slipsOf(o), "納品書");
  rowsOf(npSlipsOf(o), "金額のない紙");
  for (const [gid, g] of Object.entries(o.got || {})) if (g && (o.lines || {})[g.line]) out.push({ date: g.date || "", lid: g.line, qty: Number(g.qty) || 0, src: `「届いた」で入れた${g.by ? "（" + g.by + "）" : ""}`, gid });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
/** 品物ごとの、注文の数と届いた数 → { per: [{ lid, spec, unit, want, got }], want, got, any, done } */
export function partOf(o) {
  const list = gotList(o);
  const per = Object.entries(o.lines || {}).map(([lid, l]) => ({ lid, spec: l.spec, unit: l.unit || "", want: Number(l.qty) || 0, got: list.filter(x => x.lid === lid).reduce((t, x) => t + x.qty, 0) }));
  const want = per.reduce((t, p) => t + p.want, 0), got = per.reduce((t, p) => t + Math.max(0, p.got), 0);
  return { per, want, got, any: got > 0, done: per.length > 0 && per.every(p => p.got >= p.want) };
}
/** 一部届いた加工品か（まだ届いていない・何個か届いた・全部はそろっていない） */
export const isPartial = o => isKakou(o) && o.status === "wait" && (p => p.any && !p.done)(partOf(o));
/** 紙（納品書・金額のない紙）を入れたら「届いた」にするか：加工品は、紙の行を品物の数に数えられて、まだ全部そろわないときは「まだ」のまま */
function arriveOnPaper(o, kind, id, paper) {
  if (o.status !== "wait") return false;
  if (!isKakou(o)) return true;
  const next = { ...o, [kind]: { ...(o[kind] || {}), [id]: paper } };
  const counted = Object.entries(paper.rows || {}).some(([k, r]) => rowLineOf(next, k, r));
  return !counted || partOf(next).done;   // 数えられない紙（品名がちがう・送料だけ など）は、前と同じに「届いた」
}
/** 「届いた」を押して、何個か入れる（加工品の一部届いた）。entries = [{ line, qty }]。全部そろったら「届いた」 */
export async function markGot(o, entries, me) {
  const base = `zairyo/orders/${o.id}`, upd = {}, got = { ...(o.got || {}) };
  for (const e of entries) {
    if (!(o.lines || {})[e.line] || !(Number(e.qty) > 0)) continue;
    const k = push(ref(db, `${base}/got`)).key;
    got[k] = upd[`${base}/got/${k}`] = { line: e.line, qty: Number(e.qty), date: ymdLocal(), by: (me.name || "事務所").slice(0, 40), at: serverTimestamp() };
  }
  const done = partOf({ ...o, got }).done;
  if (done && o.status === "wait") Object.assign(upd, { [`${base}/status`]: "arrived", [`${base}/arrivedAt`]: serverTimestamp(), [`${base}/arrivedBy`]: me.name });
  await update(ref(db), upd);
  return { done };
}
const ymdLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/* ---------- 材料屋のアプリ（2回目・2-2。10/16 持ち主） ----------
   - ⚙ 設定で「材料屋のアプリで受ける」が ON の材料屋（ネットで買う店はのぞく）には、事務所が「アプリに送る」を押したときに注文がとどく（B）
   - supState：sent（アプリに送った・まだ受けていない）→ accepted（受けた）→ delivered（届けた）→ priced（金額を入れた）
   - LINE・電話の注文は、もう受けているので accepted から（supVia:"line"。持ち主 5A） */
/** 材料屋のアプリで受ける材料屋か */
export const isAppSup = s => !!(s && s.app && s.send !== "net");
/** アプリに送るときに、注文に書く欄 */
export const appSentFields = me => ({ supState: "sent", supSentAt: serverTimestamp(), supSentBy: me.name || "事務所" });
/** いまある注文をアプリに送る（加工品などの「まだ送っていない」も、送ったことにする） */
export async function sendToApp(o, me) {
  await update(ref(db, `zairyo/orders/${o.id}`), {
    ...appSentFields(me),
    ...(o.unsent ? { unsent: null, sentAt: serverTimestamp(), sentBy: me.name || "事務所" } : {}),
  });
}
/** 事務所に出す、アプリのようす（アプリに送っていなければ ""） */
export function supStateText(o) {
  if (!o.supState) return "";
  const plan = o.deliverDate ? `・${kibouText(o.deliverDate)} 届ける予定` : "";
  if (o.supState === "sent") return "アプリに送った（まだ受けていない）";
  if (o.supState === "accepted") return (o.supVia === "line" ? "LINE・電話で受けた注文（アプリに出ています）" : "材料屋が受けた") + plan;
  if (o.supState === "delivered") return `材料屋が届けた${o.supDeliveredAt ? `（${new Date(o.supDeliveredAt).getMonth() + 1}/${new Date(o.supDeliveredAt).getDate()}）` : ""}`;
  return o.slips && o.slips.sup ? "材料屋が金額を入れた" : "材料屋が金額をたしかめた";   // たしかめた＝事務所が先に入れていた（2-4）
}
/** 届く予定（材料屋が受けて、まだ届いていない注文。なければ ""）。例「10/20（火）」（2-3） */
export const deliverPlan = o => (o.deliverDate && o.status === "wait" && o.supState === "accepted" ? kibouText(o.deliverDate) : "");

/** 材料屋に送った（加工品の「まだ送っていない」を消す。Gmail で送信したあとに押す。10/15） */
export async function markSent(o, me) {
  await update(ref(db, `zairyo/orders/${o.id}`), { unsent: null, sentAt: serverTimestamp(), sentBy: me.name });
}

/** 「材料がまだ届いていない」にもどす（届いたを押しまちがえたとき） */
export async function backToWait(o) {
  await update(ref(db, `zairyo/orders/${o.id}`), { status: "wait", arrivedAt: null, arrivedBy: null });
}

/* ---------- お金（円・税抜） ---------- */
/** 1,234 の形 */
export const yen = n => (n == null || n === "") ? "" : Math.round(Number(n)).toLocaleString("ja-JP");
/** 入れた字を数にする（全角・カンマ・円・¥・空白はとる）。数でなければ null。単価は小数もよい */
export function toPrice(v) {
  const s = String(v ?? "").normalize("NFKC").replace(/[,，、円¥￥\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
/** 入れた字を数にする。マイナスもよい（-・−・‐・▲・△・(8,462)。出精値引などの行。11/10 大岡産業 No.21324）。数でなければ null */
export function toSigned(v) {
  let s = String(v ?? "").normalize("NFKC").replace(/[,，、円¥￥\s]/g, ""), neg = false;
  const m = s.match(/^\((.+)\)$/);
  if (m) { neg = true; s = m[1]; }
  if (/^[-−‐▲△]/.test(s)) { neg = !neg; s = s.slice(1); }
  const n = toPrice(s);
  return n == null ? null : neg ? -n : n;
}
/** 返品・交換の納品書か（数がマイナスの行がある・品名に「返品」「交換」「返却」。11/19 大岡産業 21424 ソケット 10A ×−5）。出精値引（数は 1）は入れない */
export const isReturnSlip = s => Object.values((s && s.rows) || {}).some(r => r && (Number(r.qty) < 0 || /返品|交換|返却/.test(String(r.spec || ""))));
/** 返品・交換の納品書（金額のない紙も）がある注文か */
export const hasReturn = o => !!o && [...Object.values(o.slips || {}), ...Object.values(o.npSlips || {})].some(isReturnSlip);
/** 単価の記録にする行か（単価があって、値引きなどのマイナスの行でない。11/10） */
const priceRow = r => r && r.price != null && Number(r.price) >= 0 && !(Number(r.amount) < 0);
/** 納品書のスキャン（1枚目・2枚目・3枚目から＝scans/3…。11/10 3枚つづき）→ [置き場所] */
export const slipScans = s => [s && s.scan, s && s.scan2, ...Object.entries((s && s.scans) || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => v)].filter(Boolean);
/** 材料費＝請求書の金額。まだなら納品書の金額（どちらもなければ null） */
export const cost = o => (o.seikyu != null ? o.seikyu : o.nouhin != null ? o.nouhin : null);
/** 納品書（入れた順） [[id, slip]] */
export const slipsOf = o => Object.entries(o.slips || {}).sort(([, a], [, b]) => (a.at || 0) - (b.at || 0));

/** 手で入れた納品書の金額（事務所の「納品書の金額を入れる」と、材料屋のアプリ。取りこみの印 imp がない）[[id, slip]]（11/4） */
export const handSlipsOf = o => slipsOf(o).filter(([, s]) => !s.imp);
/** 単価の記録のうち、この注文のこの納品書の分（注文・日付・品名・単価が同じ。材料屋が入れた分は slip:"sup"） */
const pricesOfSlip = (ps, o, sid, s) => Object.keys(ps).filter(pid => {
  const p = ps[pid];
  if (!p || p.orderId !== o.id) return false;
  if (sid === "sup") return p.slip === "sup";
  return p.slip !== "sup" && p.date === s.date && Object.values(s.rows || {}).some(r => r.spec === p.spec && r.price === p.price);
});
const logKey = o => push(ref(db, `zairyo/orders/${o.id}/log`)).key;

/** 納品書の金額を入れる。slip = {no, date, amount, rows:{品物id:{spec, qty, unit, price?, amount}}}
 *  まだ届いていない注文なら「届いた」にする。単価があれば単価の記録（/zairyo/prices）にも残す
 *  （取りこみのときは slip に scan（スキャンの置き場所）と imp（取りこみの番号）もつく）
 *  replace：消して置きかえる納品書の番号（手で入れた金額を、取りこんだ納品書に置きかえる。11/4）。その単価の記録も消す
 *  返り値：{ sid: 納品書の番号, priceIds: 単価の記録の番号, arrived: 「届いた」にしたか }（まとめて取り消すときに使う） */
export async function addSlip(o, slip, me, { replace = [] } = {}) {
  const sid = push(ref(db, `zairyo/orders/${o.id}/slips`)).key;
  const total = slipsOf(o).filter(([id]) => !replace.includes(id)).reduce((s, [, x]) => s + (Number(x.amount) || 0), 0) + (Number(slip.amount) || 0);
  const base = `zairyo/orders/${o.id}`;
  const upd = {
    [`${base}/slips/${sid}`]: { ...slip, by: me.name, at: serverTimestamp() },
    [`${base}/nouhin`]: total,
  };
  if (replace.length) {
    const ps = (await get(ref(db, "zairyo/prices"))).val() || {};
    for (const id of replace) {
      const old = (o.slips || {})[id];
      if (!old) continue;
      upd[`${base}/slips/${id}`] = null;
      pricesOfSlip(ps, o, id, old).forEach(pid => { upd[`zairyo/prices/${pid}`] = null; });
      upd[`${base}/log/${logKey(o)}`] = { at: serverTimestamp(), by: me.name || "事務所", what: `手で入れた納品書の金額（${yen(old.amount)}円${old.date ? "・" + old.date : ""}）を、取りこんだ納品書${slip.no ? " No." + slip.no : ""}に置きかえた` };
    }
  }
  const arrive = arriveOnPaper(o, "slips", sid, slip);   // 加工品は、全部そろうまで「まだ」（11/19）
  if (arrive) {
    upd[`${base}/status`] = "arrived";
    upd[`${base}/arrivedAt`] = serverTimestamp();
    upd[`${base}/arrivedBy`] = me.name;
  }
  const priceIds = [];
  for (const [lid, r] of Object.entries(slip.rows || {})) {
    if (!priceRow(r)) continue;   // 出精値引などのマイナスの行は、単価の記録にしない（11/10）
    const pk = push(ref(db, "zairyo/prices")).key;
    priceIds.push(pk);
    const line = (o.lines || {})[lid] || {};
    upd[`zairyo/prices/${pk}`] = {
      spec: r.spec, price: r.price, unit: r.unit || "", sup: o.supplier, supName: o.supplierName, key: line.key || "",
      date: slip.date, orderId: o.id, chuban: o.chuban, at: serverTimestamp(),
    };
  }
  await update(ref(db), upd);
  return { sid, priceIds, arrived: arrive };
}

/* ---------- 届いた品物（納品書の明細。11/4 事務員さん） ----------
   - 金額のない紙（送り状・受領書・ガスの仮納品書など）も、明細とスキャンを残す（npSlips。金額は入れない＝材料費は変わらない）。
     slips に入れると、材料屋のアプリで金額を入れられなくなる（ルールが「納品書がまだない」を見る）ので、別の所にする
   - 「注文にない品物」：納品書の行と注文の品物をくらべて、品名に同じ言葉（カタカナ・英字の言葉か、漢字2字）がなければ「注文にない」。
     数はくらべない（1箱と50枚のように単位がちがうことがある）。行の ord（true＝注文の品物／false＝注文にない）で、手で決めなおせる
   - 加工品・めっきは、品名が図面や「一式」なので、くらべない */
/** 金額のない紙（入れた順） [[id, paper]] */
export const npSlipsOf = o => Object.entries(o.npSlips || {}).sort(([, a], [, b]) => (a.at || 0) - (b.at || 0));
/** 品名のくらべ方：全角・半角、大文字・小文字、空白・ハイフン、× と x のちがいはそろえる */
export const specKey = s => String(s || "").normalize("NFKC").toUpperCase().replace(/[\s\-‐－―ー]/g, "").replace(/[×*＊]/g, "X");
/** 品名と数がぜんぶ同じか（行の並びは見ない） */
const itemsKey = rows => rows.map(r => `${specKey(r.spec)}|${r.qty ?? ""}`).sort().join("\n");
export const sameItems = (a, b) => !!a.length && itemsKey(a) === itemsKey(b);
export const sameDay = (a, b) => !a || !b || a === b;
const specNorm = s => String(s || "").normalize("NFKC").toUpperCase().replace(/[-‐－―]/g, "");
const specWords = s => specNorm(s).match(/[ァ-ヴー]{2,}|[A-Z][A-Z0-9]+/g) || [];
const specKanji = s => (specNorm(s).match(/[一-龯]{2,}/g) || []).flatMap(w => [...w].slice(1).map((c, i) => w[i] + c));   // 漢字2字ずつ
/** 同じ品物らしいか（品名に同じ言葉があるか） */
export function sameThing(a, b) {
  const A = specWords(a), B = specWords(b);
  if (A.some(x => B.some(y => x.includes(y) || y.includes(x)))) return true;
  const K = new Set(specKanji(b));
  return specKanji(a).some(x => K.has(x));
}
/** 注文の品物とくらべる注文か（加工品・めっきは、くらべない） */
export const checksOrd = o => o.kind !== "kakou" && o.kind !== "mekki";
/** 納品書の行が「注文にない品物」か。key＝行の番号（注文の品物の番号と同じなら注文の品物＝品物ごとに入れた金額） */
export function notInOrder(o, key, r) {
  if (r.ord != null) return !r.ord;
  if (Number(r.amount) < 0) return false;   // 出精値引などの値引きの行（マイナス）は品物ではないので「注文にない」にしない（11/10）
  if (!checksOrd(o) || (key && (o.lines || {})[key])) return false;
  return !Object.values(o.lines || {}).some(l => sameThing(l.spec, r.spec));
}
/** 金額のない紙が、金額のある納品書と同じ品物か → その納品書 [sid, slip] か null */
export const npDupOf = (o, p) => slipsOf(o).find(([, s]) => sameItems(Object.values(p.rows || {}), Object.values(s.rows || {})) && sameDay(p.date, s.date)) || null;
/** 届いた品物：[{ sid, rid, s, r, np, not }]（新しい紙が上）。金額のない紙で、金額のある納品書と同じ品物の紙は出さない（2回出ないように） */
export function deliveredRows(o) {
  const papers = [...slipsOf(o).map(([sid, s]) => [sid, s, false]), ...npSlipsOf(o).filter(([, p]) => !npDupOf(o, p)).map(([sid, s]) => [sid, s, true])]
    .sort(([, a], [, b]) => (b.date || "").localeCompare(a.date || "") || (b.at || 0) - (a.at || 0));
  return papers.flatMap(([sid, s, np]) => Object.entries(s.rows || {}).map(([rid, r]) => ({ sid, rid, s, r, np, not: notInOrder(o, rid, r) })));
}
/** 金額のない紙を入れる。paper = {no?, date, rows:{r01:{spec, qty?, unit?, ord?}}, scan?, imp?}。まだ届いていない注文なら「届いた」にする */
export async function addNpSlip(o, paper, me) {
  const id = push(ref(db, `zairyo/orders/${o.id}/npSlips`)).key, base = `zairyo/orders/${o.id}`;
  const upd = { [`${base}/npSlips/${id}`]: { ...paper, by: me.name, at: serverTimestamp() } };
  const arrive = arriveOnPaper(o, "npSlips", id, paper);   // 加工品は、全部そろうまで「まだ」（11/19）
  if (arrive) {
    upd[`${base}/status`] = "arrived";
    upd[`${base}/arrivedAt`] = serverTimestamp();
    upd[`${base}/arrivedBy`] = me.name;
  }
  await update(ref(db), upd);
  return { npId: id, arrived: arrive };
}
/** 金額のない紙を消す（「届いた」は、そのまま） */
export async function removeNpSlip(o, id) {
  await update(ref(db, `zairyo/orders/${o.id}`), { [`npSlips/${id}`]: null });
}
/** 行の「注文にない」を決めなおす（ord：true＝注文の品物・false＝注文にない） */
export async function setRowOrd(o, np, sid, rid, ord) {
  await update(ref(db, `zairyo/orders/${o.id}/${np ? "npSlips" : "slips"}/${sid}/rows/${rid}`), { ord });
}

/** 納品書を、ほかの注文に移す（11/4 YY26079：もう入っている納品書を、ちがう注文に入れなおして2回入った）。
 *  from から消して to に入れる（番号はそのまま）。単価の記録と、取りこみの記録の注文も to にする（まとめて取り消すと to から消える）。
 *  to がまだ届いていなければ「届いた」に。from の「届いた」は、そのまま */
export async function moveSlip(from, to, sid, me) {
  const s = (from.slips || {})[sid];
  if (!s) throw new Error("移す納品書が見つかりません");
  const sum = list => list.reduce((t, [, x]) => t + (Number(x.amount) || 0), 0);
  const restFrom = slipsOf(from).filter(([id]) => id !== sid), toList = slipsOf(to);
  const fb = `zairyo/orders/${from.id}`, tb = `zairyo/orders/${to.id}`;
  const what = `納品書${s.no ? " No." + s.no : ""}（${yen(s.amount)}円）`;
  const upd = {
    [`${fb}/slips/${sid}`]: null,
    [`${fb}/nouhin`]: restFrom.length ? sum(restFrom) : null,
    [`${fb}/log/${logKey(from)}`]: { at: serverTimestamp(), by: me.name || "事務所", what: `${what}を、ほかの注文（${Object.values(to.lines || {}).map(l => l.spec).join("・").slice(0, 60)}）に移した` },
    [`${tb}/slips/${sid}`]: { ...s, at: serverTimestamp() },
    [`${tb}/nouhin`]: sum(toList) + (Number(s.amount) || 0),
    [`${tb}/log/${logKey(to)}`]: { at: serverTimestamp(), by: me.name || "事務所", what: `${what}を、ほかの注文（${Object.values(from.lines || {}).map(l => l.spec).join("・").slice(0, 60)}）から移した` },
  };
  if (to.status === "wait") {
    upd[`${tb}/status`] = "arrived";
    upd[`${tb}/arrivedAt`] = serverTimestamp();
    upd[`${tb}/arrivedBy`] = me.name;
  }
  const ps = (await get(ref(db, "zairyo/prices"))).val() || {};
  pricesOfSlip(ps, from, sid, s).forEach(pid => { upd[`zairyo/prices/${pid}/orderId`] = to.id; });
  if (s.imp) {
    const rec = (await get(ref(db, `zairyo/imports/${s.imp}`))).val();
    Object.entries((rec && rec.items) || {}).forEach(([i, it]) => { if (it && it.slipId === sid) upd[`zairyo/imports/${s.imp}/items/${i}/orderId`] = to.id; });
  }
  await update(ref(db), upd);
}

/* ---------- 同じ注番・同じ材料屋の注文が2つ以上あるとき、品名が合う注文をえらぶ（11/4 YY26079） ----------
   品名の言葉（カタカナ・英字2字から）が同じなら1点、サイズの数字（10×25 の 10 と 25 など）が同じなら2点。行ごとに、いちばん合う品物の点を足す。
   本物の納品書でためすと、10X25 → M10×25、6X15 → M6×15、シートペーパー → シートペーパーの注文、と全部合った */
const scoreWords = s => specNorm(s).match(/[ァ-ヴー]{2,}|[A-Z]{2,}[A-Z0-9]*/g) || [];
const scoreNums = s => [...new Set(specNorm(s).match(/\d+(\.\d+)?/g) || [])];
export function lineScore(a, b) {
  const A = scoreWords(a), B = scoreWords(b), N = new Set(scoreNums(b));
  return A.filter(x => B.some(y => x.includes(y) || y.includes(x))).length + 2 * scoreNums(a).filter(n => N.has(n)).length;
}
/** 注文の品物と、納品書の行がどれだけ合うか（点） */
export const matchScore = (o, rows) => rows.reduce((t, r) => t + Math.max(0, ...Object.values(o.lines || {}).map(l => lineScore(l.spec, r.spec))), 0);
/** いちばん合う注文（同じ点なら、はじめの注文＝新しい注文） */
export const bestOrder = (os, rows) => os.reduce((b, o) => (!b || matchScore(o, rows) > matchScore(b, rows) ? o : b), null);
/* ---------- 2枚つづきの納品書・手で入れるときの2回数え（11/4 OS26315 大岡産業 No.21269） ----------
   2/2 を読むと、番号が同じなので「もう入っています」になり、「移す」で 1/2 が動いた。そのあと手で6行入れて、5行が2回になった */
/** 同じ品物らしいか（品名の言葉（カタカナ・英字の言葉か漢字2字）と、サイズの数字が1つ以上同じ。「溶接エルボ 90EL40A」と「ロングエルボ (90°) 40A」など） */
export function likeItem(a, b) {
  const A = scoreWords(a), B = scoreWords(b), K = new Set(specKanji(b)), N = new Set(scoreNums(b));
  const w = A.some(x => B.some(y => x.includes(y) || y.includes(x))) || specKanji(a).some(x => K.has(x));
  return w && scoreNums(a).some(n => N.has(n));
}
/** 行 r が、行の並び rows の中にあるか（品名がそろえて同じで数も同じ、または同じ品物らしくて数が同じ。金額があれば金額も同じ） */
export const rowIn = (r, rows) => rows.some(x => (specKey(x.spec) === specKey(r.spec) && (x.qty ?? null) === (r.qty ?? null))
  || (likeItem(x.spec, r.spec) && Number(x.qty) === Number(r.qty) && (x.amount == null || r.amount == null || x.amount === r.amount)));
/** 何枚かつづきの納品書（2枚・3枚…。11/10 3枚つづき）の、つづきの紙の行を足す。part = {rows:[{spec, qty?, unit?, price?, amount}], amount, scan?, pages?}
 *  行は前の行のあとに足す（r06 …）。納品書の金額と、注文の納品書の金額をふやす。単価の記録も残す。
 *  返り値：{ rowKeys: 足した行の番号, priceIds }（まとめて取り消すときに、足した分だけ消す） */
export async function addToSlip(o, sid, part, me) {
  const s = (o.slips || {})[sid];
  if (!s) throw new Error("つづきを足す納品書が見つかりません");
  const base = `zairyo/orders/${o.id}`, keys = Object.keys(s.rows || {});
  let n = keys.length;
  const next = () => { let k; do { k = "r" + String(++n).padStart(2, "0"); } while (keys.includes(k)); return k; };
  const upd = {}, rowKeys = [], priceIds = [], add = Number(part.amount) || 0;
  for (const r of part.rows) {
    const k = next();
    rowKeys.push(k);
    upd[`${base}/slips/${sid}/rows/${k}`] = r;
    if (!priceRow(r)) continue;   // 出精値引などのマイナスの行は、単価の記録にしない（11/10）
    const pk = push(ref(db, "zairyo/prices")).key;
    priceIds.push(pk);
    upd[`zairyo/prices/${pk}`] = { spec: r.spec, price: r.price, unit: r.unit || "", sup: o.supplier, supName: o.supplierName, key: "", date: s.date, orderId: o.id, chuban: o.chuban, at: serverTimestamp() };
  }
  upd[`${base}/slips/${sid}/amount`] = (Number(s.amount) || 0) + add;
  upd[`${base}/nouhin`] = slipsOf(o).reduce((t, [, x]) => t + (Number(x.amount) || 0), 0) + add;
  // スキャン：1枚目 scan・2枚目 scan2・3枚目から scans/3・scans/4 …（11/10 3枚つづき。前は3枚目が2枚目の上に書かれた）
  const had = slipScans(s);
  if (part.scan && !had.includes(part.scan)) {
    if (!s.scan) upd[`${base}/slips/${sid}/scan`] = part.scan;
    else if (!s.scan2) upd[`${base}/slips/${sid}/scan2`] = part.scan;
    else upd[`${base}/slips/${sid}/scans/${Math.max(2, ...Object.keys(s.scans || {}).map(Number).filter(Number.isFinite)) + 1}`] = part.scan;
  }
  const pages = Math.min(20, Math.max(Number(s.pages) || 0, Number(part.pages) || 0, had.length + (part.scan && !had.includes(part.scan) ? 1 : 0)));
  if (pages >= 2) upd[`${base}/slips/${sid}/pages`] = pages;
  if (isKakou(o) && o.status === "wait" && partOf({ ...o, slips: { ...o.slips, [sid]: { ...s, rows: { ...(s.rows || {}), ...Object.fromEntries(rowKeys.map((k, i) => [k, part.rows[i]])) } } } }).done) {   // 加工品が全部そろった（11/19）
    upd[`${base}/status`] = "arrived"; upd[`${base}/arrivedAt`] = serverTimestamp(); upd[`${base}/arrivedBy`] = me.name;
  }
  upd[`${base}/log/${logKey(o)}`] = { at: serverTimestamp(), by: me.name || "事務所", what: `納品書${s.no ? " No." + s.no : ""}のつづきの紙（${part.rows.length}行・${yen(add)}円）を足した（${yen(Number(s.amount) || 0)}円 → ${yen((Number(s.amount) || 0) + add)}円）` };
  await update(ref(db), upd);
  return { rowKeys, priceIds };
}
/** 手で入れる品物が、もう納品書で入っているか → { o2, s, sid, r }（入っている注文・納品書・行）か null
 *  同じ注文の納品書に同じ品物の番号の行がある、または同じ注番・同じ材料屋の注文に、取りこんだ納品書で品名（言葉とサイズ）と数が同じ行がある */
export function lineDone(orders, o, lid, l) {
  for (const [sid, s] of slipsOf(o)) { const r = (s.rows || {})[lid]; if (r) return { o2: o, s, sid, r }; }
  for (const o2 of orders || []) {
    if (o2.status === "cancelled" || o2.supplier !== o.supplier || o2.chuban !== o.chuban) continue;
    for (const [sid, s] of slipsOf(o2)) {
      if (!s.imp) continue;
      const r = Object.values(s.rows || {}).find(x => likeItem(l.spec, x.spec) && Number(x.qty) === Number(l.qty));
      if (r) return { o2, s, sid, r };
    }
  }
  return null;
}
/** 注文の品物の短い名前（えらぶ所・知らせ用） */
export const linesShort = (o, n = 40) => { const t = Object.values(o.lines || {}).map(l => l.spec).join("・"); return t.length > n ? t.slice(0, n) + "…" : t; };

/* ---------- 1枚の納品書に、同じ注番・同じ材料屋のほかの注文の分もまとめて入っている（11/25 事務員さん：小野建 26-077727・YE26025） ----------
   - まとめて入っている注文（c）：withSlip＝"入れた注文の番号/納品書の番号"・金額0円（nouhin 0）・届いた
   - 請求ずみは、その納品書といっしょ（まとめて請求・「請求が来た」・「請求まだにもどす」）。納品書を消したら、まとめるのもやめる */
/** c がまとめて入っている納品書 { oid, sid }（なければ null） */
export const withOf = c => { const m = /^([^/]+)\/(.+)$/.exec(String((c && c.withSlip) || "")); return m ? { oid: m[1], sid: m[2] } : null; };
/** 注文 oid の納品書 sid にまとめて入っている注文（取り消した注文はのぞく） */
export const coveredBy = (orders, oid, sid) => (orders || []).filter(c => c.withSlip === `${oid}/${sid}` && c.status !== "cancelled");
/** まとめる書きこみを upd に足す（まだ届いていなければ「届いた」にする）。at＝入れた注文の注文日（withAt。現場のスマホはほかの人の注文を読めないので、
 *  「○/○ の注文の納品書にまとめて入っています」と出せるように、まとめた注文に書いておく） */
export function withUpd(upd, c, oid, sid, me, at) {
  const b = `zairyo/orders/${c.id}`;
  upd[`${b}/withSlip`] = `${oid}/${sid}`;
  if (Number.isFinite(Number(at)) && Number(at) > 0) upd[`${b}/withAt`] = Number(at);
  upd[`${b}/nouhin`] = 0;
  if (c.status === "wait") { upd[`${b}/status`] = "arrived"; upd[`${b}/arrivedAt`] = serverTimestamp(); upd[`${b}/arrivedBy`] = me.name; }
}
/** まとめるのをやめる（「届いた」のまま。金額は「まだ」に） */
export async function unWith(c) {
  await update(ref(db, `zairyo/orders/${c.id}`), { withSlip: null, withAt: null, nouhin: null });
}

/** 納品書を消す（入れまちがえたとき） */
export async function removeSlip(o, sid) {
  const rest = slipsOf(o).filter(([id]) => id !== sid);
  await update(ref(db, `zairyo/orders/${o.id}`), {
    [`slips/${sid}`]: null,
    nouhin: rest.length ? rest.reduce((s, [, x]) => s + (Number(x.amount) || 0), 0) : null,
  });
}

/* ---------- 材料屋のアプリで入れた納品書の金額（2-4。10/16 持ち主 4A） ----------
   - 材料屋が入れる納品書は1枚だけ（slips/sup）。「材料屋が入れた」の印（src:"sup"）。事務所が先に入れていたら、材料屋は入れない（たしかめるだけ）
   - 事務所は「直す」で直せる。もとの金額（supAmount）・直した人（fixBy・fixAt）を残す
   - 単価は単価の記録（/zairyo/prices）にも残す（slip:"sup"。事務所が直したら入れかえる） */
const supPriceRecs = (upd, o, slip) => {
  for (const [lid, r] of Object.entries(slip.rows || {})) {
    if (!priceRow(r)) continue;   // マイナスの行は単価の記録にしない（11/10）
    const line = (o.lines || {})[lid] || {};
    upd[`zairyo/prices/${push(ref(db, "zairyo/prices")).key}`] = {
      spec: r.spec, price: r.price, unit: r.unit || "", sup: o.supplier, supName: o.supplierName, key: line.key || "",
      date: slip.date, orderId: o.id, chuban: o.chuban, slip: "sup", at: serverTimestamp(),
    };
  }
};
/** 材料屋のアプリから納品書の金額を入れる。me = 材料屋の端末 {supName, name}。注文は supState:"priced"（「終わった」へ） */
export async function supAddSlip(o, slip, me) {
  const base = `zairyo/orders/${o.id}`;
  const upd = {
    [`${base}/slips/sup`]: { ...slip, src: "sup", by: `${me.supName || o.supplierName}（${me.name}）`.slice(0, 40), at: serverTimestamp() },
    [`${base}/nouhin`]: slip.amount,
    [`${base}/supState`]: "priced",
    [`${base}/supPricedAt`]: serverTimestamp(),
    [`${base}/supPricedBy`]: me.name,
  };
  supPriceRecs(upd, o, slip);
  await update(ref(db), upd);
}
/** 事務所が先に納品書の金額を入れていたとき：材料屋は金額をたしかめて「わかりました」（「終わった」へ） */
export async function supSeePrice(o, me) {
  await update(ref(db, `zairyo/orders/${o.id}`), { supState: "priced", supPricedAt: serverTimestamp(), supPricedBy: me.name });
}
/** 材料屋が入れた納品書を、事務所が直す。me = 事務所の端末 {name} */
export async function fixSupSlip(o, slip, me) {
  const old = (o.slips || {}).sup;
  if (!old) throw new Error("材料屋が入れた納品書がありません");
  const base = `zairyo/orders/${o.id}`;
  const upd = {
    [`${base}/slips/sup`]: { ...slip, src: "sup", by: old.by, at: old.at, supAmount: old.supAmount != null ? old.supAmount : old.amount, fixBy: me.name, fixAt: serverTimestamp() },
    [`${base}/nouhin`]: slipsOf(o).reduce((s, [id, x]) => s + (id === "sup" ? 0 : Number(x.amount) || 0), 0) + slip.amount,
  };
  // 単価の記録：この納品書の分を入れかえる
  const ps = (await get(ref(db, "zairyo/prices"))).val() || {};
  for (const [pid, pr] of Object.entries(ps)) if (pr && pr.orderId === o.id && pr.slip === "sup") upd[`zairyo/prices/${pid}`] = null;
  supPriceRecs(upd, o, slip);
  await update(ref(db), upd);
}

/** 請求が来た（請求書の金額）。「請求ずみ」にする */
export async function markBilled(o, amount, me) {
  await update(ref(db, `zairyo/orders/${o.id}`), { status: "billed", seikyu: amount, billedAt: serverTimestamp(), billedBy: me.name });
}

/** 「請求まだ」にもどす（納品書ごとの「請求ずみ」の印も消す。11/19） */
export async function backToArrived(o) {
  const upd = { status: "arrived", seikyu: null, billedAt: null, billedBy: null, invoiceId: null };
  for (const [sid, s] of slipsOf(o)) if (s.inv || s.invAmt != null) { upd[`slips/${sid}/inv`] = null; upd[`slips/${sid}/invAmt`] = null; }
  await update(ref(db, `zairyo/orders/${o.id}`), upd);
}

/* ---------- 締め日と請求の月・納品書ごとの「請求ずみ」（11/19 持ち主「まとめて請求を、材料屋ごとに月1回の作業に」） ----------
   - 材料屋の締め日は ⚙ 設定 → 材料屋（/zairyo/master/suppliers/{id}/shime＝1〜30 の日。ないときは月末。30日締めは、2月は月末・31日は次の月の分。11/20 持ち主）
   - 「11月分」＝締め日で区切った月。月末なら 11/1〜11/30、20日締めなら 10/21〜11/20。どの月かは納品書の日付で決める
   - 請求ずみは納品書ごとに持つ（slips/{sid}/inv＝請求書の記録の番号・invAmt＝請求書の金額）。その注文の納品書が全部しまったら、
     注文を「請求ずみ」（status・seikyu＝請求書の金額の合計・billedAt・billedBy・invoiceId）。よつば台帳が読む注文の欄の意味は前と同じ */
/** 材料屋の締め日（1〜30。0＝月末） */
export const shimeOf = sup => { const n = Number(sup && sup.shime); return Number.isInteger(n) && n >= 1 && n <= 30 ? n : 0; };
export const shimeText = d => (d ? `${d}日` : "月末");
const ymdOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** 納品書の日付 "YYYY-MM-DD" → 請求の月 "YYYY-MM"（締め日より後の日は、つぎの月の分） */
export function billMonth(date, d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return "";
  let y = +m[1], mo = +m[2];
  if (d && +m[3] > d) { mo++; if (mo > 12) { mo = 1; y++; } }
  return `${y}-${String(mo).padStart(2, "0")}`;
}
/** 請求の月 "YYYY-MM" → { from, to }（その月の分の、はじめの日とおわりの日） */
export function billPeriod(month, d) {
  const [y, mo] = String(month).split("-").map(Number);
  const lastOf = (yy, mm) => new Date(yy, mm, 0).getDate();   // mm は 1〜12
  if (!d) return { from: ymdOf(new Date(y, mo - 1, 1)), to: ymdOf(new Date(y, mo - 1, lastOf(y, mo))) };
  const py = mo === 1 ? y - 1 : y, pm = mo === 1 ? 12 : mo - 1;
  return { from: ymdOf(new Date(py, pm - 1, Math.min(d, lastOf(py, pm)) + 1)), to: ymdOf(new Date(y, mo - 1, Math.min(d, lastOf(y, mo)))) };
}
/** 材料屋ごとに、請求書で請求ずみにする。picks = [{ o, sid（納品書の番号。null＝納品書がない注文）, amount（請求書の金額） }]
 *  inv = { no, date, total, month, from, to }。どの請求書でしめたかを /zairyo/invoices に残す。返り値：請求書の記録の番号 */
export async function billSlips(sup, picks, inv, me) {
  const iid = push(ref(db, "zairyo/invoices")).key, upd = {}, orders = {}, slips = {}, by = new Map();
  for (const p of picks) { const g = by.get(p.o.id) || { o: p.o, list: [] }; g.list.push(p); by.set(p.o.id, g); }
  const billed = (b, amount) => Object.assign(upd, { [`${b}/status`]: "billed", [`${b}/seikyu`]: Math.round(amount), [`${b}/billedAt`]: serverTimestamp(), [`${b}/billedBy`]: me.name, [`${b}/invoiceId`]: iid });
  for (const { o, list } of by.values()) {
    const b = `zairyo/orders/${o.id}`, all = slipsOf(o);
    orders[o.id] = list.reduce((t, p) => t + Math.round(p.amount), 0);
    if (!all.length) { billed(b, orders[o.id]); continue; }   // 納品書がない注文は、注文ごと
    const now = {};
    for (const p of list) {
      if (!p.sid || !(o.slips || {})[p.sid]) continue;
      now[p.sid] = Math.round(p.amount);
      upd[`${b}/slips/${p.sid}/inv`] = iid;
      upd[`${b}/slips/${p.sid}/invAmt`] = now[p.sid];
      (slips[o.id] = slips[o.id] || {})[p.sid] = now[p.sid];
    }
    // その注文の納品書が全部しまったら、注文を請求ずみに（請求の金額は、納品書ごとの請求書の金額の合計）
    if (all.every(([sid, s]) => s.inv || sid in now)) billed(b, all.reduce((t, [sid, s]) => t + (sid in now ? now[sid] : Number(s.invAmt ?? s.amount) || 0), 0));
  }
  upd[`zairyo/invoices/${iid}`] = {
    sup: sup.id, supName: sup.name, no: inv.no || "", date: inv.date, total: Math.round(inv.total), sum: Object.values(orders).reduce((t, x) => t + x, 0),
    orders, slips, month: inv.month || "", from: inv.from || "", to: inv.to || "", at: serverTimestamp(), by: me.name,
  };
  if (!Object.keys(slips).length) delete upd[`zairyo/invoices/${iid}`].slips;
  ["month", "from", "to"].forEach(k => { if (!upd[`zairyo/invoices/${iid}`][k]) delete upd[`zairyo/invoices/${iid}`][k]; });
  await update(ref(db), upd);
  return iid;
}

/** 依頼の品物の金額（現場に見せる）：納品書の明細に、その品物の行があれば「@単価 × 数 = 金額」 */
export function linePrice(l, lineId, os) {
  const o = l.orderId && os.find(x => x.id === l.orderId && x.status !== "cancelled");
  if (!o) return null;
  for (const [, s] of slipsOf(o)) {
    const r = (s.rows || {})[lineId];
    if (r && r.amount != null) return { price: r.price ?? null, qty: r.qty ?? null, unit: r.unit || l.unit, amount: r.amount };
  }
  return null;
}
export const priceText = p => (p.price != null ? `@${yen(p.price)}円 ×${p.qty ?? ""}${p.unit || ""} = ` : "") + `${yen(p.amount)}円`;

/** 依頼の金額（現場に見せる）：材料屋ごとの材料費と合計。allKnown＝全部注文して、全部の金額が入った */
export function reqMoney(r, os) {
  const act = os.filter(o => o.status !== "cancelled");
  // withSlip＝ほかの注文の納品書にまとめて入っている（11/25。0円とだけ出ると、現場がとまどうので、どの注文の納品書かを出す）
  const per = act.map(o => ({ sup: o.supplierName, amount: cost(o), status: o.status, with: o.withSlip ? { at: o.withAt || null } : null }));
  const known = per.filter(x => x.amount != null);
  return {
    per,
    total: known.reduce((s, x) => s + x.amount, 0),
    anyKnown: known.length > 0,
    allKnown: known.length > 0 && known.length === per.length && r.status === "ordered",
  };
}

/** 注文を取り消して、品物を依頼にもどす（注文は消さずに「取り消した」の印） */
export async function cancelOrder(o, r, me) {
  const upd = {
    [`zairyo/orders/${o.id}/status`]: "cancelled",
    [`zairyo/orders/${o.id}/cancelledAt`]: serverTimestamp(),
    [`zairyo/orders/${o.id}/cancelledBy`]: me.name,
  };
  if (r && r.status !== "cancelled") {
    let still = false;
    for (const [id, l] of Object.entries(r.lines || {})) {
      if (l.orderId === o.id) {
        upd[`zairyo/requests/${r.id}/lines/${id}/orderId`] = null;
        upd[`zairyo/requests/${r.id}/lines/${id}/supplier`] = null;
      } else if (l.orderId) {
        still = true;
      }
    }
    upd[`zairyo/requests/${r.id}/ordered`] = still;
    if (r.status === "ordered") upd[`zairyo/requests/${r.id}/status`] = "sent";
  }
  await update(ref(db), upd);
}
