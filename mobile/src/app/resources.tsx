import * as Crypto from "expo-crypto";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { DraftResource } from "../domain/model";
import { validateLink } from "../domain/rules";
import { formatShortDate } from "../domain/dates";
import { useI18n } from "../i18n";
import { pickImage, type Picked } from "../services/media";
import { useApp } from "../state/app";
import { editor, useEditor } from "../state/editor";
import { FormLabel, NavHeader, PrimaryButton, Tabs, ErrorText } from "../ui/components";
import { ResourceRow } from "../ui/entry";
import { LineInput } from "../ui/inputs";
import { Screen } from "../ui/Screen";
import { Txt } from "../ui/Txt";

/** Imports a picked file into account storage; on failure the resource is kept in error state to retry or remove. */
export async function storeResource(journal: NonNullable<ReturnType<typeof useApp>["journal"]>, kind: "image" | "video", p: { uri: string; ext: string; mime: string }, title: string, id = Crypto.randomUUID()): Promise<DraftResource> {
  try {
    const f = await journal.importFile(p.uri, "resources", p.ext, p.mime);
    return { id, kind, title, fileId: f.id, fileUri: journal.files.uri(f.relPath), status: "ready" };
  } catch {
    return { id, kind, title, url: p.uri, fileId: null, fileUri: null, status: "error", ...{ ext: p.ext, mime: p.mime } } as DraftResource;
  }
}

export default function Resources() {
  const { t, lang } = useI18n();
  const { journal, toast } = useApp();
  const s = useEditor();
  const [tab, setTab] = useState<"link" | "image" | "video">("link");
  const { fixture } = useApp();
  // The mock pre-fills its demo link; real use starts empty.
  const [url, setUrl] = useState(fixture ? "https://ejemplo.com/podcast" : "");
  const [title, setTitle] = useState(fixture ? "El valor de estar presente" : "");
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  if (!s || !journal) return <Screen>{null}</Screen>;

  const commit = async (r: DraftResource) => {
    const resources = [...editor.get()!.resources, r];
    editor.update({ resources });
    const c = editor.get()!;
    if (c.mode === "new") await journal.saveDraft({ id: c.id, day: c.day, prompt: c.prompt ?? null, title: c.title, body: c.body, resources });
    if (r.status === "error") toast(t("resourceFailed"));
    router.back();
  };

  return (
    <Screen keyboard>
      <NavHeader title={s.title || formatShortDate(s.day, lang)} backA11y={t("back")} onBack={() => router.back()} />
      <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: 26 }} accessibilityRole="header">
        {t("addResourcesTitle")}
      </Txt>
      <Tabs
        items={[{ key: "link", label: t("link") }, { key: "image", label: t("image") }, { key: "video", label: t("video") }]}
        active={tab}
        onChange={(k) => { setTab(k as any); setPicked(null); setError(""); }}
      />
      {tab === "link" ? (
        <>
          <View style={{ marginBottom: 24 }}>
            <FormLabel>{t("link")}</FormLabel>
            <LineInput value={url} onChangeText={(v) => { setUrl(v); setError(""); }} placeholder="https://" keyboardType="url" autoCapitalize="none" autoCorrect={false} accessibilityLabel={t("link")} />
          </View>
          <View style={{ marginBottom: 24 }}>
            <FormLabel>{t("title")}</FormLabel>
            <LineInput value={title} onChangeText={setTitle} accessibilityLabel={t("title")} />
          </View>
          {error ? <ErrorText>{error}</ErrorText> : null}
          <ResourceRow compact={false} r={{ kind: "link", title: title.trim() || url.trim() || t("link"), url: validateLink(url), status: "ready" }} t={t} />
          <PrimaryButton
            label={t("add")}
            marginTop={20}
            onPress={() => {
              const href = validateLink(url);
              if (!href) return setError(t("linkError"));
              // The URL is stored as data; it's opened by the system browser, never rendered as HTML.
              commit({ id: Crypto.randomUUID(), kind: "link", title: title.trim() || href, url: href, status: "ready" });
            }}
          />
        </>
      ) : (
        <>
          <Txt size={18} lh={1.4} color="#737b8b">
            {tab === "image" ? t("chooseImage") : t("chooseVideo")}
          </Txt>
          {picked && tab === "image" ? (
            <Image source={{ uri: picked.uri }} style={{ width: "100%", aspectRatio: 1.5, marginTop: 25 }} contentFit="cover" accessibilityLabel={t("image")} />
          ) : picked ? (
            <View style={{ marginTop: 25 }}>
              <ResourceRow compact={false} r={{ kind: "video", title: picked.name ?? t("video"), status: "ready" }} t={t} />
            </View>
          ) : null}
          {picked ? (
            <PrimaryButton
              label={t("add")}
              onPress={async () => commit(await storeResource(journal, tab, picked, picked.name?.replace(/\.[^.]+$/, "") || (tab === "image" ? t("image") : t("video"))))}
            />
          ) : (
            <PrimaryButton
              label={tab === "image" ? t("pickImage") : t("pickVideo")}
              onPress={async () => {
                try {
                  const p = await pickImage("library", tab);
                  if (p) setPicked(p);
                } catch {
                  toast(t("resourceFailed"));
                }
              }}
            />
          )}
        </>
      )}
      <Txt size={16} color="#8a92a1" align="center" style={{ marginTop: 24 }}>
        {t("savedInEntry")}
      </Txt>
    </Screen>
  );
}
