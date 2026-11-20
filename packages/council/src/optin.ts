/**
 * Gemini through Antigravity CLI (agy) is off until the user turns it on and says they accept the risk.
 *
 * Google's Antigravity Additional Terms (§6) treat accessing the service through third-party software
 * as a breach that may get the Antigravity / Gemini CLI account suspended, and the Antigravity FAQ
 * says wrapping `agy` inside third-party coding agents or applications is not supported on consumer
 * plans. GenCouncil launches `agy` for its members and chair, so it never does that on its own: the
 * user has to switch it on in the settings, after being told what it risks.
 *
 * ~/.gencouncil/providers.json  { "gemini": { "enabled": true, "acceptedAt": "<ISO>" } }
 * No file, or no "gemini" entry, means off. Read on every call: a change in the settings applies at
 * once, without a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { gencouncilHome } from "@gencouncil/core";

export interface GeminiOptIn {
  enabled: boolean;
  /** when the user last accepted the risk and turned it on */
  acceptedAt?: string;
}

interface ProviderSettings {
  gemini?: GeminiOptIn;
}

export function providerSettingsFile(): string {
  return path.join(gencouncilHome(), "providers.json");
}

function readSettings(): ProviderSettings {
  try {
    return JSON.parse(fs.readFileSync(providerSettingsFile(), "utf8")) as ProviderSettings;
  } catch {
    return {};
  }
}

export function geminiOptIn(): GeminiOptIn {
  const g = readSettings().gemini;
  return { enabled: g?.enabled === true, ...(g?.acceptedAt ? { acceptedAt: g.acceptedAt } : {}) };
}

export function geminiEnabled(): boolean {
  return geminiOptIn().enabled;
}

/**
 * Turn Gemini (Antigravity CLI) on or off for the whole space. Turning it on needs `accepted`: the
 * caller has shown the user the risk and the user has said it is their own choice.
 */
export function setGeminiEnabled(on: boolean, accepted = false): GeminiOptIn {
  if (on && !accepted) throw new Error("제미나이(안티그래비티)를 켜려면 위험 고지에 동의해야 합니다.");
  const all = readSettings();
  const prev = all.gemini;
  all.gemini = on ? { enabled: true, acceptedAt: new Date().toISOString() } : { enabled: false, ...(prev?.acceptedAt ? { acceptedAt: prev.acceptedAt } : {}) };
  fs.mkdirSync(path.dirname(providerSettingsFile()), { recursive: true });
  fs.writeFileSync(providerSettingsFile(), JSON.stringify(all, null, 2) + "\n", "utf8");
  return geminiOptIn();
}

/** what the chair, a failed launch and the account list say while it is off */
export const GEMINI_OFF =
  "제미나이(안티그래비티 CLI)는 꺼져 있습니다. Google 약관상 다른 프로그램이 agy를 띄우는 쓰임은 계정 정지 위험이 있어 기본으로 꺼 둡니다. 쓰려면 설정 > 계정에서 위험 고지를 읽고 직접 켜세요. 제미나이가 꼭 필요하면 relay(웹 제미나이·AI Studio에 사람이 붙여넣기)를 쓰세요.";

export class GeminiDisabledError extends Error {
  constructor() {
    super(GEMINI_OFF);
  }
}

/** Throws when Gemini is off. Every place that launches `agy` calls this first. */
export function assertGeminiEnabled(): void {
  if (!geminiEnabled()) throw new GeminiDisabledError();
}
