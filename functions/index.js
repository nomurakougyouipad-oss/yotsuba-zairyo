// よつば材料注文 サーバーのプログラム（Cloud Functions）
// - 場所はデータベースと同じシンガポール（asia-southeast1）
// - 名前は zairyo で始める（あとで見積・請求のアプリも同じ Firebase に入るので、ぶつからないように）
// - 役割は「アプリごと」（10/12）。材料注文の役割は zr_role、名前は zr_name。ほかのアプリのクレームは消さずに残す
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { ServerValue } from "firebase-admin/database";
import { verifyCode, hashCode, normalizeCode, MIN_LEN } from "./code.js";
import { db, requireOffice } from "./lib.js";
// 自動の保存（毎日の夜中3時・データは毎日・写真は週1回）は backup.js
export { zairyoBackup } from "./backup.js";
// AI（Claude）の入口は ai.js（11章 7-3）
export { zairyoAi } from "./ai.js";

setGlobalOptions({ region: "asia-southeast1", maxInstances: 3, memory: "256MiB", timeoutSeconds: 30 });
initializeApp();

const KINDS = { genba: "genba", office: "office" };
const NAME_MAX = 20;
const KIKI_MAX = 40;   // 機種（例 iPhone・ホーム画面）。ページが調べて送ってくる。見分けるためだけに使う

/* ---------- 合言葉の当てずっぽうを防ぐ ----------
   同じ端末で5回まちがえたら15分止める。
   だれが打っても1時間に30回まちがえたら、登録を全部15分止める（新しい端末を作りなおして当てに来るのを防ぐ）。
   登録ずみの端末は止まらない */
const TRY = { uidFails: 5, allFails: 30, windowMs: 60 * 60 * 1000, lockMs: 15 * 60 * 1000 };
const LOCKED_MSG = "まちがいが多いので、しばらく止めています。15分ほどたってから、もう一度ためしてください";

async function checkLock(uid) {
  const now = Date.now();
  const [one, all] = await Promise.all([
    db().ref(`config/tries/uid/${uid}/lockUntil`).get(),
    db().ref("config/tries/all/lockUntil").get(),
  ]);
  if ((one.val() || 0) > now || (all.val() || 0) > now) throw new HttpsError("resource-exhausted", LOCKED_MSG);
}

function bump(max, now) {
  return cur => {
    const c = cur && now - (cur.since || 0) < TRY.windowMs ? { ...cur } : { since: now, fails: 0 };
    c.fails = (c.fails || 0) + 1;
    if (c.fails >= max) {
      c.lockUntil = now + TRY.lockMs;
      c.since = now;
      c.fails = 0;
    }
    return c;
  };
}

async function countFail(uid) {
  const now = Date.now();
  await Promise.all([
    db().ref(`config/tries/uid/${uid}`).transaction(bump(TRY.uidFails, now)),
    db().ref("config/tries/all").transaction(bump(TRY.allFails, now)),
  ]);
}

/** 注文する人の一覧（かくした人は出さない） */
async function staffNames() {
  const v = (await db().ref("zairyo/master/staff").get()).val() || {};
  return Object.keys(v).filter(k => !(v[k] && v[k].hidden)).sort((a, b) => a.localeCompare(b, "ja"));
}

/** 端末を登録する。data = { kind: "genba" | "office", code, name? }
 *  現場：name がないときは、合言葉が合っているかだけ見て、注文する人の一覧を返す（まだ登録しない）
 *  返り値：{ needName: true, staff: [名前…] } または { role, name } */
