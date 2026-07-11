import { z } from "zod";
import { RegenError, defineFeature, entityQuerySchema } from "@voltcad/model-api";

const expressionSchema = z
  .union([z.string(), z.number()])
  .describe('Dimension expression, e.g. "2" or "wall_t / 2" (mm)');

/**
 * Fillet: round edges. `edges` is an EntityQuery — re-resolved on every regen,
 * so filleted edges survive upstream sketch edits (topological-naming safe).
 */
export const filletFeature = defineFeature({
  type: "fillet",
  label: "Fillet",
  schema: z.object({
    edges: entityQuerySchema.describe("Query selecting the edges to round"),
    radius: expressionSchema,
  }),
  regenerate(ctx, params, featureId) {
    const edges = ctx.resolve(params.edges).filter((h) => h.kind === "edge");
    if (edges.length === 0)
      throw new RegenError("QUERY_NO_MATCH", "Fillet: no edges matched the selection");
    const radius = ctx.evaluate(params.radius);
    if (radius <= 0)
      throw new RegenError("INVALID_PARAMS", `Fillet radius must be > 0 (got ${radius})`);
    ctx.fillet(featureId, edges, radius);
  },
});

/** Chamfer: equal-distance bevel on edges. Same query semantics as fillet. */
export const chamferFeature = defineFeature({
  type: "chamfer",
  label: "Chamfer",
  schema: z.object({
    edges: entityQuerySchema.describe("Query selecting the edges to bevel"),
    distance: expressionSchema,
  }),
  regenerate(ctx, params, featureId) {
    const edges = ctx.resolve(params.edges).filter((h) => h.kind === "edge");
    if (edges.length === 0)
      throw new RegenError("QUERY_NO_MATCH", "Chamfer: no edges matched the selection");
    const distance = ctx.evaluate(params.distance);
    if (distance <= 0)
      throw new RegenError("INVALID_PARAMS", `Chamfer distance must be > 0 (got ${distance})`);
    ctx.chamfer(featureId, edges, distance);
  },
});
