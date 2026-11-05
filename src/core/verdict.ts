import type { Issue, ReviewItem, Rule, Verdict, Evidence, Severity } from "./types";

/**
 * Everything in this file is deterministic code on purpose:
 * the model never decides the final verdict, and a "pass" without proof is impossible.
 */

/** File/line check used to reject made-up evidence. Injected so tests can fake the repo. */
export type LineCounter = (file: string) => number | null;

export function isEvidenceVerifiable(e: Evidence, lineCount: LineCounter): boolean {
  switch (e.kind) {
    case "code": {
      const n = lineCount(e.file);
      return n !== null && e.line >= 1 && e.line <= n;
    }
    case "test":
      return e.command.trim().length > 0;
    case "screenshot":
      return e.path.trim().length > 0;
    case "measurement":
      return e.source.trim().length > 0 && e.value.trim().length > 0;
  }
}

/**
 * R1/R2 + "Đạt mà không có căn cứ": strips unverifiable evidence and downgrades
 *  - pass with no remaining evidence           -> insufficient_evidence
 *  - pass on a real-data rule without a measurement -> insufficient_evidence
 */
export function normalizeItems(items: ReviewItem[], rules: Rule[], lineCount: LineCounter): ReviewItem[] {
  const byCode = new Map(rules.map((r) => [r.code, r]));
  return items.map((item) => {
    const evidence = item.evidence.filter((e) => isEvidenceVerifiable(e, lineCount));
    const out: ReviewItem = { ...item, evidence };
    const dropped = item.evidence.length - evidence.length;
    const notes: string[] = [];
    if (dropped > 0) notes.push(`${dropped} evidence reference(s) could not be verified and were removed`);

    if (out.status === "pass" && evidence.length === 0) {
      out.status = "insufficient_evidence";
      notes.push("marked Pass without verifiable evidence");
    }
    const rule = item.kind === "rule" ? byCode.get(item.ref) : undefined;
    if (rule?.requiresRealData && out.status === "pass" && !evidence.some((e) => e.kind === "measurement")) {
      out.status = "insufficient_evidence";
      notes.push("rule needs real production data; code alone cannot prove it");
    }
    if (notes.length) out.systemNote = notes.join("; ");
    return out;
  });
}

/** Issues must be reproducible: no verifiable evidence or no repro steps -> discarded (still shown). */
export function filterIssues(issues: Issue[], lineCount: LineCounter) {
  const kept: Issue[] = [];
  const discarded: { issue: Partial<Issue>; reason: string }[] = [];
  for (const issue of issues) {
    const evidence = issue.evidence.filter((e) => isEvidenceVerifiable(e, lineCount));
    if (evidence.length === 0) discarded.push({ issue, reason: "no verifiable evidence (file/line, test output or screenshot)" });
    else if (!issue.reproduce.trim() || !issue.fix_criteria.trim())
      discarded.push({ issue, reason: "missing reproduction steps or fix criteria" });
    else kept.push({ ...issue, evidence });
  }
  return { kept, discarded };
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 4, high: 3, medium: 2, low: 1 };

/** Fingerprint used both for de-duplication (R7) and for round-to-round comparison (R8). */
export function fingerprint(issue: Pick<Issue, "rule" | "requirement" | "evidence" | "category">): string {
  const code = issue.evidence.find((e) => e.kind === "code") as Extract<Evidence, { kind: "code" }> | undefined;
  const fileKey = code ? `${code.file}#${Math.floor(code.line / 10)}` : "-";
  return [issue.rule ?? "-", issue.requirement ?? "-", issue.category, fileKey].join("|");
}

/** R7: merge duplicates across scopes, keep the highest severity and every reporting reviewer. */
export function dedupeIssues(issues: Issue[]): Issue[] {
  const map = new Map<string, Issue>();
  for (const issue of issues) {
    const key = fingerprint(issue);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...issue, sources: [...new Set(issue.sources)] });
      continue;
    }
    const stronger = SEVERITY_RANK[issue.severity] > SEVERITY_RANK[existing.severity] ? issue : existing;
    map.set(key, {
      ...stronger,
      id: existing.id,
      sources: [...new Set([...existing.sources, ...issue.sources])],
      evidence: [...existing.evidence, ...issue.evidence].filter(
        (e, i, all) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(e)) === i,
      ),
    });
  }
  return [...map.values()];
}

/** Fixed verdict rules from the spec. The LLM never produces this value. */
export function computeVerdict(items: ReviewItem[], issues: Issue[]): { verdict: Verdict; reason: string } {
  const open = issues.filter((i) => i.status === "open");
  const blocking = open.filter((i) => i.severity === "blocker" || i.severity === "high");
  const failedReq = items.filter((i) => i.kind === "requirement" && i.mandatory && i.status === "fail");
  if (blocking.length || failedReq.length) {
    const parts = [];
    if (blocking.length) parts.push(`${blocking.length} blocker/high issue(s)`);
    if (failedReq.length) parts.push(`mandatory requirement failed: ${failedReq.map((i) => i.ref).join(", ")}`);
    return { verdict: "fail", reason: parts.join("; ") };
  }

  const medium = open.filter((i) => i.severity === "medium");
  const insufficient = items.filter((i) => i.status === "insufficient_evidence");
  const mandatoryNotPassed = items.filter((i) => i.kind === "requirement" && i.mandatory && i.status !== "pass");
  if (medium.length || insufficient.length || mandatoryNotPassed.length) {
    const parts = [];
    if (medium.length) parts.push(`${medium.length} medium issue(s)`);
    if (insufficient.length) parts.push(`${insufficient.length} item(s) without enough evidence`);
    const unproven = mandatoryNotPassed.filter((i) => i.status !== "insufficient_evidence");
    if (unproven.length) parts.push(`mandatory requirement not proven: ${unproven.map((i) => i.ref).join(", ")}`);
    return { verdict: "conditional_pass", reason: parts.join("; ") };
  }
  return { verdict: "pass", reason: "all mandatory requirements pass; only low issues or none" };
}

/** R8: compare two rounds. */
export function compareRounds(prev: Issue[], curr: Issue[]) {
  const currByKey = new Map(curr.map((i) => [fingerprint(i), i]));
  const prevKeys = new Set(prev.map(fingerprint));
  return {
    resolved: prev.filter((i) => i.status === "open" && !currByKey.has(fingerprint(i))),
    stillOpen: prev.filter((i) => i.status === "open" && currByKey.has(fingerprint(i))),
    introduced: curr.filter((i) => !prevKeys.has(fingerprint(i))),
  };
}
