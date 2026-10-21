import { router } from "expo-router";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { BodyMuted, InputNote, NavHeader, PageTitle, QuietAction } from "../../ui/components";
import { Screen } from "../../ui/Screen";

export default function Account() {
  const { t } = useI18n();
  const { session } = useApp();
  return (
    <Screen>
      <NavHeader title={t("account")} backA11y={t("back")} onBack={() => router.back()} />
      <PageTitle>{t("yourEmail")}</PageTitle>
      <BodyMuted>{session?.user.email ?? ""}</BodyMuted>
      <QuietAction label={t("changeEmail")} onPress={() => router.push("/settings/change-email")} />
      <InputNote>{t("verifyNewEmail")}</InputNote>
    </Screen>
  );
}
