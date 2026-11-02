// メールにつける PDF（11/2 事務員さん「メールで注文するときに、注文書の PDF をつけたい」）
// - FAX 用の紙（js/fax.js の faxHTML・mitsumoriFaxHTML）を、ブラウザの中で絵にして、A4 の PDF にする（FAX の紙と同じ形）
// - 道具は html2canvas（紙を絵にする）と jsPDF（絵を PDF にする）。cdnjs から、はじめて使うときに読む。
//   版を決めて、中身のしるし（integrity）も見る（ちがう中身なら読まない）
// - 長いときは、横1列ぜんぶ白い所（字の行のあいだ）で切って、つぎの紙へ（行の途中では切らない）。2枚目からは上に余白
// - PDF の中の字は絵（字を選んでコピーはできない）。1枚 200KB くらい
// - できた PDF は、パソコンの「ダウンロード」に出す。Gmail を開く住所ではファイルをつけられない（Gmail の決まり）ので、
//   Gmail のクリップで付けてもらう（jimusho-app.js の copyOrSend。加工品のファイルと同じ）
const LIBS = [
  { name: "html2canvas", src: "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js", integrity: "sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==" },
  { name: "jspdf", src: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", integrity: "sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA==" },
];
const SCALE = 2.2;   // 絵の細かさ（A4 の横が 1700 くらいの点。FAX・印刷で字がつぶれない）
let loading = null;

/** PDF を作る道具を読む（1回だけ。読めなかったら、つぎに押したときにもう一度読む） */
export function loadPdfLibs() {
  if (!loading) {
    loading = Promise.all(LIBS.map(l => window[l.name] ? null : new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = l.src;
      s.integrity = l.integrity;
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.onload = res;
      s.onerror = () => { s.remove(); rej(new Error("PDF を作る道具を読めませんでした")); };
      document.head.append(s);
    }))).catch(ex => { loading = null; throw ex; });
  }
  return loading;
}

/** 印刷用の HTML（js/fax.js の1枚の紙）を、A4 の PDF にする → Blob。
 *  label＝2枚以上になったとき、どの紙の下にも出す名前（例「注文書　AB26123　○○鋼材」。そのうしろに「1/2」） */
export async function htmlToPdf(html, { label = "" } = {}) {
  await loadPdfLibs();
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  // 見えない所に、A4 の横はばで出す（画面用の余白が、紙の余白になる）
  f.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  try {
    await new Promise((res, rej) => { f.onload = res; f.onerror = rej; f.srcdoc = html; document.body.append(f); });
    const doc = f.contentDocument, el = doc.documentElement;
    if (doc.fonts) await doc.fonts.ready;
    const c = await window.html2canvas(el, { scale: SCALE, backgroundColor: "#ffffff", logging: false, windowWidth: el.scrollWidth, windowHeight: el.scrollHeight, width: el.scrollWidth, height: el.scrollHeight });
    return toA4(c, label);
  } finally {
    f.remove();
  }
}

/** 絵を A4 の紙に分けて PDF にする */
function toA4(c, label) {
  const mm = c.width / 210, pageH = Math.round(297 * mm), marg = Math.round(14 * mm);
  const ctx = c.getContext("2d");
  // 横1列ごとに「白い（字・線がない）」「黒い線（表の横の線）」かを見る
  const rows = (y0, y1) => {
    const d = ctx.getImageData(0, y0, c.width, y1 - y0).data, W = c.width * 4;
    return k => {
      let dark = 0;
      for (let i = (k - y0) * W, e = i + W; i < e; i += 8) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) dark++;
      return { white: dark === 0, line: dark > c.width / 4 };   // 8 バイトおきに見ているので、半分より多い＝横の線
    };
  };
  // 切る所（下から上へさがす。紙の半分より上では切らない）：
  // ① 空いた行（段落のあいだ。白が 5mm 以上つづく所）→ ② 字の行のあいだ → ③ 表の横の線のすぐ下 → ④ そのまま
  const cutAt = (y, end) => {
    const lo = y + Math.round(pageH * 0.5);
    if (end <= lo) return end;
    const r = rows(lo, end + 1), gap = Math.round(5 * mm);
    let run = 0;
    for (let k = end; k > lo; k--) { if (r(k).white) { if (++run >= gap) return k + (run >> 1); } else run = 0; }
    for (let k = end; k > lo; k--) if (r(k).white) return k;
    for (let k = end; k > lo; k--) if (r(k).line) return Math.min(end, k + 3);
    return end;
  };
  const allWhite = (y0, y1) => { const r = rows(y0, y1); for (let k = y0; k < y1; k++) if (!r(k).white) return false; return true; };
  const cuts = [];
  let y = 0;
  while (y < c.height - 2) {
    const top = cuts.length ? marg : 0;   // 1枚目は、紙の余白が絵に入っている。2枚目からは上に余白をつける
    const bottom = y + pageH - top;       // この紙の下のはし（絵の中で）
    // のこりが、この紙におさまる（紙の下からはみ出すのが、紙の余白の白だけのときも）→ 切らない。おさまらなければ、下に余白をのこして切る
    const fits = c.height <= bottom || (c.height - bottom <= 6 * mm && allWhite(bottom, c.height));
    const end = fits ? c.height : cutAt(y, bottom - marg);
    cuts.push([y, end, top]);
    y = end;
    const r = y < c.height - 2 ? rows(y, Math.min(c.height, y + pageH)) : null;
    while (r && y < c.height - 2 && y < cuts.at(-1)[1] + pageH - 1 && r(y).white) y++;   // つぎの紙のはじめの白い所は、とばす
  }
  const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  cuts.forEach(([y0, y1, top], i) => {
    const p = document.createElement("canvas");
    p.width = c.width;
    p.height = pageH;
    const x = p.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, p.width, p.height);
    x.drawImage(c, 0, y0, c.width, y1 - y0, 0, top, c.width, y1 - y0);
    if (cuts.length > 1) {   // 2枚以上：どの紙の下にも「注文書　AB26123　○○鋼材　1/2」
      x.fillStyle = "#333";
      x.font = `${Math.round(3.6 * mm)}px "Yu Gothic", "YuGothic", "Meiryo", sans-serif`;
      x.textAlign = "right";
      x.fillText(`${label ? label + "　" : ""}${i + 1}/${cuts.length}`, c.width - 16 * mm, pageH - 7 * mm);
    }
    if (i) pdf.addPage();
    pdf.addImage(p.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, 210, 297);
  });
  return pdf.output("blob");
}

/** PDF のファイルの名前「注文書_AB26123_○○鋼材_20261102.pdf」（なに・注番・材料屋・作った日。ファイルの名前に使えない字は _ に） */
export function pdfName(what, chuban, supName, d = new Date()) {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const safe = s => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  return [what, safe(chuban), safe(supName), ymd].filter(Boolean).join("_") + ".pdf";
}

/** PDF をパソコンの「ダウンロード」に出す */
export function downloadBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60 * 1000);
}
