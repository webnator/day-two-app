import { router, useLocalSearchParams } from "expo-router";
import { useI18n } from "../i18n";
import { NavHeader, PageTitle } from "../ui/components";
import { Screen } from "../ui/Screen";
import { Txt } from "../ui/Txt";

export default function Legal() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const { t } = useI18n();
  return (
    <Screen>
      <NavHeader backA11y={t("back")} onBack={() => router.back()} />
      <PageTitle>{kind === "terms" ? t("terms") : t("privacy")}</PageTitle>
      <Txt size={19} lh={1.5}>{t("legalPending")}</Txt>
    </Screen>
  );
}
