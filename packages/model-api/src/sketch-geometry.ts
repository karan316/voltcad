import type { Point2, SketchEntity, SketchPlane } from "./sketch.ts";

/**
 * Pure sketch-plane geometry helpers, shared by the kernel adapter (profile
 * building), the viewport sketcher (drawing overlay + pointer→plane mapping),
 * and display sampling. No kernel dependencies — keep it that way.
 */

/** Orthonormal basis of a sketch plane: p3d = origin + u*U + v*V. */
export interface PlaneBasis {
  origin: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  normal: [number, number, number];
}

export function planeBasis(plane: SketchPlane, offset: number): PlaneBasis {
  if (plane.kind === "face")
    throw new Error("Face-plane basis comes from the kernel (getFaceBasis), not planeBasis()");
  // Right-handed: normal = u × v for each datum plane.
  const bases: Record<string, PlaneBasis> = {
    XY: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
    XZ: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
    YZ: { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
  };
  const b = bases[plane.plane]!;
  return {
    ...b,
    origin: [b.normal[0] * offset, b.normal[1] * offset, b.normal[2] * offset],
  };
}

export function to3D(b: PlaneBasis, p: Point2): [number, number, number] {
  return [
    b.origin[0] + b.u[0] * p[0] + b.v[0] * p[1],
    b.origin[1] + b.u[1] * p[0] + b.v[1] * p[1],
    b.origin[2] + b.u[2] * p[0] + b.v[2] * p[1],
  ];
}

/** Project a 3D point (assumed on/near the plane) into (u,v) coordinates. */
export function toUV(b: PlaneBasis, p: [number, number, number]): Point2 {
  const dx = p[0] - b.origin[0];
  const dy = p[1] - b.origin[1];
  const dz = p[2] - b.origin[2];
  return [
    dx * b.u[0] + dy * b.u[1] + dz * b.u[2],
    dx * b.v[0] + dy * b.v[1] + dz * b.v[2],
  ];
}

export function arcPoint(center: Point2, radius: number, angleDeg: number): Point2 {
  const a = (angleDeg * Math.PI) / 180;
  return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)];
}

/** CCW arc span in degrees, normalized to (0, 360]. */
export function arcSpan(s: { startAngle: number; endAngle: number }): number {
  let span = s.endAngle - s.startAngle;
  while (span <= 0) span += 360;
  return span;
}

/** Endpoints of an entity in sketch UV space (for snapping / chaining). */
export function entityEndpoints(e: SketchEntity): Point2[] {
  switch (e.type) {
    case "line":
      return [e.start, e.end];
    case "rectangle": {
      const [x1, y1] = e.corner1;
      const [x2, y2] = e.corner2;
      return [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
      ];
    }
    case "arc":
      return [arcPoint(e.center, e.radius, e.startAngle), arcPoint(e.center, e.radius, e.endAngle)];
    case "circle":
      return [e.center];
  }
}

/**
 * Sample sketch entities into a world-space line-segment soup (pairs of
 * consecutive vec3), ready for a LineSegments draw call.
 */
export function sampleSketchEntities(
  plane: SketchPlane,
  offset: number,
  entities: SketchEntity[],
): Float32Array {
  return sampleSketchEntitiesFromBasis(planeBasis(plane, offset), entities);
}

/** Same sampler, but from an explicit basis (face planes, sketcher draft). */
export function sampleSketchEntitiesFromBasis(
  basis: PlaneBasis,
  entities: SketchEntity[],
): Float32Array {
  const out: number[] = [];
  const pushSeg = (a: Point2, b: Point2) => {
    out.push(...to3D(basis, a), ...to3D(basis, b));
  };
  for (const e of entities) {
    switch (e.type) {
      case "line":
        pushSeg(e.start, e.end);
        break;
      case "rectangle": {
        const [x1, y1] = e.corner1;
        const [x2, y2] = e.corner2;
        pushSeg([x1, y1], [x2, y1]);
        pushSeg([x2, y1], [x2, y2]);
        pushSeg([x2, y2], [x1, y2]);
        pushSeg([x1, y2], [x1, y1]);
        break;
      }
      case "circle": {
        const n = 72;
        for (let k = 0; k < n; k++)
          pushSeg(
            arcPoint(e.center, e.radius, (360 * k) / n),
            arcPoint(e.center, e.radius, (360 * (k + 1)) / n),
          );
        break;
      }
      case "arc": {
        const span = arcSpan(e);
        const n = Math.max(4, Math.ceil(span / 5));
        for (let k = 0; k < n; k++)
          pushSeg(
            arcPoint(e.center, e.radius, e.startAngle + (span * k) / n),
            arcPoint(e.center, e.radius, e.startAngle + (span * (k + 1)) / n),
          );
        break;
      }
    }
  }
  return new Float32Array(out);
}
