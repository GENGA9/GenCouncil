#!/usr/bin/env node
import { COUNCIL_COMMANDS, COUNCIL_HELP, councilMain } from "./councilCli.js";
import { MEMORY_COMMANDS, MEMORY_HELP, memoryMain } from "./memoryCli.js";
import { DESKTOP_HELP, desktopMain } from "./desktopCli.js";
import { SERVICE_HELP, serviceMain } from "./serviceCli.js";
import { WEB_HELP, webMain } from "./webCli.js";

const HELP = `gencouncil - multi-AI council with shared Space memory

usage: gencouncil <command> [options]

${MEMORY_HELP}
${COUNCIL_HELP}
${WEB_HELP}
${SERVICE_HELP}
${DESKTOP_HELP}
env: GENCOUNCIL_HOME (default ~/.gencouncil)
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (MEMORY_COMMANDS.has(cmd)) return memoryMain(cmd, rest);
  if (COUNCIL_COMMANDS.has(cmd)) return councilMain(cmd, rest);
  if (cmd === "web") return webMain(rest);
  if (cmd === "service") return serviceMain(rest);
  if (cmd === "desktop") return desktopMain(rest);
  console.error(`unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  },
);
