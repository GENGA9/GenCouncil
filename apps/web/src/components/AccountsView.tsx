import { useEffect, useState } from "react";
import { api } from "../api";
import { familyColorByName } from "../model";
import type { Account } from "../types";

const STATUS_KO: Record<Account["status"], string> = { ok: "사용 가능", exhausted: "한도 소진", auth: "로그인 필요", disabled: "비활성" };

const PROVIDERS: Array<{ id: string; label: string; family: string; kind: "cli" | "web"; how: string }> = [
  { id: "claude", label: "클로드 (Claude Code)", family: "claude", kind: "cli", how: "콘솔 창에서 /login" },
  { id: "gpt", label: "GPT (Codex CLI)", family: "gpt", kind: "cli", how: "브라우저에서 ChatGPT 로그인" },
  { id: "gemini", label: "제미나이 (Antigravity CLI)", family: "gemini", kind: "cli", how: "Antigravity 창에서 구글 로그인. 계정마다 따로 추가" },
  { id: "gemini-web", label: "웹 제미나이", family: "gemini", kind: "web", how: "전용 Chrome 창에서 구글 로그인" },
  { id: "aistudio", label: "AI Studio", family: "gemini", kind: "web", how: "전용 Chrome 창에서 구글 로그인" },
  { id: "chatgpt", label: "ChatGPT 웹", family: "gpt", kind: "web", how: "전용 Chrome 창에서 로그인" },
];
const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export function AccountsView({ notify }: { notify: (m: string) => void }) {
  const [list, setList] = useState<Account[]>([]);
  const [id, setId] = useState("");
  const [provider, setProvider] = useState("claude");
  const [dir, setDir] = useState("");
  const [note, setNote] = useState("");
  const reload = () => api.accounts().then(setList).catch(() => undefined);
  useEffect(() => {
    void reload();
    const t = window.setInterval(reload, 15000);
    return () => clearInterval(t);
  }, []);

  const login = async (a: Account) => {
    try {
      const r = await api.accountLogin(a.id);
      notify(`PC에 로그인 창을 열었습니다: ${r.hint}`);
      void reload();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const add = async () => {
    try {
      const a = await api.addAccount({ id: id.trim(), provider, configDir: dir.trim() || undefined, note: note.trim() || undefined });
      setId("");
      setDir("");
      setNote("");
      await reload();
      await login(a);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="center-inner memory">
      <div className="chair-head">
        <div className="chair-title">계정</div>
      </div>
      <div className="mem-body">
        <p className="small muted">
          계정을 여러 개 미리 로그인해 두면, 위원과 의장이 쓸 수 있는 계정을 자동으로 고르고 한도가 차면 다른 계정으로 넘깁니다. 계정마다 로그인이 별도 폴더(웹은 전용 Chrome 프로필)에 저장되므로 한 번만 로그인하면 됩니다. "로그인" 버튼은 이 PC 화면에 창을 엽니다.
        </p>
        {PROVIDERS.map((p) => {
          const items = list.filter((a) => a.provider === p.id);
          if (!items.length) return null;
          return (
            <section key={p.id}>
              <h3 style={{ color: familyColorByName(p.family) }}>{p.label}</h3>
              {items.map((a) => (
                <div key={a.id} className="mem-row acct-row">
                  <div>
                    <span className="member-name">{a.id}</span>{" "}
                    <span className={`badge ${a.status === "ok" ? "ok" : a.status === "exhausted" ? "warn" : ""}`}>{STATUS_KO[a.status]}</span>
                    {p.kind === "web" && !a.loginOpenedAt && <span className="badge warn">로그인 전</span>}
                    <div className="small muted mono">{a.configDir ?? "(기본 로그인)"}</div>
                    {a.resetAt && <div className="small muted">리셋 예상: {new Date(a.resetAt).toLocaleString()}</div>}
                    {a.lastError && <div className="small warn-text">{a.lastError}</div>}
                    {a.lastUsed && <div className="small muted">마지막 사용: {new Date(a.lastUsed).toLocaleString()}</div>}
                    {a.note && <div className="small muted">{a.note}</div>}
                  </div>
                  <div className="member-actions">
                    <button className="ghost small" onClick={() => login(a)} title={p.how}>로그인</button>
                    {a.status !== "ok" && (
                      <button className="primary small" onClick={async () => { await api.resetAccount(a.id); notify(`${a.id} 복구`); void reload(); }}>복구</button>
                    )}
                    {a.configDir && (
                      <button className="ghost small danger" onClick={async () => { if (confirm(`${a.id} 를 삭제할까요? (로그인 폴더는 남습니다)`)) { await api.removeAccount(a.id); void reload(); } }}>삭제</button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
        <section>
          <h3>계정 추가</h3>
          <div className="row2">
            <label>ID<input value={id} onChange={(e) => setId(e.target.value)} placeholder={provider === "claude" ? "claude-b" : `${provider}-2`} /></label>
            <label>종류
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          </div>
          <label>로그인 저장 폴더 (비우면 자동: ~/.gencouncil/accounts/ID)<input value={dir} onChange={(e) => setDir(e.target.value)} /></label>
          <label>메모<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="회사 계정" /></label>
          <div className="small muted">추가하면 바로 로그인 창이 열립니다: {byId[provider]?.how}.</div>
          <div className="modal-actions">
            <button className="primary" onClick={add} disabled={!id.trim()}>추가하고 로그인</button>
          </div>
        </section>
      </div>
    </div>
  );
}
