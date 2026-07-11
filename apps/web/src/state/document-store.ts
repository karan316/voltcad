import { create } from "zustand";
import {
  createEmptyDocument,
  newFeatureId,
  type EntityKind,
  type FeatureNode,
  type FeatureStatus,
  type PartDocument,
  type SceneUpdate,
} from "@voltcad/model-api";
import { getGeometryWorker, type MassProperties } from "@voltcad/geometry-worker";
import { autosaveDocument, loadDocumentFromOpfs } from "../lib/opfs.ts";

/**
 * Editor store — UI state + the regeneration orchestrator.
 *
 * Invariants:
 *  - `doc` is immutable data; every mutation replaces it and schedules a regen.
 *  - regens run strictly sequentially in the worker; if edits arrive while one
 *    is in flight we re-run once at the end (latest-wins, no queue buildup).
 */

export interface Selection {
  name: string;
  kind: EntityKind;
}

export type KernelStatus = "cold" | "loading" | "ready" | "error";

interface EditorState {
  doc: PartDocument;
  scene: SceneUpdate | null;
  statuses: Record<string, FeatureStatus>;
  massProps: MassProperties | null;
  kernelStatus: KernelStatus;
  kernelError: string | null;
  regenBusy: boolean;
  regenMs: number;
  /** bump to let the viewport know highlights/scene need re-sync */
  sceneVersion: number;

  selection: Selection[];
  hovered: Selection | null;
  /** feature id currently open in the inspector */
  activeFeatureId: string | null;

  // actions
  bootstrap(): Promise<void>;
  replaceDocument(doc: PartDocument): void;
  addFeatures(nodes: (Omit<FeatureNode, "id"> & { id?: string })[]): string[];
  updateFeatureParams(id: string, params: unknown): void;
  renameFeature(id: string, name: string): void;
  toggleSuppress(id: string): void;
  removeFeature(id: string): void;
  setParameter(name: string, value: string | number): void;
  removeParameter(name: string): void;

  setHovered(sel: Selection | null): void;
  select(sel: Selection, additive: boolean): void;
  clearSelection(): void;
  setActiveFeature(id: string | null): void;

  exportModel(format: "step" | "stl"): Promise<void>;
}

/** Default part so first launch shows something real: a plate with a hole. */
function defaultDocument(): PartDocument {
  const doc = createEmptyDocument("New Part");
  doc.parameters = { thickness: 12 };
  const sketchId = newFeatureId("sk");
  const extrudeId = newFeatureId("ext");
  doc.features = [
    {
      id: sketchId,
      type: "sketch",
      name: "Sketch 1",
      params: {
        plane: { kind: "datum", plane: "XY" },
        entities: [
          { id: "rect1", type: "rectangle", corner1: [-40, -25], corner2: [40, 25] },
          { id: "hole1", type: "circle", center: [20, 0], radius: 8 },
        ],
        constraints: [],
      },
    },
    {
      id: extrudeId,
      type: "extrude",
      name: "Extrude 1",
      params: { sketch: sketchId, distance: "thickness", symmetric: false, op: "new" },
    },
  ];
  return doc;
}

// ------------------------------------------------------------- regen pipeline

let regenRunning = false;
let regenPending = false;

async function runRegen(
  get: () => EditorState,
  set: (partial: Partial<EditorState>) => void,
): Promise<void> {
  if (regenRunning) {
    regenPending = true;
    return;
  }
  regenRunning = true;
  set({ regenBusy: true });
  try {
    const worker = getGeometryWorker();
    if (get().kernelStatus === "cold") {
      set({ kernelStatus: "loading" });
      await worker.init();
      set({ kernelStatus: "ready" });
    }
    // latest-wins loop: keep regenerating until the doc stops changing
    do {
      regenPending = false;
      const doc = get().doc;
      const result = await worker.regenerate(doc);
      const statuses: Record<string, FeatureStatus> = {};
      for (const s of result.statuses) statuses[s.featureId] = s;
      set({
        scene: result.scene,
        statuses,
        regenMs: result.elapsedMs,
        sceneVersion: get().sceneVersion + 1,
      });
      // mass properties are cheap; refresh alongside every successful regen
      set({ massProps: await worker.massProperties() });
    } while (regenPending);
  } catch (e) {
    set({ kernelStatus: "error", kernelError: e instanceof Error ? e.message : String(e) });
  } finally {
    regenRunning = false;
    set({ regenBusy: false });
  }
}

