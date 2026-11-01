// 預かり（11/2 持ち主。シンプル版）── 注文が「届いた」になったら、事務所が「預かりから」にした数だけ、預かりの残りをへらして記録する
// - 材料屋の「届けました」・事務所の「届いた」・納品書の取りこみ、どれで「届いた」（wait → arrived）になっても同じ
// - 品物ごとに1回だけ（lines/{品物}/azkDone を先に立ててから、へらす。2回動いても、2回はへらない）
// - 残りより多いときは 0 にする（記録に「何本→何本」が残る。ちがったら事務所が台帳の「数を直す」で直す）
// - 届いたあとに「材料がまだ届いていない」にもどしたり、取り消したりしても、自動ではもどさない（事務所が直す）
// - 台帳の形は js/azukari.js。記録は role:"server"・by:"自動（届いた）"
// - 場所は、データベースと同じシンガポール（asia-southeast1）。OPTS に書く（index.js の setGlobalOptions は効かないため）
import { onValueUpdated } from "firebase-functions/v2/database";
import { logger } from "firebase-functions/v2";
import { ServerValue } from "firebase-admin/database";
import { db } from "./lib.js";

const OPTS = { region: "asia-southeast1", instance: "yotsuba-daicho-default-rtdb", maxInstances: 3, memory: "256MiB", timeoutSeconds: 60 };
const BY = "自動（届いた）";

export const zairyoAzukariUse = onValueUpdated({ ...OPTS, ref: "/zairyo/orders/{id}/status" }, async event => {
  if (event.data.before.val() !== "wait" || event.data.after.val() !== "arrived") return;
  await useAzukari(db(), event.params.id);
});

/** 注文 id の「預かりから」の分を、預かりの残りからへらす（データベース d。作りもののデータベースでもためせるように分けた） */
export async function useAzukari(d, id) {
  const o = (await d.ref(`zairyo/orders/${id}`).get()).val();
  if (!o || !o.supplier) return;
  for (const [lid, l] of Object.entries(o.lines || {})) {
    if (!l || !l.azk || !(Number(l.azkQty) > 0) || l.azkDone) continue;
    // 先に「へらした」の印を立てる（もう立っていたら、ほかの動きがへらしたので何もしない）
    const claim = await d.ref(`zairyo/orders/${id}/lines/${lid}/azkDone`).transaction(v => (v ? undefined : true));
    if (!claim.committed) continue;
    let from = 0, to = 0, item = null;
    const r = await d.ref(`zairyo/azukari/${o.supplier}/items/${l.azk}`).transaction(x => {
      if (!x) return x;   // まだ読めていない（このあと本物の値でやりなおす）か、預かりの品物が消されている
      from = Number(x.qty) || 0;
      to = Math.max(0, from - Number(l.azkQty));
      item = x;
      return { ...x, qty: to, at: Date.now(), by: BY };
    });
    if (!r.committed || !r.snapshot.exists() || !item) {
      logger.warn(`預かりの品物が見つかりません（注文 ${id}・品物 ${lid}・預かり ${l.azk}）`);
      continue;
    }
    await d.ref(`zairyo/azukari/${o.supplier}/log`).push({
      at: ServerValue.TIMESTAMP, by: BY, role: "server", kind: "use", iid: l.azk, spec: String(item.spec || l.spec || "").slice(0, 300), unit: String(item.unit || l.unit || "").slice(0, 10),
      from, to, orderId: id, chuban: String(o.chuban || "").slice(0, 10), kenmei: String(o.kenmei || "").slice(0, 100),
    });
  }
}
