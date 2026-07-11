import type { EntityKind } from "./ids.ts";

/**
 * Tessellation payload — the ONLY geometry representation that ever reaches
 * the main thread. All arrays are transferable typed arrays so posting a mesh
 * from the geometry worker is zero-copy (critical for RAM + frame budget).
 */

export interface FaceGroup {
  /** Persistent entity name of the B-Rep face. */
  name: string;
  /** Range into `indices` (triangle index start, in index units). */
  start: number;
  count: number;
}

export interface EdgePolyline {
  /** Persistent entity name of the B-Rep edge. */
  name: string;
  /** Range into `edgePositions` (vertex start index, in vec3 units). */
  start: number;
  count: number;
}

export interface BodyMesh {
  /** Persistent entity name of the body. */
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /**
   * Sorted by `start`; a raycast triangle index is mapped to its B-Rep face
   * via binary search — no per-triangle id array needed (saves ~4 bytes/tri).
   */
  faceGroups: FaceGroup[];
  /** All edge polylines concatenated into one buffer (one draw call). */
  edgePositions: Float32Array;
  edges: EdgePolyline[];
}

/** Lightweight scene description returned by a full regeneration. */
export interface SceneUpdate {
  bodies: BodyMesh[];
  /** Sketch wireframes for display when not extruded yet. */
  sketches: SketchDisplay[];
}

export interface SketchDisplay {
  featureId: string;
  /** Line-segment soup in world space, ready for a LineSegments draw. */
  positions: Float32Array;
}

/** Collect all transferables from a scene update for postMessage. */
export function sceneTransferables(scene: SceneUpdate): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const b of scene.bodies) {
    buffers.add(b.positions.buffer as ArrayBuffer);
    buffers.add(b.normals.buffer as ArrayBuffer);
    buffers.add(b.indices.buffer as ArrayBuffer);
    buffers.add(b.edgePositions.buffer as ArrayBuffer);
  }
  for (const s of scene.sketches) buffers.add(s.positions.buffer as ArrayBuffer);
  return [...buffers];
}

/** Resolved entity descriptor (result of running an EntityQuery). */
export interface EntityHit {
  name: string;
  kind: EntityKind;
}
