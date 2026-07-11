import { z } from "zod";
import {
  defineFeature,
  sketchConstraintSchema,
  sketchEntitySchema,
  sketchPlaneSchema,
  type FeatureId,
} from "@voltcad/model-api";

/**
 * Sketch feature: 2D geometry on a plane. Regeneration assembles closed loops
 * into planar profile faces which downstream features (extrude/revolve)
 * consume via `profilesOf`. Open/construction geometry is displayed but does
 * not produce profiles.
 */
export const sketchFeature = defineFeature({
  type: "sketch",
  label: "Sketch",
  schema: z.object({
    plane: sketchPlaneSchema.describe("Datum plane the sketch lies on"),
    entities: z.array(sketchEntitySchema).describe("2D geometry in sketch coordinates (mm)"),
    constraints: z.array(sketchConstraintSchema).default([]),
  }),
  regenerate(ctx, params, featureId) {
    ctx.buildProfile(featureId as FeatureId, params.plane, params.entities);
  },
});
