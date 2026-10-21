import type { DB } from '../db.js';
import type { Clock } from '../lib/clock.js';
import { newSessionToken, tokenHash } from '../lib/crypto.js';

export const SESSION_TTL_MS = 90 * 24 * 3_600_000;
// Avoid a write on every request; sliding precision of one minute is plenty.
const TOUCH_EVERY_MS = 60_000;

export class SessionService {
  constructor(
    private db: DB,
    private clock: Clock,
  ) {}

  create(userId: string): string {
    const token = newSessionToken();
    const now = this.clock.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash(token), userId, now, now, now + SESSION_TTL_MS);
    return token;
  }

  /** Returns the user id for a valid token and slides its expiry. */
  authenticate(token: string): string | null {
    const h = tokenHash(token);
    const row = this.db
      .prepare('SELECT user_id, last_used_at, expires_at FROM sessions WHERE token_hash = ?')
      .get(h) as { user_id: string; last_used_at: number; expires_at: number } | undefined;
    if (!row) return null;
    const now = this.clock.now();
    if (now >= row.expires_at) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
      return null;
    }
    if (now - row.last_used_at >= TOUCH_EVERY_MS) {
      this.db
        .prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?')
        .run(now, now + SESSION_TTL_MS, h);
    }
    return row.user_id;
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }

  revokeAll(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  purge(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(this.clock.now());
  }
}
