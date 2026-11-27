import { useT } from "../i18n";

/** top-bar reload for the full-screen looks: the desktop app has no browser toolbar to reload from */
export function ReloadButton() {
  const t = useT();
  return (
    <button className="vz-reload" onClick={() => location.reload()} title={t("새로고침 (F5)")}>
      <i>↻</i>
      <span className="vz-dock-label">{t("새로고침")}</span>
    </button>
  );
}
