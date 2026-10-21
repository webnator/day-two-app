import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { emptyFilters, hasFilters, search, type SearchFilters } from "../domain/search";
import { useI18n } from "../i18n";
import { useQuery, useToday } from "../state/app";
import { Btn, NavHeader, PrimaryButton, QuietAction, SecondaryButton, SectionTitle, Underlined } from "../ui/components";
import { EntryRow, entryMeta } from "../ui/day";
import { CheckOption, PickerField } from "../ui/fields";
import { Icon } from "../ui/Icon";
import { Screen } from "../ui/Screen";
import { Sheet } from "../ui/Sheet";
import { C, SERIF } from "../ui/theme";
import { Txt, glyphShift } from "../ui/Txt";

/** Search over the current (corrected) text; topics/emotions/dates filters (OR within, AND across). */
export default function Search() {
  const params = useLocalSearchParams<{ sheet?: string }>();
  const { t, lang } = useI18n();
  const today = useToday();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(emptyFilters());
  const [draft, setDraft] = useState<SearchFilters>(emptyFilters());
  const [sheet, setSheet] = useState(params.sheet === "filters");
  const [error, setError] = useState("");
  const all = useQuery((j) => j.allEntries(), []);
  const catalog = useQuery((j) => j.tagCatalog(), []);
  const items = (all ?? []).map((e) => ({ ...e, tags: e.tags }));
  const results = search(items, query, filters);
  const chip = (label: string, onPress: () => void) => (
    <Btn key={label} label={`${t("removeFilter")} ${label}`} onPress={onPress} style={{ borderWidth: 1, borderColor: "#d9dde4", borderRadius: 6, paddingVertical: 4, paddingHorizontal: 7 }}>
      <Txt size={13} color="#647086">{`${label} ×`}</Txt>
    </Btn>
  );
  const topicNames = (catalog ?? []).filter((c) => c.kind === "topic").map((c) => c.name);
  const emotionNames = (catalog ?? []).filter((c) => c.kind === "emotion").map((c) => c.name);

  return (
    <Screen keyboard>
      <NavHeader backA11y={t("back")} onBack={() => router.back()} />
      <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: 26 }} accessibilityRole="header">{t("search")}</Txt>
      <View style={{ flexDirection: "row", alignItems: "center", columnGap: 10, borderBottomWidth: 1, borderBottomColor: "#a4a9b2", paddingVertical: 8 }}>
        <Icon name="search" />
        <TextInput
          testID="search-input"
          value={query}
          onChangeText={setQuery}
          placeholder={t("searchPlaceholder")}
          placeholderTextColor="#757575"
          accessibilityLabel={t("searchA11y")}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
          selectionColor={C.ink}
          maxFontSizeMultiplier={2}
          style={{ flex: 1, fontFamily: SERIF, fontSize: 23, height: 33.05, padding: 0, paddingHorizontal: 2, color: "#000", includeFontPadding: false, transform: [{ translateY: glyphShift(23, 31.05) }] }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 7, rowGap: 7, marginVertical: 20 }}>
        <Btn label={t("openFilters")} onPress={() => { setDraft(filters); setSheet(true); }} style={{ flexDirection: "row", alignItems: "center", columnGap: 7, paddingVertical: 1, paddingHorizontal: 6 }}>
          <Icon name="filter" />
          <Underlined size={16} color={C.ink} align="left" offset="auto">{t("filters")}</Underlined>
        </Btn>
        {filters.topics.map((x) => chip(x, () => setFilters({ ...filters, topics: filters.topics.filter((y) => y !== x) })))}
        {filters.emotions.map((x) => chip(x, () => setFilters({ ...filters, emotions: filters.emotions.filter((y) => y !== x) })))}
        {filters.from || filters.to ? chip(t("dates"), () => setFilters({ ...filters, from: "", to: "" })) : null}
      </View>
      {results.length ? (
        results.map((e, i) => (
          <EntryRow
            key={e.id}
            entry={e}
            last={i === results.length - 1}
            meta={entryMeta(e, t, lang, true)}
            preview={e.kind === "audio" && e.transcriptStatus !== "ready" ? t("transcriptPending") : e.body.replace(/\s+/g, " ").trim()}
            a11y={`${t("open")} ${e.title}`}
            onPress={() => router.push({ pathname: "/entry/[id]", params: { id: e.id } })}
          />
        ))
      ) : all ? (
        <View style={{ paddingVertical: 40, alignItems: "center" }}>
          <Txt size={20} color="#7a8392" align="center">{t("noResults")}</Txt>
          {hasFilters(filters) || query ? <QuietAction label={t("clearFilters")} align="center" onPress={() => { setFilters(emptyFilters()); setQuery(""); }} /> : null}
        </View>
      ) : null}

      <Sheet visible={sheet} title={t("filters")} onClose={() => setSheet(false)} closeLabel={t("close")}>
        <SectionTitle mt={11}>{t("topics")}</SectionTitle>
        {topicNames.map((n) => (
          <CheckOption key={n} label={n} checked={draft.topics.includes(n)} onChange={(v) => setDraft({ ...draft, topics: v ? [...draft.topics, n] : draft.topics.filter((x) => x !== n) })} />
        ))}
        <SectionTitle>{t("emotions")}</SectionTitle>
        {emotionNames.map((n) => (
          <CheckOption key={n} label={n} checked={draft.emotions.includes(n)} onChange={(v) => setDraft({ ...draft, emotions: v ? [...draft.emotions, n] : draft.emotions.filter((x) => x !== n) })} />
        ))}
        <PickerField label={t("from")} mode="date" value={draft.from} max={today} clearable clearLabel={t("remove")} onChange={(v) => setDraft({ ...draft, from: v })} />
        <PickerField label={t("to")} mode="date" value={draft.to} max={today} clearable clearLabel={t("remove")} onChange={(v) => setDraft({ ...draft, to: v })} />
        {error ? <Txt size={16} color={C.error}>{error}</Txt> : null}
        <PrimaryButton
          label={t("applyFilters")}
          marginTop={24}
          onPress={() => {
            if (draft.from && draft.to && draft.from > draft.to) return setError(t("dateOrder"));
            setError("");
            setFilters(draft);
            setSheet(false);
          }}
        />
        <SecondaryButton label={t("clearFilters")} onPress={() => { setDraft(emptyFilters()); setFilters(emptyFilters()); setSheet(false); }} />
      </Sheet>
    </Screen>
  );
}
