import express from "express";
import path from "node:path";
import fs from "node:fs";
import { listRuleSets, listRuns, loadRun } from "../core/store";
import { answerQuestions, approvePlan, createRun, resolveConflict, startAnalysis } from "../agents/orchestrator";
import { compareRounds } from "../core/verdict";
import { isMockMode, readLogs } from "../llm/client";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/meta", (_req, res) => {
  const logs = readLogs();
  res.json({
    mockMode: isMockMode(),
    aiCalls: logs.length,
    aiCostUsd: logs.reduce((s, l) => s + l.costUsd, 0),
    aiErrors: logs.filter((l) => l.error).length,
  });
});

app.get("/api/rulesets", (_req, res) => res.json(listRuleSets()));
app.get("/api/runs", (_req, res) => res.json(listRuns()));

app.get("/api/runs/:id", (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

app.post("/api/runs", (req, res) => {
  const { title, requirementMd, ruleSetId, repoPath, baseBranch } = req.body ?? {};
  const errors: Record<string, string> = {};
  if (!title?.trim()) errors.title = "Give the task a short title.";
  if (!requirementMd?.trim()) errors.requirementMd = "Paste the requirement (Markdown or ticket text).";
  if (!repoPath?.trim() || !fs.existsSync(path.join(repoPath, ".git"))) errors.repoPath = "Path must be a local git repository.";
  if (!listRuleSets().some((r) => r.id === ruleSetId)) errors.ruleSetId = "Choose a rule set.";
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const run = createRun({ title, requirementMd, ruleSetId, repoPath, baseBranch: baseBranch || "main" });
  void startAnalysis(run); // long-running; UI polls
  res.status(201).json(run);
});

app.post("/api/runs/:id/answers", (req, res) => {
  const run = loadRun(req.params.id);
  if (!run || run.status !== "waiting_answers") return res.status(409).json({ error: "Run is not waiting for answers" });
  void answerQuestions(run, req.body.answers ?? {});
  res.json({ ok: true });
});

app.post("/api/runs/:id/conflicts", (req, res) => {
  const run = loadRun(req.params.id);
  if (!run || run.status !== "blocked_conflict") return res.status(409).json({ error: "Run has no open conflict" });
  void resolveConflict(run, req.body.decisions ?? {});
  res.json({ ok: true });
});

app.post("/api/runs/:id/approve-plan", (req, res) => {
  const run = loadRun(req.params.id);
  if (!run || run.status !== "waiting_plan_approval") return res.status(409).json({ error: "Run is not waiting for plan approval" });
  const approver = String(req.body.approver || "").trim();
  if (!approver) return res.status(400).json({ errors: { approver: "Enter your name to approve." } });
  void approvePlan(run, approver);
  res.json({ ok: true });
});

app.get("/api/runs/:id/compare", (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  const ra = run.rounds.find((r) => r.round === a)?.report;
  const rb = run.rounds.find((r) => r.round === b)?.report;
  if (!ra || !rb) return res.status(400).json({ error: "Both rounds need a review report" });
  res.json(compareRounds(ra.issues, rb.issues));
});

// Serve the built UI in production.
const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`API on http://localhost:${port} (${isMockMode() ? "mock model" : "live model"})`));
