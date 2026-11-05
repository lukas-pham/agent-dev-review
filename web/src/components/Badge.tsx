const LABELS: Record<string, string> = {
  pass: "Pass",
  fail: "Fail",
  conditional_pass: "Conditional pass",
  insufficient_evidence: "Not enough evidence",
  not_applicable: "Not applicable",
  compliant: "Compliant",
  conflict: "Conflict",
  needs_measurement: "Needs real data",
  blocker: "Blocker",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function Badge({ value }: { value: string }) {
  return <span className={`badge b-${value}`}>{LABELS[value] ?? value}</span>;
}
