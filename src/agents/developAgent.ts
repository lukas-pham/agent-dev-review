import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callJson, untrusted, UNTRUSTED_RULE } from "../llm/client";
import { arr, bool, en, obj, str } from "../llm/schema";
import { git, runCommand } from "../core/repo";
import { getRuleSet, log, saveRun } from "../core/store";
import type { Gap, Handoff, Issue, MatrixRow, Plan, Requirement, Run } from "../core/types";

/**
 * Agent Develop — D1..D11.
 * The pipeline is a state machine; every human gate (questions, conflicts, plan) is a stop.
 * Permissions: repo + dev store only, no merge/push, cannot touch rules or review reports.
 */

const PROMPT_VERSION = "develop-v0.1";
export const MAX_ROUNDS = 3; // D11

interface TargetConfig {
  checks: { name: string; command: string }[];
  coder: { command: string };
  protectedPaths: string[];
}
const targetConfig = (): TargetConfig => JSON.parse(fs.readFileSync(path.resolve("config/targets.json"), "utf8"));

const SYSTEM = `You are Agent Develop for Shopify apps. You must prove you understood the requirement and checked the rules BEFORE writing code.
${UNTRUSTED_RULE}
Be concrete. Acceptance criteria must be testable (an input, an action, an observable result).`;

// ---------- D1 + D2 ----------
export async function analyze(run: Run) {
  const result = await callJson<{ requirements: Requirement[]; gaps: Gap[] }>({
    promptId: "develop.analyze",
    promptVersion: PROMPT_VERSION,
    budgetKey: `run:${run.id}`,
    system: SYSTEM,
    user: `Split the requirement into REQ-01, REQ-02... items with testable acceptance criteria.
Then list missing information, contradictions and assumptions. Set blocking=true only when coding cannot start safely without a human answer, and write the question.

${untrusted("requirement", run.requirementMd)}`,
    schema: obj({
      requirements: arr(obj({ id: str("REQ-xx"), title: str(), acceptance: arr(str()), mandatory: bool() })),
      gaps: arr(obj({ type: en(["missing", "contradiction", "assumption"]), text: str(), blocking: bool(), question: str() })),
    }),
    mock: () => mockAnalyze(run.requirementMd),
  });
  run.requirements = result.requirements;
  run.gaps = result.gaps;
  log(run, "develop", `D1: ${result.requirements.length} requirement(s). D2: ${result.gaps.length} gap(s).`);
}

// ---------- D3 + D4 ----------
export async function matchRules(run: Run) {
  const rs = getRuleSet(run.ruleSetId);
  const result = await callJson<{ matrix: MatrixRow[] }>({
    promptId: "develop.match",
    promptVersion: PROMPT_VERSION,
    budgetKey: `run:${run.id}`,
    system: SYSTEM,
    user: `For every requirement x rule pair that is relevant, give relation:
- compliant: the planned behaviour satisfies the rule
- conflict: the requirement as written would violate the rule (give 1-3 options to resolve it)
- needs_measurement: only real data can prove it
- not_applicable
Include at least one row per requirement and one row per mandatory rule.

Requirements: ${JSON.stringify(run.requirements)}
Rules (${rs.id} v${rs.version}): ${JSON.stringify(rs.rules.map((r) => ({ code: r.code, title: r.title, mandatory: r.mandatory })))}`,
    schema: obj({
      matrix: arr(obj({ requirement: str(), rule: str(), relation: en(["compliant", "conflict", "needs_measurement", "not_applicable"]), note: str(), options: arr(str()) })),
    }),
    mock: () => ({
      matrix: run.requirements.flatMap((r) =>
        rs.rules.map((rule) => ({
          requirement: r.id,
          rule: rule.code,
          relation: rule.requiresRealData ? ("needs_measurement" as const) : ("not_applicable" as const),
          note: "mock: not analysed",
          options: [],
        })),
      ),
    }),
  });
  run.matrix = result.matrix;
  log(run, "develop", `D3: matrix with ${result.matrix.length} row(s).`);
}

