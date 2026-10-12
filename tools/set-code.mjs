// 合言葉を決める・変える（持ち主が自分のパソコンのターミナルで使う）
//   node tools/set-code.mjs
// - 打った合言葉は画面に出しません。元にもどせない形にしてから、Firebase（yotsuba-daicho）の /config/codes にしまいます
// - Firebase の道具（firebase）に、オーナーのアカウントでログインしている必要があります
// - 合言葉を変えても、もう登録ずみのスマホ・パソコンはそのまま使えます
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { hashCode, normalizeCode, MIN_LEN } from "../functions/code.js";

const PROJECT = "yotsuba-daicho";
const KINDS = {
  "1": { kind: "genba", label: "会社の合言葉（現場のスマホ用）" },
  "2": { kind: "office", label: "事務所の合言葉（事務所のパソコン用）" },
};

/** ふつうに聞く（打った字が見える） */
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** 打った字を * にして聞く。ターミナルによってできないときは、ふつうに聞く */
function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return ask(question + "（このターミナルでは、打った字が見えます）");
  }
  return new Promise(resolve => {
    let buf = "";
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const stop = () => { stdin.removeListener("data", onData); stdin.setRawMode(false); stdin.pause(); };
    function onData(s) {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") { stop(); process.stdout.write("\n"); resolve(buf); return; }
        if (ch === "\u0003") { stop(); process.stdout.write("\nやめました\n"); process.exit(1); }
        if (ch === "\u007f" || ch === "\b") {
          if (buf) { buf = [...buf].slice(0, -1).join(""); process.stdout.write("\b \b"); }
          continue;
        }
        if (ch < " ") continue;
        buf += ch;
        process.stdout.write("*");
      }
    }
    stdin.on("data", onData);
  });
}

console.log("よつば材料注文：合言葉を決める・変える\n");
const pick = KINDS[await ask("どちらの合言葉ですか？  1＝会社の合言葉（現場）  2＝事務所の合言葉 ：")];
if (!pick) { console.log("1 か 2 を入れてください。やめました"); process.exit(1); }

const first = await askHidden(`${pick.label}を入れてください（${MIN_LEN}文字以上。8文字以上がおすすめ）：`);
if ([...normalizeCode(first)].length < MIN_LEN) { console.log(`${MIN_LEN}文字より短いので、やめました`); process.exit(1); }
const again = await askHidden("たしかめのため、もう一度入れてください：");
if (normalizeCode(first) !== normalizeCode(again)) { console.log("1回目と2回目がちがうので、やめました"); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), "zairyo-code-"));
const file = join(dir, "code.json");
try {
  writeFileSync(file, JSON.stringify({ ...hashCode(first), setAt: Date.now() }));
  console.log("\nFirebase にしまっています…");
  // Windows では firebase.cmd なので、1つの文にしてシェルで動かす
  const r = spawnSync(`firebase database:set /config/codes/${pick.kind} "${file}" --project ${PROJECT} --force`, { stdio: "inherit", shell: true });
  if (r.status === 0) {
    console.log(`\n${pick.label}をしまいました。`);
  } else {
    console.log("\nしまえませんでした。`firebase login --reauth` でログインしなおしてから、もう一度ためしてください");
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
