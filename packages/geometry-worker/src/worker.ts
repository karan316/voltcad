/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { sceneTransferables, type PartDocument } from "@voltcad/model-api";
import { getOC, type OC } from "./occt/init.ts";
import { getContext, regenerateIncremental } from "./occt/regen-cache.ts";
import { Scope } from "./occt/scope.ts";
import type { GeometryWorkerApi, MassProperties, RegenResult } from "./api.ts";

/**
 * Geometry worker entry point.
 *
 * Owns the OCCT WASM instance and the B-Rep state of the current document.
 * The main thread only ever exchanges JSON documents (in) and typed-array
 * meshes (out, transferred zero-copy). Regeneration is incremental: only
 * features after the first change are re-executed (see regen-cache.ts).
 */

const api: GeometryWorkerApi = {
  async init() {
    await getOC();
  },

  async regenerate(doc: PartDocument): Promise<RegenResult> {
    const oc = await getOC();
    const t0 = performance.now();
    const { statuses, scene, cachedCount } = regenerateIncremental(oc, doc);
    const result: RegenResult = {
      statuses,
      scene,
      cachedCount,
      elapsedMs: performance.now() - t0,
    };
    // Transfer mesh buffers instead of structured-cloning them.
    return Comlink.transfer(result, sceneTransferables(scene));
  },

  async massProperties(): Promise<MassProperties | null> {
    const ctx = getContext();
    if (!ctx || ctx.bodies.length === 0) return null;
    const oc = await getOC();
    const scope = new Scope();
    try {
      let volume = 0;
      let surfaceArea = 0;
      let mx = 0, my = 0, mz = 0;
      for (const body of ctx.bodies) {
        const vProps = scope.add(new oc.GProp_GProps_1());
        oc.BRepGProp.VolumeProperties_1(body.shape, vProps, false, false, false);
        const v = vProps.Mass();
        const com = scope.add(vProps.CentreOfMass());
        volume += v;
        mx += com.X() * v;
        my += com.Y() * v;
        mz += com.Z() * v;
        const sProps = scope.add(new oc.GProp_GProps_1());
        oc.BRepGProp.SurfaceProperties_1(body.shape, sProps, false, false);
        surfaceArea += sProps.Mass();
      }
      return {
        volume,
        surfaceArea,
        centerOfMass: volume > 0 ? [mx / volume, my / volume, mz / volume] : [0, 0, 0],
      };
    } finally {
      scope.dispose();
    }
  },

  async exportStep(): Promise<Uint8Array> {
    const oc = await getOC();
    const comp = buildCompound(oc);
    const scope = new Scope();
    try {
      const writer = scope.add(new oc.STEPControl_Writer_1());
      const progress = scope.add(new oc.Message_ProgressRange_1());
      writer.Transfer(
        comp,
        oc.STEPControl_StepModelType.STEPControl_AsIs as never,
        true,
        progress,
      );
      writer.Write("/export.step");
      const data = oc.FS.readFile("/export.step");
      oc.FS.unlink("/export.step");
      // FS.readFile may return a view into the WASM heap, which is NOT
      // transferable — copy into a standalone buffer before transferring.
      const copy = new Uint8Array(data);
      return Comlink.transfer(copy, [copy.buffer as ArrayBuffer]);
    } finally {
      scope.dispose();
      comp.delete();
    }
  },

  async exportStl(): Promise<Uint8Array> {
    const oc = await getOC();
    const comp = buildCompound(oc);
    const scope = new Scope();
    try {
      // ensure a triangulation exists at export quality
      scope.add(new oc.BRepMesh_IncrementalMesh_2(comp, 0.05, false, 0.3, true));
      const writer = scope.add(new oc.StlAPI_Writer());
      const progress = scope.add(new oc.Message_ProgressRange_1());
      writer.Write(comp, "/export.stl", progress);
      const data = oc.FS.readFile("/export.stl");
      oc.FS.unlink("/export.stl");
      const copy = new Uint8Array(data);
      return Comlink.transfer(copy, [copy.buffer as ArrayBuffer]);
    } finally {
      scope.dispose();
      comp.delete();
    }
  },
};

function buildCompound(oc: OC) {
  const ctx = getContext();
  if (!ctx || ctx.bodies.length === 0) throw new Error("Nothing to export");
  const builder = new oc.BRep_Builder();
  const comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  for (const body of ctx.bodies) builder.Add(comp, body.shape);
  builder.delete();
  return comp;
}

Comlink.expose(api);