// invoker: "public" … 入口はだれでも通す（ページから呼ぶため）。だれが呼んだかは、中で request.auth と合言葉でたしかめる
export const zairyoRegisterDevice = onCall({ invoker: "public" }, async request => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインできていません。ページを開きなおしてください");
  const data = request.data || {};
  const kind = KINDS[data.kind];
  if (!kind) throw new HttpsError("invalid-argument", "登録の種類がちがいます");

  await checkLock(uid);
  const saved = (await db().ref(`config/codes/${kind}`).get()).val();
  if (!saved) throw new HttpsError("failed-precondition", "合言葉がまだ決まっていません。事務所に知らせてください");
  if (!verifyCode(data.code, saved)) {
    await countFail(uid);
    throw new HttpsError("permission-denied", "合言葉がちがいます");
  }

  const name = String(data.name ?? "").trim();
  if (kind === "genba") {
    const staff = await staffNames();
    if (!name) return { needName: true, staff };
    if (!staff.includes(name)) throw new HttpsError("invalid-argument", "その名前は、注文する人の一覧にありません");
  } else if (!name) {
    throw new HttpsError("invalid-argument", "このパソコンの名前を入れてください");
  }
  if ([...name].length > NAME_MAX) throw new HttpsError("invalid-argument", `名前は${NAME_MAX}文字までにしてください`);

  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), zr_role: kind, zr_name: name });
  const kiki = String(data.kiki ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, KIKI_MAX);
  await db().ref(`zairyo/devices/${uid}`).set({
    role: kind, name, registeredAt: ServerValue.TIMESTAMP, seenAt: ServerValue.TIMESTAMP, ...(kiki ? { kiki } : {}),
  });
  await db().ref(`config/tries/uid/${uid}`).remove();
  return { role: kind, name };
});

/* ---------- 事務所だけ：登録した端末を消す・合言葉を変える（11章 8。事務所かのたしかめは lib.js の requireOffice） ---------- */

/** 登録した端末を消す。data = { uid }
 *  - データベースの登録（/zairyo/devices/{uid}）を消すので、ルールですぐ読めなくなる
 *  - 材料注文の印（zr_role・zr_name）だけ外して、ログインのしるしを使えなくする（ほかのアプリの印は残す）。
 *    ほかのアプリの印もなければ、ログインごと消す
 *  - 写真の置き場（Storage）は、いま持っているしるしが切れるまで最大1時間ずれる
 *  - いま使っている自分のパソコンは消せない */
export const zairyoRemoveDevice = onCall({ invoker: "public" }, async request => {
  const me = await requireOffice(request);
  const uid = String((request.data || {}).uid || "");
  if (!uid || uid.length > 128 || /[.#$\[\]\/]/.test(uid)) throw new HttpsError("invalid-argument", "消す端末がわかりません");
  if (uid === me.uid) throw new HttpsError("failed-precondition", "いま使っているこのパソコンは、ここからは消せません");
  const d = (await db().ref(`zairyo/devices/${uid}`).get()).val();
  if (!d) throw new HttpsError("not-found", "その端末は、もう消されています");

  const auth = getAuth();
  try {
    const user = await auth.getUser(uid);
    const claims = { ...(user.customClaims || {}) };
    delete claims.zr_role;
    delete claims.zr_name;
    if (Object.keys(claims).length) {
      await auth.setCustomUserClaims(uid, claims);
      await auth.revokeRefreshTokens(uid);
    } else {
      await auth.deleteUser(uid);
    }
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  await db().ref(`zairyo/devices/${uid}`).remove();
  return { removed: d.name || "", role: d.role, by: me.name };
});

/** 合言葉を変える。data = { kind: "genba" | "office", code }
 *  変えても、もう登録ずみの端末はそのまま使える（登録のときだけ合言葉を見るため） */
export const zairyoChangeCode = onCall({ invoker: "public" }, async request => {
  const me = await requireOffice(request);
  const data = request.data || {};
  const kind = KINDS[data.kind];
  if (!kind) throw new HttpsError("invalid-argument", "どちらの合言葉かがわかりません");
  if ([...normalizeCode(data.code)].length < MIN_LEN) throw new HttpsError("invalid-argument", `合言葉は${MIN_LEN}文字以上にしてください`);
  await db().ref(`config/codes/${kind}`).set({ ...hashCode(data.code), setAt: Date.now(), setBy: me.name });
  return { kind };
});
