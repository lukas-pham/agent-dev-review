import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as develop from "./developAgent";
import { review } from "./reviewAgent";
import { log, saveRun } from "../core/store";
import type { Run } from "../core/types";

/**
 * Flow:
 *  analyze -> match -> [gate: questions/conflict = stop] -> plan -> [human approves]
 *  -> develop -> review -> fail & round<3 ? fix -> review : human decision
 *  "pass" and "conditional_pass" both go to a human. There is no auto-merge path.
 */

const checkCommands = () =>
  (JSON.parse(fs.readFileSync(path.resolve("config/targets.json"), "utf8")).checks as { command: string }[]).map((c) => c.command);

export function createRun(input: { title: string; requirementMd: string; ruleSetId: string; repoPath: string; baseBranch: string }): Run {
  const run: Run = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: "analyzing",
    ...input,
    requirements: [],
    gaps: [],
    matrix: [],
    rounds: [],
    events: [],
  };
  log(run, "human", "Run created");
  saveRun(run);
  return run;
}

async function step(run: Run, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    run.status = "error";
    run.statusDetail = (err as Error).message;
    log(run, "system", `Error: ${(err as Error).message}`);
  }
  saveRun(run);
}

export async function startAnalysis(run: Run) {
  await step(run, async () => {
    run.status = "analyzing";
    await develop.analyze(run);
    await develop.matchRules(run);
    await afterGate(run);
  });
}

async function afterGate(run: Run) {
  const g = develop.gate(run);
  if (g === "waiting_answers") {
    run.status = "waiting_answers";
    run.statusDetail = "Agent Develop has blocking questions. Answer them to continue.";
    log(run, "develop", "D2: stopped — blocking questions.");
    return;
  }
  if (g === "blocked_conflict") {
    run.status = "blocked_conflict";
    run.statusDetail = "Requirement conflicts with a mandatory rule. Pick an option or edit the requirement.";
    log(run, "develop", "D4: stopped — conflict with a mandatory rule.");
    return;
  }
  await develop.makePlan(run);
  run.status = "waiting_plan_approval";
  run.statusDetail = "Review the plan and approve it before any code is written.";
}

export async function answerQuestions(run: Run, answers: Record<number, string>) {
  await step(run, async () => {
    run.gaps = run.gaps.map((g, i) => (answers[i] !== undefined ? { ...g, answer: answers[i] } : g));
    log(run, "human", `Answered ${Object.keys(answers).length} question(s).`);
    await afterGate(run);
  });
}

export async function resolveConflict(run: Run, decisions: Record<number, string>) {
  await step(run, async () => {
    run.matrix = run.matrix.map((m, i) =>
      decisions[i] ? { ...m, relation: "compliant", note: `${m.note} — human decision: ${decisions[i]}` } : m,
    );
    log(run, "human", `Resolved ${Object.keys(decisions).length} conflict(s).`);
    await afterGate(run);
  });
}

export async function approvePlan(run: Run, approver: string) {
  run.planApprovedBy = approver;
  log(run, "human", `Plan approved by ${approver}.`);
  await developAndReview(run);
}

async function developAndReview(run: Run) {
  await step(run, async () => {
    const last = run.rounds.at(-1)?.report;
    run.status = last ? "fixing" : "developing";
    saveRun(run);
    await develop.implement(run, last ? last.issues.filter((i) => i.status === "open") : []);

    run.status = "reviewing";
    saveRun(run);
    const round = run.rounds.at(-1)!;
    round.report = await review({
      runId: run.id,
      round: round.round,
      requirementMd: run.requirementMd,
      requirements: run.requirements,
      ruleSetId: run.ruleSetId,
      repoPath: run.repoPath,
      baseBranch: run.baseBranch,
      branch: run.branch!,
      handoff: round.handoff,
      checkCommands: checkCommands(),
    });
    log(run, "review", `Round ${round.round}: ${round.report.verdict} — ${round.report.verdictReason}`);

    if (round.report.verdict === "fail") {
      if (run.rounds.length >= develop.MAX_ROUNDS) {
        run.status = "escalated";
        run.statusDetail = `Still failing after ${develop.MAX_ROUNDS} rounds. A human must take over.`;
        return;
      }
      saveRun(run);
      return developAndReview(run); // D10: next round
    }
    run.status = "waiting_human_decision";
    run.statusDetail = "Review finished. A human decides whether to merge. The system never merges.";
  });
}

/** Review an existing branch without running Agent Develop (used by the benchmark). */
export async function reviewOnly(input: { runId: string; requirementMd: string; ruleSetId: string; repoPath: string; baseBranch: string; branch: string }) {
  const run = createRun({ title: `Review ${input.branch}`, requirementMd: input.requirementMd, ruleSetId: input.ruleSetId, repoPath: input.repoPath, baseBranch: input.baseBranch });
  await develop.analyze(run);
  run.branch = input.branch;
  run.rounds.push({ round: 1 });
  run.status = "reviewing";
  run.rounds[0].report = await review({ ...input, runId: run.id, round: 1, requirements: run.requirements, checkCommands: checkCommands() });
  run.status = "waiting_human_decision";
  saveRun(run);
  return run;
}
