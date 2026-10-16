// 材料屋のアプリ（2回目・2-1）：専用リンクと、材料屋ごとの合言葉
// - 入り方は「専用リンク＋その材料屋の合言葉（最初の1回だけ）」（10/14 持ち主）。端末は何台でも、登録のときに名前を入れる
// - 専用リンクの鍵は /zairyo/supAccess/{材料屋の id} = {key, madeAt, madeBy, codeSetAt?}（事務所だけ読める。書くのはこのプログラムだけ）
// - 合言葉は /config/supCodes/{材料屋の id} にハッシュで（だれも読めない。事務所が ⚙ 設定で決める・変える）
// - 登録（zairyoRegisterDevice の kind "sup"）は index.js。鍵で材料屋を見つけて、「材料屋のアプリで受ける」が ON の材料屋だけ通す
// - 鍵を作り直すと、前のリンクでは新しく登録できない。前のリンクで登録した端末は使えるままなので、事務所が消す
// - 2-5：材料屋が、自分あての注文の図面・写真をダウンロードする（zairyoSupFiles）。ファイルの置き場は事務所・現場しか開けないので、
//   ここで「登録された材料屋の端末か・自分あての注文か・取り消しでないか・その注文のファイルか」を調べてから、リンクを渡す
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getStorage, getDownloadURL } from "firebase-admin/storage";
import { randomBytes, randomUUID } from "node:crypto";
import { hashCode, normalizeCode, MIN_LEN } from "./code.js";
import { db, requireOffice } from "./lib.js";

const SUP_ID = /^[A-Za-z0-9_-]{1,40}$/;
// 場所などはここにも書く（index.js の setGlobalOptions より先にこのファイルが読まれるので、そちらは効かない。
// 書かなかったら us-central1 にできてしまった 10/16）
const OPTS = { region: "asia-southeast1", invoker: "public", maxInstances: 3, memory: "256MiB", timeoutSeconds: 30 };

/** 事務所がえらんだ材料屋 → { supId, sup }（ない・形がちがうときは止める） */
async function supplierOf(supId) {
  const id = String(supId || "");
  if (!SUP_ID.test(id)) throw new HttpsError("invalid-argument", "材料屋がわかりません");
  const sup = (await db().ref(`zairyo/master/suppliers/${id}`).get()).val();
  if (!sup) throw new HttpsError("not-found", "その材料屋は、ありません");
  return { supId: id, sup };
}

/** 鍵 → 材料屋の id（見つからなければ ""）。材料屋は数件なので、全部見てくらべる */
export async function supIdByKey(key) {
  const k = String(key || "");
  if (k.length < 16 || k.length > 64) return "";
  const all = (await db().ref("zairyo/supAccess").get()).val() || {};
  return Object.keys(all).find(id => all[id] && all[id].key === k) || "";
}

/** 専用リンクの鍵を作る・作り直す。data = { supId, remake? } → { key }
 *  remake でないときは、もう鍵があればそれを返す */
export const zairyoSupLink = onCall(OPTS, async request => {
  const me = await requireOffice(request);
  const { supId } = await supplierOf((request.data || {}).supId);
  const ref = db().ref(`zairyo/supAccess/${supId}`);
  const cur = (await ref.get()).val() || {};
  if (cur.key && !(request.data || {}).remake) return { key: cur.key };
  const key = randomBytes(18).toString("base64url");   // 24文字。当てずっぽうでは当たらない長さ
  await ref.update({ key, madeAt: Date.now(), madeBy: me.name });
  return { key };
});

