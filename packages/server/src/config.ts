import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gencouncilHome } from "@gencouncil/core";

import type { TtsConfig } from "./tts.js";

export interface ServerConfig {
  token: string;
  port: number;
  host: string;
  telegram?: { botToken: string; chatId: string; agenda?: string; forumChatId?: string; topics?: Record<string, number>; autoNotify?: boolean };
  /** speech for the avatar mode's characters (a local TTS server with the OpenAI speech contract) */
  tts?: TtsConfig;
}

export function serverConfigFile(): string {
  return path.join(gencouncilHome(), "server.json");
}

/** Load ~/.gencouncil/server.json, creating it with a random token on first use. */
export function loadServerConfig(overrides: ServerConfigPatch = {}): ServerConfig {
  const f = serverConfigFile();
  let cfg: Partial<ServerConfig> = {};
  if (fs.existsSync(f)) {
    try {
      cfg = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<ServerConfig>;
    } catch {
      cfg = {};
    }
  }
  const merged: ServerConfig = {
    token: overrides.token ?? cfg.token ?? crypto.randomBytes(18).toString("base64url"),
    port: overrides.port ?? cfg.port ?? 7700,
    // loopback by default: phones and other PCs come in through "tailscale serve", never straight from the network
    host: overrides.host ?? cfg.host ?? "127.0.0.1",
    telegram: overrides.telegram === null ? undefined : (overrides.telegram ?? cfg.telegram),
    tts: overrides.tts ?? cfg.tts,
  };
  if (!fs.existsSync(f) || JSON.stringify(cfg) !== JSON.stringify(merged)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }
  return merged;
}

/** Persist a partial change to server.json (e.g. telegram binding). */
export type ServerConfigPatch = Omit<Partial<ServerConfig>, "telegram"> & { telegram?: ServerConfig["telegram"] | null };

export function saveServerConfig(patch: ServerConfigPatch): ServerConfig {
  return loadServerConfig(patch);
}

export function resetToken(): ServerConfig {
  return loadServerConfig({ token: crypto.randomBytes(18).toString("base64url") });
}

export interface TailscaleInfo {
  ip?: string;
  dnsName?: string;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Best-effort: what the phone should dial. Empty when tailscale is not installed/running. */
export async function detectTailscale(): Promise<TailscaleInfo> {
  const out: TailscaleInfo = {};
  const ip = await run("tailscale", ["ip", "-4"]);
  if (ip?.trim()) out.ip = ip.trim().split("\n")[0];
  const status = await run("tailscale", ["status", "--json"]);
  if (status) {
    try {
      const j = JSON.parse(status) as { Self?: { DNSName?: string } };
      const dns = j.Self?.DNSName?.replace(/\.$/, "");
      if (dns) out.dnsName = dns;
    } catch {
      /* ignore */
    }
  }
  return out;
}
