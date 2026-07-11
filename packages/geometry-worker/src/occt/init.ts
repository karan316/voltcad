/**
 * OCCT WASM bootstrap. Runs inside the geometry worker.
 *
 * The full opencascade.js build (~50MB wasm) is loaded lazily and cached by
 * the browser's HTTP cache; a slim custom OCCT build is the planned
 * optimization once the feature set stabilizes (tracked in package README).
 */
// The d.ts types init() as zero-arg; the underlying emscripten factory
// accepts a Module config object (locateFile etc.), hence the cast below.
import ocMainJs from "opencascade.js/dist/opencascade.full.js";
import ocWasmUrl from "opencascade.js/dist/opencascade.full.wasm?url";
import type { OpenCascadeInstance } from "opencascade.js/dist/opencascade.full.js";

export type OC = OpenCascadeInstance;

let instance: Promise<OC> | null = null;

export function getOC(): Promise<OC> {
  // Idempotent: repeated init() calls share one in-flight promise.
  instance ??= (ocMainJs as unknown as (opts: object) => Promise<OC>)({
    locateFile: (path: string) => (path.endsWith(".wasm") ? ocWasmUrl : path),
  });
  return instance;
}
