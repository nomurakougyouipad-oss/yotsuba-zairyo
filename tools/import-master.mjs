// 試作（prototype/zairyo-chumon.html）のマスタを、Firebase（yotsuba-daicho）のデータベースに入れる
//   node tools/import-master.mjs           … 何が入るかを見るだけ（データベースは変えない）
//   node tools/import-master.mjs --write   … 入れる（Firebase の道具に、オーナーのアカウントでログインしている必要がある）
// - 人の名前・材料屋・注番などはコードに書かない決まり（10/12）。なので、このプログラムには中身を書かず、
//   このパソコンにだけある試作から読んで、そのままデータベースに入れる
// - 入れる場所
//     /common/kaisha/{頭の2文字}          … 注番の会社 {name, kana, hidden}（台帳ぜんたいで使う）
//     /common/kotei/{頭の2文字＋件数3けた} … 固定の注番 {name, hidden}（年はのぞく。MM26000 → MM000）
//     /zairyo/master/suppliers/{id}        … 材料屋 {name, to(宛名), app, azukari, alias[], order}
//     /zairyo/master/places/{id}           … 届け先 {name, text(注文の文に書く言葉), order}
//     /zairyo/master/catalog               … 品物一覧 {units[], cats[]}（いつもの材料屋は id で持つ）
//     /zairyo/master/staff/{名前}          … 注文する人 {addedAt}（もういる人はそのまま）
// - もう入っているマスタ（材料屋・注番の会社など）があるときは、上書きしないで止まる（--force で上書き）
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";

const PROJECT = "yotsuba-daicho";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const FORCE = args.includes("--force");
const SRC = resolve(args.find(a => !a.startsWith("--")) || "prototype/zairyo-chumon.html");

/* ---------- 試作から、データの所だけ取り出す ---------- */
const NAMES = ["A_ALL", "A_SMALL", "M_SIZE", "B_MAT", "TEIJAKU", "CATS", "UNITS", "STAFF", "SUPPLIERS", "SUP_TO", "SUP_APP", "SUP_AZ",
  "PLACES", "ADDR", "KOTEI", "KAISHA", "SUP_ALIAS"];

/** `const NAME = …;` の文を1つ取り出す（かっこと文字列を数えて、いちばん外の ; までを取る） */
function extract(src, name) {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).exec(src);
  if (!m) throw new Error(`試作の中に ${name} が見つかりません`);
  let i = m.index + m[0].length, depth = 0, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 1;
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) break;
  }
  return "const " + src.slice(m.index, i + 1).replace(/^(?:const|let|var)\s+/, "");
}

const html = readFileSync(SRC, "utf8");
const code = NAMES.map(n => extract(html, n)).join("\n") + `\n({${NAMES.join(",")}})`;
const P = vm.runInNewContext(code, {}, { timeout: 2000 });

/* ---------- データベースの形にする ---------- */
const now = Date.now();
const warn = [];

const supId = new Map(P.SUPPLIERS.map((name, i) => [name, "s" + String(i + 1).padStart(2, "0")]));
const suppliers = {};
P.SUPPLIERS.forEach((name, i) => {
  suppliers[supId.get(name)] = {
    name,
    to: P.SUP_TO[name] || "御中",
    app: !!P.SUP_APP[name],
    azukari: !!P.SUP_AZ[name],
    alias: P.SUP_ALIAS[name] || [],
    order: i,
  };
});
for (const name of Object.keys(P.SUP_ALIAS)) {
  if (!supId.has(name)) warn.push(`読みかえ表の「${name}」は材料屋の一覧にないので入れません（LINE の貼り付けで出たら、事務所が「新しい材料屋として足す」をえらぶ）`);
}

const toSupId = (name, where) => {
  if (!name) return "";
  if (!supId.has(name)) { warn.push(`${where} のいつもの材料屋「${name}」が一覧にありません`); return ""; }
  return supId.get(name);
};
const catalog = {
  units: P.UNITS,
  cats: P.CATS.map(c => ({
    ...c,
    sup: toSupId(c.sup, c.name),
    items: c.items.map(it => {
      const x = { ...it };
      if ("sup" in x) x.sup = toSupId(x.sup, `${c.name}／${it.name}`);
      return x;
    }),
  })),
};

