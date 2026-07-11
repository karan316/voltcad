import type { OpenCascadeInstance } from "opencascade.js/dist/opencascade.full.js";
import type { BodyMesh, EdgePolyline, FaceGroup } from "@voltcad/model-api";
import { edgeNameFromFaces, listToArray, type NamedBody } from "./naming.ts";
import { Scope } from "./scope.ts";

type OC = OpenCascadeInstance;

/**
 * B-Rep → transferable render mesh.
 *
 * Performance rules applied here:
 *  - deflection adapts to model size (small parts stay crisp, big parts
 *    don't explode triangle counts)
 *  - location transforms are read into a plain JS matrix once per face and
 *    applied in JS — avoids one gp_Pnt WASM allocation per vertex transform
 *  - output is flat typed arrays, transferred (zero-copy) to the main thread
 */
export function tessellateBody(oc: OC, body: NamedBody): BodyMesh {
  const scope = new Scope();
  try {
    // adaptive deflection from the body's bounding box diagonal
    const bbox = scope.add(new oc.Bnd_Box_1());
    oc.BRepBndLib.Add(body.shape, bbox, false);
    let deflection = 0.1;
    if (!bbox.IsVoid()) {
      const cmin = scope.add(bbox.CornerMin());
      const cmax = scope.add(bbox.CornerMax());
      const diag = Math.hypot(cmax.X() - cmin.X(), cmax.Y() - cmin.Y(), cmax.Z() - cmin.Z());
      deflection = Math.min(Math.max(diag * 0.0008, 0.01), 1);
    }
    scope.add(new oc.BRepMesh_IncrementalMesh_2(body.shape, deflection, false, 0.35, true));

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const faceGroups: FaceGroup[] = [];
    const edgePositions: number[] = [];
    const edges: EdgePolyline[] = [];
    const doneEdges = scope.add(new oc.TopTools_IndexedMapOfShape_1());

    // face adjacency for deriving edge names
    const edgeToFaces = scope.add(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      body.shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE as never,
      oc.TopAbs_ShapeEnum.TopAbs_FACE as never,
      edgeToFaces,
    );

    for (const { face, name } of body.faces.entries()) {
      const faceScope = new Scope();
      try {
        const typedFace = oc.TopoDS.Face_1(face);
        const loc = faceScope.add(new oc.TopLoc_Location_1());
        const triHandle = faceScope.add(
          oc.BRep_Tool.Triangulation(typedFace, loc, 0 as never),
        );
        if (triHandle.IsNull()) continue;
        const tri = triHandle.get();

        // read location transform into a JS row-major 3x4 matrix (once)
        const trsf = faceScope.add(loc.Transformation());
        const m = [
          trsf.Value(1, 1), trsf.Value(1, 2), trsf.Value(1, 3), trsf.Value(1, 4),
          trsf.Value(2, 1), trsf.Value(2, 2), trsf.Value(2, 3), trsf.Value(2, 4),
          trsf.Value(3, 1), trsf.Value(3, 2), trsf.Value(3, 3), trsf.Value(3, 4),
        ];

        const base = positions.length / 3;
        const nbNodes = tri.NbNodes();
        const faceVertexNormals = new Float64Array(nbNodes * 3);
        const local = new Float64Array(nbNodes * 3);

        for (let i = 1; i <= nbNodes; i++) {
          const p = tri.Node(i);
          const x = p.X(), y = p.Y(), z = p.Z();
          p.delete();
          const k = (i - 1) * 3;
          local[k] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
          local[k + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
          local[k + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!;
          positions.push(local[k]!, local[k + 1]!, local[k + 2]!);
        }

        const reversed =
          face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
        const groupStart = indices.length;
        const nbTris = tri.NbTriangles();
        for (let i = 1; i <= nbTris; i++) {
          const t = tri.Triangle(i);
          let a = t.Value(1), b = t.Value(2), c = t.Value(3);
          t.delete();
          if (reversed) [b, c] = [c, b];
          indices.push(base + a - 1, base + b - 1, base + c - 1);

          // accumulate per-vertex normals from triangle geometry
          const ka = (a - 1) * 3, kb = (b - 1) * 3, kc = (c - 1) * 3;
          const ux = local[kb]! - local[ka]!, uy = local[kb + 1]! - local[ka + 1]!, uz = local[kb + 2]! - local[ka + 2]!;
          const vx = local[kc]! - local[ka]!, vy = local[kc + 1]! - local[ka + 1]!, vz = local[kc + 2]! - local[ka + 2]!;
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          for (const k of [ka, kb, kc]) {
            faceVertexNormals[k] = faceVertexNormals[k]! + nx;
            faceVertexNormals[k + 1] = faceVertexNormals[k + 1]! + ny;
            faceVertexNormals[k + 2] = faceVertexNormals[k + 2]! + nz;
          }
        }
        faceGroups.push({ name, start: groupStart, count: indices.length - groupStart });

        for (let i = 0; i < nbNodes; i++) {
          const k = i * 3;
          const nx = faceVertexNormals[k]!, ny = faceVertexNormals[k + 1]!, nz = faceVertexNormals[k + 2]!;
          const len = Math.hypot(nx, ny, nz) || 1;
          normals.push(nx / len, ny / len, nz / len);
        }

        // --- edges of this face (deduplicated across faces) ---
        const ex = faceScope.add(
          new oc.TopExp_Explorer_2(
            face,
            oc.TopAbs_ShapeEnum.TopAbs_EDGE as never,
            oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
          ),
        );
        for (; ex.More(); ex.Next()) {
          const edgeShape = ex.Current();
          if (doneEdges.Contains(edgeShape)) continue;
          doneEdges.Add(edgeShape);
          const edge = oc.TopoDS.Edge_1(edgeShape);
          const polyHandle = faceScope.add(
            oc.BRep_Tool.PolygonOnTriangulation_1(edge, triHandle, loc),
          );
          if (polyHandle.IsNull()) continue;
          const nodes = polyHandle.get().Nodes();
          const start = edgePositions.length / 3;
          // emit as segment pairs so all edges render in ONE LineSegments call
          for (let i = nodes.Lower(); i < nodes.Upper(); i++) {
            const k1 = (nodes.Value(i) - 1) * 3;
            const k2 = (nodes.Value(i + 1) - 1) * 3;
            edgePositions.push(
              local[k1]!, local[k1 + 1]!, local[k1 + 2]!,
              local[k2]!, local[k2 + 1]!, local[k2 + 2]!,
            );
          }
          const adjIdx = edgeToFaces.FindIndex(edgeShape);
          const faceNames =
            adjIdx > 0
              ? listToArray(oc, edgeToFaces.FindFromIndex(adjIdx)).map(
                  (f) => body.faces.nameOf(f) ?? "?",
                )
              : ["?"];
          edges.push({
            name: edgeNameFromFaces(faceNames),
            start,
            count: edgePositions.length / 3 - start,
          });
        }
      } finally {
        faceScope.dispose();
      }
    }

    return {
      name: body.name,
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      faceGroups,
      edgePositions: new Float32Array(edgePositions),
      edges,
    };
  } finally {
    scope.dispose();
  }
}
