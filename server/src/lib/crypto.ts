import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function sha256Hex(...parts: string[]): string {
  const h = createHash('sha256');
  // Length-prefix each part so ("ab","c") and ("a","bc") never collide.
  for (const p of parts) h.update(`${Buffer.byteLength(p)}:${p}|`);
  return h.digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Hash used to key rate limits and codes, and the only form of an email that may reach logs. */
export function emailHash(pepper: string, email: string): string {
  return sha256Hex('email', pepper, normalizeEmail(email));
}

export function logEmailRef(pepper: string, email: string): string {
  return emailHash(pepper, email).slice(0, 12);
}

export function newOtpCode(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String(randomInt(0, 10));
  return s;
}

export function otpHash(pepper: string, purpose: string, email: string, code: string): string {
  return sha256Hex('otp', pepper, purpose, normalizeEmail(email), code);
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url'); // 256 bits
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
