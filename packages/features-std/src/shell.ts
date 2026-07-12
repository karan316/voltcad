import { z } from "zod";
import { RegenError, defineFeature, entityQuerySchema } from "@voltcad/model-api";

const expr = z
  .union([z.string(), z.number()])
  .describe('Dimension expression, e.g. "2" or "wall_t" (mm)');

/**
 * Shell: hollow a body by removing the selected faces and offsetting the
 * remaining walls inward. The classic "box → open container" feature.
 */
export const shellFeature = defineFeature({
  type: "shell",
  label: "Shell",
  schema: z.object({
    faces: entityQuerySchema.describe("Query selecting the faces to remove (openings)"),
    thickness: expr.describe("Wall thickness in mm"),
  }),
  regenerate(ctx, params, featureId) {
    const faces = ctx.resolve(params.faces).filter((h) => h.kind === "face");
    if (faces.length === 0)
      throw new RegenError("QUERY_NO_MATCH", "Shell: no faces matched the selection");
    const thickness = ctx.evaluate(params.thickness);
    if (thickness <= 0)
      throw new RegenError("INVALID_PARAMS", `Shell thickness must be > 0 (got ${thickness})`);
    ctx.shell(featureId, faces, thickness);
  },
});
