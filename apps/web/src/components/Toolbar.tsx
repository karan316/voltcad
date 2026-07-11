import { Box, Cylinder, Maximize, Slice, Spline } from "lucide-react";
import { newFeatureId, q } from "@voltcad/model-api";
import { useEditorStore } from "../state/document-store.ts";

/**
 * Floating modeling toolbar — icon buttons with tooltips.
 * Primitive tools insert ordinary sketch+extrude features (fully editable);
 * dressing tools (fillet/chamfer) act on the current edge selection.
 */
export function Toolbar() {
  const addFeatures = useEditorStore((s) => s.addFeatures);
  const selection = useEditorStore((s) => s.selection);
  const requestFit = useEditorStore((s) => s.requestFit);
  const selectedEdges = selection.filter((s) => s.kind === "edge");

  const addBox = () => {
    const sk = newFeatureId("sk");
    addFeatures([
      {
        id: sk,
        type: "sketch",
        name: "Box Sketch",
        params: {
          plane: { kind: "datum", plane: "XY" },
          entities: [{ id: "rect1", type: "rectangle", corner1: [-30, -20], corner2: [30, 20] }],
          constraints: [],
        },
      },
      {
        type: "extrude",
        name: "Box",
        params: { sketch: sk, distance: 25, symmetric: false, op: "new" },
      },
    ]);
  };

  const addCylinder = () => {
    const sk = newFeatureId("sk");
    addFeatures([
      {
        id: sk,
        type: "sketch",
        name: "Cylinder Sketch",
        params: {
          plane: { kind: "datum", plane: "XY" },
          entities: [{ id: "c1", type: "circle", center: [0, 0], radius: 15 }],
          constraints: [],
        },
      },
      {
        type: "extrude",
        name: "Cylinder",
        params: { sketch: sk, distance: 30, symmetric: false, op: "add" },
      },
    ]);
  };

  const addDressing = (kind: "fillet" | "chamfer") => {
    if (selectedEdges.length === 0) return;
    addFeatures([
      {
        type: kind,
        name: kind === "fillet" ? "Fillet" : "Chamfer",
        params: {
          edges: q.named(...selectedEdges.map((e) => e.name)),
          [kind === "fillet" ? "radius" : "distance"]: 2,
        },
      },
    ]);
    useEditorStore.getState().clearSelection();
  };

  const edgeSuffix = selectedEdges.length > 0 ? ` (${selectedEdges.length} edges)` : " — select edges first";

  return (
    <div className="glass-panel flex items-center gap-0.5 px-1.5 py-1">
      <button className="tool-btn" data-tip="Insert box" onClick={addBox}>
        <Box size={16} strokeWidth={1.7} />
      </button>
      <button className="tool-btn" data-tip="Insert cylinder" onClick={addCylinder}>
        <Cylinder size={16} strokeWidth={1.7} />
      </button>
      <div className="tool-sep" />
      <button
        className="tool-btn"
        data-tip={`Fillet${edgeSuffix}`}
        disabled={selectedEdges.length === 0}
        onClick={() => addDressing("fillet")}
      >
        <Spline size={16} strokeWidth={1.7} />
      </button>
      <button
        className="tool-btn"
        data-tip={`Chamfer${edgeSuffix}`}
        disabled={selectedEdges.length === 0}
        onClick={() => addDressing("chamfer")}
      >
        <Slice size={16} strokeWidth={1.7} />
      </button>
      <div className="tool-sep" />
      <button className="tool-btn" data-tip="Fit view" onClick={requestFit}>
        <Maximize size={16} strokeWidth={1.7} />
      </button>
    </div>
  );
}
