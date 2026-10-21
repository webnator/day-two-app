import { Asset } from "expo-asset";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { emitChange } from "../services/events";
import { syncReminders } from "../services/reminders";
import { useApp, useToday } from "../state/app";
import { NavHeader, PrimaryButton, SecondaryButton } from "../ui/components";
import { Screen } from "../ui/Screen";
import { Txt } from "../ui/Txt";

/** The new photo replaces the previous one only after it has been stored; failure keeps the old one. */
export default function PhotoPreview() {
  const p = useLocalSearchParams<{ day: string; uri?: string; ext?: string; mime?: string; w?: string; h?: string; fixture?: string }>();
  const { t, lang } = useI18n();
  const { journal, toast } = useApp();
  const today = useToday();
  const day = p.day === "today" || !p.day ? today : p.day;
  const [uri, setUri] = useState(p.uri ?? null);
  const saving = useRef(false);
  useEffect(() => {
    if (__DEV__ && p.fixture) {
      const a = Asset.fromModule(require("../../assets/fixtures/daily-photo.png"));
      a.downloadAsync().then(() => setUri(a.localUri));
    }
  }, [p.fixture]);
  const save = async () => {
    if (!journal || !uri || saving.current) return;
    saving.current = true;
    try {
      const f = await journal.importFile(uri, "photos", p.ext ?? ".jpg", p.mime ?? "image/jpeg");
      await journal.setDayPhoto(day, f.id, { width: Number(p.w) || null, height: Number(p.h) || null });
      emitChange();
      syncReminders(journal, lang).catch(() => undefined); // cancels today's pending photo reminder
      router.back();
      toast(t("photoSaved"));
    } catch {
      toast(t("photoFailed"));
    } finally {
      saving.current = false;
    }
  };
  return (
    <Screen>
      <NavHeader title={t("dayPhoto")} backA11y={t("back")} onBack={() => router.back()} />
      <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: 26 }} accessibilityRole="header">
        {day === today ? t("instantOfToday") : t("instantOfThatDay")}
      </Txt>
      {uri ? <Image source={{ uri }} style={{ width: "100%", aspectRatio: 1.5 }} contentFit="cover" accessibilityLabel={t("photoAlt")} /> : null}
      <PrimaryButton label={t("savePhoto")} a11y={t("saveDayPhoto")} onPress={save} disabled={!uri} />
      <SecondaryButton label={t("cancel")} a11y={t("cancelPhoto")} onPress={() => router.back()} />
    </Screen>
  );
}
