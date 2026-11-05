import type { Run } from "../types";

export const STATUS_TEXT: Record<Run["status"], { label: string; needsYou: boolean; busy: boolean }> = {
  analyzing: { label: "Analysing requirement", needsYou: false, busy: true },
  waiting_answers: { label: "Waiting for your answers", needsYou: true, busy: false },
  blocked_conflict: { label: "Blocked: rule conflict", needsYou: true, busy: false },
  waiting_plan_approval: { label: "Waiting for plan approval", needsYou: true, busy: false },
  developing: { label: "Writing code", needsYou: false, busy: true },
  reviewing: { label: "Reviewing", needsYou: false, busy: true },
  fixing: { label: "Fixing review issues", needsYou: false, busy: true },
  waiting_human_decision: { label: "Ready for your merge decision", needsYou: true, busy: false },
  escalated: { label: "Escalated to a human", needsYou: true, busy: false },
  error: { label: "Error", needsYou: true, busy: false },
};

export const STEPS = [
  { key: "analyze", label: "1. Analyse" },
  { key: "match", label: "2. Check rules" },
  { key: "plan", label: "3. Plan (you approve)" },
  { key: "develop", label: "4. Develop" },
  { key: "review", label: "5. Review" },
  { key: "decide", label: "6. You decide" },
] as const;

export function stepState(run: Run): Record<string, "done" | "current" | "stopped" | "todo"> {
  const order = ["analyze", "match", "plan", "develop", "review", "decide"];
  const at: Record<Run["status"], [string, "current" | "stopped"]> = {
    analyzing: ["analyze", "current"],
    waiting_answers: ["analyze", "stopped"],
    blocked_conflict: ["match", "stopped"],
    waiting_plan_approval: ["plan", "stopped"],
    developing: ["develop", "current"],
    fixing: ["develop", "current"],
    reviewing: ["review", "current"],
    waiting_human_decision: ["decide", "stopped"],
    escalated: ["decide", "stopped"],
    error: [order[0], "stopped"],
  };
  const [cur, kind] = at[run.status];
  const idx = order.indexOf(cur);
  return Object.fromEntries(order.map((k, i) => [k, i < idx ? "done" : i === idx ? kind : "todo"]));
}
