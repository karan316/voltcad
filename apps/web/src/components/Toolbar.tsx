import {
  Box,
  Check,
  Circle,
  Cylinder,
  Home,
  Maximize,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  Slice,
  Spline,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { newFeatureId, q } from "@voltcad/model-api";
import { useEditorStore } from "../state/document-store.ts";
import { useSketchStore, type SketchTool } from "../state/sketch-store.ts";

/**
 * Floating modeling toolbar — mode-aware:
 *  - model mode: history nav, sketch/primitive creation, dressing, view
 *  - sketch mode: drawing tools, plane picker (until geometry exists),
 *    finish/cancel
 */
export function Toolbar() {
  const sketchActive = useSketchStore((s) => s.active);
  return sketchActive ? <SketchToolbar /> : <ModelToolbar />;
}

function ModelToolbar() {
  const addFeatures = useEditorStore((s) => s.addFeatures);
  const selection = useEditorStore((s) => s.selection);
  const requestFit = useEditorStore((s) => s.requestFit);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const doc = useEditorStore((s) => s.doc);
  const activeFeatureId = useEditorStore((s) => s.activeFeatureId);
  const beginSketch = useSketchStore((s) => s.begin);
  const selectedEdges = selection.filter((s) => s.kind === "edge");
  const selectedFaces = selection.filter((s) => s.kind === "face");

  const startSketch = async () => {
    // exactly one face selected → sketch on it; otherwise datum XY
    if (selectedFaces.length === 1) {
      const ok = await useSketchStore.getState().beginOnFace(selectedFaces[0]!.name);
      if (ok) {
        useEditorStore.getState().clearSelection();
        return;
      }
    }
    beginSketch({ kind: "datum", plane: "XY" });
  };

  // extrude targets the inspected sketch, falling back to the last sketch
  const targetSketch =
    doc.features.find((f) => f.id === activeFeatureId && f.type === "sketch") ??
    [...doc.features].reverse().find((f) => f.type === "sketch");

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

  const addExtrude = () => {
    if (!targetSketch) return;
    const hasBodies = doc.features.some((f) => f.type === "extrude" || f.type === "revolve");
    addFeatures([
      {
        type: "extrude",
        name: `Extrude ${doc.features.filter((f) => f.type === "extrude").length + 1}`,
        params: {
          sketch: targetSketch.id,
          distance: 10,
          symmetric: false,
          op: hasBodies ? "add" : "new",
        },
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

  const edgeSuffix =
    selectedEdges.length > 0 ? ` (${selectedEdges.length} edges)` : " — select edges first";

  return (
    <div className="glass-panel flex items-center gap-0.5 px-1.5 py-1">
      <button className="tool-btn" data-tip="Undo ⌘Z" disabled={!canUndo} onClick={undo}>
        <Undo2 size={16} strokeWidth={1.7} />
      </button>
      <button className="tool-btn" data-tip="Redo ⇧⌘Z" disabled={!canRedo} onClick={redo}>
        <Redo2 size={16} strokeWidth={1.7} />
      </button>
      <div className="tool-sep" />
      <button
        className="tool-btn"
        data-tip={
          selectedFaces.length === 1
            ? "Sketch on selected face"
            : "New sketch (select a face first to sketch on it)"
        }
        onClick={() => void startSketch()}
      >
        <PenLine size={16} strokeWidth={1.7} />
      </button>
      <button
        className="tool-btn"
        data-tip={targetSketch ? `Extrude "${targetSketch.name}"` : "Extrude — needs a sketch"}
        disabled={!targetSketch}
        onClick={addExtrude}
      >
        <ExtrudeGlyph />
      </button>
      <div className="tool-sep" />
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
      <button
        className="tool-btn"
        data-tip="Home view"
        onClick={() => useEditorStore.getState().requestHome()}
      >
        <Home size={16} strokeWidth={1.7} />
      </button>
      <button className="tool-btn" data-tip="Fit view" onClick={requestFit}>
        <Maximize size={16} strokeWidth={1.7} />
      </button>
    </div>
  );
}

function SketchToolbar() {
  const tool = useSketchStore((s) => s.tool);
  const setTool = useSketchStore((s) => s.setTool);
  const plane = useSketchStore((s) => s.plane);
  const setPlane = useSketchStore((s) => s.setPlane);
  const entityCount = useSketchStore((s) => s.entities.length);
  const finish = useSketchStore((s) => s.finish);
  const cancel = useSketchStore((s) => s.cancel);

  const tools: { id: SketchTool; icon: typeof Minus; tip: string }[] = [
    { id: "select", icon: MousePointer2, tip: "Select" },
    { id: "line", icon: Minus, tip: "Line — click to chain, Esc to end" },
    { id: "rectangle", icon: Square, tip: "Rectangle — two corners" },
    { id: "circle", icon: Circle, tip: "Circle — center, then radius" },
  ];

  return (
    <div className="glass-panel flex items-center gap-0.5 px-1.5 py-1">
      <span className="micro-label px-1.5" style={{ color: "var(--label)" }}>
        sketch
      </span>
      {tools.map(({ id, icon: Icon, tip }) => (
        <button
          key={id}
          className="tool-btn"
          data-active={tool === id}
          data-tip={tip}
          onClick={() => setTool(id)}
        >
          <Icon size={16} strokeWidth={1.7} />
        </button>
      ))}
      <div className="tool-sep" />
      {entityCount === 0 && plane.kind === "datum" &&
        (["XY", "XZ", "YZ"] as const).map((p) => (
          <button
            key={p}
            className="tool-btn !w-9 font-mono text-[10px] font-semibold"
            data-active={plane.plane === p}
            data-tip={`Sketch on ${p} plane`}
            onClick={() => setPlane({ kind: "datum", plane: p })}
          >
            {p}
          </button>
        ))}
      {plane.kind === "face" && (
        <span className="micro-label px-1.5" data-tip={plane.face}>
          on face
        </span>
      )}
      {entityCount > 0 && <span className="micro-label px-1.5">{entityCount} entities</span>}
      <div className="tool-sep" />
      <button
        className="tool-btn"
        data-tip="Finish sketch ⏎"
        style={{ color: "var(--ok)" }}
        onClick={finish}
      >
        <Check size={16} strokeWidth={2} />
      </button>
      <button
        className="tool-btn"
        data-tip="Cancel sketch"
        style={{ color: "var(--err)" }}
        onClick={cancel}
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

/** Extrude glyph (no exact lucide match: profile pulled upward). */
function ExtrudeGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v10" />
      <path d="m8 7 4-4 4 4" />
      <path d="M4 15l8 4 8-4" />
      <path d="M4 19l8 4 8-4" opacity="0.5" />
    </svg>
  );
}
