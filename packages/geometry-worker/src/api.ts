import type {
  FeatureStatus,
  PartDocument,
  PlaneBasis,
  SceneUpdate,
  SketchPlane,
} from "@voltcad/model-api";

/**
 * RPC contract between the main thread and the geometry worker.
 * Keep this file dependency-light: it is imported by both sides.
 */

export interface RegenResult {
  statuses: FeatureStatus[];
  scene: SceneUpdate;
  /** Features served from the incremental checkpoint cache. */
  cachedCount: number;
  /** Total kernel wall time, for the perf HUD. */
  elapsedMs: number;
}

export interface MassProperties {
  /** mm^3 */
  volume: number;
  /** mm^2 */
  surfaceArea: number;
  /** mm, world coordinates */
  centerOfMass: [number, number, number];
}

/** Per-body summary for AI grounding. */
export interface BodyDescription {
  name: string;
  volume: number;
  centerOfMass: [number, number, number];
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  faceCount: number;
}

export interface GeometryWorkerApi {
  /** Load + instantiate the OCCT WASM module. Idempotent. */
  init(): Promise<void>;
  /** Full history regeneration. Returns tessellated scene (transferred). */
  regenerate(doc: PartDocument): Promise<RegenResult>;
  /** Plane basis of a named planar face (sketch-on-face), or null. */
  getFaceBasis(faceName: string): Promise<PlaneBasis | null>;
  /** Resolve any sketch plane (incl. datum features) to a basis, or null. */
  getPlaneBasis(plane: SketchPlane): Promise<PlaneBasis | null>;
  /** Per-body summaries (bbox, volume, COM) for AI grounding. */
  describeBodies(): Promise<BodyDescription[]>;
  /** Minimum distance (mm) between two named entities, or null. */
  measureDistance(a: string, b: string): Promise<number | null>;
  /** Mass properties of all bodies from the last regeneration. */
  massProperties(): Promise<MassProperties | null>;
  /** Export the last regenerated bodies. */
  exportStep(): Promise<Uint8Array>;
  exportStl(): Promise<Uint8Array>;
}
