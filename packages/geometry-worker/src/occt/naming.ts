import type {
  OpenCascadeInstance,
  TopAbs_ShapeEnum,
  TopoDS_Shape,
  TopTools_IndexedMapOfShape,
  TopTools_ListOfShape,
  BRepBuilderAPI_MakeShape,
} from "opencascade.js/dist/opencascade.full.js";

type OC = OpenCascadeInstance;

/**
 * Persistent naming — VoltCAD's answer to the topological naming problem.
 *
 * Every B-Rep face carries a semantic name derived from the feature that
 * created it (e.g. "ext_a1/side:line_3" = the lateral face swept from sketch
 * line_3). Edge names are DERIVED as the sorted pair of adjacent face names
 * ("A|B"), so they are stable for free as long as face names are.
 *
 * When an operation (boolean, fillet…) rebuilds the body, names are carried
 * across using the kernel's own history (Modified/Generated/IsDeleted), so a
 * downstream "fillet edge X" reference survives upstream edits.
 *
 * Implementation notes:
 *  - OCCT subshapes are keyed via TopTools_IndexedMapOfShape (IsSame
 *    semantics), with a parallel JS array of names aligned to map indices.
 *  - Everything here allocates emscripten objects; call .dispose() to avoid
 *    leaking WASM heap (the worker keeps bodies alive only between regens).
 */
export class FaceNameMap {
  private map: TopTools_IndexedMapOfShape;
  /** 1-based, aligned with `map` indices. */
  private names: (string | undefined)[] = [];

  constructor(
    oc: OC,
    shape: TopoDS_Shape,
  ) {
    this.map = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum, this.map);
  }

  size(): number {
    return this.map.Extent();
  }

  faceAt(index: number): TopoDS_Shape {
    return this.map.FindKey(index);
  }

  nameOf(face: TopoDS_Shape): string | undefined {
    const i = this.map.FindIndex(face);
    return i > 0 ? this.names[i] : undefined;
  }

  /** Assign a name if the face exists and is still unnamed (first wins). */
  setName(face: TopoDS_Shape, name: string): boolean {
    const i = this.map.FindIndex(face);
    if (i <= 0 || this.names[i] !== undefined) return false;
    this.names[i] = name;
    return true;
  }

  /**
   * Fill any face that survived every naming pass unnamed with a positional
   * fallback. Positional names are regen-stable only while topology upstream
   * is unchanged — acceptable last resort, never the primary mechanism.
   */
  fillUnnamed(featureId: string): void {
    for (let i = 1; i <= this.map.Extent(); i++) {
      this.names[i] ??= `${featureId}/face:${i}`;
    }
  }

  entries(): { face: TopoDS_Shape; name: string }[] {
    const out: { face: TopoDS_Shape; name: string }[] = [];
    for (let i = 1; i <= this.map.Extent(); i++) {
      out.push({ face: this.map.FindKey(i), name: this.names[i] ?? `?face:${i}` });
    }
    return out;
  }

  dispose(): void {
    this.map.delete();
  }
}

/** A solid body plus its face naming table. */
export interface NamedBody {
  /** Persistent body name, e.g. "ext_a1/body". */
  name: string;
  shape: TopoDS_Shape;
  faces: FaceNameMap;
}

/**
 * Copy a TopTools_ListOfShape into a JS array without mutating the source
 * (history lists returned by Modified/Generated are internal kernel state).
 */
export function listToArray(oc: OC, list: TopTools_ListOfShape): TopoDS_Shape[] {
  const copy = new oc.TopTools_ListOfShape_1();
  copy.Assign(list);
  const out: TopoDS_Shape[] = [];
  while (copy.Size() > 0) {
    out.push(copy.First_1());
    copy.RemoveFirst();
  }
  copy.delete();
  return out;
}

/**
 * Propagate face names from source bodies through a shape-producing operation
 * into a fresh FaceNameMap for `newShape`.
 *
 * Order of precedence per new face:
 *   1. identical survivor (same face object → same name)
 *   2. kernel history: op.Modified(oldFace) / op.Generated(oldFace)
 *   3. left unnamed — caller assigns feature-specific names, then fillUnnamed.
 */
export function propagateFaceNames(
  oc: OC,
  op: BRepBuilderAPI_MakeShape,
  sources: FaceNameMap[],
  newShape: TopoDS_Shape,
): FaceNameMap {
  const next = new FaceNameMap(oc, newShape);
  for (const src of sources) {
    for (const { face, name } of src.entries()) {
      // 1) survivors: the exact same face exists in the result
      if (next.setName(face, name)) continue;
      // 2) history mapping
      if (op.IsDeleted(face)) continue;
      for (const m of listToArray(oc, op.Modified(face))) next.setName(m, name);
      for (const g of listToArray(oc, op.Generated(face))) next.setName(g, name);
    }
  }
  return next;
}

/** Deterministic derived edge name from its adjacent faces. */
export function edgeNameFromFaces(faceNames: string[]): string {
  return [...new Set(faceNames)].sort().join("|");
}
