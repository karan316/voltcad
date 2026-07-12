import {
  regenerateDocument,
  type FeatureStatus,
  type PartDocument,
  type SceneUpdate,
} from "@voltcad/model-api";
import { createStandardRegistry } from "@voltcad/features-std";
import type { OC } from "./init.ts";
import { OcModelContext, type CtxSnapshot } from "./context.ts";
import { tessellateBody } from "./tessellate.ts";
import type { FaceNameMap } from "./naming.ts";

/**
 * Incremental regeneration cache.
 *
 * After every feature we snapshot the context (cheap: arrays of references —
 * OCCT shapes are immutable, operations always produce new ones). On the next
 * regen we diff the feature list against cached keys, restore the checkpoint
 * at the longest unchanged prefix, and only re-run what changed. Editing a
 * fillet radius on a 50-feature part re-runs ONE feature, not fifty.
 *
 * Ownership: FaceNameMaps hold WASM-heap maps and may be shared between
 * checkpoints (bodies untouched by a feature carry over). Disposal therefore
 * happens ONLY here, by set-difference against everything still referenced.
 */

const registry = createStandardRegistry();

interface CacheEntry {
  /** Identity of features[0..i] + parameter table. */
  key: string;
  snap: CtxSnapshot;
  status: FeatureStatus;
}

let ctx: OcModelContext | null = null;
let cache: CacheEntry[] = [];

export function getContext(): OcModelContext | null {
  return ctx;
}

/** Stable per-feature cache key. Parameters affect every expression → global. */
function featureKeys(doc: PartDocument): string[] {
  const paramsKey = JSON.stringify(doc.parameters);
  return doc.features.map((f) => paramsKey + JSON.stringify(f));
}

function mapsIn(snaps: CtxSnapshot[], extra: FaceNameMap[] = []): Set<FaceNameMap> {
  const set = new Set<FaceNameMap>(extra);
  for (const s of snaps) for (const b of s.bodies) set.add(b.faces);
  return set;
}

/** Dispose every map in `candidates` that is not in `keep`. */
function disposeUnreferenced(candidates: Set<FaceNameMap>, keep: Set<FaceNameMap>): void {
  for (const m of candidates) if (!keep.has(m)) m.dispose();
}

export interface IncrementalResult {
  statuses: FeatureStatus[];
  scene: SceneUpdate;
  /** How many features were served from cache (perf HUD / tests). */
  cachedCount: number;
}

export function regenerateIncremental(oc: OC, doc: PartDocument): IncrementalResult {
  ctx ??= new OcModelContext(oc, doc.parameters);
  ctx.setParameters(doc.parameters);

  const keys = featureKeys(doc);

  // longest prefix of features whose keys match the cache
  let prefix = 0;
  while (prefix < keys.length && prefix < cache.length && cache[prefix]!.key === keys[prefix]) {
    prefix++;
  }

  // invalidate everything past the prefix; dispose maps that only they held
  const dropped = cache.slice(prefix);
  cache = cache.slice(0, prefix);
  const keep = mapsIn(cache.map((e) => e.snap));
  disposeUnreferenced(mapsIn(dropped.map((e) => e.snap)), keep);

  // resume from the checkpoint (or empty for a full rebuild)
  if (prefix > 0) ctx.restore(cache[prefix - 1]!.snap);
  else ctx.reset();

  const statuses: FeatureStatus[] = cache.map((e) => e.status);
  const newStatuses = regenerateDocument(doc, ctx, registry, {
    startIndex: prefix,
    onFeature: (status, index) => {
      cache.push({ key: keys[index]!, snap: ctx!.snapshot(), status });
    },
  });
  statuses.push(...newStatuses);

  // retire intermediate maps created and replaced within this run
  const stillKeep = mapsIn(cache.map((e) => e.snap));
  disposeUnreferenced(new Set(ctx.retired), stillKeep);
  ctx.retired = [];

  const scene: SceneUpdate = {
    bodies: ctx.bodies.map((b) => tessellateBody(oc, b)),
    // clone: the context's copies live in checkpoints and must survive the
    // transfer (postMessage detaches the transferred buffers)
    sketches: ctx.sketchDisplays.map((s) => ({
      featureId: s.featureId,
      positions: s.positions.slice(),
    })),
  };

  return { statuses, scene, cachedCount: prefix };
}
