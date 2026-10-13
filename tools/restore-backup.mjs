// バックアップのファイル（事務所の「今すぐバックアップを保存」で作ったもの）から、データベースを元にもどす（11章 8-2）
//   node tools/restore-backup.mjs <ファイル>          … 中身を見て、いまのデータベースとくらべるだけ（何も変えない）
//   node tools/restore-backup.mjs <ファイル> --test   … ためしの場所（/_restore_test）にもどして、読みもどしてくらべる。おわったら、ためしの場所は消す
//   node tools/restore-backup.mjs <ファイル> --write  … 本当にもどす（いまのデータは上書き）。先にいまのデータを backups/ に保存してから、「もどす」と打つと始める
//   --only <場所>  … 1か所だけ（例 --only zairyo/requests/-Nabc123）。--test・--write といっしょに使う
// - Firebase の道具に、オーナーのアカウントでログインしている必要がある（firebase login）
// - もどせるのは、ファイルに入っている材料注文の場所と /common だけ。合言葉（/config）や、ほかのアプリの場所にはさわらない
// - 写真（Storage）は入っていないので、もどらない（8-3 の週1回のまるごと保存でもどす）
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const PROJECT = "yotsuba-daicho";
const TEST_ROOT = "_restore_test";
// js/backup.js の BACKUP_PATHS と同じ
const PATHS = [
  ["zairyo/requests", "依頼"],
  ["zairyo/orders", "注文"],
  ["zairyo/invoices", "まとめて請求"],
  ["zairyo/prices", "単価の記録"],
  ["zairyo/imports", "納品書の取りこみの記録"],
  ["zairyo/master", "設定"],
  ["zairyo/devices", "登録した端末"],
  ["common", "注番の会社"],
];

class Stop extends Error { }
const stop = msg => { throw new Stop(msg); };
let tmp = "";

