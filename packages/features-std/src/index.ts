import { FeatureRegistry } from "@voltcad/model-api";
import { sketchFeature } from "./sketch.ts";
import { extrudeFeature, revolveFeature } from "./extrude.ts";
import { chamferFeature, filletFeature } from "./fillet.ts";

export { sketchFeature, extrudeFeature, revolveFeature, filletFeature, chamferFeature };

/** Build a registry containing all standard features. */
export function createStandardRegistry(): FeatureRegistry {
  return new FeatureRegistry()
    .register(sketchFeature)
    .register(extrudeFeature)
    .register(revolveFeature)
    .register(filletFeature)
    .register(chamferFeature);
}
