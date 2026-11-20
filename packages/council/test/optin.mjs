// Gemini through Antigravity CLI is off until the user turns it on with the risk accepted:
// nothing picks the Gemini login, no member, chair or one-shot starts agy, limits read zero.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountRegistry,
  GEMINI_OFF,
  drivers,
  geminiEnabled,
  geminiOptIn,
  loginCommand,
  oneShot,
  providerSettingsFile,
  setGeminiEnabled,
} from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-optin-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

// a fresh space: off, and no file written just by asking
check("a fresh space has Gemini off", geminiEnabled() === false && geminiOptIn().enabled === false);
check("asking writes nothing", !fs.existsSync(providerSettingsFile()));

const accounts = new AccountRegistry();
const gem = accounts.get("gemini");
check("the Gemini login reads disabled while off", gem?.status === "disabled" && gem.lastError === GEMINI_OFF);
check("nothing picks it", accounts.pick("gemini") === undefined);
check("the other logins are untouched", accounts.get("claude")?.status === "ok" && accounts.get("gpt")?.status === "ok");
check("the stored status is not changed by how it reads", !fs.existsSync(path.join(process.env.GENCOUNCIL_HOME, "accounts.json")) || !/disabled/.test(fs.readFileSync(path.join(process.env.GENCOUNCIL_HOME, "accounts.json"), "utf8")));

// no agy anywhere while off
check("a Gemini member refuses to start", throws(() => drivers.gemini.spawn({ cwd: tmp, prompt: "x", autonomy: "full" }, () => {}), /꺼져 있습니다/));
check("no login window for it", throws(() => loginCommand({ id: "gemini", provider: "gemini", status: "ok" }, accounts), /꺼져 있습니다/));
const shot = await oneShot({ provider: "gemini", cwd: tmp, prompt: "x", tools: "none", timeoutMs: 5000 });
check("a one-shot on Gemini answers that it is off, without running agy", shot.error === GEMINI_OFF && shot.seconds === 0);

// turning it on needs the risk accepted
check("turning it on without accepting is refused", throws(() => setGeminiEnabled(true), /동의/) && geminiEnabled() === false);
const on = setGeminiEnabled(true, true);
check("accepted: it is on, with the time it was accepted", on.enabled && Boolean(on.acceptedAt) && geminiEnabled());
check("the Gemini login reads as it is stored again", accounts.get("gemini")?.status === "ok" && accounts.pick("gemini")?.id === "gemini");
check("the setting is one small file", JSON.parse(fs.readFileSync(providerSettingsFile(), "utf8")).gemini.enabled === true);

// off again: back to off, keeping when it was last accepted
const off = setGeminiEnabled(false);
check("turning it off needs no acceptance and keeps the last acceptance time", !off.enabled && off.acceptedAt === on.acceptedAt && !geminiEnabled());
check("off again: nothing picks the login", accounts.pick("gemini") === undefined);

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall opt-in checks passed");
