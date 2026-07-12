import { z } from "zod";
import type { FeatureId } from "./ids.ts";
import type { Expression } from "./expression.ts";

/**
 * The Feature Document — VoltCAD's single source of truth.
 *
 * Geometry (B-Rep, meshes) is always a derived artifact regenerated from this
 * document. Undo/redo, AI edits, collaboration and branching are all just
 * operations on this plain-JSON structure. Keep it small, ordered and
 * deterministic to regenerate.
 */

export const featureNodeSchema = z.object({
  id: z.string(),
  /** Registry discriminator ("sketch", "extrude", …). */
  type: z.string(),
  /** User-visible name shown in the feature tree ("Extrude 1"). */
  name: z.string(),
  /** Suppressed features are skipped during regeneration. */
  suppressed: z.boolean().optional(),
  /** Validated lazily against the registered feature schema. */
  params: z.unknown(),
});

export interface FeatureNode {
  id: FeatureId;
  type: string;
  name: string;
  suppressed?: boolean;
  params: unknown;
}

export const partDocumentSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  /** Named user parameters; values are expressions ("wall_t * 2"). */
  parameters: z.record(z.string(), z.union([z.string(), z.number()])),
  features: z.array(featureNodeSchema),
  /** Features at index >= rollback are not regenerated (rollback bar). */
  rollback: z.number().int().min(0).optional(),
});

export interface PartDocument {
  version: 1;
  name: string;
  parameters: Record<string, Expression>;
  features: FeatureNode[];
  rollback?: number;
}

export function createEmptyDocument(name = "Untitled"): PartDocument {
  return { version: 1, name, parameters: {}, features: [] };
}

/** Per-feature outcome of a regeneration pass. */
export interface FeatureStatus {
  featureId: FeatureId;
  status: "ok" | "error" | "skipped" | "suppressed" | "rolledback";
  error?: { code: string; message: string; entities: string[] };
  /** Wall-clock ms spent in the kernel — surfaced in the UI for perf hygiene. */
  elapsedMs?: number;
}
