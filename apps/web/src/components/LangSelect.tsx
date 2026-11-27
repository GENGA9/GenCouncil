import { LANGS, setLang, useLang, useT, type Lang } from "../i18n";

/** The app's language: the screens, and the characters' lines and voices. */
export function LangSelect({ className = "theme-btn lang-select" }: { className?: string }) {
  const lang = useLang();
  const t = useT();
  return (
    <select className={className} value={lang} onChange={(e) => setLang(e.target.value as Lang)} title={t("화면 언어 (캐릭터 대사·음성도 따릅니다)")} aria-label={t("언어")}>
      {LANGS.map(([l, label]) => (
        <option key={l} value={l}>
          {label}
        </option>
      ))}
    </select>
  );
}
