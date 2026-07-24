/**
 * Relay-side blob exchange. Imported file payloads are content-addressed
 * (sha256) and never enter the CRDT — peers fetch missing blobs over HTTP
 * from the relay. This module is deliberately tiny and dependency-free so
 * the document store can use it without importing the collab stack.
 */

let relayHttpBase: string | null = null;

/** Set by the collab store on connect/disconnect. */
export function setRelayHttpBase(url: string | null): void {
  relayHttpBase = url;
}

export async function fetchRelayBlob(hash: string): Promise<string | null> {
  if (!relayHttpBase) return null;
  try {
    const res = await fetch(`${relayHttpBase}/blobs/${hash}`);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export async function pushRelayBlob(
  hash: string,
  content: string,
): Promise<void> {
  if (!relayHttpBase) return;
  try {
    await fetch(`${relayHttpBase}/blobs/${hash}`, {
      method: "PUT",
      body: content,
    });
  } catch {
    // relay unreachable — peer will fetch from another source or error visibly
  }
}
