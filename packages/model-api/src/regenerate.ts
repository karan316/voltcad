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
 * broken fillet doesn't hide the rest of the part.
 *
 * Incremental regen: the caller may resume from `startIndex` on a context
 * restored from a checkpoint, and receive an `onFeature` callback after each
 * feature to capture new checkpoints.
 */
export interface RegenerateOptions {
  /** First feature index to execute (earlier ones come from a checkpoint). */
  startIndex?: number;
  /** Called after each executed feature (checkpoint capture hook). */
  onFeature?(status: FeatureStatus, index: number): void;
}

export function regenerateDocument(
  doc: PartDocument,
  ctx: ModelContext,
  registry: FeatureRegistry,
  options: RegenerateOptions = {},
): FeatureStatus[] {
  const statuses: FeatureStatus[] = [];
  const start = options.startIndex ?? 0;

  for (let index = start; index < doc.features.length; index++) {
    const node = doc.features[index]!;
    const featureId = node.id as FeatureId;
    let status: FeatureStatus;

    if (doc.rollback !== undefined && index >= doc.rollback) {
      status = { featureId, status: "rolledback" };
    } else if (node.suppressed) {
      status = { featureId, status: "suppressed" };
    } else {
      const def = registry.get(node.type);
      if (!def) {
        status = {
          featureId,
          status: "error",
          error: {
            code: "INVALID_PARAMS",
            message: `Unknown feature type "${node.type}"`,
            entities: [],
          },
        };
      } else {
        // Validate params against the feature's schema before touching the kernel.
        const parsed = def.schema.safeParse(node.params);
        if (!parsed.success) {
          status = {
            featureId,
            status: "error",
            error: {
              code: "INVALID_PARAMS",
              message: parsed.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; "),
              entities: [],
            },
          };
        } else {
          const t0 = performance.now();
          try {
            def.regenerate(ctx, parsed.data, featureId);
            status = { featureId, status: "ok", elapsedMs: performance.now() - t0 };
          } catch (e) {
            status = {
              featureId,
              status: "error",
              error: toErrorInfo(e),
              elapsedMs: performance.now() - t0,
            };
          }
        }
      }
    }

    statuses.push(status);
    options.onFeature?.(status, index);
  }
  return statuses;
}

export { RegenError };
