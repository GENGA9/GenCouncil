import { useEffect, useState } from "react";
import { api } from "../api";
import type { Account } from "../types";

const STATUS_KO: Record<Account["status"], string> = { ok: "사용 가능", exhausted: "한도 소진", auth: "로그인 필요", disabled: "비활성" };

export function AccountsView({ notify }: { notify: (m: string) => void }) {
  const [list, setList] = useState<Account[]>([]);
  const [id, setId] = useState("");
  const [provider, setProvider] = useState<"claude" | "gemini">("claude");
  const [dir, setDir] = useState("");
  const [note, setNote] = useState("");
  const reload = () => api.accounts().then(setList).catch(() => undefined);
  useEffect(() => {
    void reload();
    const t = window.setInterval(reload, 15000);
    return () => clearInterval(t);
  }, []);

  const add = async () => {
    try {
      await api.addAccount({ id: id.trim(), provider, configDir: dir.trim(), note: note.trim() });
      notify(`계정 ${id} 저장. PC에서 'gencouncil account login ${id}' 로 로그인하세요.`);
      setId("");
      setDir("");
      setNote("");
      void reload();
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
          위원과 의장은 여기 등록된 계정 중 사용 가능한 것을 자동으로 고릅니다. 한도 오류가 나면 "한도 소진"으로 바뀌고 리셋 시각이 지나면 자동 복구됩니다. 다른 계정의 로그인은 PC 터미널에서 <code>gencouncil account login &lt;id&gt;</code> 로 합니다.
        </p>
        <section>
          <h3>등록된 계정</h3>
          {list.map((a) => (
            <div key={a.id} className="mem-row acct-row">
              <div>
                <span className="member-name">{a.id}</span> <span className="badge">{a.provider}</span>{" "}
                <span className={`badge ${a.status === "ok" ? "ok" : a.status === "exhausted" ? "warn" : ""}`}>{STATUS_KO[a.status]}</span>
                <div className="small muted mono">{a.configDir ?? "(기본 로그인)"}</div>
                {a.resetAt && <div className="small muted">리셋 예상: {new Date(a.resetAt).toLocaleString()}</div>}
                {a.lastError && <div className="small warn-text">{a.lastError}</div>}
                {a.lastUsed && <div className="small muted">마지막 사용: {new Date(a.lastUsed).toLocaleString()}</div>}
                {a.note && <div className="small muted">{a.note}</div>}
              </div>
              <div className="member-actions">
                {a.status !== "ok" && (
                  <button className="primary small" onClick={async () => { await api.resetAccount(a.id); notify(`${a.id} 복구`); void reload(); }}>복구</button>
                )}
                {a.configDir && (
                  <button className="ghost small danger" onClick={async () => { if (confirm(`${a.id} 를 삭제할까요?`)) { await api.removeAccount(a.id); void reload(); } }}>삭제</button>
                )}
              </div>
            </div>
          ))}
        </section>
        <section>
          <h3>계정 추가</h3>
          <div className="row2">
            <label>ID<input value={id} onChange={(e) => setId(e.target.value)} placeholder="claude-b" /></label>
            <label>제공자
              <select value={provider} onChange={(e) => setProvider(e.target.value as "claude" | "gemini")}>
                <option value="claude">claude</option>
                <option value="gemini">gemini</option>
              </select>
            </label>
          </div>
          <label>설정 폴더 (이 계정 전용 로그인 저장 위치)<input value={dir} onChange={(e) => setDir(e.target.value)} placeholder={provider === "claude" ? "C:\\Users\\me\\.claude-b" : "C:\\Users\\me\\gemini-b"} /></label>
          <label>메모<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="회사 계정" /></label>
          <div className="modal-actions">
            <button className="primary" onClick={add} disabled={!id.trim() || !dir.trim()}>추가</button>
          </div>
        </section>
      </div>
    </div>
  );
}