/** D2/D4 gate — code, not the model, decides whether to stop. */
export function gate(run: Run): "ok" | "waiting_answers" | "blocked_conflict" {
  const unanswered = run.gaps.filter((g) => g.blocking && !g.answer?.trim());
  if (unanswered.length) return "waiting_answers";
  const rs = getRuleSet(run.ruleSetId);
  const mandatory = new Set(rs.rules.filter((r) => r.mandatory).map((r) => r.code));
  if (run.matrix.some((m) => m.relation === "conflict" && mandatory.has(m.rule))) return "blocked_conflict";
  return "ok";
}

// ---------- D5 ----------
export async function makePlan(run: Run) {
  const plan = await callJson<Plan>({
    promptId: "develop.plan",
    promptVersion: PROMPT_VERSION,
    budgetKey: `run:${run.id}`,
    system: SYSTEM,
    user: `Write the implementation plan: files to change (path, change, scope: server|backend|frontend), and tests to write, each linked to a REQ id.
Requirements: ${JSON.stringify(run.requirements)}
Answers from the human: ${JSON.stringify(run.gaps.filter((g) => g.answer))}
Rule matrix: ${JSON.stringify(run.matrix.filter((m) => m.relation !== "not_applicable"))}`,
    schema: obj({
      files: arr(obj({ path: str(), change: str(), scope: str() })),
      tests: arr(obj({ name: str(), requirement: str() })),
      notes: str(),
    }),
    mock: () => ({
      files: [{ path: "app/routes/app._index.tsx", change: "mock plan", scope: "frontend" }],
      tests: run.requirements.map((r) => ({ name: `${r.id} acceptance`, requirement: r.id })),
      notes: "Mock mode: plan generated without a model.",
    }),
  });
  run.plan = plan;
  log(run, "develop", `D5: plan with ${plan.files.length} file(s), ${plan.tests.length} test(s). Waiting for approval.`);
}

// ---------- D6 + D7 + D8 + D10 ----------
export async function implement(run: Run, fixIssues: Issue[] = []) {
  const cfg = targetConfig();
  const round = run.rounds.length + 1;
  run.branch ??= `agent/${run.id}`;
  const branches = await git(run.repoPath, ["branch", "--list", run.branch]);
  if (!branches.trim()) await git(run.repoPath, ["branch", run.branch, run.baseBranch]);
  await git(run.repoPath, ["checkout", run.branch]);
  log(run, "develop", `D6: working on branch ${run.branch} (round ${round}).`);

  const prompt = coderPrompt(run, cfg, fixIssues);
  const promptFile = path.join(os.tmpdir(), `develop-${run.id}-${round}.md`);
  fs.writeFileSync(promptFile, prompt);
  const coder = await runCommand(run.repoPath, cfg.coder.command.replace("{PROMPT_FILE}", promptFile), 45 * 60_000);
  log(run, "develop", `Coder finished with exit code ${coder.exitCode}.`);

  // D8: run checks, give the coder up to 2 more attempts to fix failures.
  let checks = await runChecks(run.repoPath, cfg);
  for (let attempt = 0; attempt < 2 && checks.some((c) => c.exitCode !== 0); attempt++) {
    const failing = checks.filter((c) => c.exitCode !== 0);
    fs.writeFileSync(promptFile, `${prompt}\n\nThese checks fail, fix them without weakening or deleting tests:\n${JSON.stringify(failing, null, 2)}`);
    await runCommand(run.repoPath, cfg.coder.command.replace("{PROMPT_FILE}", promptFile), 45 * 60_000);
    checks = await runChecks(run.repoPath, cfg);
  }

  // Protected paths: the develop agent may not change rules or review reports.
  const changed = (await git(run.repoPath, ["diff", "--name-only", `${run.baseBranch}...HEAD`])).split("\n").filter(Boolean);
  const touched = changed.filter((f) => cfg.protectedPaths.some((p) => f.startsWith(p)));
  if (touched.length) {
    await git(run.repoPath, ["checkout", run.baseBranch, "--", ...touched]);
    log(run, "system", `Reverted edits to protected paths: ${touched.join(", ")}`);
  }

  await git(run.repoPath, ["add", "-A"]);
  await git(run.repoPath, ["commit", "--allow-empty", "-m", `agent: round ${round} for ${run.title}`]).catch(() => "");
  const handoff = await buildHandoff(run, round, checks);
  run.rounds.push({ round, handoff });
  log(run, "develop", `D9: handoff written for round ${round}.`);
}

