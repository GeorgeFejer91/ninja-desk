import type VDONinja from "@vdoninja/sdk";

type Pair = { local: string; remote: string };

function normalized(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const fingerprint = value.replace(/:/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : null;
}

export async function fingerprints(sdk: VDONinja, peer: string, role: "publisher" | "viewer"): Promise<Pair> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const entries = (await sdk.getStats(peer))[peer]?.filter((entry) => entry.connectionType === role) ?? [];
    const transport = entries.find((entry) => entry.type === "transport" && typeof entry.localCertificateId === "string" && typeof entry.remoteCertificateId === "string");
    if (transport) {
      const local = normalized(entries.find((entry) => entry.id === transport.localCertificateId)?.fingerprint);
      const remote = normalized(entries.find((entry) => entry.id === transport.remoteCertificateId)?.fingerprint);
      if (local && remote) return { local, remote };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("WebRTC certificate fingerprints unavailable");
}
