import type { DB } from '../db.js';
import type { Clock } from '../lib/clock.js';
import {
  constantTimeEqualHex,
  emailHash,
  newOtpCode,
  otpHash,
  sha256Hex,
} from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';

export const OTP = {
  length: 6,
  ttlMs: 10 * 60_000,
  resendCooldownMs: 42_000,
  perEmailPerHour: 5,
  // Overridable for local end-to-end runs only (many sign-ins from one machine); production keeps 20.
  perIpPerHour: Number(process.env.OTP_PER_IP_PER_HOUR) > 0 ? Number(process.env.OTP_PER_IP_PER_HOUR) : 20,
  maxAttempts: 5,
} as const;

const HOUR = 3_600_000;

export type Purpose = 'login' | 'email_change' | 'mcp';

interface CodeRow {
  code_hash: string;
  expires_at: number;
  attempts: number;
}

export class OtpService {
  constructor(
    private db: DB,
    private clock: Clock,
    private pepper: string,
  ) {}

  ipHash(ip: string): string {
    return sha256Hex('ip', this.pepper, ip);
  }

  /**
   * Enforces cooldown and hourly limits, then issues a fresh code that replaces any previous
   * one for the same (purpose, email, owner). Returns the plaintext code for the mailer only.
   */
  issue(purpose: Purpose, email: string, ip: string, ownerUserId = ''): string {
    const now = this.clock.now();
    const eh = emailHash(this.pepper, email);
    const ih = this.ipHash(ip);
    const since = now - HOUR;

    const ipSends = this.db
      .prepare('SELECT at FROM otp_sends WHERE ip_hash = ? AND at > ? ORDER BY at ASC')
      .all(ih, since) as { at: number }[];
    if (ipSends.length >= OTP.perIpPerHour) {
      throw rateLimited(ipSends[0]!.at + HOUR - now);
    }
    const emailSends = this.db
      .prepare('SELECT at FROM otp_sends WHERE email_hash = ? AND at > ? ORDER BY at ASC')
      .all(eh, since) as { at: number }[];
    const last = emailSends.at(-1);
    if (last && now - last.at < OTP.resendCooldownMs) {
      throw rateLimited(last.at + OTP.resendCooldownMs - now);
    }
    if (emailSends.length >= OTP.perEmailPerHour) {
      throw rateLimited(emailSends[0]!.at + HOUR - now);
    }

    const code = newOtpCode(OTP.length);
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO otp_sends (email_hash, ip_hash, at) VALUES (?, ?, ?)').run(eh, ih, now);
      this.db
        .prepare(
          `INSERT INTO otp_codes (purpose, email_hash, user_id, code_hash, created_at, expires_at, attempts)
           VALUES (?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (purpose, email_hash, user_id) DO UPDATE SET
             code_hash = excluded.code_hash, created_at = excluded.created_at,
             expires_at = excluded.expires_at, attempts = 0`,
        )
        .run(purpose, eh, ownerUserId, otpHash(this.pepper, purpose, email, code), now, now + OTP.ttlMs);
    });
    tx();
    return code;
  }

  /** Throws HttpError on failure; consumes the code on success. */
  verify(purpose: Purpose, email: string, code: string, ownerUserId = ''): void {
    const now = this.clock.now();
    const eh = emailHash(this.pepper, email);
    const key = [purpose, eh, ownerUserId] as const;
    const row = this.db
      .prepare('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE purpose = ? AND email_hash = ? AND user_id = ?')
      .get(...key) as CodeRow | undefined;

    // Incomplete/malformed input never counts as an attempt.
    if (!new RegExp(`^\\d{${OTP.length}}$`).test(code)) throw new HttpError(400, 'invalid_code');
    if (!row) throw new HttpError(400, 'invalid_code');
    if (now >= row.expires_at) throw new HttpError(410, 'expired_code');
    if (row.attempts >= OTP.maxAttempts) throw new HttpError(429, 'too_many_attempts');

    const ok = constantTimeEqualHex(otpHash(this.pepper, purpose, email, code), row.code_hash);
    if (!ok) {
      this.db
        .prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE purpose = ? AND email_hash = ? AND user_id = ?')
        .run(...key);
      throw new HttpError(400, 'invalid_code');
    }
    this.db.prepare('DELETE FROM otp_codes WHERE purpose = ? AND email_hash = ? AND user_id = ?').run(...key);
  }

  purge(): void {
    const now = this.clock.now();
    this.db.prepare('DELETE FROM otp_codes WHERE expires_at < ?').run(now - HOUR);
    this.db.prepare('DELETE FROM otp_sends WHERE at < ?').run(now - HOUR);
  }
}

function rateLimited(ms: number): HttpError {
  return new HttpError(429, 'rate_limited', { retryAfter: Math.max(1, Math.ceil(ms / 1000)) });
}
