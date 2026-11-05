import type { Issue } from "./types";

/**
 * Deterministic detector for "develop agent edited the tests to get past review".
 * Works on a unified diff (git diff base...branch).
 */

const TEST_FILE = /(^|\/)(__tests__|tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.py$|test_[^/]+\.py$/;
const ASSERTION = /\b(expect|assert\w*|should)\s*[.(]|\.to(Be|Equal|Throw|Match|Have)\w*\(/;
const CASE = /\b(it|test|describe)\s*\(/;
const SKIP = /\b(it|test|describe)\.(skip|todo)\(|\bx(it|describe|test)\(|@pytest\.mark\.skip|\.only\(/;
const TRIVIAL = /expect\((true|1|"[^"]*")\)\.toBe\(\1\)|assert\s+True\b/;

interface FileDiff {
  file: string;
  deleted: boolean;
  added: { line: number; text: string }[];
  removed: string[];
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { file: m ? m[1] : "?", deleted: false, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (raw.startsWith("deleted file mode")) cur.deleted = true;
    else if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/);
      newLine = m ? Number(m[1]) : 1;
    } else if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    else if (raw.startsWith("+")) cur.added.push({ line: newLine++, text: raw.slice(1) });
    else if (raw.startsWith("-")) cur.removed.push(raw.slice(1));
    else newLine++;
  }
  return files;
}

export function detectWeakenedTests(diff: string): Issue[] {
  const issues: Issue[] = [];
  let n = 0;
  const make = (file: string, line: number, title: string, severity: Issue["severity"]): Issue => ({
    id: `TG-${String(++n).padStart(3, "0")}`,
    scope: "test-guard",
    severity,
    status: "open",
    title,
    category: "test_weakened",
    evidence: [{ kind: "code", file, line: Math.max(line, 1) }],
    reproduce: `Inspect the diff of ${file}`,
    impact: "Tests no longer protect the feature; review results cannot be trusted.",
    fix_criteria: "Restore the removed/disabled tests or replace them with equally strict ones.",
    sources: ["test-guard"],
  });

  for (const f of parseUnifiedDiff(diff)) {
    if (!TEST_FILE.test(f.file)) continue;
    if (f.deleted) {
      // Deleted file has no new lines; point at line 1 of the path (evidence is the diff itself).
      issues.push({ ...make(f.file, 1, `Test file deleted: ${f.file}`, "high"), evidence: [{ kind: "test", command: `git diff -- ${f.file}`, exitCode: 0, excerpt: "deleted file mode" }] });
      continue;
    }
    const removedAsserts = f.removed.filter((l) => ASSERTION.test(l)).length;
    const addedAsserts = f.added.filter((l) => ASSERTION.test(l.text)).length;
    const removedCases = f.removed.filter((l) => CASE.test(l)).length;
    const addedCases = f.added.filter((l) => CASE.test(l.text)).length;
    const firstLine = f.added[0]?.line ?? 1;
    if (removedAsserts > addedAsserts) {
      issues.push(make(f.file, firstLine, `${removedAsserts - addedAsserts} assertion(s) removed in ${f.file}`, "high"));
    }
    if (removedCases > addedCases) {
      issues.push(make(f.file, firstLine, `${removedCases - addedCases} test case(s) removed in ${f.file}`, "high"));
    }
    for (const a of f.added) {
      if (SKIP.test(a.text)) issues.push(make(f.file, a.line, `Test disabled or focused: "${a.text.trim()}"`, "high"));
      else if (TRIVIAL.test(a.text)) issues.push(make(f.file, a.line, `Trivial assertion always passes: "${a.text.trim()}"`, "medium"));
    }
  }
  return issues;
}
