// 注文につけるファイル（注文書・図面）（10/15 事務所の相談「加工品の材料注文」の1：ファイルの土台）
// - 置き場は Storage の zairyo/files/{注文の番号}/{番号}.{拡張子}。事務所だけが上げる・見る・消す（storage.rules）。1つ 200MB まで。種類はえらばない
//   （注文書の Excel・DXF・DWG・JWW・PDF など）。あとで見積依頼のファイルを注文に引きつぐときも、同じ置き場の名前をそのまま使う
// - データは注文の files/{番号} = { name（元の名前）, path（置き場の名前）, size, type, at, by }
// - 上げるとき、ダウンロードの名前（Content-Disposition）を元の名前にしておく。押すと、その名前でパソコンの「ダウンロード」に入る
// - 「メールで送る」を押すと、Gmail を開くのといっしょに、ファイルを「ダウンロード」に出す（jimusho-app.js の copyOrSend）。
//   Gmail を開く住所では、ファイルをつけられない（Gmail の決まり）ので、Gmail のクリップで付けてもらう
// - 毎日の夜中に、新しいファイルだけ別の置き場にコピーする（functions/backup.js の saveFiles）
import { ref, push, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { ref as sref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js";
import { db, storage } from "./firebase.js";
import { esc, toast } from "./common.js";

export const MAX_FILE = 200 * 1024 * 1024;
/** 上げている途中（注文の番号 → { name, pct, i, n }）。上げている間に画面をかきなおしても、ようすを出せるように */
const uploading = new Map();

/** 注文のファイル（つけた順） [[番号, ファイル]] */
export const filesOf = o => Object.entries((o && o.files) || {}).sort(([, a], [, b]) => (a.at || 0) - (b.at || 0));

/** 「1.2MB」「350KB」 */
export function sizeText(b) {
  const n = Number(b) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

const progText = u => `上げています（${u.n > 1 ? `${u.i}/${u.n}つめ・` : ""}${u.name}）… ${u.pct}%`;
function setProg(oid, u) {
  if (u) uploading.set(oid, u); else uploading.delete(oid);
  const el = document.getElementById("fileProg");
  if (el && el.dataset.oid === oid) { el.hidden = !u; el.textContent = u ? progText(u) : ""; }
}

/** 注文の画面の「ファイル（注文書・図面）」の欄。canAdd＝つける・消すができる（取り消した注文はできない） */
export function fileBlockHTML(o, canAdd = true, { title = "ファイル（注文書・図面）", hint = "注文書（Excel）・図面（DXF・DWG・JWW・PDF など）。1つ 200MB まで。「メールで送る」を押すと、ここのファイルをパソコンの「ダウンロード」に出します。" } = {}) {
  const fs = filesOf(o), up = uploading.get(o.id);
  return `
    <div class="block" id="fileBlock"><h3>${esc(title)}</h3>
      ${fs.length ? `<ul class="flist">${fs.map(([fid, f]) => `
        <li data-fid="${esc(fid)}"><span class="fname">${esc(f.name)}<small class="hint">${sizeText(f.size)}</small></span>
          <span class="fbtns"><button type="button" class="btn" data-fdl="${esc(fid)}">ダウンロード</button>${canAdd ? `<button type="button" class="linkbtn muted" data-fdel="${esc(fid)}">消す</button>` : ""}</span></li>`).join("")}</ul>`
        : `<p class="hint">${canAdd ? "まだありません。" : "ありません。"}</p>`}
      <p class="hint ok" id="fileProg" data-oid="${esc(o.id)}" role="status"${up ? "" : " hidden"}>${up ? esc(progText(up)) : ""}</p>
      ${canAdd ? `<div class="row"><label class="btn">＋ ファイルをつける<input type="file" multiple data-fadd hidden></label>
        ${fs.length > 1 ? '<button type="button" class="btn" data-fdlall>ぜんぶダウンロード</button>' : ""}</div>
      <p class="hint">${esc(hint)}</p>` : ""}
    </div>`;
}

/** つけられるファイルだけにする（200MB より大きい・空のファイルは知らせて外す） */
export function okFiles(list) {
  const all = [...list];
  const big = all.filter(f => f.size > MAX_FILE), empty = all.filter(f => !f.size);
  if (big.length) toast(`200MB より大きいファイルは、つけられません（${big.map(f => f.name).join("・")}）`);
  if (empty.length) toast(`中身が空のファイルは、つけられません（${empty.map(f => f.name).join("・")}）`);
  return all.filter(f => f.size && f.size <= MAX_FILE);
}

/** 1つのファイルを置き場に上げる（owner＝注文の番号。まだしまっていない注文の番号でもよい）。onPct(0〜100)。
 *  返り値 { fid, entry }：entry を注文の files/{fid} に書く（書けなかったら removeUploaded で置き場からも消す） */
export async function uploadFile(owner, f, me, onPct) {
  const fid = push(ref(db, `zairyo/orders/${owner}/files`)).key;
  const m = f.name.match(/\.([A-Za-z0-9]{1,10})$/);
  const path = `zairyo/files/${owner}/${fid}${m ? "." + m[1].toLowerCase() : ""}`;
  await new Promise((resolve, reject) => {
    const task = uploadBytesResumable(sref(storage, path), f, {
      contentType: f.type || "application/octet-stream",
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,   // ダウンロードの名前を元の名前に
    });
    task.on("state_changed", s => onPct(s.totalBytes ? Math.floor(s.bytesTransferred / s.totalBytes * 100) : 0), reject, resolve);
  });
  return { fid, entry: { name: f.name.slice(0, 200), path, size: f.size, type: (f.type || "").slice(0, 100), at: serverTimestamp(), by: (me && me.name) || "事務所" } };
}
/** 上げたけれど注文に書けなかったファイルを、置き場から消す */
export const removeUploaded = paths => Promise.all(paths.map(p => deleteObject(sref(storage, p)).catch(() => {})));

/** ファイルを上げて、注文につける（1つずつ。上げおわったら注文に書く。書けなかったら置き場からも消す） */
async function addFiles(o, list, me, base) {
  const ok = okFiles(list);
  if (!ok.length) return;
  if (uploading.has(o.id)) { toast("いま上げています。終わってから、もう一度つけてください"); return; }
  let done = 0;
  try {
    for (const [i, f] of ok.entries()) {
      const u = { name: f.name, pct: 0, i: i + 1, n: ok.length };
      setProg(o.id, u);
      const { fid, entry } = await uploadFile(o.id, f, me, pct => setProg(o.id, { ...u, pct }));
      try {
        await update(ref(db, `${base}/${o.id}/files/${fid}`), entry);
      } catch (ex) {
        await removeUploaded([entry.path]);
        throw ex;
      }
      done++;
    }
  } finally {
    setProg(o.id, null);
  }
  toast(`ファイルを${done > 1 ? ` ${done}つ` : ""}つけました`);
}

/** ファイルをパソコンの「ダウンロード」に出す（上げるときに、元の名前でダウンロードになるようにしてある）。
 *  2つ以上のときは、少しずつ間をあける。はじめてのときは、Chrome が「複数のファイルのダウンロード」を聞く */
export async function downloadFiles(list) {
  const urls = await Promise.all(list.map(f => getDownloadURL(sref(storage, f.path))));
  urls.forEach((u, i) => setTimeout(() => {
    const a = document.createElement("a");
    a.href = u;
    a.download = list[i].name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  }, i * 400));
}

/** 注文の画面のファイルの欄を動かす。getOrder()＝いまの注文（データが変わると新しくなるので、押したときに読む）。
 *  base＝データの場所（注文は zairyo/orders、見積は zairyo/quotes。10/15）。
 *  redraw()＝画面をかきなおす（「本当に？」を出している間は、データが変わってもかきなおさないため、終わったら呼ぶ） */
export function wireFiles(w, getOrder, me, { onErr, redraw, base = "zairyo/orders" }) {
  w.addEventListener("change", e => {
    const inp = e.target.closest("[data-fadd]");
    if (!inp || !inp.files || !inp.files.length) return;
    const o = getOrder();
    const list = [...inp.files];
    inp.value = "";
    if (o) addFiles(o, list, me, base).catch(onErr);
  });
  w.addEventListener("click", e => {
    const t = e.target.closest("[data-fdl],[data-fdlall],[data-fdel],[data-fdelyes],[data-fdelno]");
    if (!t || t.disabled) return;
    const o = getOrder();
    if (!o) return;
    const d = t.dataset, f = id => (o.files || {})[id];
    if (d.fdl) {
      if (f(d.fdl)) downloadFiles([f(d.fdl)]).then(() => toast("「ダウンロード」に入れました"), onErr);
    } else if ("fdlall" in d) {
      downloadFiles(filesOf(o).map(([, x]) => x)).then(() => toast("ぜんぶ「ダウンロード」に入れました"), onErr);
    } else if (d.fdel) {   // 消す前に、たしかめる（「本当に？」の間は、画面をかきなおさない＝.confirm）
      const li = t.closest("li"), x = f(d.fdel);
      if (!li || !x) return;
      li.className = "confirm";
      li.innerHTML = `<p class="confirm-q">「${esc(x.name)}」を消しますか？</p>
        <div class="confirm-btns"><button type="button" class="btn danger" data-fdelyes="${esc(d.fdel)}">消す</button><button type="button" class="btn" data-fdelno>やめる</button></div>`;
    } else if ("fdelno" in d) {
      redraw();
    } else if (d.fdelyes) {
      const x = f(d.fdelyes);
      if (!x) return;
      t.disabled = true;
      t.textContent = "消しています…";
      deleteObject(sref(storage, x.path)).catch(() => {})   // 置き場にもうなくても、注文からは外す
        .then(() => update(ref(db, `${base}/${o.id}/files`), { [d.fdelyes]: null }))
        .then(() => toast(`「${x.name}」を消しました`), onErr)
        .finally(redraw);
    }
  });
}
