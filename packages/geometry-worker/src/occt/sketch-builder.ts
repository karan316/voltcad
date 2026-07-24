import type {
  OpenCascadeInstance,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Wire,
} from "opencascade.js/dist/opencascade.full.js";
import {
  RegenError,
  arcPoint,
  arcSpan,
  planeBasis,
  sampleSketchEntities,
  to3D,
  type PlaneBasis,
  type Point2,
  type SketchEntity,
} from "@voltcad/model-api";
import { Scope } from "./scope.ts";

type OC = OpenCascadeInstance;

/**
 * Sketch geometry → OCCT planar profile faces + display polylines.
 *
 * Pipeline:
 *   1. Expand compound entities (rectangle → 4 lines).
 *   2. Chain segments into loops by endpoint matching (1e-6 mm tolerance).
 *   3. Detect loop nesting (even-odd) → outer boundaries vs. holes.
 *   4. Build OCCT wires/faces on the sketch plane; ShapeFix normalizes hole
 *      orientation so we never depend on user draw direction.
 */

export { planeBasis, to3D, sampleSketchEntities };
export type { PlaneBasis };

/** A single traversable curve segment in sketch UV space. */
type Segment =
  | { kind: "line"; entId: string; a: Point2; b: Point2 }
  | {
      kind: "arc";
      entId: string;
      center: Point2;
      radius: number;
      /** degrees, CCW */
      startAngle: number;
      endAngle: number;
      a: Point2;
      b: Point2;
    }
  | { kind: "circle"; entId: string; center: Point2; radius: number };

const TOL = 1e-6;

/** Expand sketch entities into chainable segments (construction excluded). */
function toSegments(entities: SketchEntity[]): Segment[] {
  const segs: Segment[] = [];
  for (const e of entities) {
    if (e.construction) continue;
    switch (e.type) {
      case "line":
        segs.push({ kind: "line", entId: e.id, a: e.start, b: e.end });
        break;
      case "rectangle": {
        const [x1, y1] = e.corner1;
        const [x2, y2] = e.corner2;
        const corners: Point2[] = [
          [x1, y1],
          [x2, y1],
          [x2, y2],
          [x1, y2],
        ];
        for (let i = 0; i < 4; i++)
          segs.push({
            kind: "line",
            entId: `${e.id}/e${i}`,
            a: corners[i]!,
            b: corners[(i + 1) % 4]!,
          });
        break;
      }
      case "arc":
        segs.push({
          kind: "arc",
          entId: e.id,
          center: e.center,
          radius: e.radius,
          startAngle: e.startAngle,
          endAngle: e.endAngle,
          a: arcPoint(e.center, e.radius, e.startAngle),
          b: arcPoint(e.center, e.radius, e.endAngle),
        });
        break;
      case "circle":
        segs.push({
          kind: "circle",
          entId: e.id,
          center: e.center,
          radius: e.radius,
        });
        break;
    }
  }
  return segs;
}

const near = (p: Point2, q: Point2) =>
  Math.abs(p[0] - q[0]) < TOL && Math.abs(p[1] - q[1]) < TOL;

interface Loop {
  /** Segments in traversal order; `reversed[i]` = walked b→a. */
  segments: Segment[];
  reversed: boolean[];
}

/**
 * Assemble closed loops by walking endpoint-connected segments. Open chains
 * are silently ignored for profiles (they still display as sketch curves).
 * O(n²) matching is fine at sketch scale (hundreds of entities).
 */
function findLoops(segs: Segment[]): Loop[] {
  const loops: Loop[] = [];
  const used = new Set<number>();
  const chainable = segs
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind !== "circle");

  // circles are trivially closed loops
  for (const s of segs)
    if (s.kind === "circle") loops.push({ segments: [s], reversed: [false] });

  for (const { s: start, i: startIdx } of chainable) {
    if (used.has(startIdx)) continue;
    const loop: Loop = { segments: [start], reversed: [false] };
    used.add(startIdx);
    const startPt = (start as { a: Point2 }).a;
    let cursor = (start as { b: Point2 }).b;
    let closed = false;

    for (;;) {
      if (near(cursor, startPt)) {
        closed = true;
        break;
      }
      const next = chainable.find(
        ({ s, i }) =>
          !used.has(i) &&
          (near((s as { a: Point2 }).a, cursor) ||
            near((s as { b: Point2 }).b, cursor)),
      );
      if (!next) break;
      const seg = next.s as Segment & { a: Point2; b: Point2 };
      const rev = !near(seg.a, cursor);
      loop.segments.push(next.s);
      loop.reversed.push(rev);
      used.add(next.i);
      cursor = rev ? seg.a : seg.b;
    }
    if (closed && loop.segments.length > 0) loops.push(loop);
    else for (const s of loop.segments) used.delete(segs.indexOf(s)); // release open chain
  }
  return loops;
}

