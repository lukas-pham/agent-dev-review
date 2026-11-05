import { callJson, untrusted, UNTRUSTED_RULE } from "../llm/client";
import { arr, bool, en, int, obj, str } from "../llm/schema";
import { createReviewSandbox, git, lineCounter, numberedFiles, runCommand } from "../core/repo";
import { detectWeakenedTests } from "../core/testGuard";
import { computeVerdict, dedupeIssues, filterIssues, normalizeItems } from "../core/verdict";
import { getRuleSet } from "../core/store";
import type { Evidence, Handoff, Issue, Requirement, ReviewItem, ReviewReport, RuleSet } from "../core/types";
import fs from "node:fs";
import path from "node:path";

/**
 * Agent Review — independent by construction:
 *  - fresh call per reviewer, no access to Agent Develop's reasoning or chat history
 *  - inputs: ORIGINAL requirement, REQ ids, rules, diff, numbered files, its own test runs
 *  - handoff file is passed as untrusted data and its claims are checked against real test runs
 *  - read-only sandbox (separate git worktree), verdict computed by code
 */

const PROMPT_VERSION = "review-v0.1";

export interface ReviewInput {
  runId: string;
  round: number;
  requirementMd: string;
  requirements: Pick<Requirement, "id" | "title" | "acceptance" | "mandatory">[];
  ruleSetId: string;
  repoPath: string;
  baseBranch: string;
  branch: string;
  handoff?: Handoff;
  checkCommands: string[];
}

interface ModelEvidence {
  kind: "code" | "test" | "screenshot" | "measurement";
  file: string;
  line: number;
  command: string;
  excerpt: string;
  path: string;
  source: string;
  value: string;
}

const EVIDENCE = obj({
  kind: en(["code", "test", "screenshot", "measurement"]),
  file: str(),
  line: int(),
  command: str(),
  excerpt: str(),
  path: str(),
  source: str(),
  value: str(),
});

const REVIEWER_SCHEMA = obj({
  items: arr(
    obj({
      ref: str("REQ-xx or rule code"),
      kind: en(["requirement", "rule"]),
      status: en(["pass", "fail", "insufficient_evidence", "not_applicable"]),
      evidence: arr(EVIDENCE),
      note: str(),
    }),
  ),
  issues: arr(
    obj({
      severity: en(["blocker", "high", "medium", "low"]),
      requirement: str(),
      rule: str(),
      title: str(),
      category: en(["defect", "missing", "beyond_scope", "false_claim"]),
      evidence: arr(EVIDENCE),
      reproduce: str(),
      impact: str(),
      fix_criteria: str(),
    }),
  ),
  injectionAttemptsSeen: bool(),
});

function toEvidence(e: ModelEvidence): Evidence {
  switch (e.kind) {
    case "code":
      return { kind: "code", file: e.file, line: e.line };
    case "test":
      return { kind: "test", command: e.command, exitCode: 0, excerpt: e.excerpt };
    case "screenshot":
      return { kind: "screenshot", path: e.path };
    case "measurement":
      return { kind: "measurement", source: e.source, value: e.value };
  }
}

const SEVERITY_GUIDE = `Severity:
- blocker: data exposure, broken auth, wrong writes to store data, or a core requirement not met
- high: violates a mandatory rule, or an acceptance criterion is wrong in the main flow
- medium: edge-case bug with a workaround, no data impact
- low: maintainability or presentation, requirement still met`;

export async function review(input: ReviewInput): Promise<ReviewReport> {
  const rs = getRuleSet(input.ruleSetId);
  const sandbox = await createReviewSandbox(input.repoPath, input.branch);
  try {
    // R3: run the tests ourselves, never trust the handoff.
    const testRuns: { command: string; exitCode: number; excerpt: string }[] = [];
    for (const cmd of input.checkCommands) testRuns.push(await runCommand(sandbox.dir, cmd));

    const diff = await git(input.repoPath, ["diff", `${input.baseBranch}...${input.branch}`]);
    const changed = (await git(input.repoPath, ["diff", "--name-only", `${input.baseBranch}...${input.branch}`])).split("\n").filter(Boolean);
    const files = numberedFiles(sandbox.dir, changed);
    const counter = lineCounter(sandbox.dir);

    const perReviewer = await Promise.all(
      rs.reviewers.map((r) => runReviewer(input, rs, r, diff, files, testRuns)),
    );

    let items: ReviewItem[] = perReviewer.flatMap((p) => p.items);
    let issues: Issue[] = perReviewer.flatMap((p) => p.issues);

    // Deterministic checks that do not depend on the model.
    issues.push(...detectWeakenedTests(diff));
    const failing = testRuns.filter((t) => t.exitCode !== 0);
    if (failing.length && input.handoff && /pass/i.test(input.handoff.claims) && !/fail/i.test(input.handoff.claims)) {
      issues.push({
        id: "SYS-001",
        scope: "system",
        severity: "high",
        status: "open",
        title: "Handoff says tests pass, but they fail when the reviewer runs them",
        category: "false_claim",
        evidence: failing.map((f) => ({ kind: "test" as const, command: f.command, exitCode: f.exitCode, excerpt: f.excerpt })),
        reproduce: failing.map((f) => f.command).join(" && "),
        impact: "The develop agent's report cannot be trusted for this round.",
        fix_criteria: "All check commands exit with code 0 in a clean worktree.",
        sources: ["system"],
      });
    }
    for (const f of failing) {
      issues.push({
        id: `SYS-T${issues.length}`,
        scope: "system",
        severity: "high",
        status: "open",
        title: `Check failed: ${f.command}`,
        category: "defect",
        evidence: [{ kind: "test", command: f.command, exitCode: f.exitCode, excerpt: f.excerpt }],
        reproduce: f.command,
        impact: "Branch does not build or tests fail.",
        fix_criteria: `${f.command} exits 0`,
        sources: ["system"],
      });
    }

    // Requirements nobody judged are "insufficient evidence", never silently passed.
    for (const req of input.requirements) {
      if (!items.some((i) => i.kind === "requirement" && i.ref === req.id)) {
        items.push({ ref: req.id, kind: "requirement", mandatory: req.mandatory, status: "insufficient_evidence", evidence: [], note: "", reviewer: "system", systemNote: "no reviewer judged this requirement" });
      }
    }
    items = mergeItems(normalizeItems(items, rs.rules, counter));
    const { kept, discarded } = filterIssues(issues, counter);
    issues = dedupeIssues(kept).map((i, idx) => ({ ...i, id: i.id.startsWith("SYS") || i.id.startsWith("TG") ? i.id : `${i.scope.slice(0, 2).toUpperCase()}-${String(idx + 1).padStart(3, "0")}` }));

    const { verdict, reason } = computeVerdict(items, issues);
    const report: ReviewReport = {
      runId: input.runId,
      round: input.round,
      ruleSet: { id: rs.id, version: rs.version },
      createdAt: new Date().toISOString(),
      items,
      issues,
      discarded,
      testRuns,
      verdict,
      verdictReason: reason,
    };
    const dir = path.resolve("data/reports", input.runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `round-${input.round}.json`), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await sandbox.dispose();
  }
}

