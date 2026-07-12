import {
  make_gcs_wrapper,
  type GcsWrapper,
  SolveStatus,
} from "@salusoft89/planegcs";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { arcPoint, type Point2, type SketchConstraint, type SketchEntity } from "@voltcad/model-api";

/**
 * planegcs (FreeCAD's GCS solver, WASM) bridge.
 *
 * Translates VoltCAD sketch entities/constraints into planegcs primitives,
 * solves, and writes coordinates back. Solving happens in the editor at
 * interaction time — solved coordinates are BAKED into the document, so
 * regeneration stays deterministic and P2P-safe (no solver in the kernel).
 *
 * Entity → primitive mapping (ids suffixed for sub-points):
 *   line   → point ${id}.p1, point ${id}.p2, line ${id}
 *   circle → point ${id}.c, circle ${id}
 *   arc    → points ${id}.c/.s/.e, arc ${id}
 *   rectangle → not solvable (kept rigid; excluded from constraint UI)
 *
 * Coincidence is implicit: endpoints sharing coordinates (1e-6) get
 * p2p_coincident constraints, mirroring how the sketcher's endpoint snapping
 * bakes shared positions.
 */

export interface SolveResult {
  status: "ok" | "failed" | "conflicting";
  entities: SketchEntity[];
  /** Remaining degrees of freedom (0 = fully constrained). */
  dof: number;
  conflicts: string[];
}

let wrapperPromise: Promise<GcsWrapper> | null = null;
function getWrapper(): Promise<GcsWrapper> {
  wrapperPromise ??= make_gcs_wrapper(wasmUrl);
  return wrapperPromise;
}

const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;

export async function solveSketch(
  entities: SketchEntity[],
  constraints: SketchConstraint[],
): Promise<SolveResult> {
  const gcs = await getWrapper();
  gcs.clear_data();

  const prims: object[] = [];
  const endpoints: { id: string; p: Point2 }[] = [];

  for (const e of entities) {
    if (e.construction) continue;
    switch (e.type) {
      case "line":
        prims.push(
          { id: `${e.id}.p1`, type: "point", x: e.start[0], y: e.start[1], fixed: false },
          { id: `${e.id}.p2`, type: "point", x: e.end[0], y: e.end[1], fixed: false },
          { id: e.id, type: "line", p1_id: `${e.id}.p1`, p2_id: `${e.id}.p2` },
        );
        endpoints.push({ id: `${e.id}.p1`, p: e.start }, { id: `${e.id}.p2`, p: e.end });
        break;
      case "circle":
        prims.push(
          { id: `${e.id}.c`, type: "point", x: e.center[0], y: e.center[1], fixed: false },
          { id: e.id, type: "circle", c_id: `${e.id}.c`, radius: e.radius },
        );
        break;
      case "arc": {
        const s = arcPoint(e.center, e.radius, e.startAngle);
        const en = arcPoint(e.center, e.radius, e.endAngle);
        prims.push(
          { id: `${e.id}.c`, type: "point", x: e.center[0], y: e.center[1], fixed: false },
          { id: `${e.id}.s`, type: "point", x: s[0], y: s[1], fixed: false },
          { id: `${e.id}.e`, type: "point", x: en[0], y: en[1], fixed: false },
          {
            id: e.id,
            type: "arc",
            c_id: `${e.id}.c`,
            start_id: `${e.id}.s`,
            end_id: `${e.id}.e`,
            start_angle: deg2rad(e.startAngle),
            end_angle: deg2rad(e.endAngle),
            radius: e.radius,
          },
        );
        endpoints.push({ id: `${e.id}.s`, p: s }, { id: `${e.id}.e`, p: en });
        break;
      }
      case "rectangle":
        break; // rigid; not part of the solve
    }
  }

  // implicit coincidence between endpoints that share coordinates
  let ccount = 0;
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const a = endpoints[i]!;
      const b = endpoints[j]!;
      if (Math.abs(a.p[0] - b.p[0]) < 1e-6 && Math.abs(a.p[1] - b.p[1]) < 1e-6) {
        prims.push({ id: `_coin${ccount++}`, type: "p2p_coincident", p1_id: a.id, p2_id: b.id });
      }
    }
  }

  // user constraints
  for (const c of constraints) {
    const [e1, e2] = c.entities;
    const val = typeof c.value === "string" ? Number(c.value) : c.value;
    switch (c.type) {
      case "horizontal":
        prims.push({ id: c.id, type: "horizontal_l", l_id: e1 });
        break;
      case "vertical":
        prims.push({ id: c.id, type: "vertical_l", l_id: e1 });
        break;
      case "distance":
        prims.push({
          id: c.id,
          type: "p2p_distance",
          p1_id: `${e1}.p1`,
          p2_id: `${e1}.p2`,
          distance: val ?? 10,
        });
        break;
      case "radius": {
        const target = entities.find((e) => e.id === e1);
        prims.push({
          id: c.id,
          type: target?.type === "arc" ? "arc_radius" : "circle_radius",
          [target?.type === "arc" ? "a_id" : "c_id"]: e1,
          radius: val ?? 10,
        });
        break;
      }
      case "parallel":
        prims.push({ id: c.id, type: "parallel", l1_id: e1, l2_id: e2 });
        break;
      case "perpendicular":
        prims.push({ id: c.id, type: "perpendicular_ll", l1_id: e1, l2_id: e2 });
        break;
      default:
        break; // coincident/tangent/equal/angle: not yet mapped
    }
  }

  gcs.push_primitives_and_params(prims as never);
  const status = gcs.solve();
  gcs.apply_solution();

  const dof = gcs.gcs.dof();
  const conflicts = gcs.get_gcs_conflicting_constraints();

  // read solved geometry back into our entity model
  const solved: SketchEntity[] = entities.map((e) => {
    if (e.construction) return e;
    const round = (v: number) => Math.round(v * 10000) / 10000;
    try {
      if (e.type === "line") {
        const p1 = gcs.sketch_index.get_sketch_point(`${e.id}.p1`);
        const p2 = gcs.sketch_index.get_sketch_point(`${e.id}.p2`);
        return { ...e, start: [round(p1.x), round(p1.y)], end: [round(p2.x), round(p2.y)] };
      }
      if (e.type === "circle") {
        const c = gcs.sketch_index.get_sketch_point(`${e.id}.c`);
        const circle = gcs.sketch_index.get_sketch_circle(e.id);
        return { ...e, center: [round(c.x), round(c.y)], radius: round(circle.radius) };
      }
      if (e.type === "arc") {
        const c = gcs.sketch_index.get_sketch_point(`${e.id}.c`);
        const arc = gcs.sketch_index.get_sketch_arc(e.id);
        return {
          ...e,
          center: [round(c.x), round(c.y)],
          radius: round(arc.radius),
          startAngle: round(rad2deg(arc.start_angle)),
          endAngle: round(rad2deg(arc.end_angle)),
        };
      }
    } catch {
      /* primitive missing (e.g. construction) — keep original */
    }
    return e;
  });

  return {
    status:
      conflicts.length > 0
        ? "conflicting"
        : status === SolveStatus.Success || status === SolveStatus.Converged
          ? "ok"
          : "failed",
    entities: solved,
    dof: Math.max(0, dof),
    conflicts,
  };
}
