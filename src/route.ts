type Entry = Record<string, unknown> & { connectionType: "publisher" | "viewer" };

export function iceRoute(entries: Entry[], role: "publisher" | "viewer"): "Direct" | "Relayed" | "Route unknown" {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const transport = entries.find((entry) => entry.connectionType === role && entry.type === "transport" && typeof entry.selectedCandidatePairId === "string");
  const pair = byId.get(transport?.selectedCandidatePairId);
  const local = byId.get(pair?.localCandidateId);
  const remote = byId.get(pair?.remoteCandidateId);
  if (!local || !remote) return "Route unknown";
  if (local.candidateType === "relay" || remote.candidateType === "relay") return "Relayed";
  if (["host", "srflx", "prflx"].includes(String(local.candidateType)) && ["host", "srflx", "prflx"].includes(String(remote.candidateType))) return "Direct";
  return "Route unknown";
}
