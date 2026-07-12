import type { Expression } from "./expression.ts";
import type { EntityQuery } from "./query.ts";
import type { EntityHit } from "./tessellation.ts";
import type { SketchEntity, SketchPlane } from "./sketch.ts";
import type { FeatureId } from "./ids.ts";

/**
 * ModelContext — the "FeatureScript" surface.
 *
 * This is the ONLY geometry API feature implementations may use. Built-in
 * features (extrude, fillet, …) and future user-defined features consume the
 * exact same interface, which is the forcing function that keeps it complete
 * and the kernel swappable. The single implementation lives in
 * @voltcad/geometry-worker on top of OpenCascade; nothing above that package
 * ever imports OCCT.
 *
 * Methods are synchronous: feature code executes *inside* the geometry worker,
 * so a custom feature making hundreds of kernel calls pays zero messaging
 * overhead.
 */

/** Opaque handle to a kernel shape (valid only within the current regen). */
export type ShapeHandle = number & { readonly __brand?: "ShapeHandle" };

export type BooleanOp = "add" | "cut" | "intersect" | "new";

export interface ExtrudeOptions {
  /** Distance in mm (already evaluated). */
  distance: number;
  /** Extrude both directions symmetrically. */
  symmetric?: boolean;
  /** How the result merges with existing bodies. */
  op: BooleanOp;
}

export interface RevolveOptions {
  /** Axis defined in sketch-plane coordinates: point + direction. */
  axisPoint: [number, number];
  axisDir: [number, number];
  /** Angle in degrees. */
  angle: number;
  op: BooleanOp;
}

export interface ModelContext {
  /** Evaluate a dimension expression against the document parameter table. */
  evaluate(expr: Expression): number;

  /** Resolve an entity query against the current model state. */
  resolve(query: EntityQuery): EntityHit[];

  /**
   * Build planar face profile(s) from sketch entities: assembles closed loops
   * into wires, wires into faces (outer loop + holes handled by the kernel).
   * Registers resulting faces as created by `owner` for later `q.created` use.
   */
  buildProfile(owner: FeatureId, plane: SketchPlane, entities: SketchEntity[]): ShapeHandle[];

  /** Profiles previously built by a sketch feature earlier in the history. */
  profilesOf(sketch: FeatureId): ShapeHandle[];

  /** Sweep profiles linearly along the sketch-plane normal. */
  extrude(owner: FeatureId, profiles: ShapeHandle[], options: ExtrudeOptions): void;

  /** Revolve profiles about an axis lying in the sketch plane. */
  revolve(owner: FeatureId, profiles: ShapeHandle[], options: RevolveOptions): void;

  /** Round the given edges. Throws FILLET_TOO_LARGE when the kernel rejects. */
  fillet(owner: FeatureId, edges: EntityHit[], radius: number): void;

  /** Chamfer the given edges with an equal-distance chamfer. */
  chamfer(owner: FeatureId, edges: EntityHit[], distance: number): void;

  /**
   * Import bodies from a STEP or IGES payload (file text). Each root solid
   * becomes a body; faces get stable positional names under `owner`.
   */
  importShape(owner: FeatureId, format: "step" | "iges", data: string): void;

  /**
   * Hollow a body: remove the given faces and offset the remaining walls
   * inward by `thickness` (classic shell).
   */
  shell(owner: FeatureId, removeFaces: EntityHit[], thickness: number): void;

  /**
   * Create transformed copies of bodies (patterns/mirror). With `merge`,
   * copies fuse into their source body; otherwise each becomes a new body.
   */
  transformBodies(
    owner: FeatureId,
    bodies: EntityHit[],
    transforms: BodyTransform[],
    merge: boolean,
  ): void;

  /** Boolean between two existing bodies. The tool body is consumed. */
  booleanBodies(
    owner: FeatureId,
    target: EntityHit,
    tool: EntityHit,
    op: "union" | "subtract" | "intersect",
  ): void;
}

/** Serializable rigid transform for patterns and mirrors. */
export type BodyTransform =
  | { kind: "translate"; offset: [number, number, number] }
  | {
      kind: "rotate";
      axisPoint: [number, number, number];
      axisDir: [number, number, number];
      angleDeg: number;
    }
  | { kind: "mirror"; planePoint: [number, number, number]; planeNormal: [number, number, number] };
