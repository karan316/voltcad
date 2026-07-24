import { create } from "zustand";
import * as Y from "yjs";
import {
  createEmptyDocument,
  newFeatureId,
  type EntityKind,
  type FeatureNode,
  type FeatureStatus,
  type PartDocument,
  type SceneUpdate,
} from "@voltcad/model-api";
import {
  getGeometryWorker,
  WorkerTimeoutError,
  type MassProperties,
} from "@voltcad/geometry-worker";
import {
  autosaveYDoc,
  getBlob,
  loadDocumentFromOpfs,
  loadYDocFromOpfs,
  putBlob,
} from "../lib/opfs.ts";
import { fetchRelayBlob } from "../lib/blob-sync.ts";
import {
  INIT_ORIGIN,
  LOCAL_ORIGIN,
  isYDocEmpty,
  loadIntoYDoc,
  snapshotDoc,
  undoManager,
  yMutations,
  ydoc,
} from "./ydoc.ts";

/**
 * Editor store — UI state + the regeneration orchestrator.
 *
 * The source of truth is the Yjs CRDT (see ydoc.ts). `doc` in this store is a
 * derived plain-JSON snapshot so all consumers (worker, UI, AI tools) stay
 * unchanged. Every local mutation is a Y transaction; a single doc observer
 * re-snapshots, autosaves and schedules a regen — the same path remote
 * collaborator edits will take.
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
  /** bump to ask the viewport to re-frame the model */
  fitCounter: number;
  /** bump to ask the viewport for the isometric home view */
  homeCounter: number;
  /** exploded-view separation, 0 = assembled (display-only, not persisted) */
  explodeFactor: number;

  selection: Selection[];
  hovered: Selection | null;
  /** feature id currently open in the inspector */
  activeFeatureId: string | null;
  /** which sidebar tab is visible (lifted so errors can deep-link to Model) */
  sidebarTab: "chat" | "model";
  canUndo: boolean;
  canRedo: boolean;

  // actions
  bootstrap(): Promise<void>;
  replaceDocument(doc: PartDocument): void;
  renameDocument(name: string): void;
  addFeatures(nodes: (Omit<FeatureNode, "id"> & { id?: string })[]): string[];
  updateFeatureParams(id: string, params: unknown): void;
  renameFeature(id: string, name: string): void;
  toggleSuppress(id: string): void;
  removeFeature(id: string): void;
  setParameter(name: string, value: string | number): void;
  removeParameter(name: string): void;
  moveFeature(id: string, toIndex: number): void;
  setRollback(index: number | null): void;

  setHovered(sel: Selection | null): void;
  select(sel: Selection, additive: boolean): void;
  clearSelection(): void;
  setActiveFeature(id: string | null): void;
  setSidebarTab(tab: "chat" | "model"): void;
  requestFit(): void;
  requestHome(): void;
  setExplodeFactor(factor: number): void;
  undo(): void;
  redo(): void;

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
          {
            id: "rect1",
            type: "rectangle",
            corner1: [-40, -25],
            corner2: [40, 25],
          },
          { id: "hole1", type: "circle", center: [20, 0], radius: 8 },
        ],
        constraints: [],
      },
    },
    {
      id: extrudeId,
      type: "extrude",
      name: "Extrude 1",
      params: {
        sketch: sketchId,
        distance: "thickness",
        symmetric: false,
        op: "new",
      },
    },
  ];
  return doc;
}

// ------------------------------------------------------------- regen pipeline

let regenRunning = false;
let regenPending = false;
/** Callers awaiting the regen pipeline to drain (AI tools need results). */
let regenWaiters: (() => void)[] = [];

/** Resolves when the regen pipeline is idle (all queued docs processed). */
export function regenSettled(): Promise<void> {
  if (!regenRunning) return Promise.resolve();
  return new Promise((resolve) => regenWaiters.push(resolve));
}

/**
 * Imported file payloads live in the content-addressed blob store; the worker
 * needs the actual text. Inflate blob references into `data` just before
 * regen (in-memory cached, so this is cheap after the first pass).
 */
