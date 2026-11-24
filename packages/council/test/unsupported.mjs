// A login that does not offer a model yet (gpt-6.2-sol on a Codex signed in with a ChatGPT account):
// the failure is told apart from quota and login trouble, the login remembers it, and the same
// rung's previous generation runs instead - never a lower rung - until the week is over.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountRegistry, DEFAULT_LIMITS, PREDECESSOR, classifyFailure, resolveModel } from "@gencouncil/council";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gencouncil-unsupported-"));
process.env.GENCOUNCIL_HOME = path.join(tmp, "home");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failed++;
};

const ERR = `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account."}}`;
const f = classifyFailure("gpt", ERR, 1);
check("a model the login does not offer is its own kind of failure", f.kind === "model", JSON.stringify(f));
check("the message names the model", f.message.includes("gpt-6.2-sol"));
check("model_not_found alone is enough", classifyFailure("gpt", "code: model_not_found", 1).kind === "model");
check("a usage limit is still quota", classifyFailure("gpt", "You've hit your usage limit", 1).kind === "quota");
check("a login problem is still auth", classifyFailure("gpt", "Please log in again", 1).kind === "auth");
check("anything else is still other", classifyFailure("gpt", "segfault", 1).kind === "other");

const reg = new AccountRegistry();
const sol = resolveModel("gpt", undefined, DEFAULT_LIMITS.gpt);
check("the GPT default is still the current Sol", sol === "gpt-6.2-sol", sol);
check("a login with nothing learned runs it as asked", reg.fitModel("gpt", sol) === "gpt-6.2-sol");

const instead = reg.markUnsupported("gpt", "gpt-6.2-sol", f.message);
check("after the failure the previous Sol is named", instead === "gpt-6.1-sol" && PREDECESSOR["gpt-6.2-sol"] === "gpt-6.1-sol", String(instead));
check("the default now runs as 6.1 Sol on that login", reg.fitModel("gpt", sol) === "gpt-6.1-sol");
check("not a lower rung", reg.fitModel("gpt", sol) !== "gpt-6.1-terra");
check("other rungs are untouched", reg.fitModel("gpt", "gpt-6.1-terra") === "gpt-6.1-terra" && reg.fitModel("gpt", "gpt-6-luna") === "gpt-6-luna" && reg.fitModel("gpt", "gpt-6.2-astra") === "gpt-6.2-astra");
check("6.1 Sol asked by name stays", reg.fitModel("gpt", "gpt-6.1-sol") === "gpt-6.1-sol");
check("the login itself stays usable", reg.get("gpt").status === "ok");
check("another login is not affected", reg.fitModel("claude", "sonnet") === "sonnet");

check("a model with no previous generation has nothing to fall back on", reg.markUnsupported("gpt", "gpt-6.1-terra", "x") === undefined && reg.fitModel("gpt", "gpt-6.1-terra") === "gpt-6.1-terra");
reg.markUnsupported("gpt", "gpt-6.1-sol", "x");
check("when the previous one is out too, the asked model is kept (the chair sees the failure)", reg.fitModel("gpt", "gpt-6.2-sol") === "gpt-6.2-sol");

// after the retry time the new model is tried again
const file = path.join(process.env.GENCOUNCIL_HOME, "accounts.json");
const stored = JSON.parse(fs.readFileSync(file, "utf8"));
for (const a of stored) if (a.unsupported) for (const k of Object.keys(a.unsupported)) a.unsupported[k] = new Date(Date.now() - 1000).toISOString();
fs.writeFileSync(file, JSON.stringify(stored));
check("a week later the new model is tried again", reg.fitModel("gpt", "gpt-6.2-sol") === "gpt-6.2-sol" && !reg.get("gpt").unsupported);

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall unsupported-model checks passed");
