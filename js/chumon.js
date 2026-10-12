// 注文（事務所）：注文の文を作る・材料屋に注文する・注文を取り消して依頼にもどす
// - 注文は /zairyo/orders/{id}。依頼（/zairyo/requests）には、品物ごとの材料屋（supplier）と注文の番号（orderId）、
//   1つでも注文したら ordered:true、全部注文したら status:"ordered" をつける（注文と依頼は1回の書きこみでいっしょに変える）
// - 注文を取り消すときは消さずに status:"cancelled"（いつ・だれが）。その品物は依頼にもどる（材料屋を変えて注文しなおせる）
import { ref, push, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth } from "./firebase.js";
import { zenkana } from "./common.js";
import { lineText, kibouText } from "./tanomu.js";

const linesArr = o => Object.values(o.lines || {});

/** 材料屋への注文の文（試作の orderText と同じ形。LINE・メールにはりつける）。日報の件名の半角カナは全角にする */
export function orderText(o) {
  const L = [];
  L.push(`注文先　${o.supplierName}　${o.to || "御中"}`, "");
  L.push(`工事件名　${zenkana(o.kenmei || "")}`);
  L.push(`注文番号　${o.chuban}`, "");
  L.push("品名", ...linesArr(o).map(lineText));
  L.push("");
  L.push("納入希望日", kibouText(o.kibou));
  if (o.contacted) L.push(`${o.supplierName}さんに連絡済みです`);
  if (o.bashoText) L.push(o.bashoText);
  L.push("");
  if (o.memo) L.push(o.memo, "");
  L.push("注文者", o.chumonsha || "");
  if (o.tantou) L.push("担当者", o.tantou);
  return L.join("\n");
}

/** 依頼のうち、材料屋（supId）にたのむ品物（lineIds）で、注文の形を作る（まだしまわない。文のコピーにも使う） */
export function draftOrder(r, supId, sup, lineIds, bashoText) {
  const lines = {};
  for (const id of lineIds) {
    const l = r.lines[id];
    lines[id] = { key: l.key || "", cat: l.cat || "", name: l.name || "", vals: l.vals || {}, spec: l.spec, note: l.note || "", qty: l.qty, unit: l.unit };
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
