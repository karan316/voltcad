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
  planeBasis,
  sampleSketchEntitiesFromBasis,
  to3D,
  type BodyTransform,
  type EntityHit,
  type EntityQuery,
  type Expression,
  type ExtrudeOptions,
  type FeatureId,
  type ModelContext,
  type PlaneBasis,
  type RevolveOptions,
  type ShapeHandle,
  type SketchDisplay,
  type SketchEntity,
  type SketchPlane,
} from "@voltcad/model-api";
import { FaceNameMap, edgeNameFromFaces, listToArray, propagateFaceNames, type NamedBody } from "./naming.ts";
import { buildProfiles, type BuiltProfile } from "./sketch-builder.ts";
import { Scope } from "./scope.ts";

type OC = OpenCascadeInstance;

interface ProfileRecord extends BuiltProfile {
  basis: PlaneBasis;
}

/**
 * Immutable snapshot of context state after a feature — the unit of the
 * incremental-regen checkpoint cache. Arrays are copied; the referenced
 * NamedBody/ProfileRecord objects (and their kernel shapes) are shared and
 * never mutated after creation.
 */
export interface CtxSnapshot {
  bodies: NamedBody[];
  profiles: [string, ProfileRecord[]][];
  handles: ProfileRecord[];
  sketchDisplays: SketchDisplay[];
}

/**
 * OcModelContext — the single ModelContext implementation, backed by
 * OpenCascade. With incremental regen, one long-lived instance is resumed
 * from checkpoints; kernel-object ownership (FaceNameMap disposal) is
 * coordinated by the worker's cache layer, NOT here.
 */
export class OcModelContext implements ModelContext {
  bodies: NamedBody[] = [];
  sketchDisplays: SketchDisplay[] = [];
  /** Face maps swapped out mid-feature; candidates for disposal (see worker). */
  retired: FaceNameMap[] = [];

  private profiles = new Map<string, ProfileRecord[]>();
  private handles: ProfileRecord[] = []; // ShapeHandle → record
  /** Cached per-body edge adjacency (edge name → edge), rebuilt after edits. */
  private edgeCache: Map<string, { name: string; edge: TopoDS_Edge; bodyIdx: number }[]> | null =
    null;

  constructor(
    private oc: OC,
    private parameters: Readonly<Record<string, Expression>>,
  ) {}

  /** Re-point expression evaluation at a new parameter table (per regen). */
  setParameters(parameters: Readonly<Record<string, Expression>>): void {
    this.parameters = parameters;
  }

  snapshot(): CtxSnapshot {
    return {
      bodies: [...this.bodies],
      profiles: [...this.profiles.entries()].map(([k, v]) => [k, [...v]]),
      handles: [...this.handles],
      sketchDisplays: [...this.sketchDisplays],
    };
  }

  restore(snap: CtxSnapshot): void {
    this.bodies = [...snap.bodies];
    this.profiles = new Map(snap.profiles.map(([k, v]) => [k, [...v]]));
    this.handles = [...snap.handles];
    this.sketchDisplays = [...snap.sketchDisplays];
    this.edgeCache = null;
  }

  /** Reset to empty (fresh full regen). Disposal is the cache layer's job. */
  reset(): void {
    this.bodies = [];
    this.sketchDisplays = [];
    this.profiles.clear();
    this.handles = [];
    this.retired = [];
    this.edgeCache = null;
  }

  // ---------------------------------------------------------------- expression

  evaluate(expr: Expression): number {
    return evaluateExpression(expr, this.parameters);
  }

  // ------------------------------------------------------------------- sketch

  buildProfile(owner: FeatureId, plane: SketchPlane, entities: SketchEntity[]): ShapeHandle[] {
    const basis = this.basisForPlane(plane);
    const built = buildProfiles(this.oc, basis, entities);
    const records: ProfileRecord[] = built.map((b) => ({ ...b, basis }));
    this.profiles.set(owner, records);
    this.sketchDisplays.push({
      featureId: owner,
      positions: sampleSketchEntitiesFromBasis(basis, entities),
    });
    return records.map((r) => (this.handles.push(r) - 1) as ShapeHandle);
  }

