import { create } from "zustand";
import {
  newFeatureId,
  planeBasis,
  entityEndpoints,
  arcPoint,
  type PlaneBasis,
  type Point2,
  type SketchConstraint,
  type SketchEntity,
  type SketchPlane,
} from "@voltcad/model-api";
import { getGeometryWorker } from "@voltcad/geometry-worker";
import { useEditorStore } from "./document-store.ts";
import { solveSketch } from "../lib/sketch-solver.ts";

/**
 * Interactive sketch mode.
 *
 * All coordinates are sketch-plane UV in millimeters. The viewport maps
 * pointer rays onto the plane and feeds snapped UV points here; this store
 * owns the draft entities and drawing-tool state machine. Nothing touches
 * the document until finish() — cancel is free.
 *
 * Snapping: endpoint snap (radius scales with zoom) wins over grid snap
 * (1mm). Endpoint snapping bakes exact shared coordinates, which is what
 * makes drawn loops close and profiles extrudable.
 */

export type SketchTool = "select" | "line" | "rectangle" | "circle" | "arc";

interface SketchState {
  active: boolean;
  /** Feature being edited, or null when creating a new sketch. */
  editingFeatureId: string | null;
  plane: SketchPlane;
  basis: PlaneBasis;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  /** Entity ids selected with the select tool (constraint targets). */
  selectedIds: string[];
  /** Remaining degrees of freedom from the last solve; null = never solved. */
  dof: number | null;
  solveError: string | null;
  tool: SketchTool;
  /** In-progress tool points (line chain cursor, rect corner, circle center). */
  pending: Point2 | null;
  /** Second in-progress point (3-point arc: start → end → bulge). */
  pending2: Point2 | null;
  /** Snapped cursor position for preview rendering. */
  cursor: Point2 | null;
  /** Bumped on any draft change → viewport overlay rebuild. */
  version: number;

  begin(plane: SketchPlane, editFeatureId?: string): void;
  /** Start a sketch on a planar face (basis fetched from the kernel). */
  beginOnFace(faceName: string): Promise<boolean>;
  setTool(tool: SketchTool): void;
  setPlane(plane: SketchPlane): void;
  /** Pointer moved; uv already on the plane, tol = snap radius in mm. */
  hover(uv: Point2, tol: number): void;
  /** Primary click. */
  click(uv: Point2, tol: number): void;
  /** Escape: end the current chain, or drop to select tool. */
  escape(): void;
  removeLast(): void;
  /**
   * Complete the pending tool action with typed exact dimensions instead of
   * a click: line → [length], rectangle → [width, height], circle → [radius].
   * Direction/quadrant comes from the current cursor position.
   */
  applyDimension(values: number[]): void;
  /** Add a constraint on the selected entities, then solve. */
  addConstraint(type: SketchConstraint["type"], value?: number): Promise<void>;
  removeConstraint(id: string): Promise<void>;
  finish(): void;
  cancel(): void;
}

let entityCounter = 0;
const nextEntityId = () => `e${Date.now().toString(36).slice(-3)}${(entityCounter++).toString(36)}`;

/** Shared activation for datum + face begins. */
function activate(
  set: (partial: Partial<SketchState>) => void,
  get: () => SketchState,
  plane: SketchPlane,
  basis: PlaneBasis,
  entities: SketchEntity[],
  editingFeatureId: string | null,
  constraints: SketchConstraint[] = [],
): void {
  set({
    active: true,
    editingFeatureId,
    plane,
    basis,
    entities,
    constraints,
    selectedIds: [],
    dof: null,
    solveError: null,
    tool: "line",
    pending: null,
    cursor: null,
    version: get().version + 1,
  });
}

