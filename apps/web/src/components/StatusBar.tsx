import { useEditorStore } from "../state/document-store.ts";

/** Bottom status bar: hover/selection readout, mass properties, perf HUD. */
export function StatusBar() {
  const hovered = useEditorStore((s) => s.hovered);
  const selection = useEditorStore((s) => s.selection);
  const massProps = useEditorStore((s) => s.massProps);
  const regenMs = useEditorStore((s) => s.regenMs);
  const kernelError = useEditorStore((s) => s.kernelError);

  return (
    <div className="glass-panel flex items-center gap-4 px-3 py-1 text-[11px] text-slate-400">
      <span className="min-w-0 flex-1 truncate">
        {kernelError ? (
          <span className="text-red-400">{kernelError}</span>
        ) : hovered ? (
          <>
            <span className="text-slate-500">{hovered.kind}:</span> {hovered.name}
          </>
        ) : selection.length > 0 ? (
          `${selection.length} selected`
        ) : (
          "Hover to inspect · click to select · shift-click for multi-select"
        )}
      </span>
      {massProps && (
        <>
          <span title="Volume">V {formatQty(massProps.volume, "mm³")}</span>
          <span title="Surface area">A {formatQty(massProps.surfaceArea, "mm²")}</span>
          <span title="Center of mass">
            ⌖ [{massProps.centerOfMass.map((v) => v.toFixed(1)).join(", ")}]
          </span>
        </>
      )}
      <span title="Last regeneration time" className="text-slate-500">
        {regenMs.toFixed(0)}ms
      </span>
    </div>
  );
}

function formatQty(v: number, unit: string): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}×10⁶ ${unit}`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}×10³ ${unit}`;
  return `${v.toFixed(1)} ${unit}`;
}