const places = {};
P.PLACES.forEach((name, i) => { places["p" + (i + 1)] = { name, text: P.ADDR[name] || "", order: i }; });

const kaisha = {};
for (const k of P.KAISHA) {
  if (!/^[A-Z]{2}$/.test(k.code)) { warn.push(`会社の頭文字「${k.code}」の形がちがうので入れません`); continue; }
  kaisha[k.code] = { name: k.name, kana: k.kana || "", hidden: !!k.hidden };
}

const kotei = {};
for (const k of P.KOTEI) {
  if (!/^[A-Z]{2}\d{5}$/.test(k.chuban)) { warn.push(`固定の注番「${k.chuban}」の形がちがうので入れません`); continue; }
  kotei[k.chuban.slice(0, 2) + k.chuban.slice(4)] = { name: k.name, hidden: !!k.hidden };
}

/* ---------- いまのデータベースを見る（読むだけ） ---------- */
/** firebase の道具を動かす（Windows では firebase.cmd なので、1つの文にしてシェルで動かす） */
function fb(argv, opts = {}) {
  const line = ["firebase", ...argv, "--project", PROJECT].map(a => /[\s"&|<>^]/.test(a) ? `"${a}"` : a).join(" ");
  return spawnSync(line, { encoding: "utf8", shell: true, ...opts });
}
function shallow(path) {
  const r = fb(["database:get", path, "--shallow"]);
  if (r.status !== 0) throw new Error(`${path} を読めませんでした。\`firebase login --reauth\` でログインしなおしてください\n${r.stderr || ""}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() || "null") || {};
}
const haveCommon = shallow("/common");
const haveMaster = shallow("/zairyo/master");
const haveStaff = shallow("/zairyo/master/staff");

const staffNew = P.STAFF.filter(n => !haveStaff[n]);
const update = {
  "common/kaisha": kaisha,
  "common/kotei": kotei,
  "zairyo/master/suppliers": suppliers,
  "zairyo/master/places": places,
  "zairyo/master/catalog": catalog,
};
for (const n of staffNew) update[`zairyo/master/staff/${n}`] = { addedAt: now };

/* ---------- 何が入るかを出す ---------- */
const items = catalog.cats.reduce((s, c) => s + c.items.length, 0);
console.log("試作：" + SRC);
console.log(`注番の会社    ${Object.keys(kaisha).length} 社` + (haveCommon.kaisha ? "（もう入っている）" : ""));
console.log(`固定の注番    ${Object.keys(kotei).length} 件（${Object.keys(kotei).slice(0, 4).join("・")} …）` + (haveCommon.kotei ? "（もう入っている）" : ""));
console.log(`材料屋        ${Object.keys(suppliers).length} 社（宛名が御中でない：${Object.values(suppliers).filter(s => s.to !== "御中").length}／アプリ：${Object.values(suppliers).filter(s => s.app).length}／預かり：${Object.values(suppliers).filter(s => s.azukari).length}）` + (haveMaster.suppliers ? "（もう入っている）" : ""));
console.log(`届け先        ${Object.keys(places).length} か所` + (haveMaster.places ? "（もう入っている）" : ""));
console.log(`品物一覧      種類 ${catalog.cats.length}・品物 ${items}・単位 ${catalog.units.length}` + (haveMaster.catalog ? "（もう入っている）" : ""));
console.log(`注文する人    ${staffNew.length} 人を足す（もういる人 ${Object.keys(haveStaff).length} 人はそのまま）`);
for (const w of warn) console.log("※ " + w);

if (!WRITE) {
  console.log("\n見るだけでした。入れるときは --write をつけてください");
  process.exit(0);
}
const already = ["kaisha", "kotei"].filter(k => haveCommon[k]).concat(["suppliers", "places", "catalog"].filter(k => haveMaster[k]));
if (already.length && !FORCE) {
  console.log(`\nもう入っているマスタがあります（${already.join("・")}）。事務所で直した中身を消さないように、止めました。上書きするときは --force をつけてください`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "zairyo-master-"));
const file = join(dir, "master.json");
try {
  writeFileSync(file, JSON.stringify(update));
  console.log("\nFirebase に入れています…");
  const r = fb(["database:update", "/", file, "--force"], { stdio: "inherit" });
  if (r.status !== 0) { console.log("入れられませんでした"); process.exitCode = 1; }
  else console.log("入れました");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
