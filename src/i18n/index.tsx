import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  translations,
  type Lang,
  type LangPreference,
  type TranslationKey,
} from "./translations";

const STORAGE_KEY = "doccraft-language";
const DEFAULT_LANG: Lang = "en";

function loadPreference(): LangPreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh" || stored === "system") {
      return stored;
    }
  } catch {
    // ignore storage errors
  }
  // No stored value (new user) or invalid value -> follow the system language
  return "system";
}

function resolveLang(pref: LangPreference): Lang {
  if (pref === "system") {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return pref;
}

type Interpolations = Record<string, string | number>;

interface I18nContextValue {
  lang: Lang;
  preference: LangPreference;
  setLang: (pref: LangPreference) => void;
  t: (key: TranslationKey, params?: Interpolations) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] =
    useState<LangPreference>(loadPreference);
  const [lang, setLangState] = useState<Lang>(() => resolveLang(preference));

  const setLang = useCallback((next: LangPreference) => {
    setPreferenceState(next);
    setLangState(resolveLang(next));
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Interpolations) => {
      let str =
        translations[lang][key] ?? translations[DEFAULT_LANG][key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          str = str.split(`{${k}}`).join(String(v));
        }
      }
      return str;
    },
    [lang],
  );

  const value = useMemo(
    () => ({ lang, preference, setLang, t }),
    [lang, preference, setLang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within a LanguageProvider");
  }
  return ctx;
}
