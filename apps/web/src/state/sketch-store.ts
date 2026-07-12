import { create } from "zustand";
import {
  newFeatureId,
  planeBasis,
  entityEndpoints,
  type PlaneBasis,
  type Point2,
  type SketchEntity,
  type SketchPlane,
} from "@voltcad/model-api";
import { getGeometryWorker } from "@voltcad/geometry-worker";
import { useEditorStore } from "./document-store.ts";

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

export type SketchTool = "select" | "line" | "rectangle" | "circle";

interface SketchState {
  active: boolean;
  /** Feature being edited, or null when creating a new sketch. */
  editingFeatureId: string | null;
  plane: SketchPlane;
  basis: PlaneBasis;
  entities: SketchEntity[];
  tool: SketchTool;
  /** In-progress tool points (line chain cursor, rect corner, circle center). */
  pending: Point2 | null;
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
): void {
  set({
    active: true,
    editingFeatureId,
    plane,
    basis,
    entities,
    tool: "line",
    pending: null,
    cursor: null,
    version: get().version + 1,
  });
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
  tool: "line",
  pending: null,
  cursor: null,
  version: 0,

  begin(plane, editFeatureId) {
    let entities: SketchEntity[] = [];
    if (editFeatureId) {
      const feature = useEditorStore.getState().doc.features.find((f) => f.id === editFeatureId);
      const params = feature?.params as { entities?: SketchEntity[]; plane?: SketchPlane };
      entities = structuredClone(params?.entities ?? []);
      plane = params?.plane ?? plane;
    }
    if (plane.kind === "face") {
      // face plane basis lives in the kernel — fetch async then activate
      void getGeometryWorker()
        .getFaceBasis(plane.face)
        .then((basis) => {
          if (basis) activate(set, get, plane, basis, entities, editFeatureId ?? null);
        });
      return;
    }
    activate(set, get, plane, planeBasis(plane, 0), entities, editFeatureId ?? null);
  },

  async beginOnFace(faceName) {
    const basis = await getGeometryWorker().getFaceBasis(faceName);
    if (!basis) return false; // not planar — caller shows feedback
    activate(set, get, { kind: "face", face: faceName }, basis, [], null);
    return true;
  },

  setTool(tool) {
    set({ tool, pending: null, version: get().version + 1 });
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
  },

  escape() {
    const s = get();
    if (s.pending) set({ pending: null, version: s.version + 1 });
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
    set({ entities: s.entities.slice(0, -1), version: s.version + 1 });
  },

  finish() {
    const s = get();
    const editor = useEditorStore.getState();
    if (s.editingFeatureId) {
      const feature = editor.doc.features.find((f) => f.id === s.editingFeatureId);
      const prev = feature?.params as { constraints?: unknown[] };
      editor.updateFeatureParams(s.editingFeatureId, {
        plane: s.plane,
        entities: s.entities,
        constraints: prev?.constraints ?? [],
      });
    } else if (s.entities.length > 0) {
      const count = editor.doc.features.filter((f) => f.type === "sketch").length;
      editor.addFeatures([
        {
          id: newFeatureId("sk"),
          type: "sketch",
          name: `Sketch ${count + 1}`,
          params: { plane: s.plane, entities: s.entities, constraints: [] },
        },
      ]);
    }
    set({ active: false, pending: null, cursor: null, version: get().version + 1 });
  },

  cancel() {
    set({ active: false, pending: null, cursor: null, version: get().version + 1 });
  },
}));