export const useEditorStore = create<EditorState>((set, get) => {
  /** Replace the document, autosave, regenerate. The single write path. */
  function commit(doc: PartDocument): void {
    set({ doc });
    autosaveDocument(doc);
    void runRegen(get, (p) => set(p));
  }

  return {
    doc: defaultDocument(),
    scene: null,
    statuses: {},
    massProps: null,
    kernelStatus: "cold",
    kernelError: null,
    regenBusy: false,
    regenMs: 0,
    sceneVersion: 0,
    selection: [],
    hovered: null,
    activeFeatureId: null,

    async bootstrap() {
      const saved = await loadDocumentFromOpfs();
      if (saved && saved.features.length > 0) set({ doc: saved });
      void runRegen(get, (p) => set(p));
    },

    replaceDocument(doc) {
      commit(doc);
    },

    addFeatures(nodes) {
      const doc = get().doc;
      const created = nodes.map((n) => ({
        ...n,
        id: n.id ?? newFeatureId(n.type),
      })) as FeatureNode[];
      commit({ ...doc, features: [...doc.features, ...created] });
      return created.map((n) => n.id);
    },

    updateFeatureParams(id, params) {
      const doc = get().doc;
      commit({
        ...doc,
        features: doc.features.map((f) => (f.id === id ? { ...f, params } : f)),
      });
    },

    renameFeature(id, name) {
      const doc = get().doc;
      commit({ ...doc, features: doc.features.map((f) => (f.id === id ? { ...f, name } : f)) });
    },

    toggleSuppress(id) {
      const doc = get().doc;
      commit({
        ...doc,
        features: doc.features.map((f) =>
          f.id === id ? { ...f, suppressed: !f.suppressed } : f,
        ),
      });
    },

    removeFeature(id) {
      const doc = get().doc;
      commit({ ...doc, features: doc.features.filter((f) => f.id !== id) });
      if (get().activeFeatureId === id) set({ activeFeatureId: null });
    },

    setParameter(name, value) {
      const doc = get().doc;
      commit({ ...doc, parameters: { ...doc.parameters, [name]: value } });
    },

    removeParameter(name) {
      const doc = get().doc;
      const { [name]: _, ...rest } = doc.parameters;
      commit({ ...doc, parameters: rest });
    },

    setHovered(sel) {
      const cur = get().hovered;
      if (cur?.name === sel?.name) return; // avoid re-render churn on mousemove
      set({ hovered: sel });
    },

    select(sel, additive) {
      const cur = get().selection;
      const exists = cur.some((s) => s.name === sel.name);
      if (additive) {
        set({ selection: exists ? cur.filter((s) => s.name !== sel.name) : [...cur, sel] });
      } else {
        set({ selection: exists && cur.length === 1 ? [] : [sel] });
      }
    },

    clearSelection() {
      if (get().selection.length > 0) set({ selection: [] });
    },

    setActiveFeature(id) {
      set({ activeFeatureId: id });
    },

    async exportModel(format) {
      try {
        const worker = getGeometryWorker();
        const data = format === "step" ? await worker.exportStep() : await worker.exportStl();
        const blob = new Blob([data as BlobPart], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${get().doc.name || "part"}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        // surface export failures in the status bar instead of swallowing them
        set({ kernelError: `Export failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
  };
});

// dev-only escape hatch for E2E tests and console debugging
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__voltcad = {
    store: useEditorStore,
    worker: getGeometryWorker,
  };
}
