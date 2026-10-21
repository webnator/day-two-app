import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Journal } from "../data/journal";
import { currentTimeZone, dayKeyOf, type Lang } from "../domain/dates";
import { defaultReminderSettings, planJournal, planPhoto, resetFuturePhotoPlan, type PhotoPlan, type ReminderSettings } from "../domain/reminders";
import { translate } from "../i18n";

const CHANNEL = "reminders";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function getReminderSettings(j: Journal): Promise<ReminderSettings> {
  return j.get<ReminderSettings>("reminders", defaultReminderSettings());
}

export async function permissionStatus(): Promise<"granted" | "denied" | "undetermined"> {
  const p = await Notifications.getPermissionsAsync();
  return p.granted ? "granted" : p.canAskAgain ? "undetermined" : "denied";
}

/** Asked when the first reminder is switched on. */
export async function requestPermission(): Promise<boolean> {
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Recordatorios", importance: Notifications.AndroidImportance.DEFAULT });
  const p = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: false, allowBadge: false } });
  return p.granted;
}

/**
 * Brings the OS schedule in line with the settings. Journal reminders are weekly triggers with
 * deterministic identifiers; the photo reminder is one dated trigger per day drawn once.
 * Reminder texts never contain journal content.
 */
export async function syncReminders(j: Journal, lang: Lang, opts: { windowChanged?: boolean } = {}): Promise<void> {
  const settings = await getReminderSettings(j);
  const granted = (await Notifications.getPermissionsAsync()).granted;
  if (Platform.OS === "android") await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Recordatorios", importance: Notifications.AndroidImportance.DEFAULT });
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();

  // Journal
  const wanted = granted ? planJournal(settings) : [];
  for (const n of scheduled)
    if (n.identifier.startsWith("journal-") && !wanted.some((w) => w.identifier === n.identifier)) await Notifications.cancelScheduledNotificationAsync(n.identifier);
  for (const w of wanted) {
    if (scheduled.some((n) => n.identifier === w.identifier)) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: w.identifier,
      content: { body: translate(lang, "journalNotif"), data: { kind: "journal" } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday: w.weekday, hour: w.hour, minute: w.minute, channelId: CHANNEL },
    });
  }

  // Photo
  let plan = await j.get<PhotoPlan>("photoPlan", {});
  const now = new Date();
  if (opts.windowChanged) {
    const reset = resetFuturePhotoPlan(plan, now);
    for (const id of reset.cancel) await Notifications.cancelScheduledNotificationAsync(id);
    plan = reset.plan;
  }
  const photoDays = new Set((await j.photos()).map((p) => p.day));
  const result = planPhoto({
    plan,
    settings: granted ? settings : { ...settings, photoEnabled: false },
    today: dayKeyOf(now),
    now,
    timeZone: currentTimeZone(),
    hasPhoto: (d) => photoDays.has(d),
    rng: Math.random,
  });
  for (const id of result.cancel) {
    await Notifications.cancelScheduledNotificationAsync(id);
  }
  for (const s of result.schedule) {
    await Notifications.scheduleNotificationAsync({
      identifier: s.identifier,
      content: { body: translate(lang, "photoNotif"), data: { kind: "photo", day: s.identifier.slice(6) } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: s.fireAt, channelId: CHANNEL },
    });
  }
  await j.set("photoPlan", result.plan);
  // A photo saved today also withdraws a reminder already delivered, where the OS allows it.
  if (photoDays.has(dayKeyOf(now))) await Notifications.dismissNotificationAsync(`photo-${dayKeyOf(now)}`).catch(() => undefined);
}

export async function cancelAllReminders() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}
