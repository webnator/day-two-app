import { AppState } from 'react-native';
import type { Journal } from '../data/journal';
import { syncJournal, type JournalSyncApi } from '../data/sync';
import { emitChange, subscribe } from './events';

/** Foreground sync is opt-in. Offline writes stay local and retry on resume or the next tick. */
export class JournalSync {
  private stopped = false;
  private paused = false;
  private publishing = false;
  private again = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe?: () => void;
  private appSubscription?: { remove(): void };
  constructor(private journal: Journal, private api: JournalSyncApi) {}
  start() {
    this.unsubscribe = subscribe(() => { if (!this.publishing) { if (this.inFlight) this.again = true; else this.schedule(700); } });
    this.appSubscription = AppState.addEventListener('change', state => { if (state === 'active') this.schedule(0); });
    this.schedule(0);
  }
  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.runNow(); }, ms);
  }
  async setEnabled(enabled: boolean) {
    this.paused = !enabled;
    await this.journal.set('sync.enabled', enabled);
    if (!enabled) await this.inFlight;
    this.publish();
    if (enabled) await this.runNow();
  }
  private publish() { if (this.stopped) return; this.publishing = true; emitChange(); this.publishing = false; }
  runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped || this.paused || AppState.currentState === 'background') return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
      const delay = this.again ? 700 : 30000; this.again = false; this.schedule(delay);
    });
    return this.inFlight;
  }
  private async run() {
    if (!await this.journal.get('sync.enabled', false) || this.stopped || this.paused) return;
    try {
      await syncJournal(this.journal, this.api, () => this.stopped || this.paused);
      if (this.stopped || this.paused) return;
      await this.journal.set('sync.lastContact', new Date().toISOString());
      await this.journal.set('sync.error', null);
    } catch {
      if (this.stopped || this.paused) return;
      await this.journal.set('sync.error', 'sync_unavailable');
    }
    this.publish();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe?.(); this.appSubscription?.remove();
    await this.inFlight;
  }
}