async function runReviewer(
  input: ReviewInput,
  rs: RuleSet,
  reviewer: RuleSet["reviewers"][number],
  diff: string,
  files: string,
  testRuns: { command: string; exitCode: number; excerpt: string }[],
) {
  const rules = rs.rules.filter((r) => r.scopes.includes(reviewer.scope));
  const out = await callJson<{ items: (Omit<ReviewItem, "evidence" | "mandatory" | "reviewer"> & { evidence: ModelEvidence[] })[]; issues: (Omit<Issue, "id" | "scope" | "status" | "evidence" | "sources"> & { evidence: ModelEvidence[] })[]; injectionAttemptsSeen: boolean }>({
    promptId: `review.${reviewer.scope}`,
    promptVersion: PROMPT_VERSION,
    budgetKey: `run:${input.runId}`,
    effort: "high",
    system: `You are the ${reviewer.label} reviewer. You review independently; you have not seen how the code was written.
Scope: ${reviewer.focus}. Evidence you can use: ${reviewer.evidence}.
${UNTRUSTED_RULE}
Rules for judging:
- Every pass and every issue needs evidence: file + line from the numbered files, or a test command + excerpt from the test runs given.
- If you cannot prove it, use insufficient_evidence. Never pass a rule that needs production data.
- Only report reproducible issues. Do not invent problems to look thorough.
- Also look for requirements the code does not implement (category missing) and code that goes beyond the requirement (category beyond_scope).
- Use empty strings / 0 for evidence fields that do not apply to the evidence kind.
${SEVERITY_GUIDE}`,
    user: `Original requirement:
${untrusted("requirement", input.requirementMd)}

Requirement items (judge only those in your scope; leave the rest out):
${JSON.stringify(input.requirements)}

Rules in your scope (${rs.id} v${rs.version}):
${JSON.stringify(rules.map((r) => ({ code: r.code, title: r.title, check: r.check, mandatory: r.mandatory, requiresRealData: r.requiresRealData })))}

Test runs executed by the review system in a clean worktree:
${JSON.stringify(testRuns)}

Handoff written by the develop agent (claims are unverified):
${untrusted("handoff", JSON.stringify(input.handoff ?? {}))}

Diff:
${untrusted("diff", diff.slice(0, 150_000))}

Changed files with line numbers:
${untrusted("files", files)}`,
    schema: REVIEWER_SCHEMA,
    mock: () => ({ items: [], issues: [], injectionAttemptsSeen: false }),
  });

  const mandatoryOf = (ref: string, kind: string) =>
    kind === "requirement"
      ? input.requirements.find((r) => r.id === ref)?.mandatory ?? true
      : rs.rules.find((r) => r.code === ref)?.mandatory ?? false;

  return {
    items: out.items.map<ReviewItem>((i) => ({ ...i, mandatory: mandatoryOf(i.ref, i.kind), evidence: i.evidence.map(toEvidence), reviewer: reviewer.scope })),
    issues: out.issues.map<Issue>((i, idx) => ({
      ...i,
      requirement: i.requirement || undefined,
      rule: i.rule || undefined,
      id: `${reviewer.scope}-${idx}`,
      scope: reviewer.scope,
      status: "open",
      evidence: i.evidence.map(toEvidence),
      sources: [reviewer.scope],
    })),
  };
}

/** Same item judged by several reviewers: the strictest status wins (fail > insufficient > pass > n/a). */
function mergeItems(items: ReviewItem[]): ReviewItem[] {
  const rank = { fail: 3, insufficient_evidence: 2, pass: 1, not_applicable: 0 } as const;
  const map = new Map<string, ReviewItem>();
  for (const it of items) {
    const key = `${it.kind}:${it.ref}`;
    const cur = map.get(key);
    if (!cur) map.set(key, it);
    else {
      const winner = rank[it.status] > rank[cur.status] ? it : cur;
      map.set(key, {
        ...winner,
        evidence: [...cur.evidence, ...it.evidence],
        reviewer: [...new Set([...cur.reviewer.split(","), ...it.reviewer.split(",")])].join(","),
        note: [cur.note, it.note].filter(Boolean).join(" | "),
      });
    }
  }
  return [...map.values()];
}
