import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useI18n } from "../../i18n";
import { locationPermission, requestLocationPermission } from "../../services/context";
import { useApp, useQuery } from "../../state/app";
import { BodyMuted, InputNote, NavHeader, PageTitle, QuietAction, Switch } from "../../ui/components";
import { Screen } from "../../ui/Screen";
import { C } from "../../ui/theme";
import { Txt } from "../../ui/Txt";
import { emitChange } from "../../services/events";

export default function LocationSettings() {
  const { t } = useI18n();
  const { journal, toast } = useApp();
  const enabled = useQuery((j) => j.get("locationEnabled", true), []);
  const [perm, setPerm] = useState<string>("undetermined");
  useEffect(() => {
    locationPermission().then(setPerm).catch(() => undefined);
  }, []);
  return (
    <Screen>
      <NavHeader title={t("locationWeather")} backA11y={t("back")} onBack={() => router.back()} />
      <PageTitle>{t("placeMoment")}</PageTitle>
      <BodyMuted>{t("placeMomentText")}</BodyMuted>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line, marginTop: 30 }}>
        <Txt size={22}>{t("addAutomatically")}</Txt>
        <Switch value={!!enabled} label={t("addAutomaticallyA11y")} onChange={async (v) => { await journal!.set("locationEnabled", v); emitChange(); }} />
      </View>
      <InputNote>{perm === "denied" ? t("locationDenied") : t("canSaveWithoutLocation")}</InputNote>
      <QuietAction
        label={t("locationPermission")}
        onPress={async () => {
          if (perm === "denied") return Linking.openSettings();
          const ok = await requestLocationPermission();
          setPerm(ok ? "granted" : "denied");
          toast(ok ? t("permissionGranted") : t("locationDenied"));
        }}
      />
    </Screen>
  );
}
