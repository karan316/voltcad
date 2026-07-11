import { useEditorStore } from "../state/document-store.ts";

/** Bottom status strip: hover/selection readout, mass properties, perf. */
export function StatusBar() {
  const hovered = useEditorStore((s) => s.hovered);
  const selection = useEditorStore((s) => s.selection);
  const massProps = useEditorStore((s) => s.massProps);
  const regenMs = useEditorStore((s) => s.regenMs);
  const kernelError = useEditorStore((s) => s.kernelError);

  return (
    <div className="glass-panel flex h-8 items-center gap-5 px-4 font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
      <span className="min-w-0 flex-1 truncate">
        {kernelError ? (
          <span style={{ color: "var(--err)" }}>{kernelError}</span>
        ) : hovered ? (
          <span style={{ color: "var(--text-secondary)" }}>
            {hovered.kind} · {hovered.name}
          </span>
        ) : selection.length > 0 ? (
          `${selection.length} selected`
        ) : (
          "hover to inspect · click to select · shift+click multi"
        )}
      </span>
      {massProps && (
        <>
          <span data-tip="Volume">V {fmt(massProps.volume)}mm³</span>
          <span data-tip="Surface area">A {fmt(massProps.surfaceArea)}mm²</span>
          <span data-tip="Center of mass">
            com {massProps.centerOfMass.map((v) => v.toFixed(1)).join(" ")}
          </span>
        </>
      )}
      <span data-tip="Regeneration time">{regenMs.toFixed(0)}ms</span>
    </div>
  );
}

function fmt(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}e6 `;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}e3 `;
  return `${v.toFixed(1)} `;
}
