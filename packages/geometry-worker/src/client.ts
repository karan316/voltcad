import * as Comlink from "comlink";
import type { GeometryWorkerApi } from "./api.ts";

export type { GeometryWorkerApi, MassProperties, RegenResult } from "./api.ts";

/**
 * Main-thread handle to the geometry worker.
 *
 * The worker (and the ~50MB OCCT WASM download) starts lazily on first use so
 * initial page paint never waits for the kernel.
 */
let remote: Comlink.Remote<GeometryWorkerApi> | null = null;

export function getGeometryWorker(): Comlink.Remote<GeometryWorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "voltcad-geometry",
    });
    remote = Comlink.wrap<GeometryWorkerApi>(worker);
  }
  return remote;
}
