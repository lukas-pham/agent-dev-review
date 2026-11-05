import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, post } from "../api";
import type { Evidence, Issue, Run } from "../types";
import { Badge } from "../components/Badge";
import { STATUS_TEXT, STEPS, stepState } from "./statusText";

type Tab = "action" | "matrix" | "report" | "compare" | "log";

export function RunPage() {
  const { id } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("action");

  const load = () => api<Run>(`/api/runs/${id}`).then(setRun).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [id]);

  if (error) return <div className="banner error">{error}</div>;
  if (!run) return <div className="empty"><span className="spinner" /> Loading…</div>;

  const st = STATUS_TEXT[run.status];
  const steps = stepState(run);
  const report = run.rounds.at(-1)?.report;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: "0 0 12px" }}>{run.title}</h2>
        <span className="muted small">Rule set {run.ruleSetId} · branch {run.branch ?? "not created yet"}</span>
      </div>

      <div className="stepper">
        {STEPS.map((s) => (
          <div key={s.key} className={`step ${steps[s.key]}`}>{s.label}</div>
        ))}
      </div>

      <div className={`banner ${run.status === "error" ? "error" : st.needsYou ? "action" : "info"}`}>
        <strong>{st.busy && <span className="spinner" />} {st.label}</strong>
        {run.statusDetail && <div className="small">{run.statusDetail}</div>}
      </div>

      <div className="tabs" role="tablist">
        {([
          ["action", "Overview"],
          ["matrix", `Requirements × rules (${run.matrix.length})`],
          ["report", `Review report${report ? ` · round ${report.round}` : ""}`],
          ["compare", "Compare rounds"],
          ["log", "Activity"],
        ] as [Tab, string][]).map(([k, label]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)} role="tab" aria-selected={tab === k}>{label}</button>
        ))}
      </div>

      {tab === "action" && <ActionPanel run={run} onChange={load} />}
      {tab === "matrix" && <Matrix run={run} />}
      {tab === "report" && <Report run={run} />}
      {tab === "compare" && <Compare run={run} />}
      {tab === "log" && (
        <div className="card">
          <table><tbody>
            {run.events.map((e, i) => (
              <tr key={i}><td className="muted small">{new Date(e.at).toLocaleTimeString()}</td><td><strong>{e.actor}</strong></td><td>{e.message}</td></tr>
            ))}
          </tbody></table>
        </div>
      )}
    </>
  );
}

