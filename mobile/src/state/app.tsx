import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Clock, Journal } from "../data/journal";
import { dayKeyOf, type Lang } from "../domain/dates";
import { api, journalApi, setApiToken, setUnauthorizedHandler, type User } from "../services/api";
import { JournalSync } from '../services/journalSync';
import { emitChange, getVersion, subscribe } from "../services/events";
import { closeJournal, loadPrefs, loadSession, openJournal, savePrefs, saveSession, systemClock, wipeAccount, type Session } from "../services/storage";
import { Worker } from "../services/worker";
import { recoverRecordings } from "../services/recorder";
import { syncReminders } from "../services/reminders";
import { deviceLang, I18nProvider } from "../i18n";

interface AppValue {
  ready: boolean;
  session: Session | null;
  journal: Journal | null;
  worker: Worker | null;
  sync: JournalSync | null;
  clock: Clock;
  fixture: string | null;
  signIn(s: Session): Promise<void>;
  signOut(opts?: { wipe?: boolean; remote?: boolean }): Promise<void>;
  updateUser(u: User): Promise<void>;
  toast(msg: string): void;
  toastMessage: string | null;
  enterFixture(name: string, journal: Journal, clock: Clock): void;
}
const Ctx = createContext<AppValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [lang, setLang] = useState<Lang>(deviceLang());
  const [session, setSession] = useState<Session | null>(null);
  const [journal, setJournal] = useState<Journal | null>(null);
  const [sync, setSync] = useState<JournalSync | null>(null);
  const [fixture, setFixture] = useState<string | null>(null);
  const [clock, setClock] = useState<Clock>(systemClock);
  const [toastMessage, setToast] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const syncRef = useRef<JournalSync | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;

  const attach = useCallback(async (s: Session) => {
    await syncRef.current?.stop();
    setApiToken(s.token);
    const j = await openJournal(s.user.id);
    workerRef.current?.stop();
    const w = new Worker(j, () => langRef.current);
    workerRef.current = w;
    const synchronizer = new JournalSync(j, journalApi(s.token));
    syncRef.current = synchronizer;
    setSync(synchronizer);
    setJournal(j);
    await recoverRecordings(j).catch(() => undefined);
    w.start();
    synchronizer.start();
    syncReminders(j, langRef.current).catch(() => undefined);
    await j.sweepOrphans().catch(() => undefined);
  }, []);

  useEffect(() => {
    (async () => {
      const prefs = await loadPrefs();
      if (prefs.lang) setLang(prefs.lang);
      const s = await loadSession();
      if (s) {
        setSession(s);
        await attach(s).catch(() => undefined);
        // Validate the session in background; an expired/revoked token signs out without touching local data.
        api.me().then((u) => saveSession({ ...s, user: u })).catch(() => undefined);
      }
      setReady(true);
    })();
  }, [attach]);

  const signOut = useCallback(
    async (opts: { wipe?: boolean; remote?: boolean } = {}) => {
      const s = session;
      workerRef.current?.stop();
      workerRef.current = null;
      await syncRef.current?.stop();
      syncRef.current = null;
      setSync(null);
      if (opts.remote !== false) await api.logout().catch(() => undefined);
      setApiToken(null);
      await saveSession(null);
      if (s) {
        if (opts.wipe) await wipeAccount(s.user.id);
        else await closeJournal(s.user.id);
      }
      setJournal(null);
      setSession(null);
      emitChange();
    },
    [session],
  );

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Token revoked or expired: local journal is kept on the device; the person signs in again.
      signOut({ remote: false });
    });
  }, [signOut]);

  const value = useMemo<AppValue>(
    () => ({
      ready,
      session,
      journal,
      worker: workerRef.current,
      sync,
      clock,
      fixture,
      async signIn(s) {
        await saveSession(s);
        const prefs = await loadPrefs();
        await savePrefs({ ...prefs, lastEmail: s.user.email });
        setSession(s);
        await attach(s);
        emitChange();
      },
      signOut,
      async updateUser(u) {
        if (!session) return;
        const s = { ...session, user: u };
        await saveSession(s);
        setSession(s);
      },
      toast(msg) {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 2600);
      },
      toastMessage,
      enterFixture(name, j, c) {
        setLang("es"); // the mock is in Spanish
        workerRef.current?.stop();
        workerRef.current = null;
        void syncRef.current?.stop();
        syncRef.current = null;
        setSync(null);
        setFixture(name);
        setClock(c);
        setSession({ token: "", user: { id: "visual", email: "hola@ejemplo.com" } });
        setJournal(j);
        emitChange();
      },
    }),
    [ready, session, journal, sync, clock, fixture, signOut, attach, toastMessage],
  );

  const onLang = useCallback(async (l: Lang) => {
    setLang(l);
    const prefs = await loadPrefs();
    await savePrefs({ ...prefs, lang: l });
  }, []);

  return (
    <Ctx.Provider value={value}>
      <I18nProvider key={lang} initial={lang} onChange={onLang}>
        {children}
      </I18nProvider>
    </Ctx.Provider>
  );
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppProvider missing");
  return v;
}

export function useJournal(): Journal {
  const { journal } = useApp();
  if (!journal) throw new Error("no journal");
  return journal;
}

/** Today's journal date (device calendar), re-evaluated on every change and every minute. */
export function useToday(): string {
  const { clock } = useApp();
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useChangeVersion();
  return dayKeyOf(clock.now());
}

export function useChangeVersion(): number {
  const [v, setV] = useState(getVersion());
  useEffect(() => subscribe(() => setV(getVersion())), []);
  return v;
}

/** Re-runs an async read whenever the journal changes. */
export function useQuery<T>(fn: (j: Journal) => Promise<T>, deps: unknown[]): T | undefined {
  const { journal } = useApp();
  const v = useChangeVersion();
  const [data, setData] = useState<T>();
  useEffect(() => {
    let alive = true;
    if (journal) fn(journal).then((d) => alive && setData(d)).catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, v, ...deps]);
  return data;
}
