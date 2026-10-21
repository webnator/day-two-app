import * as Crypto from "expo-crypto";
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { File } from "expo-file-system";
import * as Notifications from "expo-notifications";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Linking, Platform, View } from "react-native";
import type { ContextSnapshot } from "../data/journal";
import { formatDuration, formatShortDate, timeOf } from "../domain/dates";
import { useI18n } from "../i18n";
import { captureContext } from "../services/context";
import { emitChange } from "../services/events";
import { peaksFrom, RECORDING, RECORDING_MIME } from "../services/recorder";
import { useApp, useToday } from "../state/app";
import { Btn, NavHeader, PrimaryButton, SecondaryButton } from "../ui/components";
import { Wave } from "../ui/entry";
import { Icon, weatherIcon } from "../ui/Icon";
import { Screen } from "../ui/Screen";
import { ConfirmSheet, Sheet, SheetText } from "../ui/Sheet";
import { C } from "../ui/theme";
import { Txt } from "../ui/Txt";

type Phase = "starting" | "recording" | "paused" | "saving" | "denied" | "error";

export default function Record() {
  const params = useLocalSearchParams<{ day?: string; still?: string; paused?: string; sheet?: string }>();
  const still = __DEV__ && params.still === "1"; // dev-only visual fixture: frozen screen, no microphone
  const { t, lang } = useI18n();
  const { journal, worker, toast, clock } = useApp();
  const today = useToday();
  const day = params.day && params.day !== "today" ? params.day : today;
  const recorder = useAudioRecorder(RECORDING);
  const state = useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<Phase>(still ? (params.paused ? "paused" : "recording") : "starting");
  const [sheet, setSheet] = useState<null | "leave" | "discard">(params.sheet === "leave" ? "leave" : null);
  const [ctx, setCtx] = useState<ContextSnapshot | null>(still ? { status: "resolved", city: "Madrid", temperatureC: 18, condition: "cloudy" } : null);
  const [persisted, setPersisted] = useState(still);
  const idRef = useRef(Crypto.randomUUID());
  const levels = useRef<number[]>([]);
  const [live, setLive] = useState<number[] | undefined>(undefined);
  const finished = useRef(false);

  // ---- start: permission, session, register the file, then record
  useEffect(() => {
    if (still || !journal) return;
    let cancelled = false;
    (async () => {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) return setPhase("denied");
      try {
        // Android records in the background through a foreground service, which needs the notification
        // permission. Without it, record in the foreground only (the stream on disk survives interruptions).
        const background = Platform.OS === "ios" || (await Notifications.getPermissionsAsync()).granted;
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: background, interruptionMode: "doNotMix" });
        await recorder.prepareToRecordAsync();
        const startedAt = clock.now();
        const uri = recorder.uri;
        if (!uri) throw new Error("no_uri");
        await journal.beginRecording({ id: idRef.current, tempUri: uri, mime: RECORDING_MIME, day, startedAt, timeZone: clock.timeZone(), localTime: timeOf(startedAt) });
        if (cancelled) return;
        recorder.record();
        activateKeepAwakeAsync("recording").catch(() => undefined);
        setPhase("recording");
        // Context for the START of the recording, in parallel; never blocks capture.
        const locationEnabled = await journal.get("locationEnabled", true);
        captureContext(startedAt, locationEnabled, lang).then(async (c) => {
          setCtx(c);
          await journal.setRecordingContext(idRef.current, c).catch(() => undefined);
        });
      } catch (e) {
        if (__DEV__) console.log("RECORD start failed", String(e), recorder.uri);
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      deactivateKeepAwake("recording");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal]);

  // ---- live levels and confirmation that audio is reaching storage
  useEffect(() => {
    if (still || phase !== "recording") return;
    if (state.metering != null) {
      levels.current.push(state.metering);
      const last = levels.current.slice(-39).map((db) => 7 + Math.max(0, Math.min(1, (db + 55) / 50)) * 30);
      setLive(last.length < 39 ? [...Array(39 - last.length).fill(7), ...last] : last);
    }
    if (!persisted && recorder.uri) {
      const f = new File(recorder.uri);
      if (f.exists && (f.size ?? 0) > 64) setPersisted(true);
    }
    // The OS stopped the recorder (call, Siri, media reset): show it as paused, file kept.
    if (!state.isRecording && phase === "recording" && state.durationMillis > 0) setPhase("paused");
  }, [state, phase, still, persisted, recorder]);

  const finish = async () => {
    if (still || !journal || finished.current) return;
    finished.current = true;
    setPhase("saving");
    try {
      if (recorder.isRecording || phase === "paused") await recorder.stop();
      const ext = Platform.OS === "ios" ? ".wav" : ".aac";
      await journal.attachRecordingFile(idRef.current, ext, peaksFrom(levels.current));
      await journal.finishRecording(idRef.current, state.durationMillis, t("voiceNote"));
      deactivateKeepAwake("recording");
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      emitChange();
      worker?.kick();
      router.replace({ pathname: "/entry/[id]", params: { id: idRef.current } });
      toast(t("audioSaved"));
    } catch {
      // The recording row stays registered: it will be recovered at next launch. Never claim success.
      finished.current = false;
      setPhase("error");
    }
  };

  const discard = async () => {
    finished.current = true;
    try {
      if (recorder.isRecording) await recorder.stop();
    } catch {}
    await journal?.discardRecording(idRef.current, (uri) => {
      const f = new File(uri);
      if (f.exists) f.delete();
    });
    deactivateKeepAwake("recording");
    router.back();
  };

  const togglePause = () => {
    if (still) return setPhase(phase === "paused" ? "recording" : "paused");
    if (phase === "recording") {
      recorder.pause();
      setPhase("paused");
    } else if (phase === "paused") {
      recorder.record();
      setPhase("recording");
    }
  };

  const onBack = useCallback(() => {
    if (phase === "denied" || phase === "starting") return router.back();
    setSheet("leave");
  }, [phase]);
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        onBack();
        return true;
      });
      return () => sub.remove();
    }, [onBack]),
  );

  const elapsed = still ? 0 : state.durationMillis;
  const paused = phase === "paused";
  return (
    <Screen>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <NavHeader title={formatShortDate(day, lang)} backA11y={t("back")} onBack={onBack} />
      {phase === "denied" ? (
        <>
          <Txt size={42} align="center" style={{ marginTop: 19 }}>{t("micDeniedTitle")}</Txt>
          <Txt size={18} lh={1.4} color="#737b8b" align="center" style={{ marginTop: 10 }}>{t("micDeniedText")}</Txt>
          <PrimaryButton label={t("openSettings")} onPress={() => Linking.openSettings()} />
          <SecondaryButton label={t("write")} onPress={() => router.replace({ pathname: "/editor", params: { mode: "new", day } })} />
        </>
      ) : (
        <>
          <Txt size={42} align="center" style={{ marginTop: 19 }} accessibilityRole="header">
            {t("listening")}
          </Txt>
          <Txt size={18} lh={1.4} color="#737b8b" align="center" style={{ marginTop: 10 }}>
            {phase === "starting" ? t("recordingPreparing") : t("takeYourTime")}
          </Txt>
          <View style={{ backgroundColor: C.soft, borderRadius: 15, paddingTop: 44, paddingHorizontal: 22, paddingBottom: 26, marginTop: 48, marginBottom: 36 }}>
            <Wave height={55} live={still ? undefined : live} />
            <Txt size={23} color="#7d8596" align="center" style={{ marginTop: 24 }} accessibilityLabel={formatDuration(elapsed)} accessibilityLiveRegion="none">
              {formatDuration(elapsed)}
            </Txt>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "center", columnGap: 50 }}>
            <RecordControl label={paused ? t("resume") : t("pause")} icon={paused ? "play" : "pause"} onPress={togglePause} disabled={phase === "starting" || phase === "saving"} />
            <RecordControl label={t("finish")} a11y={t("finishRecording")} icon="stop" strong onPress={finish} disabled={phase === "starting" || phase === "saving"} />
          </View>
          {ctx && (ctx.city || ctx.temperatureC != null) ? (
            <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", columnGap: 5, marginTop: 48 }}>
              {ctx.condition ? <Icon name={weatherIcon(ctx.condition)} w={22} color="#808696" /> : null}
              <Txt size={17} color="#808696">{[ctx.city, ctx.temperatureC != null ? `${Math.round(ctx.temperatureC)}°` : null].filter(Boolean).join(" · ")}</Txt>
            </View>
          ) : (
            <View style={{ height: 70.94 }} />
          )}
          <View style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 23, marginTop: 34 }}>
            <Txt size={14} color={phase === "error" ? C.error : "#8a90a0"} align="center" accessibilityLiveRegion="polite">
              {phase === "error" ? t("storageError") : persisted ? t("recordingOnDevice") : " "}
            </Txt>
          </View>
        </>
      )}

      <Sheet visible={sheet === "leave"} title={t("noteStillHere")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <PrimaryButton label={t("finishAndKeep")} marginTop={6} onPress={() => { setSheet(null); finish(); }} />
        <SecondaryButton label={t("keepRecording")} onPress={() => setSheet(null)} />
        <SecondaryButton label={t("discardRecording")} onPress={() => setSheet("discard")} />
      </Sheet>
      <ConfirmSheet visible={sheet === "discard"} title={t("discardRecordingConfirm")} text={t("discardRecordingText")} action={t("discardRecording")} cancelLabel={t("cancel")} onClose={() => setSheet("leave")} onConfirm={discard} />
    </Screen>
  );
}

function RecordControl({ label, a11y, icon, strong, onPress, disabled }: { label: string; a11y?: string; icon: "play" | "pause" | "stop"; strong?: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Btn label={a11y ?? label} onPress={onPress} disabled={disabled} style={{ alignItems: "center", rowGap: 8, paddingVertical: 1, paddingHorizontal: 6 }}>
      <View style={{ width: 68, height: 68, borderRadius: 34, borderWidth: 1, borderColor: "#111111", alignItems: "center", justifyContent: "center", backgroundColor: strong ? "#10120f" : "transparent" }}>
        <Icon name={icon} color={strong ? "#ffffff" : C.ink} />
      </View>
      <Txt size={19}>{label}</Txt>
    </Btn>
  );
}