  /** Resolve a sketch plane (datum or planar face) to a world basis. */
  basisForPlane(plane: SketchPlane): PlaneBasis {
    if (plane.kind === "datum") {
      const offset = plane.offset !== undefined ? this.evaluate(plane.offset) : 0;
      return planeBasis(plane, offset);
    }
    const basis = this.faceBasis(plane.face);
    if (!basis)
      throw new RegenError(
        "QUERY_NO_MATCH",
        `Sketch plane face "${plane.face}" not found or not planar`,
        [plane.face],
      );
    return basis;
  }

  /** Locate any named entity's shape (body, face, or edge) for measurement. */
  findShape(name: string): TopoDS_Shape | null {
    for (const body of this.bodies) {
      if (body.name === name) return body.shape;
      for (const entry of body.faces.entries()) {
        if (entry.name === name) return entry.face;
      }
    }
    for (const perBody of this.edgeIndex().values()) {
      for (const rec of perBody) if (rec.name === name) return rec.edge;
    }
    return null;
  }

  /** Plane basis of a named planar face, or null. Normal points OUT of the solid. */
  faceBasis(faceName: string): PlaneBasis | null {
    const oc = this.oc;
    for (const body of this.bodies) {
      for (const { face, name } of body.faces.entries()) {
        if (name !== faceName) continue;
        const scope = new Scope();
        try {
          const typedFace = oc.TopoDS.Face_1(face);
          const surf = scope.add(new oc.BRepAdaptor_Surface_2(typedFace, true));
          if (surf.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
          const pln = scope.add(surf.Plane());
          const loc = scope.add(pln.Location());
          const xAxis = scope.add(pln.XAxis());
          const yAxis = scope.add(pln.YAxis());
          const axis = scope.add(pln.Axis());
          const xd = scope.add(xAxis.Direction());
          const yd = scope.add(yAxis.Direction());
          const nd = scope.add(axis.Direction());
          // orient the normal outward: REVERSED faces flip the surface normal;
          // flip v too so the basis stays right-handed (n = u × v)
          const reversed =
            face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
          const sign = reversed ? -1 : 1;
          return {
            origin: [loc.X(), loc.Y(), loc.Z()],
            u: [xd.X(), xd.Y(), xd.Z()],
            v: [sign * yd.X(), sign * yd.Y(), sign * yd.Z()],
            normal: [sign * nd.X(), sign * nd.Y(), sign * nd.Z()],
          };
        } finally {
          scope.dispose();
        }
      }
    }
    return null;
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
        const [nx, ny, nz] = record.basis.normal;
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
        // axis: sketch-plane coordinates → world coordinates via the basis
        const p3 = (p: [number, number]) => to3D(record.basis, p);
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

  importShape(owner: FeatureId, format: "step" | "iges", data: string): void {
    const oc = this.oc;
    const scope = new Scope();
    const path = `/import_${owner}.${format}`;
    try {
      oc.FS.writeFile(path, data);
      const reader =
        format === "step"
          ? scope.add(new oc.STEPControl_Reader_1())
          : scope.add(new oc.IGESControl_Reader_1());
      const status = reader.ReadFile(path);
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
        throw new RegenError("KERNEL_FAILURE", `Failed to parse ${format.toUpperCase()} file`);
      const progress = scope.add(new oc.Message_ProgressRange_1());
      reader.TransferRoots(progress);
      if (reader.NbShapes() === 0)
        throw new RegenError("KERNEL_FAILURE", `${format.toUpperCase()} file contains no shapes`);
      const shape = reader.OneShape();

      // each solid becomes its own body; loose shells/faces become one body
      const solids: TopoDS_Shape[] = [];
      const ex = scope.add(
        new oc.TopExp_Explorer_2(
          shape,
          oc.TopAbs_ShapeEnum.TopAbs_SOLID as never,
          oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
        ),
      );
      for (; ex.More(); ex.Next()) solids.push(ex.Current());
      const bodies = solids.length > 0 ? solids : [shape];

      bodies.forEach((body, i) => {
        // positional face names are stable for a fixed payload — imported
        // bodies have no feature history to derive semantic names from
        const faces = new FaceNameMap(oc, body);
        faces.fillUnnamed(`${owner}:${i}`);
        this.pushBody({ name: `${owner}/body:${i}`, shape: body, faces });
      });
    } finally {
      scope.dispose();
      try {
        oc.FS.unlink(path);
      } catch {
        /* never written */
      }
    }
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

  // ------------------------------------------------- shell / pattern / boolean

  shell(owner: FeatureId, removeFaces: EntityHit[], thickness: number): void {
    const oc = this.oc;
    // all removed faces must belong to one body
    const bodyIdx = this.bodies.findIndex((b) =>
      removeFaces.some((h) => b.faces.entries().some((e) => e.name === h.name)),
    );
    if (bodyIdx < 0)
      throw new RegenError("QUERY_NO_MATCH", "Shell: selected faces no longer exist");
    const body = this.bodies[bodyIdx]!;
    const scope = new Scope();
    try {
      const closing = scope.add(new oc.TopTools_ListOfShape_1());
      let found = 0;
      for (const { face, name } of body.faces.entries()) {
        if (removeFaces.some((h) => h.name === name)) {
          closing.Append_1(face);
          found++;
        }
      }
      if (found === 0)
        throw new RegenError("QUERY_NO_MATCH", "Shell: no faces matched on a single body");

      const op = scope.add(new oc.BRepOffsetAPI_MakeThickSolid());
      const progress = scope.add(new oc.Message_ProgressRange_1());
      // negative offset hollows inward, leaving walls of `thickness`
      op.MakeThickSolidByJoin(
        body.shape,
        closing,
        -Math.abs(thickness),
        1e-3,
        oc.BRepOffset_Mode.BRepOffset_Skin as never,
        false,
        false,
        oc.GeomAbs_JoinType.GeomAbs_Arc as never,
        false,
        progress,
      );
      const progress2 = scope.add(new oc.Message_ProgressRange_1());
      op.Build(progress2);
      if (!op.IsDone())
        throw new RegenError(
          "KERNEL_FAILURE",
          `Shell of ${thickness.toFixed(2)}mm failed — wall thickness may exceed the part size`,
          removeFaces.map((h) => h.name),
        );
      const shape = op.Shape();
      const faces = propagateFaceNames(oc, op as BRepBuilderAPI_MakeShape, [body.faces], shape);
      faces.fillUnnamed(owner);
      this.replaceBody(bodyIdx, { name: body.name, shape, faces });
    } finally {
      scope.dispose();
    }
  }

  transformBodies(
    owner: FeatureId,
    bodies: EntityHit[],
    transforms: BodyTransform[],
    merge: boolean,
  ): void {
    const oc = this.oc;
    const sources = this.bodies
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => bodies.some((h) => h.name === b.name));
    if (sources.length === 0)
      throw new RegenError("QUERY_NO_MATCH", "Pattern/mirror: no bodies matched");

    for (const { b, idx } of sources) {
      let current = b;
      let copyIndex = 0;
      for (const spec of transforms) {
        const scope = new Scope();
        try {
          const trsf = scope.add(new oc.gp_Trsf_1());
          if (spec.kind === "translate") {
            trsf.SetTranslation_1(scope.add(new oc.gp_Vec_4(...spec.offset)));
          } else if (spec.kind === "rotate") {
            const ax = scope.add(
              new oc.gp_Ax1_2(
                scope.add(new oc.gp_Pnt_3(...spec.axisPoint)),
                scope.add(new oc.gp_Dir_4(...spec.axisDir)),
              ),
            );
            trsf.SetRotation_1(ax, (spec.angleDeg * Math.PI) / 180);
          } else {
            const ax2 = scope.add(
              new oc.gp_Ax2_3(
                scope.add(new oc.gp_Pnt_3(...spec.planePoint)),
                scope.add(new oc.gp_Dir_4(...spec.planeNormal)),
              ),
            );
            trsf.SetMirror_3(ax2);
          }
          const xform = scope.add(new oc.BRepBuilderAPI_Transform_2(b.shape, trsf, true));
          const copy = xform.Shape();

          if (merge) {
            // fuse copy into the (accumulating) source body
            const progress = scope.add(new oc.Message_ProgressRange_1());
            const fuse = scope.add(new oc.BRepAlgoAPI_Fuse_3(current.shape, copy, progress));
            const progress2 = scope.add(new oc.Message_ProgressRange_1());
            fuse.Build(progress2);
            if (!fuse.IsDone())
              throw new RegenError("BOOLEAN_FAILED", "Pattern fuse failed in the kernel");
            const result = fuse.Shape();
            // copies get positional names under the pattern feature; the
            // original instance keeps its semantic names via propagation
            const faces = propagateFaceNames(
              oc,
              fuse as BRepBuilderAPI_MakeShape,
              [current.faces],
              result,
            );
            faces.fillUnnamed(`${owner}:${copyIndex}`);
            this.replaceBody(idx, { name: current.name, shape: result, faces });
            current = this.bodies[idx]!;
          } else {
            const faces = new FaceNameMap(oc, copy);
            faces.fillUnnamed(`${owner}:${copyIndex}`);
            this.pushBody({ name: `${owner}/body:${copyIndex}`, shape: copy, faces });
          }
          copyIndex++;
        } finally {
          scope.dispose();
        }
      }
    }
  }

  booleanBodies(
    owner: FeatureId,
    target: EntityHit,
    tool: EntityHit,
    op: "union" | "subtract" | "intersect",
  ): void {
    const oc = this.oc;
    const targetIdx = this.bodies.findIndex((b) => b.name === target.name);
    const toolIdx = this.bodies.findIndex((b) => b.name === tool.name);
    if (targetIdx < 0 || toolIdx < 0)
      throw new RegenError("QUERY_NO_MATCH", "Boolean: target or tool body not found");
    if (targetIdx === toolIdx)
      throw new RegenError("INVALID_PARAMS", "Boolean: target and tool are the same body");
    const targetBody = this.bodies[targetIdx]!;
    const toolBody = this.bodies[toolIdx]!;
    const scope = new Scope();
    try {
      const progress = scope.add(new oc.Message_ProgressRange_1());
      const bop = scope.add(
        op === "union"
          ? new oc.BRepAlgoAPI_Fuse_3(targetBody.shape, toolBody.shape, progress)
          : op === "subtract"
            ? new oc.BRepAlgoAPI_Cut_3(targetBody.shape, toolBody.shape, progress)
            : new oc.BRepAlgoAPI_Common_3(targetBody.shape, toolBody.shape, progress),
      );
      const progress2 = scope.add(new oc.Message_ProgressRange_1());
      bop.Build(progress2);
      if (!bop.IsDone())
        throw new RegenError("BOOLEAN_FAILED", `Boolean ${op} failed in the kernel`);
      const result = bop.Shape();
      const faces = propagateFaceNames(
        oc,
        bop as BRepBuilderAPI_MakeShape,
        [targetBody.faces, toolBody.faces],
        result,
      );
      faces.fillUnnamed(owner);
      this.replaceBody(targetIdx, { name: targetBody.name, shape: result, faces });
      // the tool body is consumed
      this.retired.push(toolBody.faces);
      this.bodies.splice(this.bodies.findIndex((b) => b.name === tool.name), 1);
      this.edgeCache = null;
    } finally {
      scope.dispose();
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
    this.retired.push(faces); // tool-body map no longer referenced by a body
  }

  private pushBody(body: NamedBody): void {
    this.bodies.push(body);
    this.edgeCache = null;
  }

  private replaceBody(idx: number, next: NamedBody): void {
    // NEVER dispose here — the replaced map may be referenced by an
    // incremental-regen checkpoint. The worker cache layer owns disposal.
    this.retired.push(this.bodies[idx]!.faces);
    this.bodies[idx] = next;
    this.edgeCache = null;
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
