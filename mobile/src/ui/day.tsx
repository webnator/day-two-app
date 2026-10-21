import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";
import type { DayPhoto, Entry } from "../domain/model";
import { formatDate, formatDuration, type Lang } from "../domain/dates";
import { Btn } from "./components";
import { Icon } from "./Icon";
import { baselineShift } from "./metrics";
import { C, useMetrics } from "./theme";
import { Txt } from "./Txt";
import { Clamped } from "./Clamped";

/** `.fab`: 64 px black circle, white + (35 px, stroke 2.7), 48 px above the bottom edge. */
export function Fab({ label, onPress }: { label: string; onPress: () => void }) {
  const m = useMetrics();
  return (
    <Btn label={label} onPress={onPress} style={[st.fab, { right: m.fabRight }]}>
      <Icon name="plus" w={35} color="#ffffff" stroke={2.7} />
    </Btn>
  );
}

/** `.day-title`: "Hoy" 48px with the date baseline-aligned on the right; past days show the date, year and relative reference. */
export function DayTitle({ today, title, side, year }: { today: boolean; title: string; side: string; year?: string }) {
  const h1 = today ? { size: 48, lh: 1 } : { size: 36, lh: 1 };
  const dy = baselineShift(h1, { size: 19, lh: 1.35 });
  return (
    <View style={st.dayTitle}>
      <View style={{ flexShrink: 0, maxWidth: "100%" }}>
        <Txt size={h1.size} lh={1} ls={-1.3} accessibilityRole="header">
          {title}
        </Txt>
        {year ? (
          <Txt size={17} color={C.muted} style={{ marginTop: 5 }}>
            {year}
          </Txt>
        ) : null}
      </View>
      <Txt size={19} color="#656d80" style={{ marginTop: dy }}>
        {side}
      </Txt>
    </View>
  );
}

export function DayPhotoBlock({ photo, caption, a11y, alt, onPress }: { photo: DayPhoto; caption: string; a11y: string; alt: string; onPress: () => void }) {
  return (
    <>
      <Txt size={18} color="#656d80" style={{ marginBottom: 9 }}>
        {caption}
      </Txt>
      <Btn label={a11y} onPress={onPress} style={{ width: "100%", backgroundColor: C.soft }}>
        <Image source={{ uri: photo.uri }} style={{ width: "100%", aspectRatio: 1.5 }} contentFit="cover" accessibilityLabel={alt} transition={0} />
      </Btn>
    </>
  );
}

export function entryMeta(e: Entry, t: (k: any) => string, lang: Lang, withDate = false): string {
  const parts = [e.localTime, e.kind === "audio" ? t("audio") : t("text")];
  if (e.kind === "audio") parts.push(formatDuration(e.audioDurationMs ?? 0));
  return (withDate ? formatDate(e.day, lang) + " · " : "") + parts.join(" · ");
}

/** `.entry-row`: metadata, title, two-line preview, chevron; fine separator except on the last row. */
export function EntryRow({ entry, last, meta, preview, onPress, a11y }: { entry: Entry; last: boolean; meta: string; preview: string; onPress: () => void; a11y: string }) {
  return (
    <Btn label={a11y} onPress={onPress} style={[st.row, last && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt size={15} lh={1.4} color="#8a90a1">
          {meta}
        </Txt>
        <Txt size={23} lh={1.2} style={{ marginVertical: 4 }}>
          {entry.title}
        </Txt>
        <View><Clamped text={preview} lines={2} size={17} lh={1.35} color="#646c7d" /></View>
      </View>
      <View style={{ width: 22 }}>
        <Icon name="next" />
      </View>
    </Btn>
  );
}

const st = StyleSheet.create({
  fab: { position: "absolute", bottom: 48, width: 64, height: 64, borderRadius: 32, backgroundColor: C.fab, alignItems: "center", justifyContent: "center", zIndex: 2 },
  // Wraps (date under the title) only when large text leaves no room; words never break.
  dayTitle: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", columnGap: 12, marginBottom: 16 },
  row: { width: "100%", paddingTop: 20, paddingBottom: 22, borderBottomWidth: 1, borderBottomColor: C.line, flexDirection: "row", alignItems: "center", columnGap: 10 },
});
