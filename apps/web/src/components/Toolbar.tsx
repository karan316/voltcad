import { newFeatureId, q } from "@voltcad/model-api";
import { useEditorStore } from "../state/document-store.ts";

/**
 * Feature creation toolbar.
 *
 * v1 provides parametric primitive insertion + selection-driven dressing
 * features (fillet/chamfer). The interactive 2D sketcher replaces the
 * primitive dialogs in the next milestone — features created here are
 * ordinary sketch/extrude nodes, fully editable in the inspector.
 */
export function Toolbar() {
  const addFeatures = useEditorStore((s) => s.addFeatures);
  const selection = useEditorStore((s) => s.selection);
  const exportModel = useEditorStore((s) => s.exportModel);
  const regenBusy = useEditorStore((s) => s.regenBusy);
  const kernelStatus = useEditorStore((s) => s.kernelStatus);
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
    ] as never);
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
    ] as never);
  };

  const addFillet = (kind: "fillet" | "chamfer") => {
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
    ] as never);
    useEditorStore.getState().clearSelection();
  };

  return (
    <div className="glass-panel flex items-center gap-1 px-2 py-1.5">
      <span className="mr-2 bg-gradient-to-r from-sky-300 to-indigo-300 bg-clip-text px-1 text-sm font-bold tracking-wide text-transparent">
        VoltCAD
      </span>
      <ToolButton label="Box" onClick={addBox} />
      <ToolButton label="Cylinder" onClick={addCylinder} />
      <div className="mx-1 h-5 w-px bg-white/10" />
      <ToolButton
        label={`Fillet${selectedEdges.length ? ` (${selectedEdges.length})` : ""}`}
        disabled={selectedEdges.length === 0}
        title="Select edges in the viewport first"
        onClick={() => addFillet("fillet")}
      />
      <ToolButton
        label="Chamfer"
        disabled={selectedEdges.length === 0}
        title="Select edges in the viewport first"
        onClick={() => addFillet("chamfer")}
      />
      <div className="mx-1 h-5 w-px bg-white/10" />
      <ToolButton label="STEP" title="Export STEP" onClick={() => void exportModel("step")} />
      <ToolButton label="STL" title="Export STL" onClick={() => void exportModel("stl")} />
      <div className="flex-1" />
      {kernelStatus === "loading" && (
        <span className="animate-pulse text-xs text-sky-300">loading kernel…</span>
      )}
      {regenBusy && kernelStatus === "ready" && (
        <span className="animate-pulse text-xs text-sky-300">regenerating…</span>
      )}
      {kernelStatus === "error" && <span className="text-xs text-red-400">kernel error</span>}
    </div>
  );
}

function ToolButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.label}
    </button>
  );
}
