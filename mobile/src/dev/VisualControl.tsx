// DEVELOPMENT ONLY: follows tools/visual/control-server.js so screenshots can be scripted on both platforms.
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LogBox, Platform } from "react-native";
import { fixtureClock, seedFixture, seedFor } from "./fixtures";
import { dataFor, routes } from "./scenarios";
import { useApp } from "../state/app";

export function VisualControl() {
  const insets = useSafeAreaInsets();
  const { enterFixture, journal } = useApp();
  const journalRef = useRef(journal);
  journalRef.current = journal;
  useEffect(() => {
    if (__DEV__) console.log("INSETS", Platform.OS, JSON.stringify(insets));
  }, [insets]);
  const seq = useRef<number | null>(null);
  const startedAt = useRef(Date.now()).current;
  useEffect(() => {
    if (!__DEV__) return;
    const host = Platform.OS === "android" ? "10.0.2.2" : "localhost";
    const t = setInterval(async () => {
      try {
        const r = await fetch(`http://${host}:19100/state`);
        const s = (await r.json()) as { seq: number; name: string | null; at?: number };
        // Ignore commands older than this launch; follow every new one.
        if (s.seq !== seq.current && s.name && (s.at ?? 0) > startedAt - 2000) {
          seq.current = s.seq;
          LogBox.ignoreAllLogs(true); // keep dev banners out of comparison captures
          // Reset the stack: screens (and their sheets) from the previous scenario must unmount.
          if (router.canDismiss()) router.dismissAll();
          if (s.name.startsWith("diag:")) {
            await runDiag(s.name.slice(5), journalRef.current);
            return;
          }
          if (s.name.startsWith("calib:")) router.replace({ pathname: "/visual/calib", params: { page: s.name.slice(6) } });
          else {
            const name = s.name;
            router.replace("/visual/blank");
            const j = await seedFixture(name.startsWith("plate-") ? "empty" : dataFor[name] ?? seedFor(name));
            enterFixture(name, j, fixtureClock);
            setTimeout(() => router.replace(routes[name] ?? "/day/today"), 50);
          }
        }
      } catch {}
    }, 700);
    return () => clearInterval(t);
  }, [enterFixture]);
  return null;
}

/** DEVELOPMENT ONLY diagnostics for reminder evidence (logs to Metro). */
async function runDiag(cmd: string, journal: import("../data/journal").Journal | null) {
  const Notifications = await import("expo-notifications");
  const { syncReminders } = await import("../services/reminders");
  const { defaultReminderSettings } = await import("../domain/reminders");
  if (!journal) return console.log("DIAG no journal");
  if (cmd === "soon") {
    // Journal reminder one minute from now, every day; photo reminder on.
    const d = new Date(Date.now() + 60_000);
    const at = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await journal.set("reminders", { ...defaultReminderSettings(), journalEnabled: true, photoEnabled: true, times: [{ id: "diag", at, days: [0, 1, 2, 3, 4, 5, 6] }] });
    await syncReminders(journal, "es");
    console.log("DIAG soon scheduled for", at);
  }
  if (cmd === "photo-window") {
    // Photo window later today so today's random reminder is still pending.
    const a = new Date(Date.now() + 60 * 60_000), b = new Date(Date.now() + 120 * 60_000);
    const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await journal.set("reminders", { ...defaultReminderSettings(), photoEnabled: true, from: hm(a), to: hm(b) });
    await syncReminders(journal, "es", { windowChanged: true });
  }
  if (cmd === "sync") await syncReminders(journal, "es");
  console.log("DIAG perm", Platform.OS, JSON.stringify((await Notifications.getPermissionsAsync()).granted), JSON.stringify(await journal.get("reminders", null)), JSON.stringify(await journal.get("photoPlan", {})));
  const list = await Notifications.getAllScheduledNotificationsAsync();
  const today = list.filter((n) => n.identifier.startsWith("photo-") && n.identifier.endsWith(new Date().toISOString().slice(0, 10)));
  console.log("DIAG photo-today", Platform.OS, today.length ? "SCHEDULED " + today.map((n) => n.identifier).join(",") : "NONE");
  console.log("DIAG scheduled", list.length, JSON.stringify(list.map((n) => ({ id: n.identifier, body: n.content.body, trigger: n.trigger }))));
}
