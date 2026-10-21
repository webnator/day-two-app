import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Clock } from '../lib/clock.js';
import { tokenHash, normalizeEmail } from '../lib/crypto.js';
import { OtpService } from '../auth/otp.js';
import { codeEmail, type Mailer } from '../mail/mailer.js';
import { HttpError } from '../lib/errors.js';

const token = () => randomBytes(32).toString('base64url');
const ACCESS_MS = 3600_000, REFRESH_MS = 90 * 86400_000, FLOW_MS = 15 * 60_000;
export const SCOPES = ['journal:read', 'journal:write'];
const parse = <T extends z.ZodType>(schema: T, input: unknown): z.output<T> => {
  const r = schema.safeParse(input); if (!r.success) throw new HttpError(400, 'invalid_request'); return r.data;
};
const escaped = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
interface Client { id: string; name: string; redirects: string }
interface AuthParams { client_id: string; redirect_uri: string; response_type: 'code'; scope: string; state?: string; code_challenge: string; code_challenge_method: 'S256'; resource: string }
interface Flow { hash: string; params: string; email: string | null; expires_at: number }
export interface McpIdentity { userId: string; grantId: string; scopes: string[] }

export class OAuthService {
  readonly resource: string;
  readonly metadataUrl: string;
  private origin: string;
  private cookiePath: string;
  constructor(readonly db: DB, readonly clock: Clock, readonly baseUrl: string, private otp: OtpService, private mailer: Mailer) {
    this.resource = baseUrl + '/mcp';
    this.metadataUrl = baseUrl + '/.well-known/oauth-protected-resource';
    this.origin = new URL(baseUrl).origin;
    this.cookiePath = new URL(baseUrl).pathname.replace(/\/$/, '') + '/oauth';
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY,name TEXT NOT NULL,redirects TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_flows (hash TEXT PRIMARY KEY,params TEXT NOT NULL,email TEXT,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_grants (
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES mcp_clients(id),scopes TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mcp_codes (
        hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,challenge TEXT NOT NULL,expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,resource TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS mcp_tokens_grant ON mcp_tokens(grant_id);
      CREATE TABLE IF NOT EXISTS mcp_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);
    `);
  }
  challenge(reply: FastifyReply, error = 'invalid_token', status = 401) {
    return reply.code(status).header('WWW-Authenticate', `Bearer resource_metadata="${this.metadataUrl}", scope="journal:read journal:write", error="${error}"`).send({ error });
  }
  authenticate(raw: string | undefined): McpIdentity | null {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(raw ?? '');
    if (!m) return null;
    const r = this.db.prepare(`SELECT g.user_id,g.id,g.scopes FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id
      WHERE t.hash=? AND t.kind='access' AND t.resource=? AND t.expires_at>? AND g.revoked_at IS NULL`).get(tokenHash(m[1]!), this.resource, this.clock.now()) as { user_id: string; id: string; scopes: string } | undefined;
    return r ? { userId: r.user_id, grantId: r.id, scopes: r.scopes.split(' ') } : null;
  }
  rate(req: FastifyRequest, category: string, limit: number, ms = 60_000) {
    const now = this.clock.now(), key = tokenHash(category + ':' + req.ip);
    this.db.prepare('DELETE FROM mcp_limits WHERE until_at<=?').run(now);
    const count = this.db.prepare(`INSERT INTO mcp_limits(key,count,until_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).get(key, now + ms) as { count: number };
    if (count.count > limit) throw new HttpError(429, 'rate_limited', { retryAfter: Math.ceil(ms / 1000) });
  }
  purge() {
    const now = this.clock.now();
    this.db.prepare('DELETE FROM mcp_flows WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM mcp_codes WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM mcp_tokens WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM mcp_limits WHERE until_at<=?').run(now);
  }
  list(user: string) {
    return this.db.prepare(`SELECT g.id,c.name,g.scopes,g.created_at createdAt FROM mcp_grants g JOIN mcp_clients c ON c.id=g.client_id
      WHERE g.user_id=? AND g.revoked_at IS NULL ORDER BY g.created_at DESC`).all(user);
  }
  revoke(user: string, id: string) { this.db.prepare('UPDATE mcp_grants SET revoked_at=? WHERE id=? AND user_id=?').run(this.clock.now(), id, user); }
  private client(id: string): Client {
    const c = this.db.prepare('SELECT * FROM mcp_clients WHERE id=?').get(id) as Client | undefined;
    if (!c) throw new HttpError(400, 'invalid_client'); return c;
  }
  private mint(grantId: string, scope: string) {
    const access = token(), refresh = token(), now = this.clock.now();
    const q = this.db.prepare('INSERT INTO mcp_tokens(hash,grant_id,kind,resource,expires_at) VALUES (?,?,?,?,?)');
    q.run(tokenHash(access), grantId, 'access', this.resource, now + ACCESS_MS);
    q.run(tokenHash(refresh), grantId, 'refresh', this.resource, now + REFRESH_MS);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope };
  }
  private cookie(value: string, clear = false) {
    return `daytwo_mcp_flow=${value}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : FLOW_MS / 1000}${this.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  private form(reply: FastifyReply, flowToken: string, flow: Flow, error = '') {
    const p = JSON.parse(flow.params) as AuthParams, client = this.client(p.client_id);
    const action = escaped(this.baseUrl + '/oauth/authorize');
    const name = escaped(client.name), callbackHost = escaped(new URL(p.redirect_uri).hostname);
    const input = flow.email
      ? `<p>Te hemos enviado un código a ${escaped(flow.email)}.</p><label>Código de acceso<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
         <p>Al continuar, permites leer las entradas sincronizadas y sus datos para análisis.</p>
         ${p.scope.includes('journal:write') ? '<label class="permission"><input type="checkbox" name="write" value="yes" checked> Permitir también crear y editar entradas.</label>' : ''}
         <button name="action" value="approve">Conectar mi diario</button>`
      : '<p>Entra con el mismo email que usas en Day Two.</p><label>Email<input name="email" type="email" autocomplete="email" maxlength="254" required autofocus></label><button name="action" value="send">Recibir código</button>';
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
      .header('X-Content-Type-Options', 'nosniff').type('text/html');
    return reply.send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conectar Day Two</title>
      <style>body{margin:0;background:#fff;color:#111210;font:18px/1.4 Georgia,serif}main{max-width:380px;margin:7vh auto;padding:24px}header{text-align:center;font-size:30px;margin-bottom:54px}h1{font-size:34px;font-weight:400;line-height:1.1}p{color:#555b65}label{display:block;margin:22px 0 8px}input{box-sizing:border-box;width:100%;min-height:48px;padding:10px;font:inherit;border:1px solid #b8bcc3;border-radius:6px;margin-top:8px}button{width:100%;min-height:48px;margin-top:24px;background:#111210;color:#fff;border:0;border-radius:8px;font:inherit;padding:12px}small{font-size:14px;color:#555b65}.permission{display:flex;gap:12px;align-items:center}.permission input{width:22px;min-height:22px;flex-shrink:0;margin:0}.error{color:#9d2727}</style>
      <main><header>day two</header><h1>Conecta tu diario</h1><p>${name}<br><small>${callbackHost}</small></p>
      ${error ? `<p role="alert" class="error">${escaped(error)}</p>` : ''}<form method="post" action="${action}"><input type="hidden" name="flow" value="${escaped(flowToken)}">${input}</form>
      <small>Podrás revocar el acceso desde Ajustes → Conexiones. Los audios y las fotos se quedan en tu móvil.</small></main></html>`);
  }
  register(app: FastifyInstance) {
    const metadata = () => ({
      issuer: this.baseUrl, authorization_endpoint: this.baseUrl + '/oauth/authorize', token_endpoint: this.baseUrl + '/oauth/token',
      registration_endpoint: this.baseUrl + '/oauth/register', revocation_endpoint: this.baseUrl + '/oauth/revoke',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    });
    const protectedMetadata = () => ({ resource: this.resource, authorization_servers: [this.baseUrl], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Day Two' });
    const pathname = new URL(this.baseUrl).pathname.replace(/\/$/, '');
    for (const path of new Set(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server' + pathname])) app.get(path, async () => metadata());
    for (const path of new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource' + pathname + '/mcp'])) app.get(path, async () => protectedMetadata());
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      const params = new URLSearchParams(body as string), record: Record<string, string> = {};
      for (const [k, v] of params) { if (k in record) return done(new HttpError(400, 'invalid_request')); record[k] = v; }
      done(null, record);
    });
    app.post('/oauth/register', async (req, reply) => {
      this.rate(req, 'registration', 30, 3600_000);
      const p = parse(z.object({ client_name: z.string().min(1).max(100).default('MCP client'),
        redirect_uris: z.array(z.string().url().max(2000)).min(1).max(5), token_endpoint_auth_method: z.literal('none').optional(),
        grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(), response_types: z.array(z.literal('code')).optional() }), req.body);
      for (const uri of p.redirect_uris) { const u = new URL(uri); if (u.hash || u.username || u.password || (u.protocol !== 'https:' && !(this.origin.startsWith('http:') && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw new HttpError(400, 'invalid_redirect_uri'); }
      const id = randomUUID();
      this.db.prepare('INSERT INTO mcp_clients VALUES (?,?,?,?)').run(id, p.client_name, JSON.stringify(p.redirect_uris), this.clock.now());
      return reply.code(201).header('Cache-Control', 'no-store').send({ client_id: id, client_id_issued_at: Math.floor(this.clock.now() / 1000), client_name: p.client_name,
        redirect_uris: p.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    });
    app.get('/oauth/authorize', async (req, reply) => {
      this.rate(req, 'authorize', 60, 3600_000); this.purge();
      const p = parse(z.object({ client_id: z.string().max(200), redirect_uri: z.string().url().max(2000), response_type: z.literal('code'),
        scope: z.string().max(200).default(SCOPES.join(' ')), state: z.string().max(2000).optional(),
        code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), resource: z.literal(this.resource) }), req.query);
      const client = this.client(p.client_id);
      if (!(JSON.parse(client.redirects) as string[]).includes(p.redirect_uri)) throw new HttpError(400, 'invalid_redirect_uri');
      const scopes = [...new Set(p.scope.split(' ').filter(Boolean))];
      if (!scopes.includes('journal:read') || scopes.some(s => !SCOPES.includes(s))) throw new HttpError(400, 'invalid_scope');
      p.scope = scopes.join(' ');
      const secret = token(), flow: Flow = { hash: tokenHash(secret), params: JSON.stringify(p), email: null, expires_at: this.clock.now() + FLOW_MS };
      this.db.prepare('INSERT INTO mcp_flows VALUES (?,?,?,?)').run(flow.hash, flow.params, null, flow.expires_at);
      reply.header('Set-Cookie', this.cookie(secret)); return this.form(reply, secret, flow);
    });
    app.post('/oauth/authorize', async (req, reply) => {
      if (req.headers.origin !== this.origin) throw new HttpError(403, 'invalid_origin');
      const p = parse(z.object({ flow: z.string().regex(/^[A-Za-z0-9_-]{43}$/), action: z.enum(['send', 'approve']),
        email: z.string().max(254).optional(), code: z.string().max(6).optional(), write: z.literal('yes').optional() }), req.body);
      const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('daytwo_mcp_flow='))?.slice('daytwo_mcp_flow='.length);
      if (cookie !== p.flow) throw new HttpError(403, 'invalid_csrf');
      const flow = this.db.prepare('SELECT * FROM mcp_flows WHERE hash=? AND expires_at>?').get(tokenHash(p.flow), this.clock.now()) as Flow | undefined;
      if (!flow) throw new HttpError(400, 'expired_authorization');
      try {
        if (p.action === 'send') {
          const email = parse(z.email().max(254), normalizeEmail(p.email ?? ''));
          const code = this.otp.issue('mcp', email, req.ip, flow.hash);
          await this.mailer.send(codeEmail(email, code, 'es', 'login'));
          this.db.prepare('UPDATE mcp_flows SET email=? WHERE hash=?').run(email, flow.hash); flow.email = email;
          return this.form(reply, p.flow, flow);
        }
        if (!flow.email) throw new HttpError(400, 'invalid_request');
        this.otp.verify('mcp', flow.email, p.code ?? '', flow.hash);
      } catch (error) {
        const message = error instanceof HttpError && error.code === 'rate_limited' ? 'Espera un momento antes de pedir otro código.'
          : error instanceof HttpError ? 'El código o los datos no son válidos. Revisa el mensaje e inténtalo de nuevo.' : 'No se ha podido enviar el correo. Inténtalo de nuevo.';
        return this.form(reply.code(error instanceof HttpError ? error.statusCode : 503), p.flow, flow, message);
      }
      const params = JSON.parse(flow.params) as AuthParams, authCode = token();
      this.db.transaction(() => {
        let user = this.db.prepare('SELECT id FROM users WHERE email=?').get(flow.email) as { id: string } | undefined;
        if (!user) { user = { id: randomUUID() }; this.db.prepare('INSERT INTO users VALUES (?,?,?)').run(user.id, flow.email, this.clock.now()); }
        const grantId = randomUUID(), scope = params.scope.includes('journal:write') && p.write === 'yes' ? SCOPES.join(' ') : 'journal:read';
        this.db.prepare('INSERT INTO mcp_grants(id,user_id,client_id,scopes,created_at) VALUES (?,?,?,?,?)').run(grantId, user.id, params.client_id, scope, this.clock.now());
        this.db.prepare('INSERT INTO mcp_codes VALUES (?,?,?,?,?)').run(tokenHash(authCode), grantId, params.redirect_uri, params.code_challenge, this.clock.now() + 60_000);
        this.db.prepare('DELETE FROM mcp_flows WHERE hash=?').run(flow.hash);
      })();
      const redirect = new URL(params.redirect_uri); redirect.searchParams.set('code', authCode); redirect.searchParams.set('iss', this.baseUrl);
      if (params.state !== undefined) redirect.searchParams.set('state', params.state);
      return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('Set-Cookie', this.cookie('', true)).redirect(redirect.toString());
    });
    app.post('/oauth/token', async (req, reply) => {
      this.rate(req, 'token', 120); reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
      const p = parse(z.object({ grant_type: z.enum(['authorization_code', 'refresh_token']), client_id: z.string().max(200),
        resource: z.literal(this.resource), code: z.string().max(100).optional(), redirect_uri: z.string().max(2000).optional(),
        code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(), refresh_token: z.string().max(100).optional(), scope: z.string().max(200).optional() }), req.body);
      this.client(p.client_id);
      if (p.grant_type === 'authorization_code') return this.db.transaction(() => {
        const c = this.db.prepare(`SELECT c.*,g.client_id,g.scopes,g.revoked_at FROM mcp_codes c JOIN mcp_grants g ON g.id=c.grant_id WHERE c.hash=?`).get(tokenHash(p.code ?? '')) as
          { grant_id: string; client_id: string; scopes: string; revoked_at: number | null; redirect_uri: string; challenge: string; expires_at: number } | undefined;
        if (!c || c.expires_at <= this.clock.now() || c.revoked_at !== null || c.client_id !== p.client_id || c.redirect_uri !== p.redirect_uri || !p.code_verifier ||
          createHash('sha256').update(p.code_verifier).digest('base64url') !== c.challenge) throw new HttpError(400, 'invalid_grant');
        this.db.prepare('DELETE FROM mcp_codes WHERE hash=?').run(tokenHash(p.code!)); return this.mint(c.grant_id, c.scopes);
      })();
      const oldHash = tokenHash(p.refresh_token ?? '');
      const r = this.db.prepare(`SELECT t.*,g.client_id,g.scopes,g.revoked_at FROM mcp_tokens t JOIN mcp_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.kind='refresh'`).get(oldHash) as
        { grant_id: string; client_id: string; scopes: string; revoked_at: number | null; resource: string; expires_at: number; used: number } | undefined;
      if (!r || r.client_id !== p.client_id || r.resource !== p.resource || r.expires_at <= this.clock.now() || r.revoked_at !== null) throw new HttpError(400, 'invalid_grant');
      // A replay compromises the whole grant. Commit revocation before throwing.
      if (r.used) { this.db.prepare('UPDATE mcp_grants SET revoked_at=? WHERE id=?').run(this.clock.now(), r.grant_id); throw new HttpError(400, 'invalid_grant'); }
      if (p.scope && p.scope !== r.scopes) throw new HttpError(400, 'invalid_scope');
      return this.db.transaction(() => { this.db.prepare('UPDATE mcp_tokens SET used=1 WHERE hash=?').run(oldHash); return this.mint(r.grant_id, r.scopes); })();
    });
    app.post('/oauth/revoke', async (req, reply) => {
      this.rate(req, 'revoke', 60);
      const p = parse(z.object({ token: z.string().max(100), client_id: z.string().max(200) }), req.body);
      this.db.prepare(`UPDATE mcp_grants SET revoked_at=? WHERE client_id=? AND id IN (SELECT grant_id FROM mcp_tokens WHERE hash=?)`).run(this.clock.now(), p.client_id, tokenHash(p.token));
      return reply.header('Cache-Control', 'no-store').code(200).send({});
    });
  }
}
