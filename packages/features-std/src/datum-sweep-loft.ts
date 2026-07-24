import { z } from "zod";
import {
  RegenError,
  defineFeature,
  sketchPlaneSchema,
  type FeatureId,
  type PlaneBasis,
} from "@voltcad/model-api";

const expressionSchema = z
  .union([z.string(), z.number()])
  .describe('Dimension expression, e.g. "25" or "wall_t * 2" (mm)');

type Vec3 = [number, number, number];

/** Rodrigues rotation of v about unit axis k by angle (radians). */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cross: Vec3 = [
    k[1] * v[2] - k[2] * v[1],
    k[2] * v[0] - k[0] * v[2],
    k[0] * v[1] - k[1] * v[0],
  ];
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [
    v[0] * cos + cross[0] * sin + k[0] * dot * (1 - cos),
    v[1] * cos + cross[1] * sin + k[1] * dot * (1 - cos),
    v[2] * cos + cross[2] * sin + k[2] * dot * (1 - cos),
  ];
}

/**
 * Datum plane: a construction plane derived from a base plane (default datum,
 * planar face, or another datum feature) with an optional normal offset and
 * an optional rotation about the plane's local U or V axis. Sketches reference
 * it via `{ kind: "datumFeature", feature: <id> }`.
 */
export const datumPlaneFeature = defineFeature({
  type: "datum_plane",
  label: "Datum plane",
  schema: z.object({
    base: sketchPlaneSchema.describe("Plane this datum is derived from"),
    offset: expressionSchema
      .optional()
      .describe("Offset along the base plane normal (mm)"),
    rotate: z
      .object({
        axis: z
          .enum(["u", "v"])
          .describe("Local in-plane axis to rotate about"),
        angle: expressionSchema.describe("Rotation angle in degrees"),
      })
      .optional(),
  }),
  regenerate(ctx, params, featureId) {
    const base = ctx.planeBasisOf(params.base);
    let { u, v, normal } = base;
    let origin = base.origin;

    if (params.rotate) {
      const angle = (ctx.evaluate(params.rotate.angle) * Math.PI) / 180;
      const axis = params.rotate.axis === "u" ? u : v;
      u = rotate(u, axis, angle);
      v = rotate(v, axis, angle);
      normal = rotate(normal, axis, angle);
    }
    if (params.offset !== undefined) {
      const d = ctx.evaluate(params.offset);
      origin = [
        origin[0] + normal[0] * d,
        origin[1] + normal[1] * d,
        origin[2] + normal[2] * d,
      ];
    }
    const basis: PlaneBasis = { origin, u, v, normal };
    ctx.defineDatumPlane(featureId, basis);
  },
});

const booleanOpSchema = z
  .enum(["new", "add", "cut", "intersect"])
  .describe("How the result combines with existing bodies");

/**
 * Sweep: drive a sketch profile along a path sketch (connected chain of
 * lines/arcs, open or closed).
 */
export const sweepFeature = defineFeature({
  type: "sweep",
  label: "Sweep",
  schema: z.object({
    profile: z
      .string()
      .describe("Feature id of the sketch providing the closed profile"),
    path: z
      .string()
      .describe("Feature id of the sketch providing the path (open chain OK)"),
    op: booleanOpSchema.default("new"),
  }),
  regenerate(ctx, params, featureId) {
    const profiles = ctx.profilesOf(params.profile as FeatureId);
    if (profiles.length === 0)
      throw new RegenError(
        "OPEN_PROFILE",
        `Sketch "${params.profile}" has no closed profile to sweep`,
      );
    ctx.sweep(featureId, profiles, params.path as FeatureId, { op: params.op });
  },
});

/**
 * Loft: solid through two or more closed section sketches, in list order.
 */
export const loftFeature = defineFeature({
  type: "loft",
  label: "Loft",
  schema: z.object({
    sections: z
      .array(z.string())
      .min(2)
      .describe("Feature ids of section sketches, in loft order"),
    ruled: z
      .boolean()
      .default(false)
      .describe("Straight transitions instead of smooth"),
    op: booleanOpSchema.default("new"),
  }),
  regenerate(ctx, params, featureId) {
    ctx.loft(featureId, params.sections as FeatureId[], {
      ruled: params.ruled,
      op: params.op,
    });
  },
});
