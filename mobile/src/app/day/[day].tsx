import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Image, View, useWindowDimensions, PixelRatio } from "react-native";
import { plateForDay } from "../../content/illustrations";
import { formatDate, formatLongDate, relativeReference } from "../../domain/dates";
import { HELP_QUESTIONS } from "../../i18n/strings";
import { useI18n } from "../../i18n";
import { useApp, useQuery, useToday } from "../../state/app";
import { AppHeader, ListRow, PhotoPlaceholder, TextLink } from "../../ui/components";
import { DayPhotoBlock, DayTitle, EntryRow, Fab, entryMeta } from "../../ui/day";
import { Screen } from "../../ui/Screen";
import { Sheet } from "../../ui/Sheet";
import { C, useMetrics } from "../../ui/theme";
import { Txt } from "../../ui/Txt";
import { PhotoSourceSheet } from "../../ui/PhotoSourceSheet";

export default function DayScreen() {
  const params = useLocalSearchParams<{ day: string; sheet?: string }>();
  const today = useToday();
  const day = !params.day || params.day === "today" ? today : params.day;
  const isToday = day === today;
  const { t, lang } = useI18n();
  const m = useMetrics();
  const { fixture } = useApp();
  const { fontScale } = useWindowDimensions();
  const [sheet, setSheet] = useState<null | "create" | "help" | "photo">((params.sheet as any) ?? null);

  const data = useQuery(async (j) => ({
    entries: await j.entriesForDay(day),
    photo: await j.photo(day),
    plate: isToday ? await plateForDay(j, day, fixture ? (fixture.startsWith("plate-") ? fixture : "plate-01") : undefined) : null,
  }), [day, isToday]);
  if (!data) return <Screen day>{null}</Screen>;
  const { entries, photo, plate } = data;

  const openSettings = () => router.push("/settings");
  const openCalendar = () => router.push({ pathname: "/memories", params: { day } });
  const fab = <Fab label={t("createEntry")} onPress={() => setSheet("create")} />;
  const sheets = (
    <>
      <Sheet visible={sheet === "create"} title={t("whatToSave")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <ListRow variant="sheet" icon="pen" title={t("write")} onPress={() => { setSheet(null); router.push({ pathname: "/editor", params: { mode: "new", day } }); }} />
        <ListRow variant="sheet" icon="mic" title={t("record")} onPress={() => { setSheet(null); router.push({ pathname: "/record", params: { day } }); }} />
        <ListRow variant="sheet" icon="clip" title={t("importAudio")} onPress={() => { setSheet(null); router.push({ pathname: "/import", params: { day } }); }} />
        <ListRow
          variant="sheet"
          icon="image"
          title={photo ? t("viewDayPhoto") : t("dayPhoto")}
          onPress={() => {
            if (photo) {
              setSheet(null);
              router.push({ pathname: "/photo/[day]", params: { day } });
            } else setSheet("photo");
          }}
        />
      </Sheet>
      <Sheet visible={sheet === "help"} title={t("helpTitle")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <Txt size={18} lh={1.4} color="#717989" style={{ marginBottom: 15 }}>
          {t("helpText")}
        </Txt>
        {HELP_QUESTIONS[lang].map((q, i) => (
          <ListRow key={i} variant="sheet" title={q} onPress={() => { setSheet(null); router.push({ pathname: "/editor", params: { mode: "new", day, prompt: q } }); }} />
        ))}
      </Sheet>
      <PhotoSourceSheet visible={sheet === "photo"} day={day} onClose={() => setSheet(null)} />
    </>
  );

  // ---- Empty today: the approved composition (absolute layout of the mock, flow layout with large text)
  if (!entries.length && !photo && isToday && plate) {
    const flow = fontScale > 1.15;
    const help = <TextLink label={t("whereStart")} a11y={t("helpA11y")} onPress={() => setSheet("help")} />;
    const placeholder = <PhotoPlaceholder label={t("photoOfToday")} a11y={t("addDayPhoto")} onPress={() => setSheet("photo")} />;
    return (
      <Screen day bottom={0} floating={fab}>
        <AppHeader t={t} onProfile={openSettings} onCalendar={openCalendar} marginBottom={14} />
        <Txt size={21} align="center">
          {formatLongDate(day, lang)}
        </Txt>
        {flow ? (
          <View style={{ alignItems: "center", paddingBottom: 126 }}>
            <Txt size={m.emptyH1} lh={1.15} ls={-0.7} align="center" style={{ marginTop: 49 }} accessibilityRole="header">{plate.headline[lang]}</Txt>
            <Image source={plate.image} style={{ width: 205, height: 218, marginTop: 24 }} resizeMode="contain" accessibilityLabel={plate.alt[lang]} />
            <Txt size={21} lh={1.45} color="#505766" align="center" style={{ marginTop: 16 }}>{plate.copy[lang].join("\n")}</Txt>
            <View style={{ width: "100%", marginTop: 12 }}>{help}</View>
            <View style={{ width: "100%", marginTop: 24, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 16 }}>{placeholder}</View>
          </View>
        ) : (
          <View style={{ height: 580 }}>
            <Txt size={m.emptyH1} lh={1.15} ls={-0.7} align="center" style={{ position: "absolute", top: 49, left: -4, right: -4 }} accessibilityRole="header">
              {plate.headline[lang]}
            </Txt>
            <View style={{ position: "absolute", top: 125, left: 0, right: 0, alignItems: "center" }}>
              <Image source={plate.image} style={{ width: 205, height: 218 }} resizeMode="contain" accessibilityLabel={plate.alt[lang]} />
            </View>
            <Txt size={21} lh={1.45} color="#505766" align="center" style={{ position: "absolute", top: 351, left: 0, right: 0 }}>
              {plate.copy[lang].join("\n")}
            </Txt>
            <View style={{ position: "absolute", top: 425, left: 0, right: 0 }}>{help}</View>
            <View style={{ position: "absolute", top: 501, left: 0, right: 0, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 16 }}>{placeholder}</View>
          </View>
        )}
        {sheets}
      </Screen>
    );
  }

  const title = isToday ? t("today") : formatDate(day, lang);
  const side = isToday ? formatDate(day, lang) : relativeReference(day, today, lang);
  return (
    <Screen day floating={fab}>
      <AppHeader t={t} onProfile={openSettings} onCalendar={openCalendar} />
      {/* Collapsed margins: header 24 vs day-title 8 → 24 */}
      <DayTitle today={isToday} title={title} side={side} year={isToday ? undefined : day.slice(0, 4)} />
      {photo ? (
        <DayPhotoBlock
          photo={photo}
          caption={isToday ? t("captionToday") : t("captionPast")}
          a11y={t("viewDayPhoto")}
          alt={t("photoAlt")}
          onPress={() => router.push({ pathname: "/photo/[day]", params: { day } })}
        />
      ) : (
        <PhotoPlaceholder label={isToday ? t("photoOfToday") : t("photoOfThatDay")} a11y={t("addDayPhoto")} onPress={() => setSheet("photo")} />
      )}
      {entries.length ? (
        <View style={{ marginTop: photo ? 12 : 16 }}>
          {entries.map((e, i) => (
            <EntryRow
              key={e.id}
              entry={e}
              last={i === entries.length - 1}
              meta={entryMeta(e, t, lang)}
              preview={e.kind === "audio" && e.transcriptStatus !== "ready" ? t("transcriptPending") : e.body.replace(/\s+/g, " ").trim()}
              a11y={`${t("open")} ${e.title}`}
              onPress={() => router.push({ pathname: "/entry/[id]", params: { id: e.id } })}
            />
          ))}
        </View>
      ) : photo ? (
        <View style={{ borderTopWidth: 1, borderTopColor: C.line, marginTop: 24, paddingTop: 28, alignItems: "center" }}>
          <Txt size={28} lh={1.2} align="center">
            {t("momentSaved")}
          </Txt>
          <Txt size={18} color="#747c8c" align="center" style={{ marginTop: 12, marginBottom: 24 }}>
            {t("addSomeWords")}
          </Txt>
          <TextLink label={t("whereStart")} a11y={t("helpA11y")} onPress={() => setSheet("help")} />
        </View>
      ) : (
        <Txt size={23} align="center" style={{ paddingVertical: 35 }}>
          {t("pastEmpty")}
        </Txt>
      )}
      {sheets}
    </Screen>
  );
}
