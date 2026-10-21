import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { normalize } from "../domain/rules";
import { useI18n } from "../i18n";
import { emitChange } from "../services/events";
import { useApp, useQuery } from "../state/app";
import { editor, useEditor } from "../state/editor";
import { Btn, NavHeader, NavTextButton, PrimaryButton, QuietAction, SectionTitle, FormLabel, ListRow } from "../ui/components";
import { Icon } from "../ui/Icon";
import { LineInput } from "../ui/inputs";
import { Screen } from "../ui/Screen";
import { Sheet } from "../ui/Sheet";
import { C } from "../ui/theme";
import { Txt } from "../ui/Txt";

type Key = "topics" | "emotions";

/** Topics and emotions of the entry being edited. Changes apply when the entry is saved. */
export default function Labels() {
  const params = useLocalSearchParams<{ sheet?: string }>();
  const { t } = useI18n();
  const { journal } = useApp();
  const s = useEditor();
  const [adding, setAdding] = useState<Key | null>(params.sheet === "addTopic" ? "topics" : params.sheet === "addEmotion" ? "emotions" : null);
  const [renaming, setRenaming] = useState<{ key: Key; name: string } | null>(null);
  const [value, setValue] = useState("");
  const catalog = useQuery((j) => j.tagCatalog(), []);
  if (!s) return <Screen>{null}</Screen>;

  const add = (key: Key, name: string) => {
    const v = name.trim();
    const list = editor.get()![key];
    if (v && !list.some((x) => normalize(x) === normalize(v))) editor.update({ [key]: [...list, v] });
    setAdding(null);
    setValue("");
  };
  const kindOf = (key: Key) => (key === "topics" ? "topic" : "emotion");
  const suggestions = (key: Key) =>
    (catalog ?? []).filter((c) => c.kind === kindOf(key) && !s[key].some((x) => normalize(x) === normalize(c.name))).map((c) => c.name);

  return (
    <Screen>
      <NavHeader backA11y={t("back")} onBack={() => router.back()} right={<NavTextButton label={t("done")} a11y={t("doneLabels")} onPress={() => router.back()} />} />
      <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: 26 }} accessibilityRole="header">
        {t("labels")}
      </Txt>
      <Txt size={19} lh={1.4} color="#737b8b">
        {t("labelsIntro")}
      </Txt>
      {([
        ["topics", t("whatAbout"), t("addTopic")],
        ["emotions", t("howFelt"), t("addEmotion")],
      ] as [Key, string, string][]).map(([key, title, addLabel]) => (
        <View key={key}>
          <SectionTitle mt={35}>{title}</SectionTitle>
          {s[key].map((name) => (
            <View key={name} style={{ flexDirection: "row", alignItems: "center", minHeight: 55, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, columnGap: 13 }}>
              <Btn label={`${t("renameTag")}: ${name}`} onPress={() => { setRenaming({ key, name }); setValue(name); }} style={{ flex: 1 }}>
                <Txt size={22}>{name}</Txt>
              </Btn>
              <Btn label={`${t("remove")} ${name}`} onPress={() => editor.update({ [key]: editor.get()![key].filter((x) => x !== name) })} style={{ minWidth: 44, minHeight: 44, padding: 8, alignItems: "center", justifyContent: "center" }}>
                <Icon name="close" />
              </Btn>
            </View>
          ))}
          <QuietAction label={addLabel} onPress={() => { setAdding(key); setValue(""); }} />
        </View>
      ))}
      <Txt size={19} lh={1.4} color="#737b8b" style={{ marginTop: 50 }}>
        {t("canChange")}
      </Txt>

      <Sheet visible={!!adding} title={adding === "emotions" ? t("addEmotion") : t("addTopic")} onClose={() => setAdding(null)} closeLabel={t("close")}>
        <FormLabel>{t("name")}</FormLabel>
        <LineInput testID="tag-name-input" value={value} onChangeText={setValue} maxLength={35} autoFocus={!params.sheet} autoCorrect={false} onSubmitEditing={() => adding && add(adding, value)} accessibilityLabel={t("name")} />
        <PrimaryButton label={t("add")} marginTop={22} onPress={() => adding && value.trim() && add(adding, value)} />
        {adding && value.trim() && suggestions(adding).some((n) => n.toLowerCase().startsWith(value.trim().toLowerCase())) ? (
          <View style={{ marginTop: 22 }}>
            <FormLabel>{t("fromCatalog")}</FormLabel>
            {suggestions(adding).filter((n) => n.toLowerCase().startsWith(value.trim().toLowerCase())).map((name) => (
              <ListRow key={name} variant="sheet" title={name} onPress={() => add(adding, name)} />
            ))}
          </View>
        ) : null}
      </Sheet>

      <Sheet visible={!!renaming} title={t("renameTag")} onClose={() => setRenaming(null)} closeLabel={t("close")}>
        <FormLabel>{t("name")}</FormLabel>
        <LineInput value={value} onChangeText={setValue} maxLength={35} autoFocus autoCorrect={false} accessibilityLabel={t("name")} />
        <PrimaryButton
          label={t("rename")}
          marginTop={22}
          disabled={!value.trim()}
          onPress={async () => {
            if (!renaming || !journal) return;
            const tag = (catalog ?? []).find((c) => c.kind === kindOf(renaming.key) && normalize(c.name) === normalize(renaming.name));
            // Catalog rename keeps the tag identity on every entry that uses it.
            if (tag) await journal.renameTag(tag.id, value);
            editor.update({ [renaming.key]: editor.get()![renaming.key].map((x) => (x === renaming.name ? value.trim() : x)) });
            emitChange();
            setRenaming(null);
          }}
        />
      </Sheet>
    </Screen>
  );
}
