/**
 * Branded ID types + generators.
 *
 * Feature IDs are short, human-readable, and stable for the lifetime of a
 * document (they are embedded in persistent entity names like "ext1/side:2",
 * so they must NEVER change once assigned).
 */

export type FeatureId = string & { readonly __brand: "FeatureId" };

/**
 * Persistent semantic entity name, e.g.:
 *   "ext1/side:2"            → 3rd lateral face created by feature ext1
 *   "ext1/side:2|ext1/cap:top" → the edge shared by those two faces
 * These are produced by the geometry kernel's naming system and are opaque
 * strings everywhere else (UI, AI, document). Stability of these names across
 * regenerations is what solves the topological-naming problem.
 */
export type EntityName = string & { readonly __brand?: "EntityName" };

export type EntityKind = "vertex" | "edge" | "face" | "body";

let counter = 0;

/** Monotonic, collision-free-enough id for features created in one session. */
export function newFeatureId(type: string): FeatureId {
  // base36 timestamp fragment + counter keeps ids short but unique across
  // sessions (collaboration-safe enough until Yjs client ids are added).
  const t = Date.now().toString(36).slice(-4);
  return `${type}_${t}${(counter++).toString(36)}` as FeatureId;
}
