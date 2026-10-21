import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { auth, login, makeApp, type TestCtx } from './helpers.js';
import { entrySchema, JournalStore, type JournalEntry } from '../src/journal/store.js';
import { associations, summary } from '../src/journal/analytics.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let ctx: TestCtx;
const base = 'http://localhost:8787', resource = base + '/mcp', redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { ctx.app.queue.stop(); await ctx.app.close(); });
const sample = (id = randomUUID(), overrides: Partial<JournalEntry> = {}): JournalEntry => ({ id, day: '2026-10-13', createdAt: '2026-10-13T10:00:00.000Z', localTime: '12:00', timeZone: 'Europe/Madrid', kind: 'text', origin: 'written', title: 'Un día', titleAuto: false, body: 'Texto privado único', tags: [{ kind: 'emotion', name: 'Calma', origin: 'manual' }], city: 'Madrid', temperatureC: 21, weatherCondition: 'clear', contextStatus: 'resolved', transcriptStatus: 'none', ...overrides });
async function client() {
  const res = await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'ChatGPT test', redirect_uris: [redirect], token_endpoint_auth_method: 'none' } });
  expect(res.statusCode).toBe(201); return res.json().client_id as string;
}
async function authorize(email = 'reader@example.com', write = true) {
  const clientId = await client(), verifier = randomBytes(32).toString('base64url');
  const params = { client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'journal:read journal:write', state: 'opaque-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource };
  const start = await ctx.app.inject({ method: 'GET', url: '/oauth/authorize?' + new URLSearchParams(params) });
  expect(start.statusCode).toBe(200);
  const cookie = (start.headers['set-cookie'] as string).split(';')[0]!, flow = cookie.split('=')[1]!;
  const headers = { cookie, origin: base };
  const send = await ctx.app.inject({ method: 'POST', url: '/oauth/authorize', headers, payload: { flow, action: 'send', email } });
  expect(send.statusCode).toBe(200);
  const consent = await ctx.app.inject({ method: 'POST', url: '/oauth/authorize', headers, payload: { flow, action: 'approve', code: ctx.mailer.lastCodeFor(email), ...(write ? { write: 'yes' } : {}) } });
  expect(consent.statusCode).toBe(302);
  const callback = new URL(consent.headers.location!);
  expect(callback.searchParams.get('state')).toBe('opaque-state'); expect(callback.searchParams.get('iss')).toBe(base);
  const tokenPayload = { grant_type: 'authorization_code', client_id: clientId, resource, code: callback.searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier };
  const wrongVerifier = await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: { ...tokenPayload, code_verifier: randomBytes(32).toString('base64url') } });
  expect(wrongVerifier.statusCode).toBe(400);
  const exchange = await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: tokenPayload });
  expect(exchange.statusCode).toBe(200);
  const user = ctx.db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string };
  return { ...exchange.json(), userId: user.id, clientId, tokenPayload } as { access_token: string; refresh_token: string; userId: string; clientId: string; tokenPayload: typeof tokenPayload; scope: string };
}
async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await ctx.app.inject({ method: 'POST', url: '/mcp', headers: { ...auth(token), accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, payload: { jsonrpc: '2.0', id: 1, method, params } });
  expect(res.statusCode).toBe(200); return res.json();
}
async function call(token: string, name: string, args: object = {}) { return (await rpc(token, 'tools/call', { name, arguments: args })).result; }