async function inflateBlobs(doc: PartDocument): Promise<PartDocument> {
  let changed = false;
  const features = await Promise.all(
    doc.features.map(async (f) => {
      if (f.type !== "import") return f;
      const p = f.params as {
        format: string;
        data?: string;
        blobHash?: string;
      };
      if (!p.blobHash || p.data) return f;
      let data = await getBlob(p.blobHash);
      if (data === null) {
        // not local — a collaborator imported it; fetch from the relay
        data = await fetchRelayBlob(p.blobHash);
        if (data !== null) await putBlob(data); // cache locally for next regen
      }
      if (data === null) return f; // missing blob → feature errors in regen
      changed = true;
      return { ...f, params: { ...p, data } };
    }),
  );
  return changed ? { ...doc, features } : doc;
}

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
      const doc = await inflateBlobs(get().doc);
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
    if (e instanceof WorkerTimeoutError) {
      // watchdog killed a hung kernel — next edit boots a fresh worker
      set({ kernelStatus: "cold", kernelError: e.message });
    } else {
      set({
        kernelStatus: "error",
        kernelError: e instanceof Error ? e.message : String(e),
      });
    }
  } finally {
    regenRunning = false;
    set({ regenBusy: false });
    const waiters = regenWaiters;
    regenWaiters = [];
    for (const w of waiters) w();
  }
}

export const useEditorStore = create<EditorState>((set, get) => {
  /**
   * The single write path: every Y transaction (local mutation, undo/redo,
   * remote peer update) lands here — re-snapshot, autosave, regen.
   */
  ydoc.on("update", () => {
    set({
      doc: snapshotDoc(),
      canUndo: undoManager.canUndo(),
      canRedo: undoManager.canRedo(),
    });
    autosaveYDoc(() => Y.encodeStateAsUpdate(ydoc));
    void runRegen(get, (p) => set(p));
  });

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
    fitCounter: 0,
    homeCounter: 0,
    explodeFactor: 0,
    selection: [],
    hovered: null,
    activeFeatureId: null,
    sidebarTab: "chat" as const,
    canUndo: false,
    canRedo: false,

    async bootstrap() {
      // 1) CRDT binary is the primary save format
      const update = await loadYDocFromOpfs();
      if (update) {
        try {
          Y.applyUpdate(ydoc, update, INIT_ORIGIN);
        } catch {
          // corrupted save — fall through to legacy/default below
        }
      }
      // 2) migrate a legacy plain-JSON save, else seed the default part
      if (isYDocEmpty()) {
        const legacy = await loadDocumentFromOpfs();
        loadIntoYDoc(
          legacy && legacy.features.length > 0 ? legacy : get().doc,
          INIT_ORIGIN,
        );
      }
    },

    replaceDocument(doc) {
      loadIntoYDoc(doc, LOCAL_ORIGIN); // undoable full-state replace
    },

    renameDocument(name) {
      yMutations.setName(name);
    },

    addFeatures(nodes) {
      const created = nodes.map((n) => ({
        ...n,
        id: n.id ?? newFeatureId(n.type),
      })) as FeatureNode[];
      yMutations.addFeatures(created);
      return created.map((n) => n.id);
    },

    updateFeatureParams(id, params) {
      yMutations.updateFeatureParams(id, params);
    },

    renameFeature(id, name) {
      yMutations.renameFeature(id, name);
    },

    toggleSuppress(id) {
      yMutations.toggleSuppress(id);
    },

    removeFeature(id) {
      yMutations.removeFeature(id);
      if (get().activeFeatureId === id) set({ activeFeatureId: null });
    },

    setParameter(name, value) {
      yMutations.setParameter(name, value);
    },

    removeParameter(name) {
      yMutations.removeParameter(name);
    },

    moveFeature(id, toIndex) {
      yMutations.moveFeature(id, toIndex);
    },

    setRollback(index) {
      const doc = get().doc;
      yMutations.setRollback(
        index === null || index >= doc.features.length
          ? undefined
          : Math.max(0, index),
      );
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
        set({
          selection: exists
            ? cur.filter((s) => s.name !== sel.name)
            : [...cur, sel],
        });
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

    setSidebarTab(tab) {
      set({ sidebarTab: tab });
    },

    requestFit() {
      set({ fitCounter: get().fitCounter + 1 });
    },

    requestHome() {
      set({ homeCounter: get().homeCounter + 1 });
    },

    setExplodeFactor(factor) {
      set({ explodeFactor: Math.max(0, Math.min(1, factor)) });
    },

    undo() {
      undoManager.undo();
    },

    redo() {
      undoManager.redo();
    },

    async exportModel(format) {
      try {
        const worker = getGeometryWorker();
        const data =
          format === "step"
            ? await worker.exportStep()
            : await worker.exportStl();
        const blob = new Blob([data as BlobPart], {
          type: "application/octet-stream",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${get().doc.name || "part"}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        // surface export failures in the status bar instead of swallowing them
        set({
          kernelError: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
  };
});

// dev-only escape hatch for E2E tests and console debugging
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__voltcad = {
    store: useEditorStore,
    worker: getGeometryWorker,
    // lazy to avoid a static import cycle (collab-store imports this module)
    collab: () => import("./collab-store.ts").then((m) => m.useCollabStore),
  };
}
