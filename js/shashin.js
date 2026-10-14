// 写真・スクショ と お店のリンク と ネットでさがす（11章 6）
// - 写真は、えらんだときに長い辺1280px・JPEG（質0.8）に小さくして、すぐ Storage の zairyo/photos/{自分の端末の番号}/{番号}.jpg に上げる
//   （カートには置き場所だけしまう。iPhone で開きなおしても消えないように）。1品物4枚まで
// - 見られるのは、上げた本人の端末と事務所だけ（storage.rules）。材料屋（2回目）に見せるときは、そのとき決める
// - 送る前にカートから外した写真は、置き場からも消す。送ったあとの写真は消さない
//   （品物の画面で外した写真・入れずに閉じた写真は、品物の画面が「入れた／閉じた」ときにまとめて消す。photoPicker では消さない）
// - リンクは http・https だけ。押す前に「モノタロウ（monotaro.com）」のように、お店の名前を出す
// - ネットでさがす：書いた言葉で、お店の検索のページを新しいタブで開くだけ（アプリの中には何も取りこまない）
import { ref as sref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js";
import { storage, auth } from "./firebase.js";
import { esc, toast, openSheet, saveDraft, clearDraft } from "./common.js";

export const MAX_PHOTOS = 4;
export const SHOPS = [
  { id: "monotaro", name: "モノタロウ", url: q => "https://www.monotaro.com/s/?c=&q=" + encodeURIComponent(q) },
  { id: "misumi", name: "ミスミ", url: q => "https://jp.misumi-ec.com/vona2/result/?Keyword=" + encodeURIComponent(q) },
  { id: "amazon", name: "アマゾン", url: q => "https://www.amazon.co.jp/s?k=" + encodeURIComponent(q) },
];

/* ---------- リンク ---------- */
/** http・https のリンクだけ通す（ほかは ""） */
export function safeLink(s) {
  try {
    const u = new URL(String(s || "").trim());
    return /^https?:$/.test(u.protocol) ? u.href : "";
  } catch (err) { return ""; }
}
const linkHost = h => { try { return new URL(h).hostname.replace(/^www\./, ""); } catch (err) { return ""; } };
const SHOP_NAME = { "monotaro.com": "モノタロウ", "jp.misumi-ec.com": "ミスミ", "amazon.co.jp": "アマゾン", "amzn.asia": "アマゾン" };
/** 「モノタロウ（monotaro.com）」のような、お店の名前 */
export function linkLabel(h) {
  const host = linkHost(h);
  return SHOP_NAME[host] ? `${SHOP_NAME[host]}（${host}）` : host;
}
/** リンクが、どのネットのお店のページか（SHOPS の id。ほかのページは ""）。材料屋を最初からそのお店にするのに使う（10/15） */
export function shopOf(h) {
  const host = linkHost(h), on = d => host === d || host.endsWith("." + d);
  return on("monotaro.com") ? "monotaro" : on("misumi-ec.com") ? "misumi" : on("amazon.co.jp") || on("amzn.asia") || on("amzn.to") ? "amazon" : "";
}

/* ---------- 写真 ---------- */
/** 写真を長い辺 max px の JPEG にする（1枚 200〜300KB くらい） */
export function shrinkImage(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * s));
      c.height = Math.max(1, Math.round(img.naturalHeight * s));
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error("画像を小さくできません"))), "image/jpeg", 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像が読めません")); };
    img.src = url;
  });
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** 写真を Storage に上げて、置き場所（path）を返す */
export async function uploadPhoto(blob) {
  const path = `zairyo/photos/${auth.currentUser.uid}/${newId()}.jpg`;
  await uploadBytes(sref(storage, path), blob, { contentType: "image/jpeg" });
  urlCache.set(path, Promise.resolve(URL.createObjectURL(blob)));   // 上げたばかりの写真は、手元の画像をそのまま見せる
  return path;
}

/** 写真を置き場から消す（送る前にカートから外したとき。うまくいかなくても止めない） */
export function deletePhoto(path) {
  urlCache.delete(path);
  return deleteObject(sref(storage, path)).catch(() => { });
}

/** 写真の見る用の住所（同じ写真は1回だけ聞く） */
const urlCache = new Map();
export function photoURL(path) {
  if (!urlCache.has(path)) {
    const p = getDownloadURL(sref(storage, path));
    p.catch(() => urlCache.delete(path));   // 見られなかったら、つぎにまた聞く
    urlCache.set(path, p);
  }
  return urlCache.get(path);
}

/** 写真の小さい絵（removable なら「はずす」つき）。<img> の住所は fillPhotos であとから入れる */
export function photosHTML(paths, removable = false) {
  return (paths || []).map((p, i) => `
    <span class="ph">
      <button type="button" class="ph-img" data-phview="${esc(p)}" aria-label="写真を大きく見る"><img data-path="${esc(p)}" alt=""></button>
      ${removable ? `<button type="button" class="ph-x" data-phdel="${i}" aria-label="この写真をはずす">×</button>` : ""}
    </span>`).join("");
}
/** el の中の写真に、見る用の住所を入れる */
export function fillPhotos(el) {
  el.querySelectorAll("img[data-path]:not([src])").forEach(img => {
    photoURL(img.dataset.path).then(u => { img.src = u; }, () => { img.alt = "見られません"; img.closest(".ph-img").classList.add("ng"); });
  });
}