it('advertises OAuth metadata and refuses anonymous/mobile-session MCP access', async () => {
  const res = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: {} });
  expect(res.statusCode).toBe(401); expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
  expect((await ctx.app.inject('/.well-known/oauth-protected-resource')).json().resource).toBe(resource);
  expect((await ctx.app.inject('/.well-known/oauth-authorization-server')).json().code_challenge_methods_supported).toEqual(['S256']);
  const a = await login(ctx, 'app@example.com');
  expect((await ctx.app.inject({ method: 'POST', url: '/mcp', headers: auth(a.token), payload: {} })).statusCode).toBe(401);
});
it('works with the official MCP HTTP client over a real socket', async () => {
  const a = await authorize();
  const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'daytwo-integration', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(address + '/mcp'), { requestInit: { headers: auth(a.access_token) } }));
  try {
    expect((await client.listTools()).tools).toHaveLength(8);
    const result = await client.callTool({ name: 'get_journal_info', arguments: {} });
    expect(result.structuredContent).toMatchObject({ entries: 0 });
  } finally { await client.close(); }
});
it('revocation is owner-scoped and access tokens expire independently of refresh tokens', async () => {
  const a = await authorize(), stranger = await login(ctx, 'stranger@example.com');
  const grant = (ctx.db.prepare('SELECT id FROM mcp_grants WHERE user_id=?').get(a.userId) as { id: string }).id;
  await ctx.app.inject({ method: 'DELETE', url: '/v1/mcp/connections/' + grant, headers: auth(stranger.token) });
  expect((await call(a.access_token, 'get_journal_info')).isError).not.toBe(true);
  ctx.clock.advance(3600_001);
  expect((await ctx.app.inject({ method: 'POST', url: '/mcp', headers: auth(a.access_token), payload: {} })).statusCode).toBe(401);
  const fresh = await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', client_id: a.clientId, resource, refresh_token: a.refresh_token } });
  expect(fresh.statusCode).toBe(200);
  const phone = await login(ctx, 'reader@example.com');
  expect((await ctx.app.inject({ url: '/v1/mcp/connections', headers: auth(phone.token) })).json().connections).toHaveLength(1);
  await ctx.app.inject({ method: 'DELETE', url: '/v1/mcp/connections/' + grant, headers: auth(phone.token) });
  expect((await ctx.app.inject({ method: 'POST', url: '/mcp', headers: auth(fresh.json().access_token), payload: {} })).statusCode).toBe(401);
});
it('connects through OAuth PKCE, lists tools, and isolates each account', async () => {
  const a = await authorize(), b = await authorize('other@example.com');
  const store = new JournalStore(ctx.db, ctx.clock), entry = sample(); store.put(a.userId, entry.id, 0, entry);
  const init = await rpc(a.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  expect(init.result.serverInfo.name).toBe('day-two');
  const tools = (await rpc(a.access_token, 'tools/list')).result.tools;
  expect(tools).toHaveLength(8); expect(tools.find((t: { name: string }) => t.name === 'update_entry').annotations.destructiveHint).toBe(true);
  expect((await call(a.access_token, 'get_entry', { id: entry.id })).structuredContent.entry.body).toBe(entry.body);
  expect((await call(b.access_token, 'get_entry', { id: entry.id })).structuredContent.error).toBe('entry_not_found');
  expect((await call(b.access_token, 'get_period_summary', { start: '2026-10-01', end: '2026-10-31' })).structuredContent.entries).toBe(0);
  expect(ctx.logs.text).not.toContain(entry.body); expect(ctx.logs.text).not.toContain(a.access_token); expect(ctx.logs.text).not.toContain('reader@example.com');
});
it('creates idempotently and requires a current revision to edit', async () => {
  const a = await authorize();
  const input = { requestId: randomUUID(), day: '2026-10-13', timeZone: 'Europe/Madrid', localTime: '10:32', title: 'Paseo', body: 'Me sentí tranquilo.', topics: ['Mar'], emotions: ['Calma'] };
  const create = await call(a.access_token, 'create_entry', input);
  expect(create.isError).not.toBe(true); expect(create.structuredContent.entry.body).toBe(input.body);
  const replay = await call(a.access_token, 'create_entry', input); expect(replay.structuredContent.revision).toBe(1);
  expect((await call(a.access_token, 'create_entry', { ...input, body: 'Otro' })).structuredContent.error).toBe('idempotency_key_reused');
  const edit = await call(a.access_token, 'update_entry', { id: input.requestId, expectedRevision: 1, title: 'El mar' });
  expect(edit.structuredContent.revision).toBe(2); expect(edit.structuredContent.entry.body).toBe(input.body);
  const stale = await call(a.access_token, 'update_entry', { id: input.requestId, expectedRevision: 1, body: 'No sobrescribir' });
  expect(stale.structuredContent.error).toBe('revision_conflict');
  const store = new JournalStore(ctx.db, ctx.clock); store.put(a.userId, input.requestId, 2, null);
  expect((await call(a.access_token, 'create_entry', input)).structuredContent.error).toBe('entry_deleted');
});
it('enforces read-only consent and preserves labels on an unrelated edit', async () => {
  const a = await authorize('read@example.com', false), e = sample(); new JournalStore(ctx.db, ctx.clock).put(a.userId, e.id, 0, e);
  expect(a.scope).toBe('journal:read');
  expect((await call(a.access_token, 'update_entry', { id: e.id, expectedRevision: 1, body: 'no' })).structuredContent.error).toBe('insufficient_scope');
  const b = await authorize('write@example.com'); new JournalStore(ctx.db, ctx.clock).put(b.userId, e.id, 0, e);
  const edited = await call(b.access_token, 'update_entry', { id: e.id, expectedRevision: 1, topics: ['Familia'] });
  expect(edited.structuredContent.entry.tags).toContainEqual(e.tags[0]); expect(ctx.classifier.calls).toHaveLength(0);
});
it('rejects reused codes, wrong resource, refresh token replay, and revoked grants', async () => {
  const a = await authorize();
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: a.tokenPayload })).statusCode).toBe(400);
  const payload = { client_id: a.clientId, grant_type: 'refresh_token', resource, refresh_token: a.refresh_token };
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, resource: 'https://evil.example' } })).statusCode).toBe(400);
  const fresh = await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload }); expect(fresh.statusCode).toBe(200);
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload })).statusCode).toBe(400);
  expect((await ctx.app.inject({ method: 'POST', url: '/mcp', headers: auth(fresh.json().access_token), payload: {} })).statusCode).toBe(401);
});
it('rejects wrong callback, plain PKCE, unknown scope and cross-site consent', async () => {
  const clientId = await client(), p = { client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256', resource };
  for (const patch of [{ redirect_uri: 'https://evil.example/callback' }, { code_challenge_method: 'plain' }, { scope: 'admin' }] as Record<string, string>[]) {
    expect((await ctx.app.inject('/oauth/authorize?' + new URLSearchParams({ ...p, ...patch }))).statusCode).toBe(400);
  }
  const start = await ctx.app.inject('/oauth/authorize?' + new URLSearchParams(p)), cookie = (start.headers['set-cookie'] as string).split(';')[0]!;
  const body = { flow: cookie.split('=')[1], action: 'send', email: 'nobody@example.com' };
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, origin: 'https://evil.example' }, payload: body })).statusCode).toBe(403);
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/authorize', headers: { origin: base }, payload: body })).statusCode).toBe(403);
});
it('sync uses account isolation, revisions, pagination, and non-resurrecting tombstones', async () => {
  const a = await login(ctx, 'phone@example.com'), b = await login(ctx, 'stranger@example.com'), e = sample();
  const put = (token: string, entry: JournalEntry | null, baseRevision: number) => ctx.app.inject({ method: 'PUT', url: '/v1/journal/entries/' + e.id, headers: auth(token), payload: { entry, baseRevision } });
  expect((await put(a.token, e, 0)).json().revision).toBe(1);
  expect((await put(a.token, e, 0)).json().revision).toBe(1);
  expect((await put(a.token, { ...e, body: 'stale' }, 0)).statusCode).toBe(409);
  expect((await ctx.app.inject({ url: '/v1/journal/changes', headers: auth(b.token) })).json().items).toEqual([]);
  const changes = (await ctx.app.inject({ url: '/v1/journal/changes?limit=1', headers: auth(a.token) })).json();
  expect(changes.items[0].entry.id).toBe(e.id);
  expect((await put(a.token, null, 1)).json().entry).toBeNull();
  expect((await put(a.token, e, 2)).statusCode).toBe(409);
  const later = (await ctx.app.inject({ url: '/v1/journal/changes?after=' + changes.cursor, headers: auth(a.token) })).json();
  expect(later.items[0].entry).toBeNull(); expect(JSON.stringify(ctx.db.prepare('SELECT content FROM journal_entries').all())).not.toContain(e.body);
});
it('deleting an account removes journal data and every OAuth grant/token', async () => {
  const appSession = await login(ctx, 'delete@example.com'); ctx.clock.advance(45000);
  const a = await authorize('delete@example.com'), e = sample(); new JournalStore(ctx.db, ctx.clock).put(a.userId, e.id, 0, e);
  expect((await ctx.app.inject({ method: 'DELETE', url: '/v1/account', headers: auth(appSession.token) })).statusCode).toBe(204);
  for (const table of ['journal_entries', 'mcp_grants', 'mcp_codes', 'mcp_tokens']) expect((ctx.db.prepare('SELECT COUNT(*) n FROM ' + table).get() as { n: number }).n).toBe(0);
  expect((await ctx.app.inject({ method: 'POST', url: '/mcp', headers: auth(a.access_token), payload: {} })).statusCode).toBe(401);
});
it('validates calendar dates and excludes unexpected private fields from sync', () => {
  expect(entrySchema.safeParse(sample(undefined, { day: '2026-02-30' })).success).toBe(false);
  expect(entrySchema.safeParse({ ...sample(), audioUri: '/private/audio.wav' }).success).toBe(false);
});
it('analytics counts days separately, includes empty periods, and excludes missing weather from comparisons', () => {
  const store = new JournalStore(ctx.db, ctx.clock); ctx.db.prepare('INSERT INTO users VALUES (?,?,?)').run('analytic', 'analytics@example.com', 0);
  const a = sample(), b = sample(), c = sample(undefined, { day: '2026-10-14', tags: [], weatherCondition: null, temperatureC: null, city: null });
  for (const e of [a, b, c]) store.put('analytic', e.id, 0, e);
  const data = store.inPeriod('analytic', '2026-10-01', '2026-10-31'), result = summary(data, '2026-10-01', '2026-11-30', 'month');
  expect(result.entries).toBe(3); expect(result.recordedDays).toBe(2); expect(result.emotions[0]!.shareOfRecordedDays).toBe(.5);
  expect(result.timeline[1]!.recordedDays).toBe(0); expect(result.timeline[1]!.emotions).toEqual([]);
  const relations = associations(data, 'weather', 'emotion', 1, 20); expect(relations.eligibleEntries).toBe(2); expect(relations.excludedMissingContext).toBe(1); expect(relations.pairs[0]!.shareWithoutA).toBeNull();
});
