// Gemini through Antigravity CLI is off until the user turns it on. Turning it on shows what Google's
// terms say about it and asks the user to tick that it is their own choice; the server refuses
// without that tick (PUT /api/settings/gemini needs accept: true).
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { GeminiOptIn as Setting } from "../types";
import { locale, useT } from "../i18n";
import { rich as richText } from "../i18n/rich";

const TERMS = "https://antigravity.google/terms";
const FAQ = "https://antigravity.google/docs/faq";

const rich = (s: string) => richText(s, { terms: TERMS, faq: FAQ });

const listeners = new Set<(s: Setting | null) => void>();
let cache: Setting | null | undefined;
let loading: Promise<void> | undefined;

/**
 * Whether Gemini (Antigravity CLI) is switched on for this space. undefined while loading, null when
 * the server does not know the setting (an older server that has not been restarted yet).
 */
export function useGemini(): Setting | null | undefined {
  const [s, setS] = useState<Setting | null | undefined>(cache);
  useEffect(() => {
    listeners.add(setS);
    if (cache === undefined) void reloadGemini();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

export function reloadGemini(): Promise<void> {
  loading ??= api
    .geminiSetting()
    .then(
      (s) => publish(s),
      (e) => publish(e instanceof ApiError && e.status === 404 ? null : (cache ?? null)),
    )
    .finally(() => (loading = undefined));
  return loading;
}

function publish(s: Setting | null): void {
  cache = s;
  listeners.forEach((fn) => fn(s));
}

/** What turning it on risks, in the words the notice and the confirmation share. */
function Risk() {
  const t = useT();
  return (
    <div className="gem-risk">
      <p>{rich(t("GenCouncil은 제미나이 위원과 의장을 <b>Antigravity CLI(<code>agy</code>)를 자동으로 실행</b>해서 부릅니다. 사용량을 확인할 때도 <code>agy</code>를 실행합니다."))}</p>
      <ul>
        <li>{rich(t("Google <terms>Antigravity 추가 약관</terms> 6조는 제3자 소프트웨어로 서비스에 접근하는 것을 약관 위반으로 보고, Antigravity·Gemini CLI 계정의 <b>정지나 해지 사유</b>가 될 수 있다고 적고 있습니다."))}</li>
        <li>{rich(t("<faq>Antigravity FAQ</faq>는 <code>agy</code>를 제3자 코딩 에이전트나 앱 안에 감싸 쓰는 것을 개인(소비자) 요금제에서 <b>지원하지 않는다</b>고 적고 있습니다. 공식 권장은 Gemini Enterprise나 AI Studio API 키입니다."))}</li>
        <li>{t("GenCouncil 같은 쓰임이 허용되는지에 대한 Google 측 포럼 답변은 엇갈립니다. 실제로 정지됐다는 사용자 글도 있습니다.")}</li>
      </ul>
      <p>{rich(t("켜면 이 PC의 구글 계정이 정지될 수 있고, 그 판단과 책임은 켜는 사람에게 있습니다. 위험 없이 제미나이를 쓰려면 꺼 둔 채로 <b>relay</b>(웹 제미나이·AI Studio에 사람이 패킷을 붙여넣는 방식)를 쓰세요."))}</p>
    </div>
  );
}

/** The switch, with the notice. Shown on the accounts page (workshop and vision) and in the vision settings. */
export function GeminiOptIn({ notify }: { notify: (m: string) => void }) {
  const t = useT();
  const s = useGemini();
  const [asking, setAsking] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => {
    setAsking(false);
    setAgreed(false);
  }, []);
  useEffect(() => {
    if (!asking) return;
    const fn = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [asking, close]);
  // an older server without the setting: nothing to switch
  if (s === null || s === undefined) return null;

  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      publish(await api.setGemini(enabled, enabled && agreed));
      notify(enabled ? t("제미나이(안티그래비티)를 켰습니다. 의장의 다음 판단부터 제미나이 위원을 쓸 수 있습니다.") : t("제미나이(안티그래비티)를 껐습니다. 새 제미나이 위원·의장은 시작되지 않습니다 (이미 일하는 위원은 끝날 때까지 둡니다)."));
      close();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`gem-optin ${s.enabled ? "on" : "off"}`}>
      <div className="gem-head">
        <div>
          <div className="gem-title">
            {t("제미나이 (Antigravity CLI)")}
            <span className={`badge ${s.enabled ? "warn" : ""}`}>{s.enabled ? t("켜짐 · 본인 선택") : t("꺼짐")}</span>
          </div>
          <div className="small muted">
            {s.enabled
              ? s.acceptedAt
                ? t("{when}에 약관 위험에 동의하고 켰습니다. 제미나이 위원·의장·사용량 확인에 agy를 실행합니다.", { when: new Date(s.acceptedAt).toLocaleString(locale()) })
                : t("약관 위험에 동의하고 켰습니다. 제미나이 위원·의장·사용량 확인에 agy를 실행합니다.")
              : t("Google 약관상 계정 정지 위험이 있어 기본으로 꺼 둡니다. 꺼져 있는 동안 GenCouncil은 agy를 한 번도 실행하지 않습니다.")}
          </div>
        </div>
        {s.enabled ? (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => {
              if (confirm(t("제미나이(안티그래비티)를 끌까요? 새 제미나이 위원·의장은 시작되지 않고, 이미 일하는 위원은 끝날 때까지 둡니다."))) void change(false);
            }}
          >
            {t("끄기")}
          </button>
        ) : (
          <button className="small" disabled={busy} onClick={() => setAsking(true)}>
            {t("위험 읽고 켜기")}
          </button>
        )}
      </div>
      {asking && (
        <div className="modal-bg" onClick={close}>
          <div className="modal gem-modal" role="dialog" aria-label={t("제미나이(안티그래비티) 켜기")} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{t("제미나이(안티그래비티)를 켜기 전에")}</span>
              <button className="icon" onClick={close} aria-label={t("닫기")}>
                ✕
              </button>
            </div>
            <Risk />
            <label className="check-row gem-agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              {t("위 내용을 읽었고, 계정 정지 위험을 알고 제 판단으로 켭니다.")}
            </label>
            <div className="modal-actions">
              <button className="ghost" onClick={close}>
                {t("꺼 둔 채로 두기")}
              </button>
              <button className="primary" disabled={!agreed || busy} onClick={() => void change(true)}>
                {busy ? t("켜는 중…") : t("내 선택으로 켜기")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
