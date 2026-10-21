import { describe, expect, it } from 'vitest';
import { makeJournal } from './helpers';
import { conflicts, projection, receiveChange, resolveConflict, stable, syncJournal, type JournalSyncApi, type RemoteChange, type SyncedEntry } from '../data/sync';

class Remote implements JournalSyncApi {
  rows = new Map<string, RemoteChange>(); sequence = 0; calls = 0;
  async put(id: string, baseRevision: number, entry: SyncedEntry | null) {
    this.calls++;
    const old = this.rows.get(id);
    if (old && stable(old.entry) === stable(entry)) return structuredClone(old);
    if ((old?.revision ?? 0) !== baseRevision || (old && !old.entry && entry)) throw { status: 409, body: { current: structuredClone(old) } };
    const r = { id, revision: baseRevision + 1, sequence: ++this.sequence, updatedAt: new Date().toISOString(), entry: structuredClone(entry) };
    this.rows.set(id, r); return structuredClone(r);
  }
  async changes(after: number) {
    const items = [...this.rows.values()].filter(r => r.sequence > after).sort((a, b) => a.sequence - b.sequence).slice(0, 2);
    const cursor = items.at(-1)?.sequence ?? after;
    return { items: structuredClone(items), cursor, hasMore: [...this.rows.values()].some(r => r.sequence > cursor) };
  }
  async edit(id: string, patch: Partial<SyncedEntry> | null) { const r = this.rows.get(id)!; return this.put(id, r.revision, patch ? { ...r.entry!, ...patch } : null); }
}
type J = Awaited<ReturnType<typeof makeJournal>>['j'];
async function create(j: J, id = 'e') { await j.commitDraft({ id, day: '2026-10-13', title: 'Título', body: 'Original', prompt: null, resources: [] }, { title: 'Título', auto: false }); }
async function edit(j: J, patch: { body?: string; title?: string }) {
  const e = (await j.entry('e'))!;
  await j.updateEntry('e', { title: e.title, titleAuto: e.titleAuto, body: e.body, topics: e.tags.filter(t => t.kind === 'topic').map(t => t.name), emotions: e.tags.filter(t => t.kind === 'emotion').map(t => t.name), resources: e.resources, removeContext: false, ...patch });
}
async function audio(j: J) {
  await j.beginRecording({ id: 'e', day: '2026-10-13', tempUri: 'file://private.wav', mime: 'audio/wav', timeZone: 'Europe/Madrid', localTime: '10:00', startedAt: new Date('2026-10-13T08:00:00Z') });
  await j.attachRecordingFile('e', '.wav', [.2, .6]); await j.finishRecording('e', 25000, 'Audio');
}