/* ---------- 2-5：図面・写真のダウンロード（10/16 持ち主 1A・2A・3A） ---------- */
const PHOTO_BUCKET = "yotsuba-daicho.firebasestorage.app";   // 写真・注文のファイルの置き場（backup.js と同じ）
const ORDER_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** 呼んだのが材料屋の端末で、登録が消されていないこと。{ uid, sup } を返す */
async function requireSup(request) {
  const uid = request.auth && request.auth.uid, t = (request.auth && request.auth.token) || {};
  if (!uid || t.zr_role !== "sup" || !t.zr_sup) throw new HttpsError("permission-denied", "材料屋のアプリの端末だけができます");
  const d = (await db().ref(`zairyo/devices/${uid}`).get()).val();
  if (!d || d.role !== "sup" || d.sup !== t.zr_sup) throw new HttpsError("permission-denied", "この端末の登録が消されています");
  return { uid, sup: t.zr_sup };
}

/** ダウンロードのリンク。いまは事務所と同じ形（期限なし。持ち主 2A）。
 *  10分で使えなくなるリンク（持ち主 2B）に変えるときは、ここを
 *    (await file.getSignedUrl({ action: "read", expires: Date.now() + 10 * 60 * 1000 }))[0]
 *  にする（サーバーの係に「サービス アカウント トークン作成者」の役わりが要る。Google Cloud の IAM で持ち主が足す） */
async function linkOf(file) {
  try {
    return await getDownloadURL(file);
  } catch (ex) {
    if (ex && ex.code !== "storage/no-download-token") throw ex;
    // まだリンクの鍵がないファイル（もどしたファイルなど）は、鍵をつけてから
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: randomUUID() } });
    return getDownloadURL(file);
  }
}

/** 材料屋が、自分あての注文の図面・写真のリンクをもらう。data = { orderId }
 *  → { files: [{ id, name, size, url }], photos: { 品物の番号: [url…] } }（見られないものは url なし） */
export const zairyoSupFiles = onCall(OPTS, async request => {
  const me = await requireSup(request);
  const orderId = String((request.data || {}).orderId || "");
  if (!ORDER_ID.test(orderId)) throw new HttpsError("invalid-argument", "注文がわかりません");
  const o = (await db().ref(`zairyo/orders/${orderId}`).get()).val();
  // 自分あてで、アプリに送られた注文だけ。取り消しの注文は出さない（持ち主 3A：ほかは「終わった」でも出す）
  if (!o || o.supplier !== me.sup || !o.supState) throw new HttpsError("permission-denied", "この注文のファイルは見られません");
  if (o.status === "cancelled") throw new HttpsError("failed-precondition", "取り消しになった注文です");
  const bucket = getStorage().bucket(PHOTO_BUCKET);
  // その注文についているものだけ（場所の形もたしかめる）
  const okPath = p => typeof p === "string" && /^zairyo\/(files|photos)\/[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_.-]{1,60}$/.test(p);
  const url = p => (okPath(p) ? linkOf(bucket.file(p)).catch(() => null) : Promise.resolve(null));
  const files = await Promise.all(Object.entries(o.files || {}).map(async ([id, f]) => {
    const u = await url(f && f.path);
    return { id, name: String((f && f.name) || ""), size: Number((f && f.size) || 0), ...(u ? { url: u } : {}) };
  }));
  const photos = {};
  await Promise.all(Object.entries(o.lines || {}).map(async ([lid, l]) => {
    const ps = Object.values((l && l.photos) || {});
    if (ps.length) photos[lid] = await Promise.all(ps.map(url));
  }));
  return { files, photos };
});

/** 材料屋の合言葉を決める・変える。data = { supId, code }
 *  変えても、もう登録ずみの端末はそのまま使える（登録のときだけ見るため） */
export const zairyoSupCode = onCall(OPTS, async request => {
  const me = await requireOffice(request);
  const data = request.data || {};
  const { supId } = await supplierOf(data.supId);
  if ([...normalizeCode(data.code)].length < MIN_LEN) throw new HttpsError("invalid-argument", `合言葉は${MIN_LEN}文字以上にしてください`);
  const at = Date.now();
  await db().ref(`config/supCodes/${supId}`).set({ ...hashCode(data.code), setAt: at, setBy: me.name });
  await db().ref(`zairyo/supAccess/${supId}`).update({ codeSetAt: at, codeSetBy: me.name });
  return { supId };
});
