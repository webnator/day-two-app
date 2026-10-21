import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
import { JournalSync } from '../services/journalSync';
import { makeJournal } from './helpers';

let runtime: JournalSync | undefined;
afterEach(async () => { await runtime?.stop(); });
it('makes no network requests until sync is explicitly enabled, and stops when paused', async () => {
  const { j } = await makeJournal();
  const changes = vi.fn(async () => ({ items: [], cursor: 0, hasMore: false })), put = vi.fn();
  runtime = new JournalSync(j, { changes, put });
  runtime.start(); await runtime.runNow();
  expect(changes).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  await runtime.setEnabled(true); expect(changes).toHaveBeenCalledTimes(1);
  await runtime.setEnabled(false); await runtime.runNow(); expect(changes).toHaveBeenCalledTimes(1);
});
it('waits for in-flight requests to finish before the account database can close', async () => {
  const { j } = await makeJournal(); await j.set('sync.enabled', true);
  let finish!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  runtime = new JournalSync(j, { put: vi.fn(), changes: async () => { began(); await pending; return { items: [], cursor: 0, hasMore: false }; } });
  const running = runtime.runNow(); await started;
  let closed = false; const stopping = runtime.stop().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  finish(); await running; await stopping; expect(closed).toBe(true);
  expect(await j.get('sync.lastContact', null)).toBeNull();
});