async function runChecks(repo: string, cfg: TargetConfig) {
  const out = [];
  for (const c of cfg.checks) out.push(await runCommand(repo, c.command));
  return out;
}

function coderPrompt(run: Run, cfg: TargetConfig, fixIssues: Issue[]) {
  return `# Task: ${run.title}
You are implementing an approved plan inside this repository only.
Rules:
- Work only on the current branch. Never push, merge, deploy or touch production.
- Never edit: ${cfg.protectedPaths.join(", ")}.
- Write code AND tests for every REQ item. Never delete, skip or weaken existing tests.
- Before writing any Shopify GraphQL or API call, verify it with the Shopify Dev MCP / AI Toolkit (search docs, validate the query). Do not write APIs from memory.
- Run: ${cfg.checks.map((c) => c.command).join(" ; ")} and fix until they pass.

## Requirements
${run.requirements.map((r) => `- ${r.id} ${r.title}\n${r.acceptance.map((a) => `  - [ ] ${a}`).join("\n")}`).join("\n")}

## Human answers
${run.gaps.filter((g) => g.answer).map((g) => `- ${g.question}: ${g.answer}`).join("\n") || "- none"}

## Approved plan
${JSON.stringify(run.plan, null, 2)}
${fixIssues.length ? `\n## Review issues to fix (fix each one, then stop)\n${JSON.stringify(fixIssues, null, 2)}` : ""}`;
}

async function buildHandoff(run: Run, round: number, checks: Handoff["checks"]): Promise<Handoff> {
  const diffStat = await git(run.repoPath, ["diff", "--stat", `${run.baseBranch}...HEAD`]);
  const files = (await git(run.repoPath, ["diff", "--name-only", `${run.baseBranch}...HEAD`])).split("\n").filter(Boolean);
  const mapped = await callJson<{ mapping: Handoff["mapping"]; assumptions: string[]; notDone: string[] }>({
    promptId: "develop.handoff",
    promptVersion: PROMPT_VERSION,
    budgetKey: `run:${run.id}`,
    system: SYSTEM,
    user: `Map each requirement to the changed files and tests. List assumptions and anything not done. Be honest: unfinished items must be listed.
Requirements: ${JSON.stringify(run.requirements.map((r) => ({ id: r.id, title: r.title })))}
Changed files: ${JSON.stringify(files)}`,
    schema: obj({
      mapping: arr(obj({ requirement: str(), files: arr(str()), tests: arr(str()) })),
      assumptions: arr(str()),
      notDone: arr(str()),
    }),
    mock: () => ({
      mapping: run.requirements.map((r) => ({ requirement: r.id, files, tests: files.filter((f) => /test|spec/.test(f)) })),
      assumptions: [],
      notDone: ["Mock mode: mapping not analysed"],
    }),
  });
  return {
    round,
    diffStat,
    ...mapped,
    checks,
    claims: checks.every((c) => c.exitCode === 0) ? "All checks pass." : "Some checks fail.",
  };
}

// ---------- mock helpers ----------
function mockAnalyze(md: string): { requirements: Requirement[]; gaps: Gap[] } {
  const bullets = md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+|^\d+\.\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+|^\d+\.\s+/, ""));
  const items = (bullets.length ? bullets : [md.split("\n")[0] || "Requirement"]).slice(0, 20);
  return {
    requirements: items.map((t, i) => ({
      id: `REQ-${String(i + 1).padStart(2, "0")}`,
      title: t,
      acceptance: [`Mock: verify "${t}" manually`],
      mandatory: true,
    })),
    gaps: [{ type: "assumption", text: "Mock mode: no real analysis was performed.", blocking: false, question: "" }],
  };
}

export async function persist(run: Run) {
  saveRun(run);
}
