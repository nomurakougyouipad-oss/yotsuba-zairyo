// 合言葉のあつかい（サーバーのプログラムと tools/set-code.mjs の両方で使う）
// - 合言葉そのものはしまわない。元にもどせない形（scrypt）にしてから /config/codes にしまう
// - 全角・半角、前後の空白、大文字・小文字のちがいは同じとみなす（スマホの打ちまちがいを減らすため）
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384, R = 8, P = 1, LEN = 32;
export const MIN_LEN = 6;

export function normalizeCode(code) {
  return String(code ?? "").normalize("NFKC").trim().toLowerCase();
}

/** 合言葉 → しまう形 { algo, salt, hash } */
export function hashCode(code) {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizeCode(code), salt, LEN, { N, r: R, p: P });
  return { algo: `scrypt-${N}-${R}-${P}`, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

/** 打った合言葉が、しまってあるものと合うか */
export function verifyCode(code, saved) {
  if (!saved || !saved.salt || !saved.hash || !normalizeCode(code)) return false;
  const [, n, r, p] = String(saved.algo || "").split("-").map(Number);
  const want = Buffer.from(saved.hash, "base64");
  const got = scryptSync(normalizeCode(code), Buffer.from(saved.salt, "base64"), want.length, { N: n || N, r: r || R, p: p || P });
  return got.length === want.length && timingSafeEqual(got, want);
}
