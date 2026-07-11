import { z } from "zod";
import type { EntityKind, FeatureId } from "./ids.ts";

/**
 * Entity queries — the FeatureScript-inspired core of VoltCAD's robustness.
 *
 * Feature parameters never store raw topology indices. They store *queries*:
 * serializable descriptions of entities ("edges created by ext1", "the face
 * named ext1/cap:top") that are re-resolved against the live B-Rep on every
 * regeneration. This is simultaneously:
 *   1. the topological-naming solution (upstream edits don't break references),
 *   2. the AI grounding language (the LLM emits queries, not guessed ids),
 *   3. the UI selection format (clicking a face produces a `named` query).
 */

export type EntityQuery =
  /** Entities with specific persistent names (what UI picks produce). */
  | { kind: "named"; names: string[] }
  /** All entities of a kind created/owned by a feature (e.g. sketch regions). */
  | { kind: "created"; feature: FeatureId; entity: EntityKind }
  /** Set algebra over sub-queries. */
  | { kind: "union"; queries: EntityQuery[] }
  | { kind: "intersect"; queries: EntityQuery[] }
  /** Everything currently in the model of a kind (useful for "fillet all edges"). */
  | { kind: "all"; entity: EntityKind };

// Zod mirror of the above — used for document validation AND auto-generated
// AI tool schemas. Keep in lockstep with the TS type.
export const entityQuerySchema: z.ZodType<EntityQuery> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("named"), names: z.array(z.string()).min(1) }),
    z.object({
      kind: z.literal("created"),
      feature: z.string() as unknown as z.ZodType<FeatureId>,
      entity: z.enum(["vertex", "edge", "face", "body"]),
    }),
    z.object({ kind: z.literal("union"), queries: z.array(entityQuerySchema) }),
    z.object({ kind: z.literal("intersect"), queries: z.array(entityQuerySchema) }),
    z.object({ kind: z.literal("all"), entity: z.enum(["vertex", "edge", "face", "body"]) }),
  ]),
) as z.ZodType<EntityQuery>;

/** Convenience constructors (keep call sites terse and typo-free). */
export const q = {
  named: (...names: string[]): EntityQuery => ({ kind: "named", names }),
  created: (feature: FeatureId, entity: EntityKind): EntityQuery => ({
    kind: "created",
    feature,
    entity,
  }),
  union: (...queries: EntityQuery[]): EntityQuery => ({ kind: "union", queries }),
  all: (entity: EntityKind): EntityQuery => ({ kind: "all", entity }),
};
