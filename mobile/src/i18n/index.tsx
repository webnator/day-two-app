import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { getLocales } from "expo-localization";
import type { Lang } from "../domain/dates";
import { en, es, type StringKey } from "./strings";

type T = (key: StringKey, vars?: Record<string, string | number>) => string;
const Ctx = createContext<{ lang: Lang; t: T; setLang: (l: Lang) => void } | null>(null);

export function deviceLang(): Lang {
  try {
    return getLocales()[0]?.languageCode === "en" ? "en" : "es";
  } catch {
    return "es";
  }
}

export function translate(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  let s: string = (lang === "en" ? en : es)[key] ?? es[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function I18nProvider({ initial, children, onChange }: { initial: Lang; children: ReactNode; onChange?: (l: Lang) => void }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const value = useMemo(
    () => ({
      lang,
      t: ((key, vars) => translate(lang, key, vars)) as T,
      setLang: (l: Lang) => {
        setLangState(l);
        onChange?.(l);
      },
    }),
    [lang, onChange],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}
