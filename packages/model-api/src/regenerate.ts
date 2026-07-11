import type { PartDocument, FeatureStatus } from "./document.ts";
import type { FeatureRegistry } from "./feature.ts";
import type { ModelContext } from "./model-context.ts";
import type { FeatureId } from "./ids.ts";
import { RegenError, toErrorInfo } from "./errors.ts";

/**
 * Sequential history regeneration (pure orchestration — no kernel knowledge).
 *
 * Executes each feature in order against a ModelContext. A failed feature
 * marks itself "error"; subsequent features still run (Onshape behavior) so a
 * broken fillet doesn't hide the rest of the part, EXCEPT when the failure
 * happened while the model has no bodies yet (nothing downstream can work).
 *
 * Incremental regen (per-feature B-Rep caching, dirty tracking) plugs in here
 * later without touching feature implementations.
 */
export function regenerateDocument(
  doc: PartDocument,
  ctx: ModelContext,
  registry: FeatureRegistry,
): FeatureStatus[] {
  const statuses: FeatureStatus[] = [];

  for (const node of doc.features) {
    const featureId = node.id as FeatureId;
    if (node.suppressed) {
      statuses.push({ featureId, status: "suppressed" });
      continue;
    }
    const def = registry.get(node.type);
    if (!def) {
      statuses.push({
        featureId,
        status: "error",
        error: {
          code: "INVALID_PARAMS",
          message: `Unknown feature type "${node.type}"`,
          entities: [],
        },
      });
      continue;
    }

    // Validate params against the feature's schema before touching the kernel.
    const parsed = def.schema.safeParse(node.params);
    if (!parsed.success) {
      statuses.push({
        featureId,
        status: "error",
        error: {
          code: "INVALID_PARAMS",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          entities: [],
        },
      });
      continue;
    }

    const t0 = performance.now();
    try {
      def.regenerate(ctx, parsed.data, featureId);
      statuses.push({ featureId, status: "ok", elapsedMs: performance.now() - t0 });
    } catch (e) {
      statuses.push({
        featureId,
        status: "error",
        error: toErrorInfo(e),
        elapsedMs: performance.now() - t0,
      });
    }
  }
  return statuses;
}

export { RegenError };