describe('opt-in journal synchronization', () => {
  it('migrates without enabling sync and projects only explicitly shared fields', async () => {
    const { j } = await makeJournal(); await audio(j);
    expect(await j.get('sync.enabled', false)).toBe(false);
    const result = projection(await j.entry('e'))!;
    expect(Object.keys(result).sort()).toEqual(['id','day','createdAt','timeZone','localTime','kind','origin','title','titleAuto','body','tags','city','temperatureC','weatherCondition','contextStatus','transcriptStatus'].sort());
    expect(JSON.stringify(result)).not.toContain('file://');
  });
  it('pushes existing entries once and pulls all pages onto a fresh device', async () => {
    const { j } = await makeJournal(), remote = new Remote();
    for (const id of ['a','b','c','d','e']) await create(j, id);
    await syncJournal(j, remote); expect(remote.rows.size).toBe(5);
    await syncJournal(j, remote); expect(remote.calls).toBe(5);
    const other = await makeJournal(); await syncJournal(other.j, remote);
    expect(await other.j.entriesForDay('2026-10-13')).toHaveLength(5);
    expect(await other.j.get('sync.cursor', 0)).toBe(5);
  });
  it('merges disjoint edits and then sends the combined version', async () => {
    const { j } = await makeJournal(), remote = new Remote(); await create(j); await syncJournal(j, remote);
    await edit(j, { body: 'Desde el móvil' }); await remote.edit('e', { title: 'Desde Claude' });
    await syncJournal(j, remote);
    expect(await j.entry('e')).toMatchObject({ title: 'Desde Claude', body: 'Desde el móvil' });
    expect(await conflicts(j)).toHaveLength(0);
    await syncJournal(j, remote); expect(remote.rows.get('e')!.entry).toMatchObject({ title: 'Desde Claude', body: 'Desde el móvil' });
  });
  it('keeps both conflicting texts until the person selects a version', async () => {
    const { j } = await makeJournal(), remote = new Remote(); await create(j); await syncJournal(j, remote);
    await edit(j, { body: 'Mi versión' }); await remote.edit('e', { body: 'La otra versión' });
    await syncJournal(j, remote); await syncJournal(j, remote);
    expect((await conflicts(j))[0]).toMatchObject({ local: { body: 'Mi versión' }, remote: { entry: { body: 'La otra versión' } }, fields: ['body'] });
    await resolveConflict(j, 'e', 'local'); await syncJournal(j, remote);
    expect(remote.rows.get('e')!.entry!.body).toBe('Mi versión'); expect(await conflicts(j)).toHaveLength(0);
  });
  it('does not lose a phone edit made while its previous write is in flight', async () => {
    const { j } = await makeJournal(), remote = new Remote(); await create(j);
    let edited = false;
    const api = { changes: (after: number) => remote.changes(after), put: async (id: string, revision: number, e: SyncedEntry | null) => {
      const r = await remote.put(id, revision, e); if (!edited) { edited = true; await edit(j, { body: 'Escrito durante la petición' }); } return r;
    } };
    await syncJournal(j, api); expect((await j.entry('e'))!.body).toBe('Escrito durante la petición');
    await syncJournal(j, remote); expect(remote.rows.get('e')!.entry!.body).toBe('Escrito durante la petición');
  });
  it('recovers after the server committed but the response was lost', async () => {
    const { j } = await makeJournal(), remote = new Remote(); await create(j);
    await expect(syncJournal(j, { changes: after => remote.changes(after), put: async (...args) => { await remote.put(...args); throw Error('offline'); } })).rejects.toThrow('offline');
    await syncJournal(j, remote); expect(remote.rows.size).toBe(1); expect(remote.rows.get('e')!.revision).toBe(1);
  });
  it('preserves original audio and resources and blocks late AI from replacing remote text', async () => {
    const { j, files } = await makeJournal(), remote = new Remote(); await audio(j);
    const f = await j.importFile('file://resource.jpg', 'resources', '.jpg', 'image/jpeg');
    const e = (await j.entry('e'))!;
    await j.updateEntry('e', { title: e.title, titleAuto: false, body: '', topics: [], emotions: [], removeContext: false, resources: [{ id: 'res', kind: 'image', title: 'Foto', status: 'ready', fileId: f.id }] });
    const job = (await j.runnableJobs()).find(x => x.kind === 'transcribe')!;
    await syncJournal(j, remote); await remote.edit('e', { body: 'Corrección en ChatGPT', transcriptStatus: 'ready' }); await syncJournal(j, remote);
    const updated = (await j.entry('e'))!;
    expect(updated.audioFileId).toBe(e.audioFileId); expect(updated.waveform).toEqual(e.waveform); expect(updated.resources).toHaveLength(1); expect(files.stored.size).toBe(2);
    expect(await j.applyTranscript(job.id, { text: 'Resultado tardío' })).toBe('alternative');
    expect((await j.entry('e'))!.body).toBe('Corrección en ChatGPT');
  });
  it('cancels stale classification even when only tags changed remotely', async () => {
    const { j } = await makeJournal(), remote = new Remote(); await create(j); const job = (await j.runnableJobs()).find(x => x.kind === 'classify')!;
    await syncJournal(j, remote); await remote.edit('e', { tags: [{ name: 'Mar', kind: 'topic', origin: 'manual' }] }); await syncJournal(j, remote);
    expect(await j.applyClassification(job.id, { topics: ['Trabajo'], emotions: [] })).toBe(false);
    expect((await j.entry('e'))!.tags.map(t => t.name)).toEqual(['Mar']);
  });
  it('propagates deletion and never resurrects the old entry', async () => {
    const { j } = await makeJournal(), remote = new Remote(); await create(j); await syncJournal(j, remote); await j.deleteEntry('e'); await syncJournal(j, remote);
    expect(remote.rows.get('e')!.entry).toBeNull(); await syncJournal(j, remote); expect(await j.entry('e')).toBeNull();
  });
  it('keeps unsent changes and media as a new entry after an explicit deletion conflict choice', async () => {
    const { j, files } = await makeJournal(), remote = new Remote(); await audio(j); await syncJournal(j, remote);
    await edit(j, { body: 'Quiero conservarlo' }); await remote.edit('e', null); await syncJournal(j, remote);
    expect(await conflicts(j)).toHaveLength(1); const before = [...files.stored];
    await resolveConflict(j, 'e', 'local'); await syncJournal(j, remote);
    expect(await j.entry('e')).toBeNull(); const entries = await j.entriesForDay('2026-10-13');
    expect(entries).toHaveLength(1); expect(entries[0].body).toBe('Quiero conservarlo'); expect(entries[0].audioFileId).toBeTruthy(); expect([...files.stored]).toEqual(before);
    expect(remote.rows.get('e')!.entry).toBeNull(); expect([...remote.rows.values()].filter(x => x.entry)).toHaveLength(1);
  });
  it('accepts remote deletion only after commit and keeps an unrelated daily photo', async () => {
    const { j, files } = await makeJournal(), remote = new Remote(); await audio(j);
    const photo = await j.importFile('file://day.jpg', 'photos', '.jpg', 'image/jpeg'); await j.setDayPhoto('2026-10-13', photo.id, {});
    await syncJournal(j, remote); await remote.edit('e', null); await syncJournal(j, remote);
    expect(await j.entry('e')).toBeNull(); expect(files.stored.size).toBe(1); expect(files.exists(photo.relPath)).toBe(true);
  });
  it('preserves files if a deletion transaction rolls back', async () => {
    const { j, db, files } = await makeJournal(), remote = new Remote(); await audio(j); await syncJournal(j, remote);
    const deletion = await remote.edit('e', null);
    await db.exec("CREATE TRIGGER fail_sync BEFORE UPDATE ON sync_bases BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    await expect(receiveChange(j, deletion)).rejects.toThrow('test rollback');
    expect(await j.entry('e')).not.toBeNull(); expect(files.stored.size).toBe(1);
  });
});
