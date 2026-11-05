import fs from "node:fs";
import path from "node:path";
import { RuleSet, type Run } from "./types";

const DATA = path.resolve("data/runs");
const RULES = path.resolve("rules");

export function saveRun(run: Run) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, `${run.id}.json`), JSON.stringify(run, null, 2));
}

export function loadRun(id: string): Run | null {
  const file = path.join(DATA, `${path.basename(id)}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Run) : null;
}

export function listRuns(): Run[] {
  if (!fs.existsSync(DATA)) return [];
  return fs
    .readdirSync(DATA)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) as Run)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listRuleSets(): RuleSet[] {
  return fs
    .readdirSync(RULES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => RuleSet.parse(JSON.parse(fs.readFileSync(path.join(RULES, f), "utf8"))));
}

export function getRuleSet(id: string): RuleSet {
  const rs = listRuleSets().find((r) => r.id === id);
  if (!rs) throw new Error(`Unknown rule set ${id}`);
  return rs;
}

export function log(run: Run, actor: Run["events"][number]["actor"], message: string) {
  run.events.push({ at: new Date().toISOString(), actor, message });
}