function ActionPanel({ run, onChange }: { run: Run; onChange: () => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [decisions, setDecisions] = useState<Record<number, string>>({});
  const [approver, setApprover] = useState("");
  const [err, setErr] = useState("");

  const send = async (url: string, data: unknown) => {
    setErr("");
    try {
      await post(url, data);
      onChange();
    } catch (e) {
      const body = (e as { body?: { errors?: Record<string, string> } }).body;
      setErr(body?.errors ? Object.values(body.errors).join(" ") : (e as Error).message);
    }
  };

  return (
    <>
      {run.status === "waiting_answers" && (
        <div className="card">
          <h2>Questions from Agent Develop</h2>
          <p className="muted small">Coding will not start until these are answered.</p>
          {run.gaps.map((g, i) => g.blocking && (
            <div key={i}>
              <label htmlFor={`q${i}`}>{g.question || g.text}</label>
              <input id={`q${i}`} value={answers[i] ?? ""} onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} />
            </div>
          ))}
          <button className="primary" style={{ marginTop: 12 }} onClick={() => send(`/api/runs/${run.id}/answers`, { answers })}>Send answers</button>
        </div>
      )}

      {run.status === "blocked_conflict" && (
        <div className="card">
          <h2>Conflicts with mandatory rules</h2>
          {run.matrix.map((m, i) => m.relation === "conflict" && (
            <div key={i} className="issue">
              <h3>{m.requirement} × {m.rule}</h3>
              <p className="small">{m.note}</p>
              <label htmlFor={`c${i}`}>Your decision</label>
              <select id={`c${i}`} value={decisions[i] ?? ""} onChange={(e) => setDecisions({ ...decisions, [i]: e.target.value })}>
                <option value="">Choose an option…</option>
                {(m.options ?? []).map((o) => <option key={o}>{o}</option>)}
              </select>
            </div>
          ))}
          <button className="primary" onClick={() => send(`/api/runs/${run.id}/conflicts`, { decisions })}>Continue with these decisions</button>
        </div>
      )}

      {run.status === "waiting_plan_approval" && run.plan && (
        <div className="card">
          <h2>Plan — approve before code is written</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>File</th><th>Scope</th><th>Change</th></tr></thead>
            <tbody>{run.plan.files.map((f) => <tr key={f.path}><td><code>{f.path}</code></td><td>{f.scope}</td><td>{f.change}</td></tr>)}</tbody>
          </table></div>
          <h3 className="small">Tests to write</h3>
          <ul className="small">{run.plan.tests.map((t) => <li key={t.name}>{t.requirement}: {t.name}</li>)}</ul>
          {run.plan.notes && <p className="muted small">{run.plan.notes}</p>}
          <label htmlFor="approver">Your name (recorded with the approval)</label>
          <div className="row">
            <input id="approver" style={{ maxWidth: 280 }} value={approver} onChange={(e) => setApprover(e.target.value)} />
            <button className="primary" onClick={() => send(`/api/runs/${run.id}/approve-plan`, { approver })}>Approve plan & start coding</button>
          </div>
        </div>
      )}

      {err && <div className="banner error">{err}</div>}

      <div className="grid2">
        <div className="card">
          <h2>Requirements ({run.requirements.length})</h2>
          {run.requirements.length === 0 ? <p className="muted">Not analysed yet.</p> : (
            <ul className="small">
              {run.requirements.map((r) => (
                <li key={r.id}><strong>{r.id}</strong> {r.title} {r.mandatory ? "" : <span className="muted">(optional)</span>}
                  <ul>{r.acceptance.map((a) => <li key={a} className="muted">{a}</li>)}</ul>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Gaps, contradictions, assumptions</h2>
          {run.gaps.length === 0 ? <p className="muted">None found.</p> : (
            <ul className="small">{run.gaps.map((g, i) => (
              <li key={i}><Badge value={g.blocking ? "high" : "low"} /> <strong>{g.type}</strong>: {g.text}{g.answer && <div className="muted">Answer: {g.answer}</div>}</li>
            ))}</ul>
          )}
        </div>
      </div>

      {run.rounds.at(-1)?.report && (
        <div className="card">
          <h2>Latest verdict</h2>
          <div className="row"><Badge value={run.rounds.at(-1)!.report!.verdict} /><span className="small">{run.rounds.at(-1)!.report!.verdictReason}</span></div>
          <p className="muted small">The verdict is computed by fixed rules in code, not by the model. Merge is always your decision.</p>
        </div>
      )}
    </>
  );
}

function Matrix({ run }: { run: Run }) {
  const [hideNa, setHideNa] = useState(true);
  const rows = run.matrix.filter((m) => !hideNa || m.relation !== "not_applicable");
  const report = run.rounds.at(-1)?.report;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Requirement × rule matrix</h2>
        <label className="small" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={hideNa} onChange={(e) => setHideNa(e.target.checked)} /> Hide “not applicable”</label>
      </div>
      {rows.length === 0 ? <div className="empty">No rows.</div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Requirement</th><th>Rule</th><th>Plan check (Develop)</th><th>Review result</th><th>Note</th></tr></thead>
          <tbody>{rows.map((m, i) => {
            const item = report?.items.find((it) => it.ref === m.rule);
            return (
              <tr key={i}><td>{m.requirement}</td><td>{m.rule}</td><td><Badge value={m.relation} /></td>
                <td>{item ? <Badge value={item.status} /> : <span className="muted">—</span>}</td><td className="small">{m.note}</td></tr>
            );
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}

function EvidenceLink({ e, run }: { e: Evidence; run: Run }) {
  if (e.kind === "code") return <a href={`vscode://file/${run.repoPath}/${e.file}:${e.line}`}>{e.file}:{e.line}</a>;
  if (e.kind === "test") return <span>test <code>{e.command}</code> → exit {e.exitCode}</span>;
  if (e.kind === "screenshot") return <span>screenshot {e.path}</span>;
  return <span>{e.source}: {e.value}</span>;
}

function IssueCard({ issue, run }: { issue: Issue; run: Run }) {
  return (
    <div className="issue">
      <h3><Badge value={issue.severity} /> {issue.id} · {issue.title}</h3>
      <dl className="kv">
        <dt>Scope</dt><dd>{issue.scope} {issue.sources.length > 1 && <span className="muted">(also: {issue.sources.join(", ")})</span>}</dd>
        {issue.requirement && <><dt>Requirement</dt><dd>{issue.requirement}</dd></>}
        {issue.rule && <><dt>Rule</dt><dd>{issue.rule}</dd></>}
        <dt>Evidence</dt><dd>{issue.evidence.map((e, i) => <div key={i}><EvidenceLink e={e} run={run} /></div>)}</dd>
        <dt>Reproduce</dt><dd>{issue.reproduce}</dd>
        <dt>Impact</dt><dd>{issue.impact}</dd>
        <dt>Fixed when</dt><dd>{issue.fix_criteria}</dd>
      </dl>
    </div>
  );
}

function Report({ run }: { run: Run }) {
  const [round, setRound] = useState<number | null>(null);
  const reports = run.rounds.filter((r) => r.report).map((r) => r.report!);
  if (!reports.length) return <div className="card empty">No review yet. The report appears after Agent Develop hands over a branch.</div>;
  const rep = reports.find((r) => r.round === round) ?? reports.at(-1)!;
  const insufficient = rep.items.filter((i) => i.status === "insufficient_evidence");
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="verdict"><Badge value={rep.verdict} /></div>
            <div className="small">{rep.verdictReason}</div>
            <div className="muted small">Rule set {rep.ruleSet.id} v{rep.ruleSet.version} · {new Date(rep.createdAt).toLocaleString()}</div>
          </div>
          <select style={{ width: "auto" }} value={rep.round} onChange={(e) => setRound(Number(e.target.value))}>
            {reports.map((r) => <option key={r.round} value={r.round}>Round {r.round}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        <h2>Issues ({rep.issues.length})</h2>
        {rep.issues.length === 0 ? <p className="muted">No verified issues.</p> : rep.issues.map((i) => <IssueCard key={i.id} issue={i} run={run} />)}
      </div>

      {insufficient.length > 0 && (
        <div className="card">
          <h2>Not enough evidence ({insufficient.length})</h2>
          <p className="muted small">These items could not be proven either way. They are never counted as Pass.</p>
          <ul className="small">{insufficient.map((i) => <li key={i.ref}><strong>{i.ref}</strong> — {i.systemNote || i.note}</li>)}</ul>
        </div>
      )}

      <div className="card">
        <h2>All checked items</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Item</th><th>Status</th><th>Evidence</th><th>Reviewer</th></tr></thead>
          <tbody>{rep.items.map((i) => (
            <tr key={i.kind + i.ref}><td>{i.ref}{i.mandatory && " *"}</td><td><Badge value={i.status} /></td>
              <td className="small">{i.evidence.map((e, k) => <div key={k}><EvidenceLink e={e} run={run} /></div>)}{i.systemNote && <div className="muted">{i.systemNote}</div>}</td>
              <td className="small">{i.reviewer}</td></tr>
          ))}</tbody>
        </table></div>
        <p className="muted small">* mandatory</p>
      </div>

      <div className="card">
        <h2>Tests run by the reviewer</h2>
        {rep.testRuns.map((t) => (
          <details key={t.command}><summary><Badge value={t.exitCode === 0 ? "pass" : "fail"} /> <code>{t.command}</code></summary><pre>{t.excerpt}</pre></details>
        ))}
      </div>

      {rep.discarded.length > 0 && (
        <div className="card">
          <h2>Discarded findings ({rep.discarded.length})</h2>
          <p className="muted small">Reported by a reviewer but rejected by the system because they could not be verified.</p>
          <ul className="small">{rep.discarded.map((d, i) => <li key={i}>{d.issue.title} — <span className="muted">{d.reason}</span></li>)}</ul>
        </div>
      )}
    </>
  );
}

function Compare({ run }: { run: Run }) {
  const rounds = run.rounds.filter((r) => r.report).map((r) => r.round);
  const [a, setA] = useState(rounds[0]);
  const [b, setB] = useState(rounds.at(-1));
  const [data, setData] = useState<{ resolved: Issue[]; stillOpen: Issue[]; introduced: Issue[] } | null>(null);
  useEffect(() => {
    if (a && b && a !== b) api<typeof data>(`/api/runs/${run.id}/compare?a=${a}&b=${b}`).then(setData);
  }, [a, b]);
  if (rounds.length < 2) return <div className="card empty">Comparison appears once there are at least two review rounds.</div>;
  const col = (title: string, list: Issue[]) => (
    <div className="card"><h2>{title} ({list.length})</h2>{list.map((i) => <div key={i.id} className="small"><Badge value={i.severity} /> {i.title}</div>)}</div>
  );
  return (
    <>
      <div className="row">
        <span>Compare round</span>
        <select style={{ width: "auto" }} value={a} onChange={(e) => setA(Number(e.target.value))}>{rounds.map((r) => <option key={r}>{r}</option>)}</select>
        <span>with</span>
        <select style={{ width: "auto" }} value={b} onChange={(e) => setB(Number(e.target.value))}>{rounds.map((r) => <option key={r}>{r}</option>)}</select>
      </div>
      {data && <div className="grid2" style={{ marginTop: 12 }}>{col("Resolved", data.resolved)}{col("Still open", data.stillOpen)}{col("New in later round", data.introduced)}</div>}
    </>
  );
}
