import * as Crypto from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { formatShortDate } from "../../domain/dates";
import type { Resource } from "../../domain/model";
import { useI18n } from "../../i18n";
import { emitChange } from "../../services/events";
import { useApp, useQuery, useToday } from "../../state/app";
import { BodyMuted, ListRow, NavHeader, NavIconButton, NavTextButton, QuietAction, SectionTitle } from "../../ui/components";
import { AudioPlayer, EntryMeta, Notice, ResourceRow, SavedState, Spinner, TagLines, TranscriptReview } from "../../ui/entry";
import { Screen } from "../../ui/Screen";
import { ConfirmSheet, Sheet } from "../../ui/Sheet";
import { Txt } from "../../ui/Txt";

export default function EntryDetail() {
  const { id, sheet: initialSheet, scroll } = useLocalSearchParams<{ id: string; sheet?: string; scroll?: string }>();
  const { t, lang } = useI18n();
  const { journal, worker, toast } = useApp();
  const today = useToday();
  const [sheet, setSheet] = useState<null | "menu" | "delete" | "resource" | "replace">((initialSheet as any) ?? null);
  const [resource, setResource] = useState<Resource | null>(null);
  const [seekRequest, setSeekRequest] = useState<{ at: number; id: number }>();
  const seekTo = (at: number) => setSeekRequest((prev) => ({ at, id: (prev?.id ?? 0) + 1 }));
  const scrollRef = useRef<ScrollView>(null);
  const e = useQuery((j) => j.entry(id), [id]);
  const transcriptionJob = useQuery((j) => j.db.first<{ status: string }>("SELECT status FROM jobs WHERE entry_id = ? AND kind = 'transcribe' ORDER BY created_at DESC LIMIT 1", [id]), [id]);
  useEffect(() => {
    if (scroll === "bottom" && e) setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 300);
  }, [scroll, e]);
  if (e === undefined) return <Screen>{null}</Screen>;
  if (e === null) {
    // Deleted (or never existed): never show stale content.
    return (
      <Screen>
        <NavHeader backA11y={t("back")} onBack={() => router.back()} />
      </Screen>
    );
  }
  const status = e.kind === "audio" ? e.transcriptStatus : "ready";
  const ready = status === "ready";
  const transcribing = !!transcriptionJob && ["queued", "running", "remote"].includes(transcriptionJob.status);
  const topics = e.tags.filter((x) => x.kind === "topic").map((x) => x.name);
  const emotions = e.tags.filter((x) => x.kind === "emotion").map((x) => x.name);
  const isToday = e.day === today;
  const openResource = (r: Resource) => {
    if (r.kind === "link" && r.url) WebBrowser.openBrowserAsync(r.url).catch(() => undefined);
    else {
      setResource(r);
      setSheet("resource");
    }
  };

  return (
    <Screen ref={scrollRef}>
      <NavHeader
        backLabel={isToday ? t("today") : formatShortDate(e.day, lang)}
        backA11y={t("back")}
        onBack={() => router.back()}
        title={formatShortDate(e.day, lang)}
        marginBottom={18}
        right={
          <>
            <NavTextButton label={t("edit")} a11y={t("editEntry")} onPress={() => router.push({ pathname: "/editor", params: { mode: "edit", id: e.id } })} />
            <NavIconButton icon="more" label={t("moreOptions")} onPress={() => setSheet("menu")} />
          </>
        }
      />
      {status === "offline" ? <Notice>{t("offline")}</Notice> : null}
      <Txt size={34} lh={1.12} ls={-0.9} style={{ marginBottom: 12 }} accessibilityRole="header">
        {e.title}
      </Txt>
      <EntryMeta entry={e} t={t} />
      {ready ? <TagLines topics={topics} emotions={emotions} t={t} /> : <View style={{ height: 22 }} />}
      {e.kind === "audio" ? <AudioPlayer uri={e.audioUri} durationMs={e.audioDurationMs} peaks={e.waveform} t={t} seekRequest={seekRequest} /> : null}
      {!ready ? <SavedState>{status === "offline" ? t("savedOnDevice") : t("audioSaved")}</SavedState> : null}
      {e.kind === "audio" ? <SectionTitle size={21} mt={ready ? 22 : 0} mb={12}>{t("transcription")}</SectionTitle> : null}
      {ready ? (
        <>
          {e.kind === "audio" && transcribing ? <BodyMuted style={{ marginBottom: 12 }}>{t("preparing")}</BodyMuted> : null}
          {e.kind === "audio" && transcriptionJob?.status === "failed" ? <BodyMuted style={{ marginBottom: 12 }}>{t("couldNotTranscribe")} {t("audioIsSaved")}</BodyMuted> : null}
          <TranscriptReview spans={e.transcriptUncertain} label={t("transcriptReview")} onSeek={seekTo} />
          <Txt size={18} lh={1.38} selectable style={e.kind === "text" ? { marginTop: 25 } : undefined}>
            {e.body}
          </Txt>
          {e.transcriptAlternative ? (
            <View style={{ marginTop: 22 }}>
              <Notice>{t("alternativeTitle")}</Notice>
              <BodyMuted>{t("alternativeText")}</BodyMuted>
              <TranscriptReview spans={e.transcriptAlternativeUncertain} label={t("transcriptReview")} onSeek={seekTo} />
              <Txt size={18} lh={1.38} color="#646c7d" style={{ marginTop: 12 }}>
                {e.transcriptAlternative}
              </Txt>
              <QuietAction label={t("useAlternative")} onPress={async () => { await journal!.acceptAlternative(e.id); emitChange(); }} />
              <QuietAction label={t("discardAlternative")} onPress={async () => { await journal!.dismissAlternative(e.id); emitChange(); }} />
            </View>
          ) : null}
          {e.resources.length ? (
            <View style={{ marginTop: 22 }}>
              <SectionTitle size={21} mt={0} mb={12}>{t("resources")}</SectionTitle>
              {e.resources.map((r) => (
                <ResourceRow key={r.id} r={r} t={t} onPress={() => openResource(r)} />
              ))}
            </View>
          ) : null}
        </>
      ) : status === "processing" || status === "pending" ? (
        <View style={{ paddingVertical: 24, alignItems: "center" }} accessibilityLiveRegion="polite">
          <Spinner />
          <Txt align="center">{t("preparing")}</Txt>
          <Txt size={17} color="#707a8d" align="center" style={{ marginVertical: 13 }}>
            {t("canLeave")}
          </Txt>
        </View>
      ) : (
        <>
          <Txt size={18} lh={1.38}>{status === "error" ? t("couldNotTranscribe") : t("transcriptPendingLong")}</Txt>
          <BodyMuted style={{ marginTop: 10 }}>{status === "error" ? t("audioIsSaved") : t("resumeWhenOnline")}</BodyMuted>
          <QuietAction
            label={status === "error" ? t("retry") : t("retryNow")}
            onPress={() => {
              if (status === "error") worker?.retryTranscription(e.id, Crypto.randomUUID());
              else worker?.retryNow(e.id);
            }}
          />
        </>
      )}

      <Sheet visible={sheet === "menu"} title={t("thisEntry")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <ListRow variant="sheet" icon="pen" title={t("edit")} onPress={() => { setSheet(null); router.push({ pathname: "/editor", params: { mode: "edit", id: e.id } }); }} />
        {e.kind === "audio" && e.audioUri && !transcribing ? <ListRow variant="sheet" icon="mic" title={t("retranscribe")} onPress={() => {
          setSheet(null);
          void worker?.retryTranscription(e.id, Crypto.randomUUID());
        }} /> : null}
        <ListRow variant="sheet" icon="trash" title={t("deleteEntry")} onPress={() => setSheet("delete")} />
      </Sheet>
      <ConfirmSheet
        visible={sheet === "delete"}
        title={t("deleteEntryQ")}
        text={t("deleteEntryText")}
        action={t("deleteEntry")}
        cancelLabel={t("cancel")}
        onClose={() => setSheet(null)}
        onConfirm={async () => {
          setSheet(null);
          await journal!.deleteEntry(e.id);
          emitChange();
          worker?.kick(); // propagates remote cancellation of pending processing
          router.back();
        }}
      />
      <Sheet visible={sheet === "resource" && !!resource} title={resource?.title ?? ""} onClose={() => setSheet(null)} closeLabel={t("close")}>
        {resource?.kind === "image" && resource.fileUri ? (
          <Image source={{ uri: resource.fileUri }} style={{ width: "100%", aspectRatio: 1.5 }} contentFit="contain" accessibilityLabel={resource.title} />
        ) : null}
        {resource?.kind === "video" && resource.fileUri ? <VideoResource uri={resource.fileUri} /> : null}
        {resource?.kind === "image" && resource.fileId ? (
          <QuietAction
            label={t("useAsDayPhoto")}
            onPress={async () => {
              const existing = await journal!.photo(e.day);
              if (existing) return setSheet("replace");
              await journal!.useResourceAsDayPhoto(resource.id, e.day);
              emitChange();
              setSheet(null);
              toast(t("photoSaved"));
            }}
          />
        ) : null}
      </Sheet>
      <ConfirmSheet
        visible={sheet === "replace"}
        title={t("replacePhotoQ")}
        text={t("replacePhotoText")}
        action={t("useAsDayPhoto")}
        cancelLabel={t("cancel")}
        onClose={() => setSheet(null)}
        onConfirm={async () => {
          if (!resource) return;
          await journal!.useResourceAsDayPhoto(resource.id, e.day);
          emitChange();
          setSheet(null);
          toast(t("photoSaved"));
        }}
      />
    </Screen>
  );
}

function VideoResource({ uri }: { uri: string }) {
  // Loaded on demand: only video resources need the player.
  const { VideoView, useVideoPlayer } = require("expo-video") as typeof import("expo-video");
  const player = useVideoPlayer(uri);
  return <VideoView player={player} style={{ width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000" }} nativeControls contentFit="contain" />;
}
