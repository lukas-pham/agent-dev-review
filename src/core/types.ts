import { z } from "zod";

// ---------- Rules (versioned data, editable without touching agents) ----------
export const CheckMethod = z.enum(["code_read", "run", "screenshot", "real_data", "external_dashboard"]);
export const Scope = z.string(); // e.g. "server" | "backend" | "frontend" | "finance-controls" ...

export const Rule = z.object({
  code: z.string(),
  title: z.string(),
  scopes: z.array(Scope),
  check: z.array(CheckMethod),
  mandatory: z.boolean(),
  /** Can only be judged from production / dashboard data, never from code. */
  requiresRealData: z.boolean().default(false),
  source: z.string().optional(),
});
export type Rule = z.infer<typeof Rule>;

export const RuleSet = z.object({
  id: z.string(),
  version: z.string(),
  updatedAt: z.string(),
  description: z.string(),
  reviewers: z.array(z.object({ scope: Scope, label: z.string(), focus: z.string(), evidence: z.string() })),
  rules: z.array(Rule),
});
export type RuleSet = z.infer<typeof RuleSet>;

// ---------- Develop agent artefacts ----------
export const Requirement = z.object({
  id: z.string(), // REQ-01
  title: z.string(),
  acceptance: z.array(z.string()),
  mandatory: z.boolean(),
});
export type Requirement = z.infer<typeof Requirement>;

export const Gap = z.object({
  type: z.enum(["missing", "contradiction", "assumption"]),
  text: z.string(),
  blocking: z.boolean(),
  question: z.string().optional(),
  answer: z.string().optional(),
});
export type Gap = z.infer<typeof Gap>;

export const Relation = z.enum(["compliant", "conflict", "needs_measurement", "not_applicable"]);
export const MatrixRow = z.object({
  requirement: z.string(),
  rule: z.string(),
  relation: Relation,
  note: z.string(),
  options: z.array(z.string()).optional(), // proposals when relation=conflict
});
export type MatrixRow = z.infer<typeof MatrixRow>;

export const Plan = z.object({
  files: z.array(z.object({ path: z.string(), change: z.string(), scope: z.string() })),
  tests: z.array(z.object({ name: z.string(), requirement: z.string() })),
  notes: z.string().optional(),
});
export type Plan = z.infer<typeof Plan>;

// ---------- Review artefacts ----------
export const Evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), file: z.string(), line: z.number().int().positive(), note: z.string().optional() }),
  z.object({ kind: z.literal("test"), command: z.string(), exitCode: z.number(), excerpt: z.string() }),
  z.object({ kind: z.literal("screenshot"), path: z.string(), note: z.string().optional() }),
  z.object({ kind: z.literal("measurement"), source: z.string(), value: z.string() }),
]);
export type Evidence = z.infer<typeof Evidence>;

export const ItemStatus = z.enum(["pass", "fail", "insufficient_evidence", "not_applicable"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const ReviewItem = z.object({
  ref: z.string(), // REQ-01 or rule code
  kind: z.enum(["requirement", "rule"]),
  mandatory: z.boolean(),
  status: ItemStatus,
  evidence: z.array(Evidence),
  note: z.string(),
  reviewer: z.string(),
  /** Set when the system (not the model) changed the status. */
  systemNote: z.string().optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const Severity = z.enum(["blocker", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const Issue = z.object({
  id: z.string(),
  scope: z.string(),
  severity: Severity,
  status: z.enum(["open", "fixed"]),
  requirement: z.string().optional(),
  rule: z.string().optional(),
  title: z.string(),
  evidence: z.array(Evidence),
  reproduce: z.string(),
  impact: z.string(),
  fix_criteria: z.string(),
  /** Reviewers that reported it (kept after de-duplication, R7). */
  sources: z.array(z.string()),
  /** "beyond_scope" = code does more than the requirement asked (R4). */
  category: z.enum(["defect", "missing", "beyond_scope", "test_weakened", "false_claim"]).default("defect"),
});
export type Issue = z.infer<typeof Issue>;

export const Verdict = z.enum(["pass", "conditional_pass", "fail"]);
export type Verdict = z.infer<typeof Verdict>;

export interface ReviewReport {
  runId: string;
  round: number;
  ruleSet: { id: string; version: string };
  createdAt: string;
  items: ReviewItem[];
  issues: Issue[];
  /** Issues the model reported without verifiable evidence — shown, never counted. */
  discarded: { issue: Partial<Issue>; reason: string }[];
  testRuns: { command: string; exitCode: number; excerpt: string }[];
  verdict: Verdict;
  verdictReason: string;
}

export type RunStatus =
  | "analyzing"
  | "waiting_answers"
  | "blocked_conflict"
  | "waiting_plan_approval"
  | "developing"
  | "reviewing"
  | "fixing"
  | "waiting_human_decision"
  | "escalated"
  | "error";

export interface Run {
  id: string;
  title: string;
  createdAt: string;
  status: RunStatus;
  statusDetail?: string;
  requirementMd: string;
  ruleSetId: string;
  repoPath: string;
  baseBranch: string;
  branch?: string;
  requirements: Requirement[];
  gaps: Gap[];
  matrix: MatrixRow[];
  plan?: Plan;
  planApprovedBy?: string;
  rounds: { round: number; handoff?: Handoff; report?: ReviewReport }[];
  events: { at: string; actor: "develop" | "review" | "human" | "system"; message: string }[];
}

export interface Handoff {
  round: number;
  diffStat: string;
  mapping: { requirement: string; files: string[]; tests: string[] }[];
  assumptions: string[];
  notDone: string[];
  checks: { command: string; exitCode: number; excerpt: string }[];
  /** What the develop agent claims; the reviewer never trusts this. */
  claims: string;
}
