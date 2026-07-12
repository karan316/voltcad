import type { FeatureStatus, PartDocument, PlaneBasis, SceneUpdate } from "@voltcad/model-api";

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

export interface GeometryWorkerApi {
  /** Load + instantiate the OCCT WASM module. Idempotent. */
  init(): Promise<void>;
  /** Full history regeneration. Returns tessellated scene (transferred). */
  regenerate(doc: PartDocument): Promise<RegenResult>;
  /** Plane basis of a named planar face (sketch-on-face), or null. */
  getFaceBasis(faceName: string): Promise<PlaneBasis | null>;
  /** Mass properties of all bodies from the last regeneration. */
  massProperties(): Promise<MassProperties | null>;
  /** Export the last regenerated bodies. */
  exportStep(): Promise<Uint8Array>;
  exportStl(): Promise<Uint8Array>;
}
