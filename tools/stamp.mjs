// 新しいプログラムの番号（version.json）を作る（11/4）。GitHub に送る前に、毎回 node tools/stamp.mjs
// - ページ（index.html・jimusho.html・zairyoya.html）は、version.json の番号をプログラムの住所につけて読む（ブラウザに古いプログラムが残らない）
// - 開いているアプリは、番号がかわったら、使っていないときに自動で読みなおす（js/common.js の watchVersion）
// - v＝js・css の中身から作る短い番号（中身が同じなら同じ番号）。files＝番号をつけて読むプログラム
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const js = readdirSync("js").filter(f => f.endsWith(".js")).sort().map(f => "js/" + f);
const h = createHash("sha1");
[...js, "css/common.css"].forEach(f => h.update(f + "\n" + readFileSync(f, "utf8").replace(/\r\n/g, "\n")));
const v = h.digest("hex").slice(0, 10);
writeFileSync("version.json", JSON.stringify({ v, files: js }, null, 1) + "\n");
console.log("version.json", v, `（プログラム ${js.length}こ）`);