/** Distance from a point to an entity's curve, for select-tool hit testing. */
function distanceToEntity(uv: Point2, e: SketchEntity): number {
  const segDist = (a: Point2, b: Point2): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((uv[0] - a[0]) * dx + (uv[1] - a[1]) * dy) / len2));
    return Math.hypot(uv[0] - (a[0] + t * dx), uv[1] - (a[1] + t * dy));
  };
  switch (e.type) {
    case "line":
      return segDist(e.start, e.end);
    case "circle":
      return Math.abs(Math.hypot(uv[0] - e.center[0], uv[1] - e.center[1]) - e.radius);
    case "arc": {
      // approximate: radial distance if angle within span, else endpoint dist
      const ang = (Math.atan2(uv[1] - e.center[1], uv[0] - e.center[0]) * 180) / Math.PI;
      let span = e.endAngle - e.startAngle;
      while (span <= 0) span += 360;
      let rel = ang - e.startAngle;
      while (rel < 0) rel += 360;
      if (rel <= span)
        return Math.abs(Math.hypot(uv[0] - e.center[0], uv[1] - e.center[1]) - e.radius);
      const s = arcPoint(e.center, e.radius, e.startAngle);
      const en = arcPoint(e.center, e.radius, e.endAngle);
      return Math.min(Math.hypot(uv[0] - s[0], uv[1] - s[1]), Math.hypot(uv[0] - en[0], uv[1] - en[1]));
    }
    case "rectangle": {
      const [x1, y1] = e.corner1;
      const [x2, y2] = e.corner2;
      return Math.min(
        segDist([x1, y1], [x2, y1]),
        segDist([x2, y1], [x2, y2]),
        segDist([x2, y2], [x1, y2]),
        segDist([x1, y2], [x1, y1]),
      );
    }
  }
}

/**
 * 3-point arc: circumcircle through start S, end E, and a point M on the arc.
 * Returns our CCW (startAngle→endAngle) representation, oriented so the arc
 * passes through M. Null when the points are collinear.
 */
