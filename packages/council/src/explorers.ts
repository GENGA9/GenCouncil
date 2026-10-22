/**
 * Read-only explorer subagents for claude members (Claude Code `--agents` JSON).
 * Haiku maps the repo, finds call sites and pulls docs so the Sonnet main session
 * spends its context on the actual change.
 */
export const EXPLORER_MODEL = "haiku";

export function explorerAgents(model = EXPLORER_MODEL): Record<string, { description: string; prompt: string; tools: string[]; model: string }> {
  const readOnly = ["Read", "Glob", "Grep"];
  return {
    search: {
      description: "Maps the repository: which files, folders and modules relate to a topic. Read-only. Use before planning a change.",
      prompt:
        "You are a read-only repository explorer. Given a topic or feature, find the relevant files and folders and explain in one line each why they matter. " +
        "Answer with paths and short notes, newest/most central first. Never edit files, never run commands.",
      tools: readOnly,
      model,
    },
    grep: {
      description: "Finds call sites, definitions and usages of a symbol, string or pattern across the repo. Read-only.",
      prompt:
        "You are a read-only code finder. Given a symbol, string or regex, list every definition and usage as `path:line` with the matching line, grouped by file. " +
        "Flag the one that defines it. Never edit files, never run commands.",
      tools: readOnly,
      model,
    },
    docs: {
      description: "Pulls the relevant API reference or documentation from the repo (README, docs/, comments, type definitions). Read-only.",
      prompt:
        "You are a read-only documentation reader. Given an API, library or module name, find and summarise how it is used in this repo: signatures, options, examples, gotchas. " +
        "Quote the source path for each fact. Never edit files, never run commands.",
      tools: readOnly,
      model,
    },
  };
}
