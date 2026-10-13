// サーバーのプログラムで共通に使う部品（index.js・ai.js）
import { HttpsError } from "firebase-functions/v2/https";
import { getDatabase } from "firebase-admin/database";

// データベースは使うときにつなぐ（読みこみのときにつなぐと、Firebase に入れるときの下しらべで止まる）
let database;
export const db = () => (database ||= getDatabase());

/** 呼んだのが事務所の端末で、登録が消されていないこと。{uid, name} を返す */
export async function requireOffice(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid || request.auth.token.zr_role !== "office") throw new HttpsError("permission-denied", "事務所のパソコンだけができます");
  const d = (await db().ref(`zairyo/devices/${uid}`).get()).val();
  if (!d || d.role !== "office") throw new HttpsError("permission-denied", "このパソコンの登録が消されています");
  return { uid, name: d.name || "" };
}