export function arcFrom3Points(
  S: Point2,
  E: Point2,
  M: Point2,
): { center: Point2; radius: number; startAngle: number; endAngle: number } | null {
  const ax = S[0], ay = S[1], bx = E[0], by = E[1], cx = M[0], cy = M[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null; // collinear
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const radius = Math.hypot(ax - ux, ay - uy);
  const ang = (p: Point2) => ((Math.atan2(p[1] - uy, p[0] - ux) * 180) / Math.PI + 360) % 360;
  const aS = ang(S), aE = ang(E), aM = ang(M);
  // CCW span S→E contains M? then start=S; otherwise the arc runs E→S
  const ccwContains = (from: number, to: number, x: number) => {
    const span = (to - from + 360) % 360;
    const rel = (x - from + 360) % 360;
    return rel <= span;
  };
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return ccwContains(aS, aE, aM)
    ? { center: [r4(ux), r4(uy)], radius: r4(radius), startAngle: r4(aS), endAngle: r4(aE) }
    : { center: [r4(ux), r4(uy)], radius: r4(radius), startAngle: r4(aE), endAngle: r4(aS) };
}

/** Snap to nearby existing endpoint first, then to the 1mm grid. */
function snap(uv: Point2, entities: SketchEntity[], pending: Point2 | null, tol: number): Point2 {
  let best: Point2 | null = null;
  let bestD = tol;
  const candidates: Point2[] = pending ? [pending] : [];
  for (const e of entities) candidates.push(...entityEndpoints(e));
  for (const c of candidates) {
    const d = Math.hypot(c[0] - uv[0], c[1] - uv[1]);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best) return [best[0], best[1]];
  return [Math.round(uv[0]), Math.round(uv[1])];
}

export const useSketchStore = create<SketchState>((set, get) => ({
  active: false,
  editingFeatureId: null,
  plane: { kind: "datum", plane: "XY" },
  basis: planeBasis({ kind: "datum", plane: "XY" }, 0),
  entities: [],
  constraints: [],
  selectedIds: [],
  dof: null,
  solveError: null,
  tool: "line",
  pending: null,
  pending2: null,
  cursor: null,
  version: 0,

  begin(plane, editFeatureId) {
    let entities: SketchEntity[] = [];
    let constraints: SketchConstraint[] = [];
    if (editFeatureId) {
      const feature = useEditorStore.getState().doc.features.find((f) => f.id === editFeatureId);
      const params = feature?.params as {
        entities?: SketchEntity[];
        plane?: SketchPlane;
        constraints?: SketchConstraint[];
      };
      entities = structuredClone(params?.entities ?? []);
      constraints = structuredClone(params?.constraints ?? []);
      plane = params?.plane ?? plane;
    }
    if (plane.kind === "face") {
      // face plane basis lives in the kernel — fetch async then activate
      void getGeometryWorker()
        .getFaceBasis(plane.face)
        .then((basis) => {
          if (basis) activate(set, get, plane, basis, entities, editFeatureId ?? null, constraints);
        });
      return;
    }
    activate(set, get, plane, planeBasis(plane, 0), entities, editFeatureId ?? null, constraints);
  },

  async beginOnFace(faceName) {
    const basis = await getGeometryWorker().getFaceBasis(faceName);
    if (!basis) return false; // not planar — caller shows feedback
    activate(set, get, { kind: "face", face: faceName }, basis, [], null);
    return true;
  },

  setTool(tool) {
    set({ tool, pending: null, pending2: null, version: get().version + 1 });
  },

  setPlane(plane) {
    // only before anything is drawn — reorienting existing geometry is a lie
    if (get().entities.length > 0 || plane.kind === "face") return;
    set({ plane, basis: planeBasis(plane, 0), version: get().version + 1 });
  },

  hover(uv, tol) {
    const s = get();
    const snapped = snap(uv, s.entities, s.pending, tol);
    const cur = s.cursor;
    if (cur && cur[0] === snapped[0] && cur[1] === snapped[1]) return;
    set({ cursor: snapped, version: s.version + 1 });
  },

  click(uv, tol) {
    const s = get();
    const p = snap(uv, s.entities, s.pending, tol);

    if (s.tool === "select") {
      // hit-test entities; toggle selection (constraint targets)
      let best: string | null = null;
      let bestD = tol * 1.5;
      for (const e of s.entities) {
        const d = distanceToEntity(uv, e);
        if (d < bestD) {
          bestD = d;
          best = e.id;
        }
      }
      if (!best) {
        set({ selectedIds: [], version: s.version + 1 });
        return;
      }
      const selectedIds = s.selectedIds.includes(best)
        ? s.selectedIds.filter((id) => id !== best)
        : [...s.selectedIds, best];
      set({ selectedIds, version: s.version + 1 });
      return;
    }

    if (s.tool === "line") {
      if (!s.pending) {
        set({ pending: p, version: s.version + 1 });
        return;
      }
      // zero-length guard (double click on same point ends the chain)
      if (Math.hypot(p[0] - s.pending[0], p[1] - s.pending[1]) < 1e-9) {
        set({ pending: null, version: s.version + 1 });
        return;
      }
      const line: SketchEntity = { id: nextEntityId(), type: "line", start: s.pending, end: p };
      set({
        entities: [...s.entities, line],
        pending: p, // chain: next segment starts here
        version: s.version + 1,
      });
      return;
    }

    if (s.tool === "rectangle") {
      if (!s.pending) {
        set({ pending: p, version: s.version + 1 });
        return;
      }
      if (p[0] === s.pending[0] || p[1] === s.pending[1]) return; // degenerate
      const rect: SketchEntity = {
        id: nextEntityId(),
        type: "rectangle",
        corner1: s.pending,
        corner2: p,
      };
      set({ entities: [...s.entities, rect], pending: null, version: s.version + 1 });
      return;
    }

    if (s.tool === "circle") {
      if (!s.pending) {
        set({ pending: p, version: s.version + 1 });
        return;
      }
      const radius = Math.hypot(p[0] - s.pending[0], p[1] - s.pending[1]);
      if (radius < 0.5) return; // sub-half-millimeter circles are misclicks
      const circle: SketchEntity = {
        id: nextEntityId(),
        type: "circle",
        center: s.pending,
        radius: Math.round(radius * 100) / 100,
      };
      set({ entities: [...s.entities, circle], pending: null, version: s.version + 1 });
      return;
    }

    if (s.tool === "arc") {
      if (!s.pending) {
        set({ pending: p, version: s.version + 1 });
        return;
      }
      if (!s.pending2) {
        if (Math.hypot(p[0] - s.pending[0], p[1] - s.pending[1]) < 1e-9) return;
        set({ pending2: p, version: s.version + 1 });
        return;
      }
      const arc = arcFrom3Points(s.pending, s.pending2, p);
      if (!arc) return; // collinear — keep waiting for a valid bulge point
      const entity: SketchEntity = { id: nextEntityId(), type: "arc", ...arc };
      set({
        entities: [...s.entities, entity],
        pending: null,
        pending2: null,
        version: s.version + 1,
      });
      return;
    }
  },

  escape() {
    const s = get();
    if (s.pending || s.pending2) set({ pending: null, pending2: null, version: s.version + 1 });
    else if (s.tool !== "select") set({ tool: "select", version: s.version + 1 });
  },

  applyDimension(values) {
    const s = get();
    if (!s.pending) return;
    const [a, b] = values;
    if (s.tool === "line" && a && a > 0) {
      // direction from cursor; falls back to +X
      let dx = 1, dy = 0;
      if (s.cursor) {
        const len = Math.hypot(s.cursor[0] - s.pending[0], s.cursor[1] - s.pending[1]);
        if (len > 1e-6) {
          dx = (s.cursor[0] - s.pending[0]) / len;
          dy = (s.cursor[1] - s.pending[1]) / len;
        }
      }
      const end: Point2 = [
        Math.round((s.pending[0] + dx * a) * 1000) / 1000,
        Math.round((s.pending[1] + dy * a) * 1000) / 1000,
      ];
      const line: SketchEntity = { id: nextEntityId(), type: "line", start: s.pending, end };
      set({ entities: [...s.entities, line], pending: end, version: s.version + 1 });
    } else if (s.tool === "rectangle" && a && b && a > 0 && b > 0) {
      // quadrant from cursor; defaults to +x/+y
      const sx = s.cursor && s.cursor[0] < s.pending[0] ? -1 : 1;
      const sy = s.cursor && s.cursor[1] < s.pending[1] ? -1 : 1;
      const rect: SketchEntity = {
        id: nextEntityId(),
        type: "rectangle",
        corner1: s.pending,
        corner2: [s.pending[0] + sx * a, s.pending[1] + sy * b],
      };
      set({ entities: [...s.entities, rect], pending: null, version: s.version + 1 });
    } else if (s.tool === "circle" && a && a > 0) {
      const circle: SketchEntity = {
        id: nextEntityId(),
        type: "circle",
        center: s.pending,
        radius: a,
      };
      set({ entities: [...s.entities, circle], pending: null, version: s.version + 1 });
    }
  },

  removeLast() {
    const s = get();
    if (s.entities.length === 0) return;
    const removed = s.entities[s.entities.length - 1]!;
    set({
      entities: s.entities.slice(0, -1),
      // drop constraints referencing the removed entity
      constraints: s.constraints.filter((c) => !c.entities.includes(removed.id)),
      selectedIds: s.selectedIds.filter((id) => id !== removed.id),
      version: s.version + 1,
    });
  },

  async addConstraint(type, value) {
    const s = get();
    const constraint: SketchConstraint = {
      id: `c${Date.now().toString(36).slice(-4)}${s.constraints.length}`,
      type,
      entities: [...s.selectedIds],
      ...(value !== undefined && { value }),
    };
    const constraints = [...s.constraints, constraint];
    await runSolve(set, get, s.entities, constraints);
  },

  async removeConstraint(id) {
    const s = get();
    await runSolve(
      set,
      get,
      s.entities,
      s.constraints.filter((c) => c.id !== id),
    );
  },

  finish() {
    const s = get();
    const editor = useEditorStore.getState();
    if (s.editingFeatureId) {
      editor.updateFeatureParams(s.editingFeatureId, {
        plane: s.plane,
        entities: s.entities,
        constraints: s.constraints,
      });
    } else if (s.entities.length > 0) {
      const count = editor.doc.features.filter((f) => f.type === "sketch").length;
      editor.addFeatures([
        {
          id: newFeatureId("sk"),
          type: "sketch",
          name: `Sketch ${count + 1}`,
          params: { plane: s.plane, entities: s.entities, constraints: s.constraints },
        },
      ]);
    }
    set({ active: false, pending: null, pending2: null, cursor: null, version: get().version + 1 });
  },

  cancel() {
    set({ active: false, pending: null, pending2: null, cursor: null, version: get().version + 1 });
  },
}));

/**
 * Solve and commit the result to the draft. On conflict the new constraint
 * set is kept visible with an error so the user can remove the offender.
 */
async function runSolve(
  set: (partial: Partial<SketchState>) => void,
  get: () => SketchState,
  entities: SketchEntity[],
  constraints: SketchConstraint[],
): Promise<void> {
  try {
    const result = await solveSketch(entities, constraints);
    set({
      entities: result.status === "ok" ? result.entities : entities,
      constraints,
      dof: result.dof,
      solveError:
        result.status === "conflicting"
          ? "Conflicting constraints — remove the last one"
          : result.status === "failed"
            ? "Solver could not converge"
            : null,
      selectedIds: [],
      version: get().version + 1,
    });
  } catch (e) {
    set({
      constraints,
      solveError: e instanceof Error ? e.message : String(e),
      version: get().version + 1,
    });
  }
}
