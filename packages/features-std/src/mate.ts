import { z } from "zod";
import { defineFeature } from "@voltcad/model-api";

const expressionSchema = z
  .union([z.string(), z.number()])
  .describe('Dimension expression, e.g. "25" or "wall_t * 2"');

/**
 * Mate: Onshape-style assembly constraint as a history feature. Rigidly
 * repositions the body owning `moving` so that face's frame coincides with
 * the `fixed` face's frame:
 *
 *   - flip=true (default): faces point at each other — contact mate
 *   - offset: gap along the fixed face normal (slider position)
 *   - angle: spin about the fixed face normal (revolute position)
 *
 * One mate fully positions a body (fastened). Chains assemble leaf-first:
 * mate B→A, then C→B — downstream mates see the already-positioned bodies
 * because face names propagate through the transform.
 */
export const mateFeature = defineFeature({
  type: "mate",
  label: "Mate",
  schema: z.object({
    fixed: z
      .string()
      .describe("Persistent name of the fixed (target) planar face"),
    moving: z
      .string()
      .describe("Persistent name of the planar face on the body to move"),
    flip: z
      .boolean()
      .default(true)
      .describe(
        "true: faces touch (normals anti-aligned); false: flush (aligned)",
      ),
    offset: expressionSchema
      .default(0)
      .describe("Gap along the fixed face normal (mm)"),
    angle: expressionSchema
      .default(0)
      .describe("Rotation about the fixed face normal (deg)"),
  }),
  regenerate(ctx, params, featureId) {
    ctx.mate(featureId, params.fixed, params.moving, {
      flip: params.flip,
      offset: ctx.evaluate(params.offset),
      angleDeg: ctx.evaluate(params.angle),
    });
  },
});
