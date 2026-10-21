import * as Crypto from "expo-crypto";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Platform, ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { IOS_INPUT_FIRST_LINE, IOS_INPUT_LINE_GAP } from "../ui/metrics";
import { formatShortDate, timeOf } from "../domain/dates";
import { deriveTitle, isSavable } from "../domain/rules";
import { useI18n } from "../i18n";
import { emitChange } from "../services/events";
import { useApp, useToday } from "../state/app";
import { editor, fromEntry, useEditor } from "../state/editor";
import { Btn, PrimaryButton, SecondaryButton, SectionTitle, TextNavHeader, Underlined } from "../ui/components";
import { AudioPlayer, EntryMeta, ResourceRow, TagLines } from "../ui/entry";
import { Icon } from "../ui/Icon";
import { Screen } from "../ui/Screen";
import { Sheet, SheetText } from "../ui/Sheet";
import { C, SERIF } from "../ui/theme";
import { Txt, glyphShift } from "../ui/Txt";
import { storeResource } from "./resources";

export default function Editor() {
  const params = useLocalSearchParams<{ mode: "new" | "edit"; id?: string; day?: string; prompt?: string; next?: string; sheet?: string; scroll?: string }>();
  const { t, lang } = useI18n();
  const { fontScale } = useWindowDimensions();
  const { journal, worker, toast, clock } = useApp();
  const today = useToday();
  const s = useEditor();
  const [sheet, setSheet] = useState<null | "leave">(params.sheet === "leave" ? "leave" : null);
  const [ready, setReady] = useState(false);
  const [bodyLines, setBodyLines] = useState(1);
  const [titleLines, setTitleLines] = useState(1);
  const [titleHeight, setTitleHeight] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(0);
  const saving = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- start the session
  useEffect(() => {
    if (!journal) return;
    (async () => {
      const existing = editor.get();
      const same = existing && ((params.mode === "edit" && existing.id === params.id) || (params.mode === "new" && existing.mode === "new"));
      if (!same) {
        if (params.mode === "edit" && params.id) {
          const e = await journal.entry(params.id);
          if (!e) return router.back();
          editor.start(fromEntry(e));
        } else {
          const draft = await journal.draft();
          const day = params.day && params.day !== "today" ? params.day : today;
          editor.start(
            draft
              ? { mode: "new", id: draft.id, day: draft.day, prompt: draft.prompt, kind: "text", localTime: timeOf(clock.now()), title: draft.title, titleAuto: false, body: draft.body, topics: [], emotions: [], resources: draft.resources, removeContext: false }
              : { mode: "new", id: Crypto.randomUUID(), day, prompt: params.prompt ?? null, kind: "text", localTime: timeOf(clock.now()), title: "", titleAuto: false, body: "", topics: [], emotions: [], resources: [], removeContext: false },
          );
          if (draft && params.prompt && !draft.prompt) editor.update({ prompt: params.prompt });
        }
      }
      setReady(true);
      if (params.next === "labels") router.push({ pathname: "/labels", params: params.sheet === "addTopic" ? { sheet: "addTopic" } : {} });
      if (params.next === "resources") router.push("/resources");
      if (params.scroll === "bottom") setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 1200);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal]);

  // ---- autosave of new drafts (local, never an entry until Save)
  const persistDraft = useCallback(() => {
    const c = editor.get();
    if (!journal || !c || c.mode !== "new") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const now = editor.get();
      if (!now || now.mode !== "new") return;
      if (!isSavable(now.title, now.body, now.resources.length)) return;
      journal.saveDraft({ id: now.id, day: now.day, prompt: now.prompt ?? null, title: now.title, body: now.body, resources: now.resources }).catch(() => undefined);
    }, 300);
  }, [journal]);

  const leave = useCallback(() => {
    const c = editor.get();
    if (!c) return router.back();
    if (c.mode === "new" && !isSavable(c.title, c.body, c.resources.length)) {
      journal?.discardDraft(c.id).catch(() => undefined);
      editor.end();
      return router.back();
    }
    if (c.mode === "edit" && !editor.dirty()) {
      editor.end();
      return router.back();
    }
    setSheet("leave");
  }, [journal]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        leave();
        return true;
      });
      return () => sub.remove();
    }, [leave]),
  );

  const save = async () => {
    const c = editor.get();
    if (!journal || !c || saving.current) return;
    if (!isSavable(c.title, c.body, c.resources.length)) return toast(t("writeSomething"));
    saving.current = true;
    try {
      // An automatic title follows the corrected text; a title the person wrote is kept.
      const keepAuto = c.mode === "edit" && c.titleAuto && c.title === c.original?.title;
      const title = deriveTitle(keepAuto ? "" : c.title, c.body, c.resources.length > 0, c.kind === "audio" ? t("voiceNote") : t("neutralTitle"));
      if (c.mode === "new") {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        const { id } = await journal.commitDraft({ id: c.id, day: c.day, prompt: c.prompt ?? null, title: c.title, body: c.body, resources: c.resources }, title);
        editor.end();
        emitChange();
        worker?.kick();
        router.replace({ pathname: "/entry/[id]", params: { id } });
      } else {
        await journal.updateEntry(c.id, { title: title.title, titleAuto: title.auto, body: c.body, topics: c.topics, emotions: c.emotions, resources: c.resources, removeContext: c.removeContext });
        editor.end();
        emitChange();
        worker?.kick();
        router.back();
      }
      toast(t("entrySaved"));
    } catch {
      toast(t("storageError"));
    } finally {
      saving.current = false;
    }
  };

  if (!s || !ready) return <Screen>{null}</Screen>;
  const isNew = s.mode === "new";
  const update = (patch: Partial<typeof s>) => {
    editor.update(patch);
    persistDraft();
  };
  // Textareas grow to their content like the mock (`height = scrollHeight` → floor(lines × line-height)).
  const scale = Math.min(fontScale, 2); // maxFontSizeMultiplier
  const titleShift = glyphShift(34, 34 * 1.12) + (Platform.OS === "ios" ? IOS_INPUT_FIRST_LINE.title : 0);
  const bodyShift = glyphShift(18, 18 * 1.38) + (Platform.OS === "ios" ? IOS_INPUT_FIRST_LINE.body : 0);

  return (
    <Screen keyboard ref={scrollRef}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <TextNavHeader
        left={isNew ? t("close") : t("cancel")}
        leftA11y={isNew ? t("closeDraft") : t("cancelEdit")}
        onLeft={leave}
        title={formatShortDate(s.day, lang)}
        right={t("save")}
        rightA11y={t("saveEntry")}
        onRight={save}
      />
      {s.prompt ? (
        <Txt size={18} lh={1.4} color="#737b8b" style={{ marginBottom: 20 }} accessibilityHint="Pregunta guía, no forma parte de tu texto">
          {s.prompt}
        </Txt>
      ) : null}
      <LineCounter text={s.title || " "} size={34} lh={1.12} ls={-0.7} onLines={setTitleLines} onHeight={setTitleHeight} />
      <TextInput
        testID="title-input"
        value={s.title}
        onChangeText={(v) => update({ title: v.replace(/\n/g, " ") })}
        placeholder={t("titlePlaceholder")}
        placeholderTextColor={C.placeholder}
        accessibilityLabel={t("titleA11y")}
        multiline
        scrollEnabled={false}
        
        submitBehavior="blurAndSubmit"
        maxFontSizeMultiplier={2}
        selectionColor={C.ink}
        style={{ width: "100%", fontFamily: SERIF, fontSize: 34, lineHeight: scale > 1 ? undefined : Platform.OS === "ios" ? 34 * 1.12 - IOS_INPUT_LINE_GAP * 34 : 34 * 1.12, letterSpacing: scale > 1 ? 0 : -0.7, color: "#000000", padding: 0, paddingTop: 0, marginBottom: 10, ...(scale > 1 ? { height: Math.ceil(titleHeight * 1.08) + 6 } : { height: Math.floor(titleLines * 34 * 1.12) }), transform: [{ translateY: scale > 1 ? 0 : titleShift }], textAlignVertical: "top" }}
      />
      <EntryMeta entry={{ localTime: s.localTime, kind: s.kind, city: s.removeContext ? null : s.city, temperatureC: s.removeContext ? null : s.temperatureC, weatherCondition: s.removeContext ? null : s.weatherCondition }} t={t} />
      {!isNew ? (
        <TagLines topics={s.topics} emotions={s.emotions} editable t={t} onEdit={() => router.push("/labels")} />
      ) : null}
      {s.kind === "audio" ? (
        <>
          <AudioPlayer uri={s.audioUri} durationMs={s.audioDurationMs} peaks={s.waveform} t={t} />
          <Txt size={14} color="#80899b" style={{ marginTop: 5 }}>
            {t("audioOriginal")}
          </Txt>
          <SectionTitle size={21} mt={22} mb={12}>{t("transcription")}</SectionTitle>
        </>
      ) : (
        <View style={{ height: 25 }} />
      )}
      <LineCounter text={s.body || " "} size={18} lh={1.38} onLines={setBodyLines} onHeight={setBodyHeight} />
      <TextInput
        testID="body-input"
        value={s.body}
        onChangeText={(v) => update({ body: v })}
        placeholder={t("bodyPlaceholder")}
        placeholderTextColor={C.placeholder}
        accessibilityLabel={s.kind === "audio" ? t("transcription") : t("bodyA11y")}
        multiline
        scrollEnabled={false}
        maxFontSizeMultiplier={2}
        selectionColor={C.ink}
        style={{ width: "100%", fontFamily: SERIF, fontSize: 18, lineHeight: Platform.OS === "ios" ? 18 * 1.38 - IOS_INPUT_LINE_GAP * 18 : 18 * 1.38, color: "#111111", padding: 0, paddingTop: 0, minHeight: 215, ...(scale > 1 ? { height: Math.max(215, Math.ceil(bodyHeight * 1.08) + 6) } : { height: Math.max(215, Math.floor(bodyLines * 18 * 1.38)) }), textAlignVertical: "top", transform: [{ translateY: bodyShift }] }}
      />
      {s.resources.length ? (
        <View style={{ marginTop: 22 }}>
          <SectionTitle size={21} mt={0} mb={12}>{t("resources")}</SectionTitle>
          {s.resources.map((r) => (
            <View key={r.id}>
              <ResourceRow r={r} t={t} onPress={() => undefined} />
              <View style={{ paddingTop: 3, marginBottom: 16, flexDirection: "row", columnGap: 12 }}>
                {r.status === "error" ? (
                  <Btn
                    label={`${t("retry")} ${r.title}`}
                    style={{ paddingVertical: 1, paddingHorizontal: 6, alignSelf: "flex-start" }}
                    onPress={async () => {
                      const src = r as typeof r & { ext?: string; mime?: string };
                      if (!journal || !src.url) return;
                      const fixed = await storeResource(journal, r.kind === "video" ? "video" : "image", { uri: src.url, ext: src.ext ?? ".jpg", mime: src.mime ?? "image/jpeg" }, r.title, r.id);
                      update({ resources: editor.get()!.resources.map((x) => (x.id === r.id ? fixed : x)) });
                    }}
                  >
                    <Underlined size={16} color="#787f8f" align="left" offset="auto">{t("retry")}</Underlined>
                  </Btn>
                ) : null}
                <Btn label={`${t("removeResource")} ${r.title}`} onPress={() => update({ resources: editor.get()!.resources.filter((x) => x.id !== r.id) })} style={{ paddingVertical: 1, paddingHorizontal: 6, alignSelf: "flex-start" }}>
                  <Underlined size={16} color="#787f8f" align="left" offset="auto">{t("removeResource")}</Underlined>
                </Btn>
              </View>
            </View>
          ))}
          <ResourceAdd t={t} />
        </View>
      ) : (
        <ResourceAdd t={t} />
      )}
      {!isNew && s.city && !s.removeContext ? (
        <View style={{ paddingTop: 8, paddingBottom: 0.11 }}>
          <Btn label={t("removeContextA11y")} onPress={() => update({ removeContext: true })} style={{ paddingVertical: 1, paddingHorizontal: 6, alignSelf: "flex-start" }}>
            <Underlined size={14} color="#7b8494" align="left" offset="auto">{t("removeContext")}</Underlined>
          </Btn>
        </View>
      ) : null}
      <Txt size={14} color="#8a90a0" align="center" style={{ marginTop: 34 }} accessibilityLiveRegion="polite">
        {isNew ? t("draftSaved") : t("changesOnSave")}
      </Txt>

      <Sheet visible={sheet === "leave"} title={isNew ? t("leaveDraftTitle") : t("leaveEditTitle")} onClose={() => setSheet(null)} closeLabel={t("close")}>
        <SheetText>{isNew ? t("leaveDraftText") : t("leaveEditText")}</SheetText>
        <PrimaryButton
          label={isNew ? t("keepDraft") : t("saveChanges")}
          marginTop={7}
          onPress={async () => {
            setSheet(null);
            if (isNew) {
              const c = editor.get()!;
              await journal!.saveDraft({ id: c.id, day: c.day, prompt: c.prompt ?? null, title: c.title, body: c.body, resources: c.resources });
              editor.end();
              router.back();
            } else save();
          }}
        />
        <SecondaryButton
          label={isNew ? t("discardDraft") : t("discardChanges")}
          onPress={async () => {
            setSheet(null);
            const c = editor.get();
            if (c?.mode === "new") await journal!.discardDraft(c.id);
            else if (c) await journal!.collect(c.resources.filter((r) => r.fileId && !c.original?.resources.includes(r.fileId)).map((r) => r.fileId));
            editor.end();
            router.back();
          }}
        />
        <SecondaryButton label={t("keepEditing")} onPress={() => setSheet(null)} />
      </Sheet>
    </Screen>
  );
}

