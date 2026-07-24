import * as Y from "yjs";
import type { FeatureNode, PartDocument } from "@voltcad/model-api";

/**
 * CRDT document layer — the PartDocument lives inside a Y.Doc.
 *
 * Structure:
 *   meta:       Y.Map  { name, version, rollback? }
 *   parameters: Y.Map  { [name]: string | number }
 *   features:   Y.Array<Y.Map>  each { id, type, name, suppressed?, params }
 *
 * Feature params are stored as plain JSON values (feature-level granularity):
 * concurrent edits to *different* features merge cleanly; edits to the same
 * feature's params are last-write-wins. That is the right tradeoff for CAD —
 * half-merged params would regen garbage.
 *
 * All local mutations go through the exported mutators, which transact with
 * LOCAL_ORIGIN so the UndoManager only tracks local edits (remote peers'
 * changes must never enter the local undo stack).
 */

export const ydoc = new Y.Doc({ gc: true });
export const LOCAL_ORIGIN = "local";
/** Origin for bootstrap/migration writes — excluded from undo history. */
export const INIT_ORIGIN = "init";

const meta = ydoc.getMap<unknown>("meta");
const parameters = ydoc.getMap<string | number>("parameters");
const features = ydoc.getArray<Y.Map<unknown>>("features");

export const undoManager = new Y.UndoManager([meta, parameters, features], {
  trackedOrigins: new Set([LOCAL_ORIGIN]),
  captureTimeout: 0, // every transaction is its own undo step
});

/**
 * Same-origin tab sync. All tabs share one OPFS autosave file, so without a
 * live channel between them the last writer would clobber the others. A
 * BroadcastChannel keeps every tab's Y.Doc converged in realtime — the same
 * merge semantics as remote collaboration, with zero servers involved.
 */
const BC_ORIGIN = "bc";
if (typeof BroadcastChannel !== "undefined") {
  const bc = new BroadcastChannel("voltcad-doc");
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== BC_ORIGIN) bc.postMessage({ t: "update", u: update });
  });
  bc.onmessage = (e: MessageEvent) => {
    if (e.data?.t === "update") {
      Y.applyUpdate(ydoc, new Uint8Array(e.data.u), BC_ORIGIN);
    } else if (e.data?.t === "request-state") {
      bc.postMessage({ t: "update", u: Y.encodeStateAsUpdate(ydoc) });
    }
  };
  bc.postMessage({ t: "request-state" }); // pull state from any live sibling
}

// ------------------------------------------------------------- converters

function featureToYMap(f: FeatureNode): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", f.id);
  m.set("type", f.type);
  m.set("name", f.name);
  if (f.suppressed !== undefined) m.set("suppressed", f.suppressed);
  m.set("params", f.params ?? {});
  return m;
}

function yMapToFeature(m: Y.Map<unknown>): FeatureNode {
  const f: FeatureNode = {
    id: m.get("id") as FeatureNode["id"],
    type: m.get("type") as string,
    name: m.get("name") as string,
    params: m.get("params"),
  };
  const suppressed = m.get("suppressed");
  if (suppressed !== undefined) f.suppressed = suppressed as boolean;
  return f;
}

/** Plain-JSON snapshot — everything downstream (worker, UI) stays unchanged. */
export function snapshotDoc(): PartDocument {
  const doc: PartDocument = {
    version: 1,
    name: (meta.get("name") as string) ?? "Untitled",
    parameters: Object.fromEntries(parameters.entries()),
    features: features.map(yMapToFeature),
  };
  const rollback = meta.get("rollback");
  if (typeof rollback === "number") doc.rollback = rollback;
  return doc;
}

/** Full-state replace (bootstrap, migration, AI doc rewrite). */
export function loadIntoYDoc(
  doc: PartDocument,
  origin: string = INIT_ORIGIN,
): void {
  ydoc.transact(() => {
    meta.set("name", doc.name);
    meta.set("version", 1);
    if (doc.rollback !== undefined) meta.set("rollback", doc.rollback);
    else meta.delete("rollback");
    for (const key of [...parameters.keys()]) parameters.delete(key);
    for (const [k, v] of Object.entries(doc.parameters)) parameters.set(k, v);
    features.delete(0, features.length);
    features.insert(0, doc.features.map(featureToYMap));
  }, origin);
}

export function isYDocEmpty(): boolean {
  return features.length === 0 && meta.get("name") === undefined;
}

// ------------------------------------------------------------- mutators
// Each is a single undoable transaction with LOCAL_ORIGIN.

function local(fn: () => void): void {
  ydoc.transact(fn, LOCAL_ORIGIN);
}

function featureIndex(id: string): number {
  for (let i = 0; i < features.length; i++) {
    if (features.get(i).get("id") === id) return i;
  }
  return -1;
}

export const yMutations = {
  setName(name: string): void {
    local(() => meta.set("name", name));
  },

  setRollback(index: number | undefined): void {
    local(() => {
      if (index === undefined) meta.delete("rollback");
      else meta.set("rollback", index);
    });
  },

  setParameter(name: string, value: string | number): void {
    local(() => parameters.set(name, value));
  },

  removeParameter(name: string): void {
    local(() => parameters.delete(name));
  },

  addFeatures(nodes: FeatureNode[]): void {
    local(() => features.insert(features.length, nodes.map(featureToYMap)));
  },

  updateFeatureParams(id: string, params: unknown): void {
    const i = featureIndex(id);
    if (i < 0) return;
    local(() => features.get(i).set("params", params));
  },

  renameFeature(id: string, name: string): void {
    const i = featureIndex(id);
    if (i < 0) return;
    local(() => features.get(i).set("name", name));
  },

  toggleSuppress(id: string): void {
    const i = featureIndex(id);
    if (i < 0) return;
    local(() => {
      const m = features.get(i);
      m.set("suppressed", !(m.get("suppressed") as boolean | undefined));
    });
  },

  removeFeature(id: string): void {
    const i = featureIndex(id);
    if (i < 0) return;
    local(() => features.delete(i, 1));
  },

  /** Yjs has no native move — delete + re-insert a clone. */
  moveFeature(id: string, toIndex: number): void {
    const from = featureIndex(id);
    if (from < 0 || toIndex < 0 || toIndex > features.length) return;
    local(() => {
      const clone = featureToYMap(yMapToFeature(features.get(from)));
      features.delete(from, 1);
      features.insert(toIndex > from ? toIndex - 1 : toIndex, [clone]);
    });
  },
};
