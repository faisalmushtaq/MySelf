/**
 * Minimal ULID generator (Crockford base32, time-sortable, crypto-random).
 * Dependency-free so it runs identically in browser and Node tests.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[rand[i]! % 32];
  return time + random;
}
