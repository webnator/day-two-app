import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import * as Network from "expo-network";
import { useI18n } from "../../i18n";
import { api } from "../../services/api";
import { exportJournal } from "../../services/export";
import { cancelAllReminders } from "../../services/reminders";
import { useApp } from "../../state/app";
import { ListRow, NavHeader, PageTitle, QuietAction } from "../../ui/components";
import { Screen } from "../../ui/Screen";
import { ConfirmSheet } from "../../ui/Sheet";
import { C } from "../../ui/theme";

export default function DataScreen() {
  const params = useLocalSearchParams<{ sheet?: string }>();
  const { t } = useI18n();
  const { journal, session, signOut, toast } = useApp();
  const [sheet, setSheet] = useState(params.sheet === "delete");
  const [busy, setBusy] = useState(false);
  return (
    <Screen>
      <NavHeader title={t("yourData")} backA11y={t("back")} onBack={() => router.back()} />
      <PageTitle>{t("dataTitle")}</PageTitle>
      <ListRow
        icon="export"
        title={t("exportJournal")}
        sub={t("exportSub")}
        onPress={async () => {
          if (!journal || busy) return;
          setBusy(true);
          toast(t("exporting"));
          try {
            await exportJournal(journal, session?.user.email ?? "");
          } catch {
            toast(t("exportFailed"));
          } finally {
            setBusy(false);
          }
        }}
      />
      <ListRow icon="pin" title={t("locationWeather")} sub={t("locationSub")} onPress={() => router.push("/settings/location")} />
      <ListRow icon="calendar" title={t("manageDays")} onPress={() => router.push("/settings/manage-days")} />
      <View style={{ marginTop: 64, borderTopWidth: 1, borderTopColor: C.line }}>
        <QuietAction label={t("deleteAccount")} onPress={() => setSheet(true)} />
      </View>
      <ConfirmSheet
        visible={sheet}
        title={t("deleteAccountQ")}
        text={t("deleteAccountText")}
        action={t("deleteAccount")}
        cancelLabel={t("cancel")}
        onClose={() => setSheet(false)}
        onConfirm={async () => {
          const net = await Network.getNetworkStateAsync().catch(() => null);
          if (net && !net.isConnected) {
            setSheet(false);
            return toast(t("deleteAccountOffline"));
          }
          try {
            // Server first (revokes every session and deletes server-side data), then this device.
            await api.deleteAccount();
          } catch {
            setSheet(false);
            return toast(t("deleteAccountOffline"));
          }
          setSheet(false);
          await cancelAllReminders().catch(() => undefined);
          await signOut({ wipe: true, remote: false });
          router.replace("/access");
        }}
      />
    </Screen>
  );
}
