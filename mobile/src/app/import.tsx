import * as Crypto from "expo-crypto";
import { Asset } from "expo-asset";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../i18n";
import { emitChange } from "../services/events";
import { MAX_AUDIO_MB, pickAudio, type Picked } from "../services/media";
import { useApp, useToday } from "../state/app";
import { ErrorText, NavHeader, PrimaryButton, SecondaryButton } from "../ui/components";
import { AudioPlayer } from "../ui/entry";
import { Screen } from "../ui/Screen";
import { C } from "../ui/theme";
import { Txt } from "../ui/Txt";
import { formatDuration } from "../domain/dates";

/** Native file picker → listen → explicit "Guardar audio". Cancelling creates nothing. */
export default function ImportAudio() {
  const params = useLocalSearchParams<{ day?: string; fixture?: string }>();
  const { t } = useI18n();
  const { journal, worker, toast } = useApp();
  const today = useToday();
  const day = params.day && params.day !== "today" ? params.day : today;
  const [file, setFile] = useState<Picked | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState("");
  // The original must be playable before it is saved (a renamed non-audio file is rejected here).
  const [playable, setPlayable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!file) return;
    setPlayable(null);
    const timer = setTimeout(() => setPlayable((p) => (p === true ? p : false)), 6000);
    return () => clearTimeout(timer);
  }, [file]);
  useEffect(() => {
    if (playable === false) setError(t("unsupportedFormat"));
  }, [playable, t]);
  const saving = useRef(false);
  const id = useRef(Crypto.randomUUID()).current;

  const choose = async () => {
    setError("");
    let r: Awaited<ReturnType<typeof pickAudio>>;
    try {
      r = await pickAudio();
    } catch {
      setError(t("storageError"));
      return;
    }
    if (!r.ok) {
      if (r.reason === "format") setError(t("unsupportedFormat"));
      else if (r.reason === "size") setError(t("tooLarge", { max: MAX_AUDIO_MB }));
      else if (!file) router.back(); // cancelled before choosing anything: nothing is created
      return;
    }
    setFile(r.file);
  };
  useEffect(() => {
    if (__DEV__ && params.fixture) {
      const a = Asset.fromModule(require("../../assets/fixtures/walk.m4a"));
      a.downloadAsync().then(() => { setFile({ uri: a.localUri!, mime: "audio/mp4", ext: ".m4a", name: "Una nota de voz.m4a" }); setDuration(154000); });
    } else {
      // Let the "+" sheet finish dismissing: iOS can't present the picker on top of a closing modal.
      const t = setTimeout(choose, 500);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!journal || !file || saving.current) return;
    saving.current = true;
    try {
      const f = await journal.importFile(file.uri, "audio", file.ext, file.mime);
      await journal.createImportedAudio({ id, fileId: f.id, day, durationMs: duration, title: t("voiceNote") });
      emitChange();
      worker?.kick();
      router.replace({ pathname: "/entry/[id]", params: { id } });
      toast(t("audioSaved"));
    } catch {
      setError(t("storageError"));
    } finally {
      saving.current = false;
    }
  };

  return (
    <Screen>
      <NavHeader backA11y={t("back")} onBack={() => router.back()} />
      <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: 26 }} accessibilityRole="header">{t("importAudio")}</Txt>
      <Txt size={18} lh={1.4} color="#737b8b">{t("importIntro")}</Txt>
      {file ? (
        <>
          <View style={{ backgroundColor: C.soft, padding: 20, borderRadius: 12, marginVertical: 30 }}>
            <Txt>{file.name ?? "audio" + file.ext}</Txt>
            <Txt size={15} lh={1.4} color="#8a90a1">{`${duration ? formatDuration(duration) + " · " : ""}${t("audio")}`}</Txt>
          </View>
          <AudioPlayer
            uri={file.uri}
            durationMs={duration}
            t={t}
            onDuration={(ms) => {
              setDuration((d) => d ?? ms);
              if (ms > 0) {
                setPlayable(true);
                setError("");
              }
            }}
          />
        </>
      ) : (
        <View style={{ height: 30 }} />
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {file && playable !== false ? (
        <PrimaryButton label={t("saveAudio")} a11y={t("saveImported")} onPress={save} disabled={playable !== true} />
      ) : (
        <PrimaryButton label={t("chooseFile")} onPress={choose} />
      )}
      <SecondaryButton label={t("cancel")} a11y={t("cancelImport")} onPress={() => router.back()} />
    </Screen>
  );
}
