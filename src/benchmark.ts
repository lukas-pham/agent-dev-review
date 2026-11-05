import fs from "node:fs";
import path from "node:path";
import { reviewOnly } from "./agents/orchestrator";
import { fingerprint } from "./core/verdict";
import type { Issue, Verdict } from "./core/types";

/**
 * Benchmark runner.
 * Each case folder: case.json = { repoPath, baseBranch, branch, ruleSetId, clean: boolean,
 *   expected: [{ rule?, requirement?, file, severity }] } and requirement.md
 * Metrics (targets from the spec):
 *   detection >= 80% of seeded bugs, 100% of blockers; clean PRs failed <= 10%;
 *   same verdict in 3 runs >= 90% of PRs.
 * Publish the real numbers, including misses and false positives.
 */

interface Case {
  repoPath: string;
  baseBranch: string;
  branch: string;
  ruleSetId: string;
  clean: boolean;
  expected: { rule?: string; requirement?: string; file: string; severity: Issue["severity"] }[];
}

const RUNS = Number(process.env.BENCH_RUNS || 3);
const root = path.resolve("benchmark/cases");
const cases = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "case.json")));

let seeded = 0, found = 0, blockers = 0, blockersFound = 0, cleanCount = 0, cleanFailed = 0, consistent = 0;
const rows: unknown[] = [];

for (const id of cases) {
  const c = JSON.parse(fs.readFileSync(path.join(root, id, "case.json"), "utf8")) as Case;
  if (!fs.existsSync(c.repoPath)) {
    console.log(`skip ${id}: repo ${c.repoPath} not found`);
    continue;
  }
  const requirementMd = fs.readFileSync(path.join(root, id, "requirement.md"), "utf8");
  const verdicts: Verdict[] = [];
  let firstIssues: Issue[] = [];
  for (let i = 0; i < RUNS; i++) {
    const run = await reviewOnly({ runId: `${id}-${i}`, requirementMd, ...c });
    const rep = run.rounds[0].report!;
    verdicts.push(rep.verdict);
    if (i === 0) firstIssues = rep.issues;
  }
  if (verdicts.every((v) => v === verdicts[0])) consistent++;

  const hit = (e: Case["expected"][number]) =>
    firstIssues.some((i) => i.evidence.some((ev) => ev.kind === "code" && ev.file === e.file) && (!e.rule || i.rule === e.rule));
  for (const e of c.expected) {
    seeded++;
    if (hit(e)) found++;
    if (e.severity === "blocker") {
      blockers++;
      if (hit(e)) blockersFound++;
    }
  }
  if (c.clean) {
    cleanCount++;
    if (verdicts[0] === "fail") cleanFailed++;
  }
  rows.push({ id, verdicts, expected: c.expected.length, reported: firstIssues.map(fingerprint) });
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const summary = {
  cases: rows.length,
  detection: pct(found, seeded),
  blockerDetection: pct(blockersFound, blockers),
  cleanFalseFail: pct(cleanFailed, cleanCount),
  consistency: pct(consistent, rows.length),
  rows,
};
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/benchmark-result.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