/** Sample a loop into a polygon for area/containment tests. */
function samplePolygon(loop: Loop): Point2[] {
  const pts: Point2[] = [];
  for (let i = 0; i < loop.segments.length; i++) {
    const s = loop.segments[i]!;
    const rev = loop.reversed[i]!;
    if (s.kind === "line") {
      pts.push(rev ? s.b : s.a);
    } else if (s.kind === "arc") {
      const n = Math.max(4, Math.ceil(Math.abs(arcSpan(s)) / 10));
      for (let k = 0; k < n; k++) {
        const t = rev ? 1 - k / n : k / n;
        pts.push(arcPoint(s.center, s.radius, s.startAngle + arcSpan(s) * t));
      }
    } else {
      const n = 32;
      for (let k = 0; k < n; k++)
        pts.push(arcPoint(s.center, s.radius, (360 * k) / n));
    }
  }
  return pts;
}

function pointInPolygon(p: Point2, poly: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      inside = true;
  }
  return inside;
}

/** Proper segment-segment intersection (excluding shared endpoints). */
function segmentsIntersect(
  a1: Point2,
  a2: Point2,
  b1: Point2,
  b2: Point2,
): boolean {
  const d = (p: Point2, q: Point2, r: Point2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/**
 * Reject loop pairs that CROSS each other. Overlapping profiles produce
 * self-intersecting faces that make OCCT throw opaque kernel exceptions
 * deep inside extrude/boolean — catching it here yields an actionable error
 * (and gives the AI copilot something it can actually self-correct from).
 */
function assertLoopsDontCross(polygons: Point2[][]): void {
  for (let i = 0; i < polygons.length; i++) {
    for (let j = i + 1; j < polygons.length; j++) {
      const a = polygons[i]!;
      const b = polygons[j]!;
      for (let k = 0; k < a.length; k++) {
        for (let m = 0; m < b.length; m++) {
          if (
            segmentsIntersect(
              a[k]!,
              a[(k + 1) % a.length]!,
              b[m]!,
              b[(m + 1) % b.length]!,
            )
          ) {
            throw new RegenError(
              "INVALID_PARAMS",
              'Sketch profile loops overlap/cross each other. Loops must be either fully separate or fully nested (nested = hole). To build a compound outline, use ONE closed chain of lines/arcs, or extrude separate shapes with op "add".',
            );
          }
        }
      }
    }
  }
}

export interface BuiltProfile {
  face: TopoDS_Face;
  /** Profile boundary edges tagged with the sketch entity that produced them. */
  edgeTags: { edge: TopoDS_Edge; entId: string }[];
}

/** Build one OCCT edge for a segment. Returned edge is owned by the caller. */
function buildEdge(
  oc: OC,
  basis: PlaneBasis,
  s: Segment,
  scope: Scope,
): TopoDS_Edge {
  const P = (p: Point2) => {
    const [x, y, z] = to3D(basis, p);
    return scope.add(new oc.gp_Pnt_3(x, y, z));
  };
  const N = () => scope.add(new oc.gp_Dir_4(...basis.normal));

  if (s.kind === "line") {
    const mk = scope.add(new oc.BRepBuilderAPI_MakeEdge_3(P(s.a), P(s.b)));
    return mk.Edge();
  }
  const [cx, cy, cz] = to3D(basis, s.center);
  const ax2 = scope.add(
    new oc.gp_Ax2_3(scope.add(new oc.gp_Pnt_3(cx, cy, cz)), N()),
  );
  const circ = scope.add(new oc.gp_Circ_2(ax2, s.radius));
  if (s.kind === "circle") {
    const mk = scope.add(new oc.BRepBuilderAPI_MakeEdge_8(circ));
    return mk.Edge();
  }
  // arc: trimmed circle between endpoints, CCW around the plane normal
  const mkArc = scope.add(
    new oc.GC_MakeArcOfCircle_3(circ, P(s.a), P(s.b), true),
  );
  const trimmed = scope.add(mkArc.Value());
  const curveHandle = scope.add(new oc.Handle_Geom_Curve_2(trimmed.get()));
  const mk = scope.add(new oc.BRepBuilderAPI_MakeEdge_24(curveHandle));
  return mk.Edge();
}

/**
 * Build profile faces from sketch entities on an arbitrary plane basis.
 * Returns one face per outer loop, with holes applied (one nesting level).
 */
export function buildProfiles(
  oc: OC,
  basis: PlaneBasis,
  entities: SketchEntity[],
): BuiltProfile[] {
  const loops = findLoops(toSegments(entities));
  if (loops.length === 0) return [];

  // classify nesting: a loop contained in an odd number of others is a hole
  const polygons = loops.map(samplePolygon);
  assertLoopsDontCross(polygons);
  const depth = loops.map((_, i) =>
    polygons.reduce(
      (d, poly, j) =>
        j !== i && pointInPolygon(polygons[i]![0]!, poly) ? d + 1 : d,
      0,
    ),
  );

  const results: BuiltProfile[] = [];
  const scope = new Scope();
  try {
    const wires: {
      wire: TopoDS_Wire;
      tags: { edge: TopoDS_Edge; entId: string }[];
    }[] = loops.map((loop) => {
      const mkWire = scope.add(new oc.BRepBuilderAPI_MakeWire_1());
      const tags: { edge: TopoDS_Edge; entId: string }[] = [];
      for (const s of loop.segments) {
        const edge = buildEdge(oc, basis, s, scope);
        mkWire.Add_1(edge);
        tags.push({ edge, entId: s.entId });
      }
      if (!mkWire.IsDone())
        throw new RegenError("OPEN_PROFILE", "Failed to close sketch loop");
      return { wire: mkWire.Wire(), tags };
    });

    for (let i = 0; i < loops.length; i++) {
      if (depth[i]! % 2 !== 0) continue; // holes handled with their outer
      const mkFace = scope.add(
        new oc.BRepBuilderAPI_MakeFace_15(wires[i]!.wire, true),
      );
      const tags = [...wires[i]!.tags];
      for (let j = 0; j < loops.length; j++) {
        // attach holes nested directly inside this outer loop
        if (j === i || depth[j]! % 2 === 0) continue;
        if (!pointInPolygon(polygons[j]![0]!, polygons[i]!)) continue;
        mkFace.Add(wires[j]!.wire);
        tags.push(...wires[j]!.tags);
      }
      if (!mkFace.IsDone())
        throw new RegenError(
          "OPEN_PROFILE",
          "Failed to build profile face from sketch",
        );
      // ShapeFix normalizes wire orientations (holes must run opposite to the
      // outer boundary — users draw in arbitrary direction).
      const fix = scope.add(new oc.ShapeFix_Face_2(mkFace.Face()));
      fix.FixOrientation_1();
      const fixedFace = fix.Face();

      // ShapeFix may rebuild wires with new edge objects; re-associate our
      // sketch-entity tags with the face's ACTUAL edges (IsSame matching),
      // otherwise downstream Generated() lookups (side-face naming) miss.
      const faceEdges: TopoDS_Edge[] = [];
      const ex = scope.add(
        new oc.TopExp_Explorer_2(
          fixedFace,
          oc.TopAbs_ShapeEnum.TopAbs_EDGE as never,
          oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
        ),
      );
      for (; ex.More(); ex.Next())
        faceEdges.push(oc.TopoDS.Edge_1(ex.Current()));
      const remapped = tags.map(({ edge, entId }) => ({
        edge: faceEdges.find((fe) => fe.IsSame(edge)) ?? edge,
        entId,
      }));

      results.push({ face: fixedFace, edgeTags: remapped });
    }
    return results;
  } finally {
    // Wires/faces returned are TopoDS_Shape values (cheap handles into the
    // kernel); the builder objects themselves are freed here.
    scope.dispose();
  }
}

/**
 * Build a single wire (open OR closed) from sketch entities, for use as a
 * sweep path. Segments are chained by endpoint proximity starting from an
 * arbitrary free end; construction geometry is excluded.
 */
export function buildPathWire(
  oc: OC,
  basis: PlaneBasis,
  entities: SketchEntity[],
): TopoDS_Wire {
  const segs = toSegments(entities).filter(
    (s) => s.kind !== "circle",
  ) as (Segment & {
    a: Point2;
    b: Point2;
  })[];
  if (segs.length === 0)
    throw new RegenError(
      "OPEN_PROFILE",
      "Path sketch has no line/arc entities to sweep along",
    );

  // count endpoint occurrences to find a free end (open chain start)
  const endpointUses = (p: Point2) =>
    segs.reduce(
      (n, s) => n + (near(s.a, p) ? 1 : 0) + (near(s.b, p) ? 1 : 0),
      0,
    );
  const startIdx = segs.findIndex(
    (s) => endpointUses(s.a) === 1 || endpointUses(s.b) === 1,
  );
  const first = segs[startIdx >= 0 ? startIdx : 0]!;
  const firstReversed =
    startIdx >= 0 && endpointUses(first.b) === 1 && endpointUses(first.a) !== 1;

  const ordered: { seg: (typeof segs)[number]; reversed: boolean }[] = [
    { seg: first, reversed: firstReversed },
  ];
  const used = new Set([segs.indexOf(first)]);
  let cursor = firstReversed ? first.a : first.b;
  for (;;) {
    const nextIdx = segs.findIndex(
      (s, i) => !used.has(i) && (near(s.a, cursor) || near(s.b, cursor)),
    );
    if (nextIdx < 0) break;
    const seg = segs[nextIdx]!;
    const reversed = !near(seg.a, cursor);
    ordered.push({ seg, reversed });
    used.add(nextIdx);
    cursor = reversed ? seg.a : seg.b;
  }
  if (used.size !== segs.length)
    throw new RegenError(
      "OPEN_PROFILE",
      "Path sketch entities must form a single connected chain",
    );

  const scope = new Scope();
  try {
    const mkWire = scope.add(new oc.BRepBuilderAPI_MakeWire_1());
    for (const { seg } of ordered)
      mkWire.Add_1(buildEdge(oc, basis, seg, scope));
    if (!mkWire.IsDone())
      throw new RegenError(
        "OPEN_PROFILE",
        "Failed to build a wire from the path sketch",
      );
    return mkWire.Wire();
  } finally {
    scope.dispose();
  }
}