/* ---------- Firebase の道具 ---------- */
function fb(argv) {
  const line = ["firebase", ...argv, "--project", PROJECT].map(a => (/[\s"&|<>^]/.test(a) ? `"${a}"` : a)).join(" ");
  const r = spawnSync(line, { encoding: "utf8", shell: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ");
    if (/credentials|reauth|login/i.test(msg)) stop("Firebase の道具のログインが切れています。firebase login --reauth をしてから、もう一度ためしてください");
    stop("Firebase の道具がうまく動きませんでした：" + msg);
  }
  return r.stdout;
}
const fbGet = path => JSON.parse(fb(["database:get", "/" + path]).trim() || "null");
function fbSet(path, value) {
  if (value === null || value === undefined) {
    fb(["database:remove", "/" + path, "--force"]);
    return;
  }
  const f = join(tmp, "data.json");
  writeFileSync(f, JSON.stringify(value));
  fb(["database:set", "/" + path, f, "--force"]);
}

/* ---------- くらべる ---------- */
// 並びがちがっても同じとみなす（データベースは、キーを並べかえて返すため）
const canon = v => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
const count = v => (v && typeof v === "object" ? Object.keys(v).length : v === null || v === undefined ? 0 : 1);
const pad = x => String(x).padStart(2, "0");
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

async function main() {
  const args = process.argv.slice(2);
  const TEST = args.includes("--test");
  const WRITE = args.includes("--write");
  const onlyAt = args.indexOf("--only");
  const ONLY = onlyAt >= 0 ? String(args[onlyAt + 1] || "").replace(/^\/+|\/+$/g, "") : "";
  const FILE = args.find((a, i) => !a.startsWith("--") && (onlyAt < 0 || i !== onlyAt + 1));
  if (!FILE) stop("もどすファイルを書いてください（例 node tools/restore-backup.mjs zairyo-backup-2026-10-13-0745.json）");
  if (TEST && WRITE) stop("--test と --write は、いっしょに使えません");
  if (onlyAt >= 0 && !ONLY) stop("--only のあとに、もどす場所を書いてください");

  /* ---------- ファイルを読む ---------- */
  let file;
  try {
    file = JSON.parse(readFileSync(resolve(FILE), "utf8"));
  } catch (err) {
    stop("ファイルを読めませんでした：" + err.message);
  }
  if (!file || file.app !== "yotsuba-zairyo" || file.kind !== "backup" || !file.data || typeof file.data !== "object") {
    stop("材料注文のバックアップのファイルではないようです");
  }
  if (file.project && file.project !== PROJECT) stop(`ちがう Firebase（${file.project}）のバックアップです`);
  const unknown = Object.keys(file.data).filter(p => !PATHS.some(([q]) => q === p));
  if (unknown.length) console.log(`（知らない場所は使いません：${unknown.join("・")}）`);

  /** ファイルの中の「場所」の中身。--only のときは、その下の1か所 */
  const pick = path => {
    const top = PATHS.find(([q]) => path === q || path.startsWith(q + "/"));
    if (!top) stop(`${path} は、バックアップに入っている場所ではありません（${PATHS.map(([q]) => q).join("・")}）`);
    if (!(top[0] in file.data)) stop(`${top[0]} は、このファイルに入っていません`);
    let v = file.data[top[0]] ?? null;
    for (const seg of path.slice(top[0].length).split("/").filter(Boolean)) v = v && typeof v === "object" ? v[seg] ?? null : null;
    return v;
  };

  tmp = mkdtempSync(join(tmpdir(), "zairyo-restore-"));
  const targets = ONLY ? [[ONLY, "えらんだ1か所"]] : PATHS.filter(([p]) => p in file.data);
  const savedAt = file.savedAt ? new Date(file.savedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "（わからない）";
  console.log(`\nバックアップ：${savedAt}　保存した人：${file.savedBy || "（なし）"}`);
  console.log(ONLY ? `もどす場所：${ONLY}` : "もどす場所：ファイルに入っている場所ぜんぶ");

  /* ---------- 1. いまとくらべる（何も変えない） ---------- */
  console.log("\n■ いまのデータベースとくらべる");
  const diffs = [];
  for (const [p, label] of targets) {
    const want = pick(p), now = fbGet(p);
    const ok = same(want, now);
    if (!ok) diffs.push(p);
    console.log(`  ${ok ? "○ 同じ" : "△ ちがう"}　${label}（${p}）　ファイル ${count(want)}・いま ${count(now)}`);
  }
  console.log(diffs.length ? `\nちがう所が ${diffs.length}か所あります。` : "\nぜんぶ、いまのデータと同じです。");

  /* ---------- 2. ためしの場所にもどす ---------- */
  if (TEST) {
    console.log(`\n■ ためしの場所（/${TEST_ROOT}）にもどして、読みもどす`);
    let bad = 0;
    try {
      for (const [p, label] of targets) {
        const want = pick(p);
        fbSet(`${TEST_ROOT}/${p}`, want);
        const back = fbGet(`${TEST_ROOT}/${p}`);
        const ok = same(want, back);
        if (!ok) bad++;
        console.log(`  ${ok ? "○ もどせた" : "× ちがった"}　${label}（${p}）　${count(back)}`);
      }
    } finally {
      fb(["database:remove", "/" + TEST_ROOT, "--force"]);
      console.log(`  ためしの場所（/${TEST_ROOT}）は消しました`);
    }
    console.log(bad ? `\n× ${bad}か所が、ファイルとちがいました。` : "\n○ ぜんぶ、ファイルのとおりにもどせました（いまのデータは変えていません）。");
  }

  /* ---------- 3. 本当にもどす ---------- */
  if (WRITE) {
    if (!diffs.length) {
      console.log("\nいまのデータと同じなので、もどす必要はありません。");
      return;
    }
    // 先に、いまのデータを保存しておく（もどしたあとで「やっぱり前のほうがよかった」ときのため）
    mkdirSync("backups", { recursive: true });
    const before = {
      app: "yotsuba-zairyo", kind: "backup", version: 1, project: PROJECT,
      savedAt: new Date().toISOString(), savedBy: "restore-backup.mjs（もどす前）", data: {},
    };
    for (const [p] of PATHS) before.data[p] = fbGet(p);
    const beforeFile = join("backups", `before-restore-${stamp(new Date())}.json`);
    writeFileSync(beforeFile, JSON.stringify(before, null, 1));
    console.log(`\nいまのデータを ${beforeFile} に保存しました。`);
    console.log(`もどすのは、ちがう ${diffs.length}か所：${diffs.join("・")}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question("本当にもどすときは「もどす」と打って Enter（ほかはやめる）：")).normalize("NFKC").trim();
    rl.close();
    if (ans !== "もどす") {
      console.log("やめました。データベースは変えていません。");
      return;
    }
    for (const p of diffs) {
      fbSet(p, pick(p));
      console.log(`  ○ もどしました：${p}`);
    }
    const still = diffs.filter(p => !same(pick(p), fbGet(p)));
    console.log(still.length ? `\n× まだちがう所があります：${still.join("・")}` : "\n○ もどしました。ファイルと同じになったのをたしかめました。");
  }
}

main()
  .catch(err => {
    console.error("\n× " + (err instanceof Stop ? err.message : (err && err.stack) || err) + "\n");
    process.exitCode = 1;
  })
  .finally(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    console.log("");
  });
