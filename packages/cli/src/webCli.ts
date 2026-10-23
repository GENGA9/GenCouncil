import { parseArgs } from "node:util";
import { loadServerConfig, resetToken, saveServerConfig, serverConfigFile, startServer, TelegramBridge } from "@gencouncil/server";

export const WEB_HELP = `web
  web [--port 7700] [--host 127.0.0.1]   start the web UI + API server (foreground)
  web token [--reset]                     print (or regenerate) the access token
  web telegram --token <bot token> --chat <chat id> [--agenda project/slug]   enable the Telegram bot
  web telegram --off                      disable it
`;

export async function webMain(rest: string[]): Promise<number> {
  if (rest[0] === "token") {
    const cfg = rest.includes("--reset") ? resetToken() : loadServerConfig();
    console.log(cfg.token);
    console.error(`(${serverConfigFile()})`);
    return 0;
  }
  if (rest[0] === "telegram") {
    const { values } = parseArgs({
      args: rest.slice(1),
      options: { token: { type: "string" }, chat: { type: "string" }, agenda: { type: "string" }, off: { type: "boolean" } },
    });
    if (values.off) {
      saveServerConfig({ telegram: null });
      console.log("telegram disabled");
      return 0;
    }
    const cur = loadServerConfig().telegram;
    const botToken = values.token ?? cur?.botToken;
    const chatId = values.chat ?? cur?.chatId;
    if (!botToken || !chatId) {
      console.error(
        "usage: web telegram --token <bot token from @BotFather> --chat <your chat id> [--agenda project/slug]\n" +
          "(chat id: message your bot once, then open https://api.telegram.org/bot<token>/getUpdates and read message.chat.id)",
      );
      return 2;
    }
    const telegram = { botToken, chatId, agenda: values.agenda ?? cur?.agenda };
    const bridge = new TelegramBridge(telegram, { log: console.error, listAgendas: () => [], getRuntime: () => Promise.reject(new Error("n/a")), onBind: () => undefined });
    try {
      const user = await bridge.verify();
      await bridge.send("GenCouncil 연결됨. /help 로 명령을 봅니다.");
      saveServerConfig({ telegram });
      console.log(`telegram bot @${user} saved; restart 'gencouncil web' to activate`);
      return 0;
    } catch (e) {
      console.error(`telegram check failed: ${(e as Error).message}`);
      return 1;
    }
  }
  const { values } = parseArgs({ args: rest, options: { port: { type: "string" }, host: { type: "string" } } });
  // the server is long-lived: a pipe to a child process that already exited must not take it down
  const PIPE_ERRORS = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);
  process.on("uncaughtException", (e: NodeJS.ErrnoException) => {
    if (e.code && PIPE_ERRORS.has(e.code)) {
      console.error(`[web] ignored ${e.code}: ${e.message}`);
      return;
    }
    console.error(e);
    process.exit(1);
  });
  const srv = await startServer({
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    log: (l) => console.log(`[web] ${l}`),
  });
  const ts = srv.tailscale;
  console.log("");
  console.log(`GenCouncil web : ${srv.url}`);
  console.log(`token          : ${srv.config.token}   (gencouncil web token)`);
  if (srv.telegram) console.log(`Telegram       : @${srv.telegram} (chat ${srv.config.telegram?.chatId})`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(srv.config.host);
  if (loopback) console.log("접속 범위      : 이 PC만 (다른 기기는 tailscale serve 주소로)");
  if (ts.dnsName) {
    if (!loopback) console.log(`Tailscale      : http://${ts.dnsName}:${srv.config.port}  (same network as your phone)`);
    console.log(`Tailscale HTTPS: https://${ts.dnsName}   (처음 한 번: tailscale serve --bg http://127.0.0.1:${srv.config.port})`);
  } else if (ts.ip && !loopback) {
    console.log(`Tailscale IP   : http://${ts.ip}:${srv.config.port}`);
  } else {
    console.log(`Tailscale      : 감지되지 않음. 설치 후 'tailscale serve --bg ${srv.config.port}' 로 https 주소를 만들면 폰에서 PWA로 설치할 수 있다.`);
  }
  console.log("Ctrl+C to stop");
  await new Promise<void>((resolve) => {
    const stop = () => {
      console.log("\n[web] shutting down…");
      void srv.close().then(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
