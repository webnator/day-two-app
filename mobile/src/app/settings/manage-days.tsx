import { router } from "expo-router";
import { useState } from "react";
import { formatDate } from "../../domain/dates";
import { useI18n } from "../../i18n";
import { emitChange } from "../../services/events";
import { syncReminders } from "../../services/reminders";
import { useApp, useQuery } from "../../state/app";
import { ListRow, NavHeader, PageTitle } from "../../ui/components";
import { Screen } from "../../ui/Screen";
import { ConfirmSheet } from "../../ui/Sheet";

export default function ManageDays() {
  const { t, lang } = useI18n();
  const { journal, worker } = useApp();
  const days = useQuery((j) => j.daysWithContent(), []);
  const [day, setDay] = useState<string | null>(null);
  return (
    <Screen>
      <NavHeader title={t("manageDays")} backA11y={t("back")} onBack={() => router.back()} />
      <PageTitle>{t("yourDays")}</PageTitle>
      {(days ?? []).map((d) => (
        <ListRow key={d} title={formatDate(d, lang, true)} sub={t("deleteWholeDay")} onPress={() => setDay(d)} />
      ))}
      <ConfirmSheet
        visible={!!day}
        title={t("deleteDayQ")}
        text={t("deleteDayText", { date: day ? formatDate(day, lang, true) : "" })}
        action={t("deleteDay")}
        cancelLabel={t("cancel")}
        onClose={() => setDay(null)}
        onConfirm={async () => {
          const d = day!;
          setDay(null);
          await journal!.deleteDay(d);
          emitChange();
          worker?.kick();
          syncReminders(journal!, lang).catch(() => undefined);
        }}
      />
    </Screen>
  );
}
