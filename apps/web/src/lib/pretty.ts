import type { PartDocument } from "@voltcad/model-api";

/**
 * Translate internal identifiers into human language for the UI.
 * Internal names ("ext_h4/side:rect1/e0", edge "A|B") are precise and stable
 * but hostile to read — every user-facing surface should pass through here.
 */

/** Map a feature id to its display name. */
function featureName(id: string, doc: PartDocument): string {
  return doc.features.find((f) => f.id === id)?.name ?? id;
}

/** One face-name part → "Extrude 1 · side rect1/e0". */
function prettyFacePart(part: string, doc: PartDocument): string {
  const slash = part.indexOf("/");
  if (slash < 0) return part;
  const owner = featureName(part.slice(0, slash), doc);
  const local = part
    .slice(slash + 1)
    .replace("side:", "side ")
    .replace("cap:", "cap ")
    .replace("face:", "face ")
    .replace("rev:", "rev ");
  return `${owner} · ${local}`;
}

/** Persistent entity name → readable description. */
export function prettyEntityName(
  name: string,
  kind: string,
  doc: PartDocument,
): string {
  if (kind === "edge" && name.includes("|")) {
    // an edge is the intersection of its two adjacent faces
    const [a, b] = name.split("|");
    return `${prettyFacePart(a!, doc)} ∩ ${prettyFacePart(b!, doc)}`;
  }
  if (kind === "body") return `${featureName(name.split("/")[0]!, doc)} body`;
  return prettyFacePart(name, doc);
}

/** Replace raw feature ids inside error messages with quoted display names. */
export function humanizeError(message: string, doc: PartDocument): string {
  let out = message;
  for (const f of doc.features) {
    if (f.id === f.name) continue;
    // already-quoted ids first (avoids ""double quoting""), then bare ids
    out = out.split(`"${f.id}"`).join(`"${f.name}"`);
    out = out.split(f.id).join(`"${f.name}"`);
  }
  return out;
}
