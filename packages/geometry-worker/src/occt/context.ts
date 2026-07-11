import type {
  OpenCascadeInstance,
  TopAbs_ShapeEnum,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  BRepBuilderAPI_MakeShape,
} from "opencascade.js/dist/opencascade.full.js";
import {
  RegenError,
  evaluateExpression,
  type EntityHit,
  type EntityQuery,
  type Expression,
  type ExtrudeOptions,
  type FeatureId,
  type ModelContext,
  type RevolveOptions,
  type ShapeHandle,
  type SketchDisplay,
  type SketchEntity,
  type SketchPlane,
} from "@voltcad/model-api";
import { FaceNameMap, edgeNameFromFaces, listToArray, propagateFaceNames, type NamedBody } from "./naming.ts";
import { buildProfiles, sketchDisplayPositions, type BuiltProfile } from "./sketch-builder.ts";
import { Scope } from "./scope.ts";

type OC = OpenCascadeInstance;

interface ProfileRecord extends BuiltProfile {
  normal: [number, number, number];
  planeOrigin: [number, number, number];
}

/**
 * OcModelContext — the single ModelContext implementation, backed by
 * OpenCascade. One instance lives for the duration of one regeneration pass;
 * bodies survive after regen (for tessellation/export) until the next pass
 * disposes them.
 */
export class OcModelContext implements ModelContext {
  readonly bodies: NamedBody[] = [];
  readonly sketchDisplays: SketchDisplay[] = [];

  private profiles = new Map<string, ProfileRecord[]>();
  private handles: ProfileRecord[] = []; // ShapeHandle → record
  /** Cached per-body edge adjacency (edge name → edge), rebuilt after edits. */
  private edgeCache: Map<string, { name: string; edge: TopoDS_Edge; bodyIdx: number }[]> | null =
    null;

  constructor(
    private oc: OC,
    private parameters: Readonly<Record<string, Expression>>,
  ) {}

  // ---------------------------------------------------------------- expression

  evaluate(expr: Expression): number {
    return evaluateExpression(expr, this.parameters);
  }

  // ------------------------------------------------------------------- sketch

  buildProfile(owner: FeatureId, plane: SketchPlane, entities: SketchEntity[]): ShapeHandle[] {
    const offset = plane.offset !== undefined ? this.evaluate(plane.offset) : 0;
    const built = buildProfiles(this.oc, plane, offset, entities);
    const basisNormal = builtNormal(plane);
    const records: ProfileRecord[] = built.map((b) => ({
      ...b,
      normal: basisNormal,
      planeOrigin: [basisNormal[0] * offset, basisNormal[1] * offset, basisNormal[2] * offset],
    }));
    this.profiles.set(owner, records);
    this.sketchDisplays.push({
      featureId: owner,
      positions: sketchDisplayPositions(plane, offset, entities),
    });
    return records.map((r) => (this.handles.push(r) - 1) as ShapeHandle);
  }

  profilesOf(sketch: FeatureId): ShapeHandle[] {
    const records = this.profiles.get(sketch) ?? [];
    return records.map((r) => {
      const existing = this.handles.indexOf(r);
      return (existing >= 0 ? existing : this.handles.push(r) - 1) as ShapeHandle;
    });
  }

  // ------------------------------------------------------------------ queries

  resolve(query: EntityQuery): EntityHit[] {
    switch (query.kind) {
      case "named": {
        const want = new Set(query.names);
        return this.allEntities().filter((h) => want.has(h.name));
      }
      case "created":
        // Ownership is encoded in the name prefix; a derived edge name matches
        // when any of its component face names belongs to the feature.
        return this.allEntities().filter(
          (h) =>
            h.kind === query.entity &&
            h.name.split("|").some((part) => part.startsWith(`${query.feature}/`)),
        );
      case "all":
        return this.allEntities().filter((h) => h.kind === query.entity);
      case "union": {
        const seen = new Map<string, EntityHit>();
        for (const sub of query.queries)
          for (const h of this.resolve(sub)) seen.set(h.name, h);
        return [...seen.values()];
      }
      case "intersect": {
        const lists = query.queries.map((sub) => this.resolve(sub));
        if (lists.length === 0) return [];
        const counts = new Map<string, { hit: EntityHit; n: number }>();
        for (const list of lists)
          for (const h of list) {
            const c = counts.get(h.name) ?? { hit: h, n: 0 };
            c.n++;
            counts.set(h.name, c);
          }
        return [...counts.values()].filter((c) => c.n === lists.length).map((c) => c.hit);
      }
    }
  }

