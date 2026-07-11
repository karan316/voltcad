import type { z } from "zod";
import type { ModelContext } from "./model-context.ts";
import type { FeatureId } from "./ids.ts";

/**
 * defineFeature — one definition powers five consumers:
 *   1. document validation        (schema)
 *   2. auto-generated UI dialogs  (schema)
 *   3. AI tool definitions        (schema → OpenAI tool JSON)
 *   4. regeneration               (regenerate)
 *   5. TypeScript param types     (z.infer)
 *
 * Built-in features are NOT special: they register through the same function
 * that future user-defined ("VoltScript") features will use.
 */

export interface FeatureDefinition<S extends z.ZodType = z.ZodType> {
  /** Unique document type discriminator, e.g. "extrude". Never rename. */
  type: string;
  /** Human label for UI + AI. */
  label: string;
  /** Parameter schema. `.describe()` strings become AI tool docs. */
  schema: S;
  /**
   * Recompute geometry. Runs inside the geometry worker; must be
   * deterministic (P2P peers regenerate independently and must converge).
   */
  regenerate(ctx: ModelContext, params: z.infer<S>, featureId: FeatureId): void;
}

/** Identity helper for inference; keeps feature files boilerplate-free. */
export function defineFeature<S extends z.ZodType>(
  def: FeatureDefinition<S>,
): FeatureDefinition<S> {
  return def;
}

/**
 * Registry — maps document `type` strings to definitions. Instantiated once
 * per runtime (worker for regen, main thread for UI schemas).
 */
export class FeatureRegistry {
  private defs = new Map<string, FeatureDefinition>();

  register(def: FeatureDefinition<z.ZodType>): this {
    if (this.defs.has(def.type))
      throw new Error(`Feature type "${def.type}" already registered`);
    this.defs.set(def.type, def);
    return this;
  }

  get(type: string): FeatureDefinition | undefined {
    return this.defs.get(type);
  }

  all(): FeatureDefinition[] {
    return [...this.defs.values()];
  }
}
