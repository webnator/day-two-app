import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from "expo-audio";
import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import type { Entry, Resource, TranscriptSpan } from "../domain/model";
import { formatDuration } from "../domain/dates";
import { Btn } from "./components";
import { Icon, weatherIcon } from "./Icon";
import { C } from "./theme";
import { Txt } from "./Txt";

// ---------------------------------------------------------------- metadata line

/** `.entry-meta`: "20:48 · Audio · Madrid · 18°" + sky icon (15px, #808696). */
export function EntryMeta({ entry, t, weatherLabel }: { entry: Pick<Entry, "localTime" | "kind" | "city" | "temperatureC" | "weatherCondition">; t: (k: any) => string; weatherLabel?: string }) {
  const parts = [entry.localTime, entry.kind === "audio" ? t("audio") : t("text")];
  if (entry.city) parts.push(entry.city);
  if (entry.temperatureC != null) parts.push(`${Math.round(entry.temperatureC)}°`);
  return (
    <View style={st.meta}>
      <Txt size={15} color="#808696">
        {parts.join(" · ")}
      </Txt>
      {entry.weatherCondition ? (
        <View accessible accessibilityRole="image" accessibilityLabel={weatherLabel ?? entry.weatherCondition}>
          <Icon name={weatherIcon(entry.weatherCondition)} w={22} color="#808696" />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- tags

/** Two discreet rows (topics, emotions) under the title — also while editing. */
export function TagLines({
  topics, emotions, editable = false, onEdit, t, compact = true,
}: { topics: string[]; emotions: string[]; editable?: boolean; onEdit?: (k: "topics" | "emotions") => void; t: (k: any) => string; compact?: boolean }) {
  const rows: ["topics" | "emotions", "tag" | "heart", string[]][] = [
    ["topics", "tag", topics],
    ["emotions", "heart", emotions],
  ];
  const visible = rows.filter(([, , list]) => list.length || editable);
  if (!visible.length) return <View style={{ height: 18 }} />; // empty .tags: collapsed margins (max 16, 18)
  return (
    <View style={{ marginTop: 16, marginBottom: 18, rowGap: 5 }}>
      {visible.map(([key, icon, list]) => (
        <View key={key} style={[st.tagLine, editable && { minHeight: 36 }]}>
          <Icon name={icon} w={22} />
          <Txt size={18} style={{ flexShrink: 1 }} accessibilityLabel={`${key === "topics" ? t("topics") : t("emotions")}: ${list.join(", ")}`}>
            {list.join(" · ") || (key === "topics" ? t("addTopic") : t("addEmotion"))}
          </Txt>
          {editable ? (
            <Btn label={key === "topics" ? t("editTopics") : t("editEmotions")} onPress={() => onEdit?.(key)} style={st.editTag}>
              <Txt size={16} color="#818998">
                {t("edit")}
              </Txt>
            </Btn>
          ) : null}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- waveform

const mockHeights = Array.from({ length: 39 }, (_, i) => 7 + Math.abs(Math.sin(i * 2.53)) * 30);

/** `.wave`: 39 bars, 2–3 px, gap 2. Real peaks when captured while recording; the mock pattern otherwise. */
export function Wave({ peaks, height = 38, live }: { peaks?: number[] | null; height?: number; live?: number[] }) {
  const heights = live ?? (peaks?.length ? peaks.map((p) => 7 + p * 30) : mockHeights);
  return (
    <View style={[st.wave, { height }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {heights.map((h, i) => (
        <View key={i} style={[st.bar, { height: h }]} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- audio player

/** `.audio-player`: real playback of the original file, 1× / 1.5× / 2×. */
export function AudioPlayer({ uri, durationMs, peaks, t, onDuration, seekRequest }: { uri?: string | null; durationMs?: number | null; peaks?: number[] | null; t: (k: any) => string; onDuration?: (ms: number) => void; seekRequest?: { at: number; id: number } }) {
  const player = useAudioPlayer(uri ? { uri } : null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!seekRequest || !uri) return;
    let cancelled = false;
    void (async () => {
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      if (cancelled) return;
      await player.seekTo(Math.max(0, seekRequest.at));
      if (!cancelled) player.play();
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [seekRequest, uri, player]);
  useEffect(() => {
    if (status.duration > 0) onDuration?.(Math.round(status.duration * 1000));
  }, [status.duration, onDuration]);
  useEffect(() => {
    if (status.didJustFinish) {
      player.seekTo(0).catch(() => undefined);
      player.pause();
    }
  }, [status.didJustFinish, player]);
  const toggle = async () => {
    if (!uri) return;
    if (status.playing) player.pause();
    else {
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => undefined);
      player.play();
    }
  };
  const nextSpeed = () => {
    const s = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(s);
    player.setPlaybackRate(s, "high");
  };
  const shown = status.playing || status.currentTime > 0 ? formatDuration(status.currentTime * 1000) : formatDuration(durationMs ?? (status.duration || 0) * 1000);
  return (
    <View style={st.player}>
      <Btn label={status.playing ? t("pausePlayback") : t("play")} onPress={toggle} style={st.play} disabled={!uri}>
        <Icon name={status.playing ? "pause" : "play"} w={23} color="#ffffff" />
      </Btn>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Wave peaks={peaks} />
      </View>
      <Txt size={16} color="#7b8394" accessibilityLabel={shown}>
        {shown}
      </Txt>
      <Btn label={t("speed")} onPress={nextSpeed} style={st.speed} accessibilityValue={{ text: `${speed}×` }}>
        <Txt size={18}>{`${speed}×`}</Txt>
      </Btn>
    </View>
  );
}

export function TranscriptReview({ spans, label, onSeek }: { spans?: TranscriptSpan[]; label: string; onSeek: (at: number) => void }) {
  if (!spans?.length) return null;
  return (
    <View style={{ marginBottom: 16 }}>
      <Txt size={16} color="#707a8d">{label}</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14 }}>
        {spans.map((span, i) => {
          const time = `${formatDuration(span.start * 1000)}–${formatDuration(span.end * 1000)}`;
          return <Btn key={i} label={time} onPress={() => onSeek(span.start)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Txt size={16} color="#707a8d" style={{ textDecorationLine: "underline" }}>{time}</Txt>
          </Btn>;
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- resources

/** `.resource-row`: 20 px / padding 15 13 in forms; 18 px / padding 13 inside detail and editor. */
export function ResourceRow({ r, t, onPress, compact = true }: { r: Pick<Resource, "kind" | "title" | "url" | "status">; t: (k: any) => string; onPress?: () => void; compact?: boolean }) {
  const kind = r.kind === "link" ? t("linkKind") : r.kind === "image" ? t("imageKind") : t("videoKind");
  const body = (
    <>
      <Icon name={r.kind === "link" ? "link" : r.kind === "image" ? "image" : "video"} w={28} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt size={compact ? 18 : 20}>{r.title}</Txt>
        <Txt size={16} color={r.status === "error" ? C.error : "#828a9b"}>
          {r.status === "error" ? t("resourceFailed") : kind}
        </Txt>
      </View>
      {onPress ? <Icon name="next" w={18} h={28} /> : null}
    </>
  );
  return onPress ? (
    <Btn label={`${t("openResource")} ${r.title}`} onPress={onPress} style={[st.resource, !compact && st.resourceForm]}>
      {body}
    </Btn>
  ) : (
    <View style={[st.resource, !compact && st.resourceForm]}>{body}</View>
  );
}
// ---------------------------------------------------------------- states

export function Notice({ icon = "wifi", children }: { icon?: "wifi"; children: string }) {
  return (
    <View style={st.notice} accessibilityRole="alert">
      <Icon name={icon} />
      <Txt size={16}>{children}</Txt>
    </View>
  );
}

export function SavedState({ children }: { children: string }) {
  return (
    <View style={st.saved} accessibilityLiveRegion="polite">
      <Icon name="circlecheck" w={22} h={24} />
      <Txt size={17}>{children}</Txt>
    </View>
  );
}

export function Spinner() {
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const a = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [spin]);
  return <Animated.View style={[st.spinner, { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }]} />;
}

const st = StyleSheet.create({
  meta: { flexDirection: "row", alignItems: "center", columnGap: 5, flexWrap: "wrap", minHeight: 22 },
  tagLine: { flexDirection: "row", alignItems: "center", columnGap: 10, minHeight: 25 },
  editTag: { marginLeft: "auto", minHeight: 36, paddingVertical: 1, paddingHorizontal: 6, justifyContent: "center" },
  wave: { flexDirection: "row", alignItems: "center", columnGap: 2, overflow: "hidden" },
  bar: { flex: 1, minWidth: 2, maxWidth: 3, backgroundColor: C.waveBar, borderRadius: 2 },
  player: { flexDirection: "row", alignItems: "center", columnGap: 12, backgroundColor: C.soft, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 13, minHeight: 74 },
  play: { backgroundColor: C.play, borderRadius: 23, width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  speed: { minHeight: 44, paddingHorizontal: 2, justifyContent: "center" },
  resource: { flexDirection: "row", alignItems: "center", columnGap: 12, width: "100%", backgroundColor: C.soft, padding: 13, borderRadius: 12, marginBottom: 10 },
  resourceForm: { paddingVertical: 15, paddingHorizontal: 13 },
  notice: { flexDirection: "row", alignItems: "center", columnGap: 9, padding: 12, backgroundColor: C.soft, borderRadius: 6, marginBottom: 20 },
  saved: { flexDirection: "row", alignItems: "center", columnGap: 10, marginVertical: 22 },
  spinner: { width: 25, height: 25, borderRadius: 12.5, borderWidth: 2, borderColor: "#d8dce4", borderTopColor: "#707684", alignSelf: "center", marginBottom: 20 },
});
