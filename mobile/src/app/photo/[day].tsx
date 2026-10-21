import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { formatShortDate } from "../../domain/dates";
import { useI18n } from "../../i18n";
import { emitChange } from "../../services/events";
import { syncReminders } from "../../services/reminders";
import { useApp, useQuery, useToday } from "../../state/app";
import { ListRow, NavHeader, NavIconButton, PhotoPlaceholder, SecondaryButton } from "../../ui/components";
import { Screen } from "../../ui/Screen";
import { ConfirmSheet, Sheet, SheetText } from "../../ui/Sheet";
import { PhotoSourceSheet } from "../../ui/PhotoSourceSheet";
import { Txt } from "../../ui/Txt";

export default function PhotoView() {
  const params = useLocalSearchParams<{ day: string; sheet?: string }>();
  const { t, lang } = useI18n();
  const { journal } = useApp();
  const today = useToday();
  const day = params.day === "today" ? today : params.day;
  const [sheet, setSheet] = useState<null | "menu" | "delete" | "source">(params.sheet === "menu" ? "menu" : null);
  const photo = useQuery((j) => j.photo(day), [day]);
  const isToday = day === today;
  return (
    <Screen>
      <NavHeader
        backLabel={isToday ? t("today") : formatShortDate(day, lang)}
        backA11y={t("back")}
        onBack={() => router.back()}
        title={formatShortDate(day, lang)}
        right={photo ? <NavIconButton icon="more" label={t("photoOptions")} onPress={() => setSheet("menu")} /> : null}
      />
      <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: 10 }} accessibilityRole="header">
        {isToday ? t("captionToday") : t("captionPast")}
      </Txt>
      {photo ? (
        <>
          <Txt size={17} color="#808696">{photo.localTime}</Txt>
          <Image source={{ uri: photo.uri }} style={{ width: "100%", aspectRatio: 1.5, marginTop: 20 }} contentFit="cover" accessibilityLabel={t("photoAlt")} />
        </>
      ) : photo === null ? (
        <PhotoPlaceholder label={isToday ? t("photoOfToday") : t("photoOfThatDay")} a11y={t("addDayPhoto")} onPress={() => setSheet("source")} />
      ) : null}

      <Sheet visible={sheet === "menu"} title={t("dayPhoto")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <ListRow variant="sheet" icon="image" title={t("changePhoto")} onPress={() => setSheet("source")} />
        <ListRow variant="sheet" icon="trash" title={t("deletePhoto")} onPress={() => setSheet("delete")} />
        <SheetText style={{ marginTop: 22 }}>{t("entriesKept")}</SheetText>
        <SecondaryButton label={t("cancel")} onPress={() => setSheet(null)} />
      </Sheet>
      <PhotoSourceSheet visible={sheet === "source"} day={day} onClose={() => setSheet(null)} />
      <ConfirmSheet
        visible={sheet === "delete"}
        title={t("deletePhotoQ")}
        text={t("entriesKept")}
        action={t("deletePhoto")}
        cancelLabel={t("cancel")}
        onClose={() => setSheet(null)}
        onConfirm={async () => {
          setSheet(null);
          await journal!.deleteDayPhoto(day);
          emitChange();
          syncReminders(journal!, lang).catch(() => undefined);
          router.back();
        }}
      />
    </Screen>
  );
}
