// Speech for the avatar mode: the chair speaks with its character's voice. The voices come from a local
// TTS server with the OpenAI speech contract (POST /v1/audio/speech -> WAV), e.g. Agentg's Supertonic
// adapter. It is configured in server.json ("tts"); when it has a "launch" command the server is started
// on the first request and stopped again after it has been idle a while.
import { spawn, type ChildProcess } from "node:child_process";

export interface TtsConfig {
  /** where the TTS server listens, e.g. http://127.0.0.1:18880 */
  baseUrl: string;
  model?: string;
  /** how to start it when it is not running ("%NAME%" is expanded from the environment) */
  launch?: { exe: string; args: string[]; cwd?: string };
  /** stop a server this process started after this many idle minutes (default 30) */
  idleMinutes?: number;
  /** how long to wait for it to come up (default 60) */
  startSeconds?: number;
}

const expand = (s: string) => s.replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all);

export class Tts {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private idle?: NodeJS.Timeout;

  constructor(
    private readonly config: TtsConfig | undefined,
    private readonly log: (msg: string) => void,
  ) {}

  get available(): boolean {
    return Boolean(this.config?.baseUrl);
  }

  private async healthy(): Promise<boolean> {
    try {
      const r = await fetch(`${this.config!.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** the TTS server is up: start it if we know how */
  private async ensure(): Promise<void> {
    if (await this.healthy()) return;
    const launch = this.config?.launch;
    if (!launch) throw new Error("TTS 서버가 꺼져 있고 시작 방법(launch)이 설정되지 않았습니다");
    if (!this.starting) {
      this.starting = (async () => {
        if (!this.child || this.child.exitCode !== null) {
          this.log(`tts: starting ${launch.exe}`);
          this.child = spawn(expand(launch.exe), launch.args.map(expand), { cwd: launch.cwd ? expand(launch.cwd) : undefined, stdio: "ignore", windowsHide: true });
          // a missing program is reported by the wait below timing out, never by crashing the server
          this.child.on("error", (e) => {
            this.log(`tts: could not start (${e.message})`);
            this.child = undefined;
          });
          this.child.on("exit", (code) => {
            this.log(`tts: server exited (${code})`);
            this.child = undefined;
          });
        }
        const until = Date.now() + (this.config?.startSeconds ?? 60) * 1000;
        while (Date.now() < until) {
          if (await this.healthy()) return;
          await new Promise((r) => setTimeout(r, 700));
        }
        throw new Error("TTS 서버가 제시간에 켜지지 않았습니다");
      })().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    if (!this.child) return;
    this.idle = setTimeout(() => this.stop(), (this.config?.idleMinutes ?? 30) * 60_000);
    this.idle.unref();
  }

  /** WAV bytes for the text in the voice (e.g. "ko_F1") */
  async speak(text: string, voice: string, speed?: number): Promise<Buffer> {
    if (!this.config?.baseUrl) throw new Error("TTS가 설정되지 않았습니다");
    await this.ensure();
    const r = await fetch(`${this.config.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.model ?? "tts", input: text, voice, response_format: "wav", ...(speed ? { speed } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    this.touch();
    if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.child && this.child.exitCode === null) {
      this.log("tts: stopping the idle server");
      this.child.kill();
    }
    this.child = undefined;
  }
}
