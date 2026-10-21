import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { formatDate, formatMonthGroup, formatMonthTitle, makeDay, monthCells, parseDay, WEEKDAY_INITIALS } from "../domain/dates";
import { useI18n } from "../i18n";
import { useApp, useQuery, useToday } from "../state/app";
import { Btn, NavHeader, NavIconButton, QuietAction, Tabs } from "../ui/components";
import { Icon } from "../ui/Icon";
import { Screen } from "../ui/Screen";
import { C } from "../ui/theme";
import { Txt } from "../ui/Txt";

/** Recuerdos: Calendario / Álbum (text tabs, not a bottom bar). Back returns to the day it came from. */
export default function Memories() {
  const params = useLocalSearchParams<{ tab?: string; day?: string }>();
  const { t, lang } = useI18n();
  const { fixture } = useApp(); // the mock alternates the crop of its single demo photo
  const today = useToday();
  const [tab, setTab] = useState<"calendar" | "album">(params.tab === "album" ? "album" : "calendar");
  const [selected, setSelected] = useState(params.day && params.day !== "today" ? params.day : today);
  const start = parseDay(selected);
  const [month, setMonth] = useState({ y: start.y, m: start.m });
  const prefix = `${month.y}-${String(month.m + 1).padStart(2, "0")}`;
  const markers = useQuery((j) => j.monthMarkers(prefix), [prefix]);
  const preview = useQuery(async (j) => ({ entries: await j.entriesForDay(selected), photo: await j.photo(selected) }), [selected]);
  const photos = useQuery((j) => j.photos(), []);

  const header = (
    <>
      <NavHeader
        backLabel={t("today")}
        backA11y={t("back")}
        onBack={() => router.back()}
        right={<NavIconButton icon="search" label={t("searchMemories")} onPress={() => router.push("/search")} />}
      />
      <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: 26 }} accessibilityRole="header">{t("memories")}</Txt>
      <Tabs items={[{ key: "calendar", label: t("calendar") }, { key: "album", label: t("album") }]} active={tab} onChange={(k) => setTab(k as any)} />
    </>
  );

  if (tab === "album") {
    const groups = new Map<string, string[]>();
    for (const p of photos ?? []) groups.set(p.day.slice(0, 7), [...(groups.get(p.day.slice(0, 7)) ?? []), p.day]);
    return (
      <Screen>
        {header}
        {photos && !photos.length ? <Txt size={20} color="#7a8392" align="center" style={{ paddingVertical: 40 }}>{t("albumEmpty")}</Txt> : null}
        {[...groups.entries()].map(([ym, days], gi) => {
          const [y, m] = ym.split("-").map(Number);
          return (
            <View key={ym}>
              <Txt size={22} style={{ borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 10, marginTop: gi === 0 ? 0 : 22, marginBottom: 14 }} accessibilityRole="header">
                {formatMonthGroup(y, m - 1, lang)}
              </Txt>
              <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 18 }}>
                {days.map((d, i) => {
                  const p = photos!.find((x) => x.day === d)!;
                  return (
                    <Btn key={d} label={`${t("open")} ${formatDate(d, lang, true)}`} onPress={() => router.navigate({ pathname: "/day/[day]", params: { day: d === today ? "today" : d } })} style={{ width: "48.57%", flexGrow: 0 }}>
                      <Image source={{ uri: p.uri }} style={{ width: "100%", aspectRatio: 1 }} contentFit="cover" contentPosition={fixture ? (i % 2 ? "right" : "left") : "center"} accessibilityLabel={`${t("photoAlt")} ${formatDate(d, lang)}`} />
                      <Txt size={16} color="#778093" style={{ marginTop: 5 }}>{formatDate(d, lang)}</Txt>
                    </Btn>
                  );
                })}
              </View>
            </View>
          );
        })}
      </Screen>
    );
  }

  const cells = monthCells(month.y, month.m);
  const go = (delta: number) => {
    let m = month.m + delta, y = month.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setMonth({ y, m });
  };
  const first = preview?.entries[0];
  return (
    <Screen>
      {header}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <Btn label={t("prevMonth")} onPress={() => go(-1)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="back" /></Btn>
        <Txt size={22} accessibilityRole="header">{formatMonthTitle(month.y, month.m, lang)}</Txt>
        <Btn label={t("nextMonth")} onPress={() => go(1)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon name="next" /></Btn>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {WEEKDAY_INITIALS[lang].map((w, i) => (
          <View key={"w" + i} style={{ width: "14.2857%", height: 30.25, justifyContent: "flex-start" }}>
            <Txt size={15} align="center">{w}</Txt>
          </View>
        ))}
        {cells.map((n, i) => {
          if (!n) return <View key={"e" + i} style={{ width: "14.2857%", height: 49 }} />;
          const d = makeDay(month.y, month.m, n);
          const future = d > today;
          const isSel = d === selected;
          const hasEntry = markers?.entries.has(d);
          const hasPhoto = markers?.photos.has(d);
          return (
            <Btn
              key={d}
              label={formatDate(d, lang, true)}
              accessibilityState={{ selected: isSel, disabled: future }}
              disabled={future}
              onPress={() => setSelected(d)}
              style={{ width: "14.2857%", height: 49, alignItems: "center", paddingVertical: 4, opacity: 1 }}
            >
              <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: isSel ? "#111111" : "transparent" }}>
                <Txt size={18} color={isSel ? "#ffffff" : future ? "#a2a9b7" : C.ink} align="center">{String(n)}</Txt>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", columnGap: 4, height: 8 }}>
                {hasEntry ? <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: isSel ? "#111111" : "#111111" }} /> : null}
                {hasPhoto ? <Icon name="image" w={10} stroke={2} /> : null}
              </View>
            </Btn>
          );
        })}
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: C.line, marginTop: 26, paddingTop: 20 }}>
        <Txt size={19} color="#687385">{formatDate(selected, lang)}</Txt>
        {first ? (
          <Btn label={`${t("open")} ${first.title}`} onPress={() => router.push({ pathname: "/entry/[id]", params: { id: first.id } })} style={{ flexDirection: "row", alignItems: "center", columnGap: 10, paddingTop: 20, paddingBottom: 22, borderBottomWidth: 1, borderBottomColor: C.line }}>
            {preview?.photo ? <Image source={{ uri: preview.photo.uri }} style={{ width: 62, height: 62 }} contentFit="cover" accessibilityLabel={t("photoAlt")} /> : <View style={{ width: 62 }} />}
            <View style={{ flex: 1 }}>
              <Txt size={20} lh={1.2} style={{ marginVertical: 4 }}>{first.title}</Txt>
              <Txt size={15} lh={1.4} color="#8a90a1">{`${first.localTime} · ${first.kind === "audio" ? t("audio") : t("text")}`}</Txt>
            </View>
            <View style={{ width: 18 }}><Icon name="next" /></View>
          </Btn>
        ) : (
          <Txt size={18} lh={1.4} color="#737b8b" style={{ marginVertical: 16 }}>{preview?.photo ? t("momentSaved") : t("aDayToRemember")}</Txt>
        )}
        <View style={{ alignItems: "center", marginTop: 16 }}>
          <QuietAction label={t("viewThisDay")} a11y={t("viewSelectedDay")} align="center" onPress={() => router.navigate({ pathname: "/day/[day]", params: { day: selected === today ? "today" : selected } })} />
        </View>
      </View>
    </Screen>
  );
}
