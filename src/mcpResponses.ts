// Shared response envelope helpers for the GenLayer MCP tools.
// Every tool returns the same canonical shape so clients can parse uniformly.

import { formatJson } from "./genlayerRpc.js";

export function makeCanonicalResponse(input: {
  kind: string;
  summary: string;
  currentState: Record<string, unknown>;
  blockers: string[];
  nextActions: string[];
  fallbacks: string[];
  data: unknown;
}) {
  return {
    kind: input.kind,
    summary: input.summary,
    current_state: input.currentState,
    blockers: input.blockers,
    next_actions: input.nextActions,
    fallbacks: input.fallbacks,
    data: input.data
  };
}

export function isCanonicalEnvelope(value: unknown): value is ReturnType<typeof makeCanonicalResponse> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "kind" in (value as Record<string, unknown>) &&
    "summary" in (value as Record<string, unknown>)
  );
}

export function textEnvelope(envelope: ReturnType<typeof makeCanonicalResponse>) {
  return {
    content: [
      {
        type: "text" as const,
        text: formatJson(envelope)
      }
    ]
  };
}
