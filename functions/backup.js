// 自動の保存（11章 8-3）：毎日の夜中3時（日本の時刻）に動く
// - データ：毎日。8-2 の「今すぐバックアップを保存」と同じ形の JSON を、別の置き場の data/ に入れる
// - 注文のファイル（注文書・図面。10/15）：毎日、まだコピーしていないものだけを、別の置き場の files/{日時}/ にコピーする（saveFiles）
// - 写真：週1回（日曜）。写真の置き場の zairyo/photos/ をぜんぶ、別の置き場の photos/{日時}/ にコピーする。
//   日曜がうまくいかなかったときは、次の日以降に（前の写真の保存から6日半たっていたら）やりなおす
// - 別の置き場は東京（asia-northeast1）。12週（84日）たったものは、置き場のライフサイクルが消す。
//   このプログラムには「足す」権限しかないので、前の保存を消したり書きかえたりはできない（10/13 持ち主）
// - 結果は /zairyo/backupLog に書く（事務所の「バックアップ」のタブに出す）
// - Firebase の「毎日の自動バックアップ」は、有効にするとエラーになって使えなかったので、このプログラムで代わりにする（10/13）
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getDatabase, ServerValue } from "firebase-admin/database";
import { getStorage } from "firebase-admin/storage";

const BACKUP_BUCKET = "yotsuba-daicho-zairyo-backup";
const PHOTO_BUCKET = "yotsuba-daicho.firebasestorage.app";
const PHOTO_PREFIXES = ["zairyo/photos/", "zairyo/scans/"];   // 写真と、納品書のスキャン（7-5c）
// js/backup.js の BACKUP_PATHS と同じ（tools/restore-backup.mjs でもどせる形）
const BACKUP_PATHS = ["zairyo/requests", "zairyo/orders", "zairyo/quotes", "zairyo/invoices", "zairyo/prices", "zairyo/imports", "zairyo/officeInfo", "zairyo/master", "zairyo/devices", "common"];
const PHOTO_EVERY = 6.5 * 24 * 60 * 60 * 1000;   // 前の写真の保存からこれだけたったら、日曜でなくても写真を保存する
// 注文につけたファイル（注文書・図面。10/15）：大きいので、写真のように毎週ぜんぶはコピーしない。毎日、まだコピーしていないものだけ。
// 別の置き場は84日で消えるので、80日たったものは、もう一度コピーする（このプログラムは置き場を読めない＝「足す」だけなので、
// コピーした記録は /zairyo/backupFiles に残す。ここはアプリからは読めない・書けない）
const FILE_PREFIX = "zairyo/files/";
const FILE_REDO = 80 * 24 * 60 * 60 * 1000;
const JST = 9 * 60 * 60 * 1000;