  private allEntities(): EntityHit[] {
    const out: EntityHit[] = [];
    for (const body of this.bodies) {
      out.push({ name: body.name, kind: "body" });
      for (const { name } of body.faces.entries()) out.push({ name, kind: "face" });
    }
    for (const perBody of this.edgeIndex().values())
      for (const { name } of perBody) out.push({ name, kind: "edge" });
    return out;
  }

  /**
   * Derived edge names: each edge is named by its adjacent faces ("A|B").
   * Rebuilt lazily after any body mutation.
   */
  private edgeIndex(): Map<string, { name: string; edge: TopoDS_Edge; bodyIdx: number }[]> {
    if (this.edgeCache) return this.edgeCache;
    const oc = this.oc;
    const index = new Map<string, { name: string; edge: TopoDS_Edge; bodyIdx: number }[]>();
    this.bodies.forEach((body, bodyIdx) => {
      const scope = new Scope();
      const map = scope.add(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
      oc.TopExp.MapShapesAndAncestors(
        body.shape,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum,
        oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum,
        map,
      );
      const perBody: { name: string; edge: TopoDS_Edge; bodyIdx: number }[] = [];
      for (let i = 1; i <= map.Extent(); i++) {
        const edge = oc.TopoDS.Edge_1(map.FindKey(i));
        const faceNames = listToArray(oc, map.FindFromIndex(i)).map(
          (f) => body.faces.nameOf(f) ?? "?",
        );
        perBody.push({ name: edgeNameFromFaces(faceNames), edge, bodyIdx });
      }
      index.set(body.name, perBody);
      scope.dispose();
    });
    this.edgeCache = index;
    return index;
  }

  /** Locate concrete edges for resolved hits, grouped by owning body. */
  private edgesByBody(hits: EntityHit[]): Map<number, TopoDS_Edge[]> {
    const want = new Set(hits.map((h) => h.name));
    const grouped = new Map<number, TopoDS_Edge[]>();
    for (const perBody of this.edgeIndex().values()) {
      for (const rec of perBody) {
        if (!want.has(rec.name)) continue;
        const list = grouped.get(rec.bodyIdx) ?? [];
        list.push(rec.edge);
        grouped.set(rec.bodyIdx, list);
      }
    }
    return grouped;
  }

  // ----------------------------------------------------------------- features

  extrude(owner: FeatureId, profiles: ShapeHandle[], options: ExtrudeOptions): void {
    const oc = this.oc;
    for (const handle of profiles) {
      const record = this.handles[handle];
      if (!record) throw new RegenError("KERNEL_FAILURE", "Invalid profile handle");
      const scope = new Scope();
      try {
        const [nx, ny, nz] = record.normal;
        const d = options.distance;
        let baseFace: TopoDS_Face = record.face;
        let edgeTags = record.edgeTags;

        if (options.symmetric) {
          // shift the profile back by d/2 so the sweep is centered on the plane
          const trsf = scope.add(new oc.gp_Trsf_1());
          trsf.SetTranslation_1(
            scope.add(new oc.gp_Vec_4((-nx * d) / 2, (-ny * d) / 2, (-nz * d) / 2)),
          );
          const xform = scope.add(new oc.BRepBuilderAPI_Transform_2(record.face, trsf, true));
          baseFace = oc.TopoDS.Face_1(xform.Shape());
          // re-associate profile edges with their transformed copies so
          // Generated() lookups (side-face naming) still work
          edgeTags = record.edgeTags.map(({ edge, entId }) => ({
            edge: oc.TopoDS.Edge_1(xform.ModifiedShape(edge)),
            entId,
          }));
        }

        const vec = scope.add(new oc.gp_Vec_4(nx * d, ny * d, nz * d));
        const prism = scope.add(new oc.BRepPrimAPI_MakePrism_1(baseFace, vec, true, true));
        if (!prism.IsDone())
          throw new RegenError("KERNEL_FAILURE", "Extrude failed in the kernel");
        const shape = prism.Shape();

        // --- persistent naming ---
        const faces = new FaceNameMap(oc, shape);
        // lateral faces: swept from tagged profile edges → semantic names
        for (const { edge, entId } of edgeTags) {
          for (const g of listToArray(oc, prism.Generated(edge)))
            faces.setName(g, `${owner}/side:${entId}`);
        }
        // caps: FirstShape/LastShape are the start/end snapshots of the sweep
        nameShapeFaces(oc, faces, prism.FirstShape(), `${owner}/cap:start`);
        nameShapeFaces(oc, faces, prism.LastShape(), `${owner}/cap:end`);
        faces.fillUnnamed(owner);

        this.applyBooleanOp(owner, shape, faces, options.op);
      } finally {
        scope.dispose();
      }
    }
  }

  revolve(owner: FeatureId, profiles: ShapeHandle[], options: RevolveOptions): void {
    const oc = this.oc;
    for (const handle of profiles) {
      const record = this.handles[handle];
      if (!record) throw new RegenError("KERNEL_FAILURE", "Invalid profile handle");
      const scope = new Scope();
      try {
        // axis: sketch-plane coordinates → world coordinates
        const b = { normal: record.normal, origin: record.planeOrigin };
        const basisFor = axisBasis(b.normal);
        const p3 = (p: [number, number]): [number, number, number] => [
          b.origin[0] + basisFor.u[0] * p[0] + basisFor.v[0] * p[1],
          b.origin[1] + basisFor.u[1] * p[0] + basisFor.v[1] * p[1],
          b.origin[2] + basisFor.u[2] * p[0] + basisFor.v[2] * p[1],
        ];
        const origin = p3(options.axisPoint);
        const tip = p3([
          options.axisPoint[0] + options.axisDir[0],
          options.axisPoint[1] + options.axisDir[1],
        ]);
        const dir: [number, number, number] = [
          tip[0] - origin[0],
          tip[1] - origin[1],
          tip[2] - origin[2],
        ];
        const ax = scope.add(
          new oc.gp_Ax1_2(
            scope.add(new oc.gp_Pnt_3(...origin)),
            scope.add(new oc.gp_Dir_4(...dir)),
          ),
        );
        const angleRad = (options.angle * Math.PI) / 180;
        const revol = scope.add(new oc.BRepPrimAPI_MakeRevol_1(record.face, ax, angleRad, true));
        if (!revol.IsDone())
          throw new RegenError("KERNEL_FAILURE", "Revolve failed in the kernel");
        const shape = revol.Shape();

        const faces = new FaceNameMap(oc, shape);
        for (const { edge, entId } of record.edgeTags) {
          for (const g of listToArray(oc, revol.Generated(edge)))
            faces.setName(g, `${owner}/rev:${entId}`);
        }
        if (options.angle < 360) {
          nameShapeFaces(oc, faces, revol.FirstShape(), `${owner}/cap:start`);
          nameShapeFaces(oc, faces, revol.LastShape(), `${owner}/cap:end`);
        }
        faces.fillUnnamed(owner);
        this.applyBooleanOp(owner, shape, faces, options.op);
      } finally {
        scope.dispose();
      }
    }
  }

  fillet(owner: FeatureId, edges: EntityHit[], radius: number): void {
    this.filletOrChamfer(owner, edges, radius, "fillet");
  }

  chamfer(owner: FeatureId, edges: EntityHit[], distance: number): void {
    this.filletOrChamfer(owner, edges, distance, "chamfer");
  }

  private filletOrChamfer(
    owner: FeatureId,
    edges: EntityHit[],
    value: number,
    kind: "fillet" | "chamfer",
  ): void {
    const oc = this.oc;
    const grouped = this.edgesByBody(edges);
    if (grouped.size === 0)
      throw new RegenError("QUERY_NO_MATCH", `${kind}: selected edges no longer exist`);
    const nameByEdge = new Map<TopoDS_Edge, string>();
    for (const perBody of this.edgeIndex().values())
      for (const rec of perBody) nameByEdge.set(rec.edge, rec.name);

    for (const [bodyIdx, bodyEdges] of grouped) {
      const body = this.bodies[bodyIdx]!;
      const scope = new Scope();
      try {
        const op =
          kind === "fillet"
            ? scope.add(
                new oc.BRepFilletAPI_MakeFillet(
                  body.shape,
                  oc.ChFi3d_FilletShape.ChFi3d_Rational as never,
                ),
              )
            : scope.add(new oc.BRepFilletAPI_MakeChamfer(body.shape));
        for (const e of bodyEdges) {
          if (kind === "fillet")
            (op as InstanceType<OC["BRepFilletAPI_MakeFillet"]>).Add_2(value, e);
          else (op as InstanceType<OC["BRepFilletAPI_MakeChamfer"]>).Add_2(value, e);
        }
        const progress = scope.add(new oc.Message_ProgressRange_1());
        op.Build(progress);
        if (!op.IsDone())
          throw new RegenError(
            "FILLET_TOO_LARGE",
            `${kind} of ${value.toFixed(2)}mm failed — radius likely exceeds adjacent face size`,
            edges.map((e) => e.name),
          );
        const shape = op.Shape();

        // survivors + kernel history first, then name the new blend faces
        // after the edge they replaced ("fil_x/face:capA|sideB")
        const faces = propagateFaceNames(oc, op as BRepBuilderAPI_MakeShape, [body.faces], shape);
        for (const e of bodyEdges) {
          const edgeName = nameByEdge.get(e) ?? "edge";
          for (const g of listToArray(oc, op.Generated(e)))
            faces.setName(g, `${owner}/face:${edgeName}`);
        }
        faces.fillUnnamed(owner);

        this.replaceBody(bodyIdx, { name: body.name, shape, faces });
      } finally {
        scope.dispose();
      }
    }
  }

  // ------------------------------------------------------------ body plumbing

  private applyBooleanOp(
    owner: FeatureId,
    shape: TopoDS_Shape,
    faces: FaceNameMap,
    op: "new" | "add" | "cut" | "intersect",
  ): void {
    const oc = this.oc;
    if (op === "new" || this.bodies.length === 0) {
      if (op === "cut")
        throw new RegenError("BOOLEAN_FAILED", "Nothing to cut — the model has no bodies yet");
      this.pushBody({ name: `${owner}/body`, shape, faces });
      return;
    }

    const targets = op === "cut" ? [...this.bodies.keys()] : [0];
    for (const idx of targets) {
      const body = this.bodies[idx]!;
      const scope = new Scope();
      try {
        const progress = scope.add(new oc.Message_ProgressRange_1());
        const bop = scope.add(
          op === "add"
            ? new oc.BRepAlgoAPI_Fuse_3(body.shape, shape, progress)
            : op === "cut"
              ? new oc.BRepAlgoAPI_Cut_3(body.shape, shape, progress)
              : new oc.BRepAlgoAPI_Common_3(body.shape, shape, progress),
        );
        const progress2 = scope.add(new oc.Message_ProgressRange_1());
        bop.Build(progress2);
        if (!bop.IsDone())
          throw new RegenError("BOOLEAN_FAILED", `Boolean ${op} failed in the kernel`);
        const result = bop.Shape();
        const merged = propagateFaceNames(
          oc,
          bop as BRepBuilderAPI_MakeShape,
          [body.faces, faces],
          result,
        );
        merged.fillUnnamed(owner);
        this.replaceBody(idx, { name: body.name, shape: result, faces: merged });
      } finally {
        scope.dispose();
      }
    }
    faces.dispose();
  }

  private pushBody(body: NamedBody): void {
    this.bodies.push(body);
    this.edgeCache = null;
  }

  private replaceBody(idx: number, next: NamedBody): void {
    this.bodies[idx]!.faces.dispose();
    this.bodies[idx] = next;
    this.edgeCache = null;
  }

  /** Free all kernel objects owned by this context. */
  dispose(): void {
    for (const b of this.bodies) b.faces.dispose();
    this.bodies.length = 0;
    this.edgeCache = null;
    this.handles.length = 0;
    this.profiles.clear();
  }
}

/** Name every face of a subshape snapshot (caps are single faces in practice). */
function nameShapeFaces(
  oc: OC,
  faces: FaceNameMap,
  shape: TopoDS_Shape,
  name: string,
): void {
  const scope = new Scope();
  const ex = scope.add(
    new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum,
    ),
  );
  let i = 0;
  for (; ex.More(); ex.Next()) {
    faces.setName(ex.Current(), i === 0 ? name : `${name}:${i}`);
    i++;
  }
  scope.dispose();
}

function builtNormal(plane: SketchPlane): [number, number, number] {
  return plane.plane === "XY" ? [0, 0, 1] : plane.plane === "XZ" ? [0, -1, 0] : [1, 0, 0];
}

function axisBasis(normal: [number, number, number]): {
  u: [number, number, number];
  v: [number, number, number];
} {
  // matches planeBasis() in sketch-builder — keep in sync
  if (normal[2] === 1) return { u: [1, 0, 0], v: [0, 1, 0] };
  if (normal[1] === -1) return { u: [1, 0, 0], v: [0, 0, 1] };
  return { u: [0, 1, 0], v: [0, 0, 1] };
}
