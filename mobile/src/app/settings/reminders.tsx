import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, View } from "react-native";
import { defaultReminderSettings, validWindow, type JournalTime, type ReminderSettings } from "../../domain/reminders";
import { useI18n } from "../../i18n";
import { emitChange } from "../../services/events";
import { permissionStatus, requestPermission, syncReminders } from "../../services/reminders";
import { useApp, useQuery } from "../../state/app";
import { ErrorText, FormLabel, ListRow, NavHeader, PrimaryButton, QuietAction, SecondaryButton, Switch } from "../../ui/components";
import { CheckOption, PickerField } from "../../ui/fields";
import { Screen } from "../../ui/Screen";
import { Sheet, SheetText } from "../../ui/Sheet";
import { C } from "../../ui/theme";
import { Txt } from "../../ui/Txt";

const EVERY = [0, 1, 2, 3, 4, 5, 6], WEEK = [0, 1, 2, 3, 4], WEEKEND = [5, 6];
const same = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
const SHORT = { es: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"], en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] };

export default function Reminders() {
  const params = useLocalSearchParams<{ sheet?: string }>();
  const { t, lang } = useI18n();
  const { journal } = useApp();
  const settings = useQuery((j) => j.get<ReminderSettings>("reminders", defaultReminderSettings()), []);
  const [sheet, setSheet] = useState<null | "time" | "window" | "denied">(params.sheet === "window" ? "window" : null);
  const [editing, setEditing] = useState<JournalTime | null>(null);
  const [repeat, setRepeat] = useState<"every" | "week" | "weekend" | "custom">("every");
  const [win, setWin] = useState({ from: "09:00", to: "20:00" });
  const [error, setError] = useState("");
  if (!settings || !journal) return <Screen>{null}</Screen>;

  const label = (days: number[]) =>
    same(days, EVERY) ? t("everyDay") : same(days, WEEK) ? t("weekdays") : same(days, WEEKEND) ? t("weekend") : [...days].sort().map((d) => SHORT[lang][d]).join(", ");
  const save = async (next: ReminderSettings, windowChanged = false) => {
    await journal.set("reminders", next);
    emitChange();
    await syncReminders(journal, lang, { windowChanged }).catch(() => undefined);
  };
  /** Permission is asked when the first reminder is switched on; denial never blocks the journal. */
  const enable = async (key: "journalEnabled" | "photoEnabled", v: boolean) => {
    if (v) {
      const status = await permissionStatus();
      const ok = status === "granted" || (status === "undetermined" && (await requestPermission()));
      if (!ok) return setSheet("denied");
    }
    await save({ ...settings, [key]: v }, key === "photoEnabled");
  };
  const openTime = (tm: JournalTime | null) => {
    const days = tm?.days ?? EVERY;
    setEditing(tm ?? { id: `t${Date.now()}`, at: "19:00", days: EVERY });
    setRepeat(same(days, EVERY) ? "every" : same(days, WEEK) ? "week" : same(days, WEEKEND) ? "weekend" : "custom");
    setSheet("time");
  };
  const switchRow = (text: string, value: boolean, a11y: string, onChange: (v: boolean) => void) => (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Txt size={22}>{text}</Txt>
      <Switch value={value} label={a11y} onChange={onChange} />
    </View>
  );

  return (
    <Screen>
      <NavHeader title={t("reminders")} backA11y={t("back")} onBack={() => router.back()} />
      <View style={{ marginBottom: 34 }}>
        {switchRow(t("forYourJournal"), settings.journalEnabled, t("activateJournal"), (v) => enable("journalEnabled", v))}
        {settings.times.map((tm) => (
          <ListRow key={tm.id} title={tm.at} sub={label(tm.days)} onPress={() => openTime(tm)} />
        ))}
        <QuietAction label={t("addTime")} a11y={t("addTimeA11y")} onPress={() => openTime(null)} />
      </View>
      <View style={{ marginBottom: 34 }}>
        {switchRow(t("onePhotoADay"), settings.photoEnabled, t("activatePhoto"), (v) => enable("photoEnabled", v))}
        <ListRow title={t("from")} value={settings.from} onPress={() => { setWin({ from: settings.from, to: settings.to }); setError(""); setSheet("window"); }} />
        <ListRow title={t("to")} value={settings.to} onPress={() => { setWin({ from: settings.from, to: settings.to }); setError(""); setSheet("window"); }} />
        <Txt size={16} color="#818999" style={{ marginTop: 20 }}>{t("photoNote1") + "\n" + t("photoNote2")}</Txt>
      </View>
      <QuietAction
        label={t("notificationPermissions")}
        onPress={async () => {
          const status = await permissionStatus();
          if (status === "denied") return setSheet("denied");
          if (await requestPermission()) await syncReminders(journal, lang);
          else setSheet("denied");
        }}
      />
      <Txt size={15} color="#89909e" style={{ marginTop: 15 }}>{t("deliveryLimits")}</Txt>

      <Sheet visible={sheet === "time" && !!editing} title={t("momentForYou")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        {editing ? (
          <>
            <PickerField label={t("time")} mode="time" mt={8} mb={24} value={editing.at} onChange={(at) => setEditing({ ...editing, at })} />
            <FormLabel>{t("repeat")}</FormLabel>
            {([["every", t("everyDay")], ["week", t("weekdays")], ["weekend", t("weekend")], ["custom", t("customDays")]] as const).map(([k, l]) => (
              <CheckOption key={k} label={l} checked={repeat === k} onChange={() => { setRepeat(k); if (k !== "custom") setEditing({ ...editing, days: k === "every" ? EVERY : k === "week" ? WEEK : WEEKEND }); }} />
            ))}
            {repeat === "custom" ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14 }}>
                {SHORT[lang].map((d, i) => (
                  <CheckOption key={d} label={d} checked={editing.days.includes(i)} onChange={(v) => setEditing({ ...editing, days: v ? [...editing.days, i] : editing.days.filter((x) => x !== i) })} />
                ))}
              </View>
            ) : null}
            <PrimaryButton
              label={t("save")}
              marginTop={22}
              disabled={!editing.days.length}
              onPress={async () => {
                const exists = settings.times.some((x) => x.id === editing.id);
                await save({ ...settings, times: exists ? settings.times.map((x) => (x.id === editing.id ? editing : x)) : [...settings.times, editing] });
                setSheet(null);
              }}
            />
            {settings.times.some((x) => x.id === editing.id) ? (
              <SecondaryButton label={t("removeTime")} onPress={async () => { await save({ ...settings, times: settings.times.filter((x) => x.id !== editing.id) }); setSheet(null); }} />
            ) : null}
          </>
        ) : null}
      </Sheet>

      <Sheet visible={sheet === "window"} title={t("photoWindow")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <PickerField label={t("from")} mode="time" mt={8} value={win.from} onChange={(from) => setWin({ ...win, from })} />
        <PickerField label={t("to")} mode="time" value={win.to} onChange={(to) => setWin({ ...win, to })} />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <PrimaryButton
          label={t("save")}
          marginTop={24}
          onPress={async () => {
            if (!validWindow(win.from, win.to)) return setError(t("windowError"));
            await save({ ...settings, ...win }, true);
            setSheet(null);
          }}
        />
      </Sheet>

      <Sheet visible={sheet === "denied"} title={t("notifDeniedTitle")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <SheetText>{t("notifDeniedText")}</SheetText>
        <PrimaryButton label={t("openSettings")} marginTop={7} onPress={() => { setSheet(null); Linking.openSettings(); }} />
        <SecondaryButton label={t("notNow")} onPress={() => setSheet(null)} />
      </Sheet>
    </Screen>
  );
}