/**
 * Counts the lines a text wraps to with the editor's typography, so the input box can be sized like
 * the mock's textarea (`height = scrollHeight`). Invisible, zero-height, not focusable.
 */
function LineCounter({ text, size, lh, ls, onLines, onHeight }: { text: string; size: number; lh: number; ls?: number; onLines: (n: number) => void; onHeight?: (h: number) => void }) {
  return (
    <View style={{ height: 0, overflow: "hidden" }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden pointerEvents="none">
      <Txt
        size={size}
        lh={lh}
        ls={ls}
        onTextLayout={(e) => {
          const ls_ = e.nativeEvent.lines;
          onLines(Math.max(1, ls_.length + (text.endsWith("\n") ? 1 : 0)));
          onHeight?.(ls_.reduce((a, l) => a + l.height, 0));
        }}
      >
        {text}
      </Txt>
    </View>
  );
}

function ResourceAdd({ t }: { t: (k: any) => string }) {
  return (
    <Btn label={t("addResources")} onPress={() => router.push("/resources")} style={{ flexDirection: "row", columnGap: 11, alignItems: "center", minHeight: 48, alignSelf: "flex-start", paddingVertical: 1, paddingHorizontal: 6, marginLeft: 0 }}>
      <Icon name="clip" />
      <Txt size={18}>{t("addResources")}</Txt>
    </Btn>
  );
}
