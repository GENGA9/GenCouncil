// ?lang=en (or ja, ko) on the demo page: the screen language, set before the other modules load
// (film.tsx reads it for its made-up project's words)
import { setLang, type Lang } from "../i18n";

const lang = new URLSearchParams(location.search).get("lang");
if (lang === "ko" || lang === "en" || lang === "ja") setLang(lang as Lang);
