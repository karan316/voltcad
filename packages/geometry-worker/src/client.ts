import * as Comlink from "comlink";
import type { GeometryWorkerApi } from "./api.ts";

export type { GeometryWorkerApi, MassProperties, RegenResult } from "./api.ts";

/**
 * Main-thread handle to the geometry worker.
 *
 * The worker (and the ~50MB OCCT WASM download) starts lazily on first use so
 * initial page paint never waits for the kernel.
 *
 * Watchdog: OCCT has no cooperative cancellation — a pathological input can
 * hang the kernel forever. Every RPC gets a deadline; on timeout the worker is
 * terminated and recreated, and the call rejects with WorkerTimeoutError so
 * the caller can surface it and recover (the next call boots a fresh worker).
 */

export class WorkerTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(
      `Geometry kernel timed out after ${Math.round(timeoutMs / 1000)}s in "${method}" — worker was restarted`,
    );
    this.name = "WorkerTimeoutError";
  }
}

/** Per-method deadlines (ms). init downloads + compiles the WASM module. */
const TIMEOUTS: Partial<Record<keyof GeometryWorkerApi, number>> & {
  default: number;
} = {
  init: 180_000,
  regenerate: 60_000,
  default: 30_000,
};

let worker: Worker | null = null;
let remote: Comlink.Remote<GeometryWorkerApi> | null = null;

function spawn(): Comlink.Remote<GeometryWorkerApi> {
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "voltcad-geometry",
  });
  remote = Comlink.wrap<GeometryWorkerApi>(worker);
  return remote;
}

/** Terminate a hung/broken worker; the next call spawns a fresh one. */
export function resetGeometryWorker(): void {
  worker?.terminate();
  worker = null;
  remote = null;
}

function withWatchdog<A extends unknown[], R>(
  method: keyof GeometryWorkerApi,
  call: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => {
    const timeoutMs = TIMEOUTS[method] ?? TIMEOUTS.default;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        resetGeometryWorker();
        reject(new WorkerTimeoutError(method, timeoutMs));
      }, timeoutMs);
      call(...args).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  };
}

export function getGeometryWorker(): GeometryWorkerApi {
  const r = remote ?? spawn();
  // Facade is rebuilt per call so it always targets the live remote (the
  // underlying worker may have been replaced after a watchdog reset).
  return {
    init: withWatchdog("init", () => r.init()),
    regenerate: withWatchdog("regenerate", (doc) => r.regenerate(doc)),
    getFaceBasis: withWatchdog("getFaceBasis", (n) => r.getFaceBasis(n)),
    getPlaneBasis: withWatchdog("getPlaneBasis", (p) => r.getPlaneBasis(p)),
    describeBodies: withWatchdog("describeBodies", () => r.describeBodies()),
    measureDistance: withWatchdog("measureDistance", (a, b) =>
      r.measureDistance(a, b),
    ),
    massProperties: withWatchdog("massProperties", () => r.massProperties()),
    exportStep: withWatchdog("exportStep", () => r.exportStep()),
    exportStl: withWatchdog("exportStl", () => r.exportStl()),
  };
}
