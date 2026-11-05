import { useEffect, useState } from "react";
import { api } from "../api";

interface Meta { mockMode: boolean; aiCalls: number; aiCostUsd: number; aiErrors: number }

export function MetaBar() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    api<Meta>("/api/meta").then(setMeta).catch(() => setMeta(null));
  }, []);
  if (!meta) return null;
  return (
    <span className="muted" title="Every model call is logged with prompt version, tokens, latency and errors">
      {meta.mockMode ? <span className="badge b-medium">Mock model — no API key</span> : <span className="badge b-pass">Live model</span>}{" "}
      {meta.aiCalls} AI calls · ${meta.aiCostUsd.toFixed(2)} · {meta.aiErrors} errors
    </span>
  );
}
