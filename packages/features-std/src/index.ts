import { FeatureRegistry } from "@voltcad/model-api";
import { sketchFeature } from "./sketch.ts";
import { extrudeFeature, revolveFeature } from "./extrude.ts";
import { chamferFeature, filletFeature } from "./fillet.ts";
import { importFeature } from "./import.ts";

export { sketchFeature, extrudeFeature, revolveFeature, filletFeature, chamferFeature, importFeature };

/** Build a registry containing all standard features. */
export function createStandardRegistry(): FeatureRegistry {
  return new FeatureRegistry()
    .register(sketchFeature)
    .register(extrudeFeature)
    .register(revolveFeature)
    .register(filletFeature)
    .register(chamferFeature)
    .register(importFeature);
}
