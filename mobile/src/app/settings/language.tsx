import { router } from "expo-router";
import { useI18n } from "../../i18n";
import { InputNote, ListRow, NavHeader, PageTitle } from "../../ui/components";
import { Screen } from "../../ui/Screen";

export default function Language() {
  const { t, lang, setLang } = useI18n();
  return (
    <Screen>
      <NavHeader title={t("language")} backA11y={t("back")} onBack={() => router.back()} />
      <PageTitle>{t("langTitle")}</PageTitle>
      <ListRow title="Español" value={lang === "es" ? "✓" : undefined} onPress={() => setLang("es")} />
      <ListRow title="English" value={lang === "en" ? "✓" : undefined} onPress={() => setLang("en")} />
      <InputNote>{t("langNote")}</InputNote>
    </Screen>
  );
}