/** 写真をつける欄。list（置き場所の並び）をそのまま変える。onChange() で知らせる */
export function photoPicker(box, list, onChange) {
  let busy = 0;
  const draw = () => {
    box.innerHTML = photosHTML(list, true) +
      (busy ? `<span class="ph-busy">上げています…（${busy}枚）</span>` : "") +
      (list.length + busy < MAX_PHOTOS ? '<label class="ph-add"><input type="file" accept="image/*" multiple hidden>＋ つける</label>' : "");
    fillPhotos(box);
  };
  const add = async files => {
    const fs = [...files].filter(f => /^image\//.test(f.type)).slice(0, MAX_PHOTOS - list.length - busy);
    busy += fs.length;
    draw();
    for (const f of fs) {
      try {
        list.push(await uploadPhoto(await shrinkImage(f)));
      } catch (err) {
        toast("写真を上げられませんでした。電波をたしかめて、もう一度ためしてください");
      }
      busy--;
      draw();
      if (onChange) onChange();
    }
  };
  box.addEventListener("change", e => { if (e.target.matches('input[type="file"]')) add(e.target.files); });
  box.addEventListener("click", e => {
    const d = e.target.closest("[data-phdel]");
    if (!d) return;
    list.splice(Number(d.dataset.phdel), 1);   // 置き場から消すのは、使う側（品物の画面）が決める
    draw();
    if (onChange) onChange();
  });
  // パソコンなら、写真をドラッグしてもつけられる
  const zone = box.closest(".field") || box;
  zone.addEventListener("dragover", e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); box.classList.add("drop"); } });
  zone.addEventListener("dragleave", () => box.classList.remove("drop"));
  zone.addEventListener("drop", e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); box.classList.remove("drop"); add(e.dataTransfer.files); });
  draw();
  return { isBusy: () => busy > 0 };
}

/** 写真を大きく見る（押すか Esc で閉じる） */
export function openPhoto(path) {
  const d = document.createElement("div");
  d.className = "lightbox";
  d.setAttribute("role", "dialog");
  d.setAttribute("aria-label", "写真");
  d.innerHTML = '<img alt=""><button type="button" class="x" aria-label="閉じる">×</button>';
  photoURL(path).then(u => { d.querySelector("img").src = u; }, () => { d.querySelector("img").alt = "見られません"; });
  const close = () => { d.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
  d.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(d);
  d.querySelector(".x").focus();
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-phview]");
  if (b) openPhoto(b.dataset.phview);
});

/** 品物の行・注文についている写真とリンク */
export function attachOf(lines) {
  const ls = Object.values(lines || {});
  return {
    photos: ls.flatMap(l => Object.values(l.photos || {})),
    links: [...new Set(ls.map(l => l.link).filter(Boolean))],
  };
}
/** 写真とリンクの欄（なければ ""）。出したあと fillPhotos(el) を呼ぶ */
export function attachHTML(lines, title = "写真・リンク") {
  const a = attachOf(lines);
  if (!a.photos.length && !a.links.length) return "";
  return `
    <div class="block attach"><h3>${esc(title)}</h3>
      ${a.photos.length ? `<div class="photos">${photosHTML(a.photos)}</div>` : ""}
      ${a.links.map(h => `<a class="shoplink" href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(h))} のページを開く</a>`).join("")}
    </div>`;
}

/* ---------- ネットでさがす（現場の上のボタン） ---------- */
let webQ = "";
/** onFound(言葉) … 「見つけた物を注文に入れる」を押したとき（「自由に書く」を品名入りで開く）
 *  q0 … 書きかけからもどすときの言葉 */
export function openWebSearch(onFound, q0) {
  if (typeof q0 === "string") webQ = q0;
  const html = `
    <div class="pw" id="webWrap">
      <div class="panel-head"><div><span class="eyebrow">一覧にない物をさがす</span><h2 id="panelTitle">ネットでさがす</h2></div>
        <button type="button" class="x" data-close aria-label="閉じる">×</button></div>
      <div class="field"><label for="wQ">さがす言葉</label>
        <input id="wQ" class="inp" enterkeyhint="search" autocomplete="off" placeholder="例　キャスター 100mm 自在" value="${esc(webQ)}" data-autofocus></div>
      <div class="field"><span class="lab">どのお店でさがしますか？</span>
        <div class="shops big">${SHOPS.map(sh => `<a class="btn shop" data-shop="${sh.id}" href="#" target="_blank" rel="noopener noreferrer">${sh.name}</a>`).join("")}</div>
        <span class="hint" id="wHint">お店のページが別に開きます。</span></div>
      <ol class="howto">
        <li>お店で品物が見つかったら、スクショを撮る</li>
        <li>このアプリにもどって、下のボタンを押す</li>
        <li>スクショをつけて、カートに入れる</li>
      </ol>
      <div class="sheet-foot"><button type="button" class="btn primary big full" id="wToCart">見つけた物を注文に入れる</button></div>
    </div>`;
  openSheet(html, p => {
    const w = p.querySelector("#webWrap"), q = w.querySelector("#wQ"), hint = w.querySelector("#wHint");
    const up = () => {
      webQ = q.value.trim().replace(/\s+/g, " ");
      w.querySelectorAll("[data-shop]").forEach(a => {
        a.href = webQ ? SHOPS.find(sh => sh.id === a.dataset.shop).url(webQ) : "#";
        a.setAttribute("aria-disabled", String(!webQ));
      });
      if (webQ) { hint.textContent = "お店のページが別に開きます。"; hint.className = "hint"; }
      saveDraft({ kind: "web", q: webQ });   // お店からもどってアプリが開きなおしても、この画面にもどす
    };
    q.addEventListener("input", up);
    q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); q.blur(); } });
    w.addEventListener("click", e => {
      const a = e.target.closest("[data-shop]");
      if (a && !webQ) { e.preventDefault(); hint.textContent = "先に、さがす言葉を書いてください"; hint.className = "hint bad"; q.focus(); return; }
      if (e.target.closest("#wToCart")) onFound(webQ);
    });
    up();
  }, { onClose: clearDraft });
}