let database;
const db = () => (database ||= getDatabase());
const pad = x => String(x).padStart(2, "0");
/** 日本の時刻で「2026-10-13-0300」 */
function stampOf(ms) {
  const d = new Date(ms + JST);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** データを読んで、別の置き場に JSON で入れる */
async function saveData(now, stamp) {
  const data = {};
  for (const p of BACKUP_PATHS) data[p] = (await db().ref(p).get()).val();
  const body = JSON.stringify({
    app: "yotsuba-zairyo", kind: "backup", version: 1, project: "yotsuba-daicho",
    savedAt: new Date(now).toISOString(), savedBy: "毎日の自動保存",
    note: "よつば材料注文のバックアップ。写真と合言葉は入っていない。戻すときは tools/restore-backup.mjs を使う",
    data,
  }, null, 1);
  const name = `data/${stamp.slice(0, 7)}/zairyo-backup-${stamp}.json`;
  await getStorage().bucket(BACKUP_BUCKET).file(name).save(body, { resumable: false, contentType: "application/json" });
  const n = v => (v && typeof v === "object" ? Object.keys(v).length : 0);
  return { file: name, bytes: Buffer.byteLength(body), requests: n(data["zairyo/requests"]), orders: n(data["zairyo/orders"]) };
}

/** 写真をぜんぶ、別の置き場の photos/{日時}/ にコピーする（置き場どうしでコピーするので、ここには写真を読みこまない） */
async function savePhotos(now, stamp) {
  const src = getStorage().bucket(PHOTO_BUCKET), dst = getStorage().bucket(BACKUP_BUCKET);
  const files = [];
  for (const prefix of PHOTO_PREFIXES) {
    const [list] = await src.getFiles({ prefix });
    files.push(...list.filter(f => !f.name.endsWith("/")));
  }
  const dir = `photos/${stamp}`;
  let bytes = 0;
  for (let i = 0; i < files.length; i += 10) {   // 10枚ずつ
    await Promise.all(files.slice(i, i + 10).map(f => f.copy(dst.file(`${dir}/${f.name}`))));
  }
  for (const f of files) bytes += Number(f.metadata.size || 0);
  await dst.file(`${dir}/_list.json`).save(JSON.stringify({
    savedAt: new Date(now).toISOString(), count: files.length, bytes, files: files.map(f => f.name),
  }, null, 1), { resumable: false, contentType: "application/json" });
  return { dir, count: files.length, bytes };
}

/** 注文のファイルのうち、まだコピーしていない（か、80日より前にコピーした）ものだけを、別の置き場の files/{日時}/ にコピーする */
async function saveFiles(now, stamp) {
  const src = getStorage().bucket(PHOTO_BUCKET), dst = getStorage().bucket(BACKUP_BUCKET);
  const [list] = await src.getFiles({ prefix: FILE_PREFIX });
  const files = list.filter(f => !f.name.endsWith("/"));
  const rec = db().ref("zairyo/backupFiles");
  const done = (await rec.get()).val() || {};
  const keyOf = name => name.slice(FILE_PREFIX.length).replace(/[.#$[\]/]/g, "_");   // データベースの名前に使えない字を _ に
  const todo = files.filter(f => !(now - (done[keyOf(f.name)] || 0) < FILE_REDO));
  const dir = `files/${stamp}`;
  let bytes = 0;
  for (let i = 0; i < todo.length; i += 5) {   // 大きいので5つずつ
    const part = todo.slice(i, i + 5);
    await Promise.all(part.map(f => f.copy(dst.file(`${dir}/${f.name}`))));
    await rec.update(Object.fromEntries(part.map(f => [keyOf(f.name), now])));
    for (const f of part) bytes += Number(f.metadata.size || 0);
  }
  return { dir, count: todo.length, bytes, total: files.length };
}

/** 毎日の夜中3時。データは毎日、写真は日曜（または前の写真の保存から6日半たったとき）、注文のファイルは毎日（新しいものだけ） */
// 場所はここにも書く（index.js の setGlobalOptions より先にこのファイルが読まれるので、そちらは効かない）
export const zairyoBackup = onSchedule({
  region: "asia-southeast1", schedule: "0 3 * * *", timeZone: "Asia/Tokyo", retryCount: 0,
  timeoutSeconds: 540, memory: "512MiB", maxInstances: 1,
}, async () => {
  const now = Date.now(), stamp = stampOf(now);
  const log = db().ref("zairyo/backupLog");

  try {
    const r = await saveData(now, stamp);
    await log.child("data").set({ ok: true, at: ServerValue.TIMESTAMP, ...r });
  } catch (err) {
    console.error("データの保存に失敗", err);
    await log.child("data").set({ ok: false, at: ServerValue.TIMESTAMP, error: String(err.message || err).slice(0, 300) });
  }

  try {   // 注文のファイル（毎日・新しいものだけ。10/15）
    const r = await saveFiles(now, stamp);
    await log.child("files").set({ ok: true, at: ServerValue.TIMESTAMP, ...r });
  } catch (err) {
    console.error("ファイルの保存に失敗", err);
    await log.child("files").set({ ok: false, at: ServerValue.TIMESTAMP, error: String(err.message || err).slice(0, 300) });
  }

  const last = (await log.child("photos").get()).val();
  const sunday = new Date(now + JST).getUTCDay() === 0;
  const lastOk = (last && last.okAt) || 0;
  if (!sunday && now - lastOk < PHOTO_EVERY) return;
  try {
    const r = await savePhotos(now, stamp);
    await log.child("photos").set({ ok: true, at: ServerValue.TIMESTAMP, okAt: now, ...r });
  } catch (err) {
    console.error("写真の保存に失敗", err);
    await log.child("photos").set({ ok: false, at: ServerValue.TIMESTAMP, okAt: lastOk, error: String(err.message || err).slice(0, 300) });
  }
});
