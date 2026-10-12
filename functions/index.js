// よつば材料注文 サーバーのプログラム（Cloud Functions）
// - 場所はデータベースと同じシンガポール（asia-southeast1）
// - 名前は zairyo で始める（あとで見積・請求のアプリも同じ Firebase に入るので、ぶつからないように）
// - 役割は「アプリごと」（10/12）。材料注文の役割は zr_role、名前は zr_name。ほかのアプリのクレームは消さずに残す
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase, ServerValue } from "firebase-admin/database";
import { verifyCode } from "./code.js";

setGlobalOptions({ region: "asia-southeast1", maxInstances: 3, memory: "256MiB", timeoutSeconds: 30 });
initializeApp();
// データベースは使うときにつなぐ（読みこみのときにつなぐと、Firebase に入れるときの下しらべで止まる）
let database;
const db = () => (database ||= getDatabase());

const KINDS = { genba: "genba", office: "office" };
const NAME_MAX = 20;

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
  await db().ref(`zairyo/devices/${uid}`).set({ role: kind, name, registeredAt: ServerValue.TIMESTAMP });
  await db().ref(`config/tries/uid/${uid}`).remove();
  return { role: kind, name };
});
