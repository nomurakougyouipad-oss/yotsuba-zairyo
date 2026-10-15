// 注文（事務所）：注文の文を作る・材料屋に注文する・注文を取り消して依頼にもどす
// - 注文は /zairyo/orders/{id}。依頼（/zairyo/requests）には、品物ごとの材料屋（supplier）と注文の番号（orderId）、
//   1つでも注文したら ordered:true、全部注文したら status:"ordered" をつける（注文と依頼は1回の書きこみでいっしょに変える）
// - 注文を取り消すときは消さずに status:"cancelled"（いつ・だれが）。その品物は依頼にもどる（材料屋を変えて注文しなおせる）
import { ref, push, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { zenkana } from "./common.js";
import { lineText, kibouText } from "./tanomu.js";
import { attachOf } from "./shashin.js";

const linesArr = o => Object.values(o.lines || {});

/** 材料屋への注文の文（試作の orderText と同じ形。LINE・メール・FAX）。日報の件名の半角カナは全角にする
 *  info＝事務所の情報（⚙ 設定の「会社・注文書」と「注文する人」の電話番号。/zairyo/officeInfo）{ company, phrases, tels }
 *  - 納入希望日は「○○工場へ最短希望」の形の1行（届け先＋希望日＋希望）。「取りに行く」は今までどおり（希望日＋届け先の文「取りに伺います」）
 *  - 注文者・担当者の名前のうしろに電話番号（入れてある人だけ）。決まり文句は、いちばん下（LINE・メール・FAX ぜんぶ）
 *  - footer：会社の名前・住所など（メールだけ。FAX は印刷の紙の下に別に出す。LINE には出さない）（10/14 持ち主） */
export function orderText(o, info = {}, { footer = false } = {}) {
  const tels = info.tels || {};
  const who = n => (n && tels[n] ? `${n}(${tels[n]})` : n || "");
  const L = [];
  L.push(`注文先　${o.supplierName}　${o.to || "御中"}`, "");
  L.push(`工事件名　${zenkana(o.kenmei || "")}`);
  L.push(`注文番号　${o.chuban}`, "");
  L.push("品名", ...linesArr(o).map(lineText));
  const at = attachOf(o.lines);
  at.links.forEach(h => L.push("参考：" + h));
  if (at.photos.length) L.push("※品物の写真を別に送ります");
  const fl = Object.values(o.files || {}).sort((a, b) => (a.at || 0) - (b.at || 0)).map(f => f.name).filter(Boolean);
  if (fl.length) L.push(`※添付ファイル：${fl.join("、")}`);   // 注文につけた注文書・図面（10/15）
  L.push("");
  const pickup = !o.basho || /^取りに/.test(o.basho);
  L.push("納入希望日", pickup ? kibouText(o.kibou) : `${o.basho}へ${kibouText(o.kibou)}希望`);
  if (o.contacted) L.push(`${o.supplierName}さんに連絡済みです`);
  if (o.bashoText) L.push(o.bashoText);
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
   どちらも、押したときに文のコピーもする（うまく入らなかったときに、はりつけられるように） */
export const COMPANY = "よつば建設工業";

/** メールの件名「注文　注番　件名（よつば建設工業）」 */
export function mailSubject(o) {
  return `注文　${o.chuban}　${zenkana(o.kenmei || "")}（${COMPANY}）`;
}

/** 材料屋 sup に o を送る住所（Gmail か LINE）。送り方を決めていなければ "" */
export function sendUrl(sup, o, info = {}) {
  const enc = encodeURIComponent;
  if (sup && sup.send === "mail") {
    const text = orderText(o, info, { footer: true });   // メールは、いちばん下に会社の名前・住所など
    const cc = Object.values(sup.cc || {}).filter(Boolean);   // CC は、なくてもよい・いくつでも（カンマでつなぐ）
    return `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(sup.email || "")}${cc.length ? `&cc=${enc(cc.join(","))}` : ""}&su=${enc(mailSubject(o))}&body=${enc(text)}`;
  }
  if (sup && sup.send === "line") return `https://line.me/R/share?text=${enc(orderText(o, info))}`;
  return "";
}

/** ボタンの名前 */
export const sendLabel = sup => (sup && sup.send === "mail" ? "メールで送る" : sup && sup.send === "line" ? "LINE で送る" : sup && sup.send === "fax" ? "FAX 用に印刷" : "");

/** 依頼のうち、材料屋（supId）にたのむ品物（lineIds）で、注文の形を作る（まだしまわない。文のコピーにも使う） */
export function draftOrder(r, supId, sup, lineIds, bashoText) {
  const lines = {};
  for (const id of lineIds) {
    const l = r.lines[id];
    lines[id] = { key: l.key || "", cat: l.cat || "", name: l.name || "", vals: l.vals || {}, spec: l.spec, note: l.note || "", qty: l.qty, unit: l.unit };
    if (l.photos) lines[id].photos = Object.values(l.photos);   // 写真・リンクも注文についていく
    if (l.link) lines[id].link = l.link;
  }
  return {
    reqId: r.id, supplier: supId, supplierName: sup.name, to: sup.to || "御中",
    chuban: r.chuban, kenmei: r.kenmei, tantou: r.tantou || "", chumonsha: r.chumonsha || "",
    kibou: r.kibou || "最短", basho: r.basho || "", bashoText: bashoText || "",
    contacted: r.contacted === supId, memo: r.memo || "",
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
  // ほかに、まだ注文していない品物がなければ、依頼ぜんぶ注文した
  const rest = Object.entries(r.lines || {}).filter(([id, l]) => !ids.includes(id) && !l.orderId);
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
/** 材料費＝請求書の金額。まだなら納品書の金額（どちらもなければ null） */
export const cost = o => (o.seikyu != null ? o.seikyu : o.nouhin != null ? o.nouhin : null);
/** 納品書（入れた順） [[id, slip]] */
export const slipsOf = o => Object.entries(o.slips || {}).sort(([, a], [, b]) => (a.at || 0) - (b.at || 0));

/** 納品書の金額を入れる。slip = {no, date, amount, rows:{品物id:{spec, qty, unit, price?, amount}}}
 *  まだ届いていない注文なら「届いた」にする。単価があれば単価の記録（/zairyo/prices）にも残す
 *  （取りこみのときは slip に scan（スキャンの置き場所）と imp（取りこみの番号）もつく）
 *  返り値：{ sid: 納品書の番号, priceIds: 単価の記録の番号, arrived: 「届いた」にしたか }（まとめて取り消すときに使う） */
export async function addSlip(o, slip, me) {
  const sid = push(ref(db, `zairyo/orders/${o.id}/slips`)).key;
  const total = slipsOf(o).reduce((s, [, x]) => s + (Number(x.amount) || 0), 0) + (Number(slip.amount) || 0);
  const base = `zairyo/orders/${o.id}`;
  const upd = {
    [`${base}/slips/${sid}`]: { ...slip, by: me.name, at: serverTimestamp() },
    [`${base}/nouhin`]: total,
  };
  if (o.status === "wait") {
    upd[`${base}/status`] = "arrived";
    upd[`${base}/arrivedAt`] = serverTimestamp();
    upd[`${base}/arrivedBy`] = me.name;
  }
  const priceIds = [];
  for (const [lid, r] of Object.entries(slip.rows || {})) {
    if (r.price == null) continue;
    const pk = push(ref(db, "zairyo/prices")).key;
    priceIds.push(pk);
    const line = (o.lines || {})[lid] || {};
    upd[`zairyo/prices/${pk}`] = {
      spec: r.spec, price: r.price, unit: r.unit || "", sup: o.supplier, supName: o.supplierName, key: line.key || "",
      date: slip.date, orderId: o.id, chuban: o.chuban, at: serverTimestamp(),
    };
  }
  await update(ref(db), upd);
  return { sid, priceIds, arrived: o.status === "wait" };
}

/** 納品書を消す（入れまちがえたとき） */
export async function removeSlip(o, sid) {
  const rest = slipsOf(o).filter(([id]) => id !== sid);
  await update(ref(db, `zairyo/orders/${o.id}`), {
    [`slips/${sid}`]: null,
    nouhin: rest.length ? rest.reduce((s, [, x]) => s + (Number(x.amount) || 0), 0) : null,
  });
}

/** 請求が来た（請求書の金額）。「請求ずみ」にする */
export async function markBilled(o, amount, me) {
  await update(ref(db, `zairyo/orders/${o.id}`), { status: "billed", seikyu: amount, billedAt: serverTimestamp(), billedBy: me.name });
}

/** 「請求まだ」にもどす */
export async function backToArrived(o) {
  await update(ref(db, `zairyo/orders/${o.id}`), { status: "arrived", seikyu: null, billedAt: null, billedBy: null, invoiceId: null });
}

/** 材料屋ごとにまとめて「請求が来た」（月の請求書）。rows = [{o, amount}]、inv = {no, date, total}
 *  えらんだ注文をまとめて請求ずみにして、どの請求書でまとめたかを /zairyo/invoices に残す */
export async function billMany(sup, rows, inv, me) {
  const iid = push(ref(db, "zairyo/invoices")).key;
  const orders = Object.fromEntries(rows.map(({ o, amount }) => [o.id, amount]));
  const upd = {
    [`zairyo/invoices/${iid}`]: {
      sup: sup.id, supName: sup.name, no: inv.no || "", date: inv.date, total: inv.total,
      sum: rows.reduce((s, x) => s + x.amount, 0), orders, at: serverTimestamp(), by: me.name,
    },
  };
  for (const { o, amount } of rows) {
    const b = `zairyo/orders/${o.id}`;
    upd[`${b}/status`] = "billed";
    upd[`${b}/seikyu`] = amount;
    upd[`${b}/billedAt`] = serverTimestamp();
    upd[`${b}/billedBy`] = me.name;
    upd[`${b}/invoiceId`] = iid;
  }
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
  const per = act.map(o => ({ sup: o.supplierName, amount: cost(o), status: o.status }));
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
