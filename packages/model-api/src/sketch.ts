import { z } from "zod";

/**
 * Sketch data model (2D geometry in sketch-plane coordinates, mm).
 *
 * v1 stores *solved* coordinates directly; the planegcs constraint solver
 * (next milestone) will read `constraints` and write coordinates back.
 * Constraint types are declared now so documents stay forward-compatible.
 */

export const point2Schema = z.tuple([z.number(), z.number()]);
export type Point2 = z.infer<typeof point2Schema>;

export const sketchEntitySchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("line"),
    start: point2Schema,
    end: point2Schema,
    /** Construction geometry guides the solver but produces no profile edges. */
    construction: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("circle"),
    center: point2Schema,
    radius: z.number().positive(),
    construction: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("arc"),
    center: point2Schema,
    radius: z.number().positive(),
    /** Angles in degrees, CCW from +X of the sketch plane. */
    startAngle: z.number(),
    endAngle: z.number(),
    construction: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("rectangle"),
    /** Two opposite corners; expanded to 4 lines by the kernel adapter. */
    corner1: point2Schema,
    corner2: point2Schema,
    construction: z.boolean().optional(),
  }),
]);
export type SketchEntity = z.infer<typeof sketchEntitySchema>;

/** Declared ahead of solver integration; currently persisted but not solved. */
export const sketchConstraintSchema = z.object({
  id: z.string(),
  type: z.enum([
    "coincident",
    "horizontal",
    "vertical",
    "parallel",
    "perpendicular",
    "tangent",
    "equal",
    "distance",
    "radius",
    "angle",
  ]),
  entities: z.array(z.string()).min(1),
  value: z.union([z.string(), z.number()]).optional(),
});
export type SketchConstraint = z.infer<typeof sketchConstraintSchema>;

/**
 * Where a sketch lives: a datum plane with optional offset, or a planar face
 * of an existing body (referenced by persistent entity name — re-resolved
 * every regeneration, so it survives upstream edits).
 */
export const sketchPlaneSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("datum"),
    plane: z.enum(["XY", "XZ", "YZ"]),
    /** Offset along the plane normal, expression in mm. */
    offset: z.union([z.string(), z.number()]).optional(),
  }),
  z.object({
    kind: z.literal("face"),
    /** Persistent name of a planar face, e.g. "ext1/cap:end". */
    face: z.string(),
  }),
]);
export type SketchPlane = z.infer<typeof sketchPlaneSchema>;
