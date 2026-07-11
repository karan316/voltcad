import { z } from "zod";
import { RegenError, defineFeature, type FeatureId } from "@voltcad/model-api";

const expressionSchema = z
  .union([z.string(), z.number()])
  .describe('Dimension expression, e.g. "25" or "wall_t * 2" (mm)');

const booleanOpSchema = z
  .enum(["new", "add", "cut", "intersect"])
  .describe("How the result combines with existing bodies");

/**
 * Extrude: linear sweep of a sketch's profile faces along the plane normal.
 */
export const extrudeFeature = defineFeature({
  type: "extrude",
  label: "Extrude",
  schema: z.object({
    sketch: z.string().describe("Feature id of the sketch providing the profile"),
    distance: expressionSchema,
    symmetric: z.boolean().default(false).describe("Extrude both directions equally"),
    op: booleanOpSchema.default("new"),
  }),
  regenerate(ctx, params, featureId) {
    const profiles = ctx.profilesOf(params.sketch as FeatureId);
    if (profiles.length === 0)
      throw new RegenError(
        "OPEN_PROFILE",
        `Sketch "${params.sketch}" has no closed profile to extrude`,
      );
    const distance = ctx.evaluate(params.distance);
    if (distance <= 0)
      throw new RegenError("INVALID_PARAMS", `Extrude distance must be > 0 (got ${distance})`);
    ctx.extrude(featureId, profiles, {
      distance,
      symmetric: params.symmetric,
      op: params.op,
    });
  },
});

/**
 * Revolve: sweep a sketch's profiles about an axis lying in the sketch plane.
 */
export const revolveFeature = defineFeature({
  type: "revolve",
  label: "Revolve",
  schema: z.object({
    sketch: z.string().describe("Feature id of the sketch providing the profile"),
    axisPoint: z.tuple([z.number(), z.number()]).default([0, 0])
      .describe("Point on the revolve axis, in sketch coordinates"),
    axisDir: z.tuple([z.number(), z.number()]).default([0, 1])
      .describe("Axis direction in sketch coordinates"),
    angle: expressionSchema.default(360).describe("Revolve angle in degrees"),
    op: booleanOpSchema.default("new"),
  }),
  regenerate(ctx, params, featureId) {
    const profiles = ctx.profilesOf(params.sketch as FeatureId);
    if (profiles.length === 0)
      throw new RegenError(
        "OPEN_PROFILE",
        `Sketch "${params.sketch}" has no closed profile to revolve`,
      );
    const angle = ctx.evaluate(params.angle);
    if (angle <= 0 || angle > 360)
      throw new RegenError("INVALID_PARAMS", `Revolve angle must be in (0, 360] (got ${angle})`);
    ctx.revolve(featureId, profiles, {
      axisPoint: params.axisPoint,
      axisDir: params.axisDir,
      angle,
      op: params.op,
    });
  },
});
