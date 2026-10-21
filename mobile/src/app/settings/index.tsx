import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n";
import { useApp, useQuery } from "../../state/app";
import { ListRow, NavHeader, PrimaryButton, SecondaryButton } from "../../ui/components";
import { Screen } from "../../ui/Screen";
import { ConfirmSheet, Sheet, SheetText } from "../../ui/Sheet";
import { C } from "../../ui/theme";
import { cancelAllReminders } from "../../services/reminders";
import { connectionsCopy } from '../../content/connectionsCopy';

export default function Settings() {
  const { t, lang } = useI18n();
  const { session, signOut } = useApp();
  const [sheet, setSheet] = useState<null | "logout" | "wipe">(null);
  const pending = useQuery((j) => j.pendingJobCount(), []);
  const out = async (wipe: boolean) => {
    setSheet(null);
    if (wipe) await cancelAllReminders().catch(() => undefined);
    await signOut({ wipe });
    router.replace("/access");
  };
  return (
    <Screen>
      <NavHeader title={t("settings")} backLabel={t("today")} backA11y={t("back")} onBack={() => router.back()} />
      <ListRow variant="settings" icon="user" title={t("account")} sub={session?.user.email} onPress={() => router.push("/settings/account")} />
      <ListRow variant="settings" icon="bell" title={t("reminders")} onPress={() => router.push("/settings/reminders")} />
      <ListRow variant="settings" icon="globe" title={t("language")} value={lang === "es" ? "Español" : "English"} onPress={() => router.push("/settings/language")} />
      <ListRow variant="settings" icon="pin" title={t("locationWeather")} onPress={() => router.push("/settings/location")} />
      <ListRow variant="settings" icon="data" title={t("yourData")} onPress={() => router.push("/settings/data")} />
      <ListRow variant="settings" icon="globe" title={connectionsCopy[lang].title} sub="ChatGPT · Claude" onPress={() => router.push('/settings/connections')} />
      <View style={{ marginTop: 64, borderTopWidth: 1, borderTopColor: C.line }}>
        <ListRow variant="settings" icon="logout" title={t("logout")} onPress={() => setSheet("logout")} />
      </View>

      <Sheet visible={sheet === "logout"} title={t("logoutQ")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <SheetText>{t("logoutText")}</SheetText>
        {pending ? <SheetText>{t("logoutPending", { n: pending })}</SheetText> : null}
        <PrimaryButton label={t("logoutKeep")} marginTop={7} testID="logout-keep" onPress={() => out(false)} />
        <SecondaryButton label={t("logoutWipe")} onPress={() => setSheet("wipe")} />
        <SecondaryButton label={t("cancel")} onPress={() => setSheet(null)} />
      </Sheet>
      <ConfirmSheet visible={sheet === "wipe"} title={t("logoutWipeQ")} text={t("logoutWipeText")} action={t("logoutWipe")} cancelLabel={t("cancel")} onClose={() => setSheet("logout")} onConfirm={() => out(true)} />
    </Screen>
  );
}
