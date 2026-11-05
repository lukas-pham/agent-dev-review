import { useEffect, useState } from "react";
import { api } from "../api";
import type { RuleSet } from "../types";

export function RulesPage() {
  const [sets, setSets] = useState<RuleSet[]>([]);
  useEffect(() => {
    api<RuleSet[]>("/api/rulesets").then(setSets);
  }, []);
  return (
    <>
      <p className="muted small">Rules are versioned data files in <code>rules/</code>. Change them without touching the agents. Agent Develop cannot edit them.</p>
      {sets.map((s) => (
        <div className="card" key={s.id}>
          <h2>{s.id} · v{s.version} <span className="muted small">updated {s.updatedAt}</span></h2>
          <p className="small muted">{s.description}</p>
          <p className="small"><strong>Reviewers:</strong> {s.reviewers.map((r) => r.label).join(", ")}</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Code</th><th>Rule</th><th>Scope</th><th>How it is checked</th><th>Mandatory</th></tr></thead>
            <tbody>{s.rules.map((r) => (
              <tr key={r.code}><td>{r.code}</td><td>{r.title}</td><td>{r.scopes.join(", ")}</td>
                <td>{r.check.join(", ")}{r.requiresRealData && <div className="muted small">needs real data — never passes on code alone</div>}</td>
                <td>{r.mandatory ? "Yes" : "No"}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      ))}
    </>
  );
}
