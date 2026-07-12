import { z } from "zod";
import {
  RegenError,
  defineFeature,
  entityQuerySchema,
  q,
  type BodyTransform,
  type EntityHit,
  type ModelContext,
} from "@voltcad/model-api";

const expr = z.union([z.string(), z.number()]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Default body selection: everything (single-body parts just work). */
function resolveBodies(ctx: ModelContext, query?: unknown): EntityHit[] {
  const bodies = ctx
    .resolve((query as never) ?? q.all("body"))
    .filter((h) => h.kind === "body");
  if (bodies.length === 0)
    throw new RegenError("QUERY_NO_MATCH", "Pattern: no bodies matched the selection");
  return bodies;
}

/**
 * Linear pattern: copies of bodies along a direction. Instance 0 is the
 * original; instances 1..count-1 are translated copies (fused when merged).
 */
export const linearPatternFeature = defineFeature({
  type: "linear_pattern",
  label: "Linear pattern",
  schema: z.object({
    bodies: entityQuerySchema.optional().describe("Bodies to pattern (default: all)"),
    direction: vec3.describe("Pattern direction in world coordinates"),
    spacing: expr.describe("Distance between instances (mm)"),
    count: expr.describe("Total instance count including the original (≥2)"),
    merge: z.boolean().default(true).describe("Fuse copies into the source body"),
  }),
  regenerate(ctx, params, featureId) {
    const count = Math.round(ctx.evaluate(params.count));
    const spacing = ctx.evaluate(params.spacing);
    if (count < 2) throw new RegenError("INVALID_PARAMS", "Pattern count must be ≥ 2");
    if (spacing === 0) throw new RegenError("INVALID_PARAMS", "Pattern spacing must be non-zero");
    const len = Math.hypot(...params.direction);
    if (len < 1e-9) throw new RegenError("INVALID_PARAMS", "Pattern direction is zero");
    const dir = params.direction.map((v) => v / len) as [number, number, number];

    const transforms: BodyTransform[] = [];
    for (let i = 1; i < count; i++) {
      transforms.push({
        kind: "translate",
        offset: [dir[0] * spacing * i, dir[1] * spacing * i, dir[2] * spacing * i],
      });
    }
    ctx.transformBodies(featureId, resolveBodies(ctx, params.bodies), transforms, params.merge);
  },
});

/**
 * Circular pattern: copies rotated about an axis. `totalAngle` 360 spreads
 * instances evenly around the full circle.
 */
export const circularPatternFeature = defineFeature({
  type: "circular_pattern",
  label: "Circular pattern",
  schema: z.object({
    bodies: entityQuerySchema.optional().describe("Bodies to pattern (default: all)"),
    axisPoint: vec3.default([0, 0, 0]).describe("Point on the rotation axis (world)"),
    axisDir: vec3.default([0, 0, 1]).describe("Axis direction (world)"),
    count: expr.describe("Total instance count including the original (≥2)"),
    totalAngle: expr.default(360).describe("Angular span in degrees (360 = full circle)"),
    merge: z.boolean().default(true),
  }),
  regenerate(ctx, params, featureId) {
    const count = Math.round(ctx.evaluate(params.count));
    const totalAngle = ctx.evaluate(params.totalAngle);
    if (count < 2) throw new RegenError("INVALID_PARAMS", "Pattern count must be ≥ 2");
    // full circle: N evenly spaced; partial span: endpoints inclusive
    const step = totalAngle >= 360 ? 360 / count : totalAngle / (count - 1);
    const transforms: BodyTransform[] = [];
    for (let i = 1; i < count; i++) {
      transforms.push({
        kind: "rotate",
        axisPoint: params.axisPoint,
        axisDir: params.axisDir,
        angleDeg: step * i,
      });
    }
    ctx.transformBodies(featureId, resolveBodies(ctx, params.bodies), transforms, params.merge);
  },
});

/** Mirror bodies about a datum plane (optionally offset along its normal). */
export const mirrorFeature = defineFeature({
  type: "mirror",
  label: "Mirror",
  schema: z.object({
    bodies: entityQuerySchema.optional().describe("Bodies to mirror (default: all)"),
    plane: z.enum(["XY", "XZ", "YZ"]).describe("Mirror datum plane"),
    offset: expr.default(0).describe("Plane offset along its normal (mm)"),
    merge: z.boolean().default(true).describe("Fuse the mirrored copy into the source"),
  }),
  regenerate(ctx, params, featureId) {
    const offset = ctx.evaluate(params.offset);
    const normal: [number, number, number] =
      params.plane === "XY" ? [0, 0, 1] : params.plane === "XZ" ? [0, -1, 0] : [1, 0, 0];
    const transforms: BodyTransform[] = [
      {
        kind: "mirror",
        planePoint: [normal[0] * offset, normal[1] * offset, normal[2] * offset],
        planeNormal: normal,
      },
    ];
    ctx.transformBodies(featureId, resolveBodies(ctx, params.bodies), transforms, params.merge);
  },
});

/** Boolean between two bodies. The tool body is consumed by the operation. */
export const booleanFeature = defineFeature({
  type: "boolean",
  label: "Boolean",
  schema: z.object({
    target: entityQuerySchema.describe("Query selecting the target body (kept)"),
    tool: entityQuerySchema.describe("Query selecting the tool body (consumed)"),
    op: z.enum(["union", "subtract", "intersect"]),
  }),
  regenerate(ctx, params, featureId) {
    const target = ctx.resolve(params.target).find((h) => h.kind === "body");
    const tool = ctx.resolve(params.tool).find((h) => h.kind === "body");
    if (!target || !tool)
      throw new RegenError("QUERY_NO_MATCH", "Boolean: target or tool body not found");
    ctx.booleanBodies(featureId, target, tool, params.op);
  },
});
