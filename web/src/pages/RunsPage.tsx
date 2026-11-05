import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, post } from "../api";
import type { Run, RuleSet } from "../types";
import { STATUS_TEXT } from "./statusText";

const EXAMPLE = `# Home page metrics
- Home page shows how many products are missing a description
- Merchant can start a catalog scan from the home page
- Errors from the scan appear next to the button and do not disappear`;

export function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [form, setForm] = useState({ title: "", requirementMd: "", ruleSetId: "bfs", repoPath: "", baseBranch: "main" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    api<Run[]>("/api/runs").then(setRuns);
    api<RuleSet[]>("/api/rulesets").then(setRuleSets);
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const run = await post<Run>("/api/runs", form);
      nav(`/runs/${run.id}`);
    } catch (err) {
      setErrors((err as { body?: { errors?: Record<string, string> } }).body?.errors ?? { form: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const field = (k: string) => (errors[k] ? "has-error" : "");

  return (
    <>
      <div className="card">
        <h2>Start a task</h2>
        <p className="muted small">
          Agent Develop turns the requirement into REQ items, checks them against the rule set, and stops to ask you before writing any code.
          Agent Review then checks the branch independently. You always make the final merge decision.
        </p>
        <form onSubmit={submit}>
          <div className="grid2">
            <div className={field("title")}>
              <label htmlFor="title">Task title</label>
              <input id="title" value={form.title} onChange={set("title")} placeholder="Home page metrics" />
              {errors.title && <div className="field-error">{errors.title}</div>}
            </div>
            <div className={field("ruleSetId")}>
              <label htmlFor="rs">Rule set</label>
              <select id="rs" value={form.ruleSetId} onChange={set("ruleSetId")}>
                {ruleSets.map((r) => (
                  <option key={r.id} value={r.id}>{r.id} v{r.version} — {r.rules.length} rules</option>
                ))}
              </select>
              {errors.ruleSetId && <div className="field-error">{errors.ruleSetId}</div>}
            </div>
            <div className={field("repoPath")}>
              <label htmlFor="repo">Local repo path</label>
              <input id="repo" value={form.repoPath} onChange={set("repoPath")} placeholder="/home/me/apps/product-enrichment" />
              {errors.repoPath && <div className="field-error">{errors.repoPath}</div>}
            </div>
            <div>
              <label htmlFor="base">Base branch</label>
              <input id="base" value={form.baseBranch} onChange={set("baseBranch")} />
            </div>
          </div>
          <div className={field("requirementMd")}>
            <label htmlFor="req">Requirement (Markdown or ticket text)</label>
            <textarea id="req" value={form.requirementMd} onChange={set("requirementMd")} placeholder={EXAMPLE} />
            {errors.requirementMd && <div className="field-error">{errors.requirementMd}</div>}
          </div>
          {errors.form && <div className="field-error">{errors.form}</div>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy}>{busy ? "Starting…" : "Analyse requirement"}</button>
            <button type="button" onClick={() => setForm({ ...form, title: "Home page metrics", requirementMd: EXAMPLE })}>Fill example</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Tasks</h2>
        {runs.length === 0 ? (
          <div className="empty">No tasks yet. Start one above.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Task</th><th>Status</th><th>Rounds</th><th>Last verdict</th><th>Created</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/runs/${r.id}`}>{r.title}</Link></td>
                    <td>{STATUS_TEXT[r.status].label}</td>
                    <td>{r.rounds.length}</td>
                    <td>{r.rounds.at(-1)?.report?.verdict ?? "—"}</td>
                    <td className="muted small">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
