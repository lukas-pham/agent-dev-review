import { describe, expect, it } from "vitest";
import { computeVerdict, compareRounds, dedupeIssues, filterIssues, normalizeItems } from "../src/core/verdict";
import type { Issue, ReviewItem, Rule } from "../src/core/types";

const lines = (f: string) => (f === "app/a.ts" ? 50 : null);
const rule = (code: string, extra: Partial<Rule> = {}): Rule => ({ code, title: code, scopes: ["backend"], check: ["code_read"], mandatory: true, requiresRealData: false, ...extra });
const item = (over: Partial<ReviewItem>): ReviewItem => ({ ref: "REQ-01", kind: "requirement", mandatory: true, status: "pass", evidence: [{ kind: "code", file: "app/a.ts", line: 3 }], note: "", reviewer: "backend", ...over });
const issue = (over: Partial<Issue>): Issue => ({ id: "X", scope: "backend", severity: "low", status: "open", title: "t", evidence: [{ kind: "code", file: "app/a.ts", line: 10 }], reproduce: "r", impact: "i", fix_criteria: "f", sources: ["backend"], category: "defect", ...over });

describe("normalizeItems", () => {
  it("downgrades pass without evidence", () => {
    const [out] = normalizeItems([item({ evidence: [] })], [], lines);
    expect(out.status).toBe("insufficient_evidence");
  });
  it("removes evidence pointing to non-existent lines", () => {
    const [out] = normalizeItems([item({ evidence: [{ kind: "code", file: "app/a.ts", line: 999 }] })], [], lines);
    expect(out.status).toBe("insufficient_evidence");
    expect(out.evidence).toHaveLength(0);
  });
  it("never passes a real-data rule on code alone", () => {
    const [out] = normalizeItems([item({ ref: "BFS 2.1.1", kind: "rule" })], [rule("BFS 2.1.1", { requiresRealData: true })], lines);
    expect(out.status).toBe("insufficient_evidence");
  });
});

describe("filterIssues", () => {
  it("discards issues without verifiable evidence", () => {
    const { kept, discarded } = filterIssues([issue({ evidence: [{ kind: "code", file: "nope.ts", line: 1 }] }), issue({})], lines);
    expect(kept).toHaveLength(1);
    expect(discarded).toHaveLength(1);
  });
});

describe("computeVerdict", () => {
  it("fails on a high issue", () => {
    expect(computeVerdict([item({})], [issue({ severity: "high" })]).verdict).toBe("fail");
  });
  it("fails when a mandatory requirement fails", () => {
    expect(computeVerdict([item({ status: "fail" })], []).verdict).toBe("fail");
  });
  it("conditional pass on medium issue or insufficient evidence", () => {
    expect(computeVerdict([item({})], [issue({ severity: "medium" })]).verdict).toBe("conditional_pass");
    expect(computeVerdict([item({ status: "insufficient_evidence" })], []).verdict).toBe("conditional_pass");
  });
  it("passes with only low issues", () => {
    expect(computeVerdict([item({})], [issue({ severity: "low" })]).verdict).toBe("pass");
  });
  it("ignores fixed issues", () => {
    expect(computeVerdict([item({})], [issue({ severity: "blocker", status: "fixed" })]).verdict).toBe("pass");
  });
});

describe("dedupe and compare", () => {
  it("merges duplicates and keeps all sources and the higher severity", () => {
    const out = dedupeIssues([issue({ rule: "BFS 3.1.1", severity: "medium" }), issue({ rule: "BFS 3.1.1", severity: "high", scope: "frontend", sources: ["frontend"], evidence: [{ kind: "code", file: "app/a.ts", line: 12 }] })]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
    expect(out[0].sources.sort()).toEqual(["backend", "frontend"]);
  });
  it("classifies resolved, still open and new issues", () => {
    const a = issue({ rule: "A" });
    const b = issue({ rule: "B" });
    const c = issue({ rule: "C" });
    const r = compareRounds([a, b], [b, c]);
    expect(r.resolved.map((i) => i.rule)).toEqual(["A"]);
    expect(r.stillOpen.map((i) => i.rule)).toEqual(["B"]);
    expect(r.introduced.map((i) => i.rule)).toEqual(["C"]);
  });
});
