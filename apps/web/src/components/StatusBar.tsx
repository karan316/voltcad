import { useEditorStore } from "../state/document-store.ts";
import { prettyEntityName } from "../lib/pretty.ts";

/** Bottom status strip: hover/selection readout, mass properties, perf. */
export function StatusBar() {
  const hovered = useEditorStore((s) => s.hovered);
  const selection = useEditorStore((s) => s.selection);
  const massProps = useEditorStore((s) => s.massProps);
  const regenMs = useEditorStore((s) => s.regenMs);
  const kernelError = useEditorStore((s) => s.kernelError);
  const doc = useEditorStore((s) => s.doc);

  const selectedFacesOnly =
    selection.length > 0 && selection.every((x) => x.kind === "face");

  return (
    <div className="flex h-8 items-center gap-5 px-4 font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
      <span className="min-w-0 flex-1 truncate">
        {kernelError ? (
          <span style={{ color: "var(--err)" }}>{kernelError}</span>
        ) : hovered ? (
          <span style={{ color: "var(--text-secondary)" }}>
            {hovered.kind} · {prettyEntityName(hovered.name, hovered.kind, doc)}
          </span>
        ) : selectedFacesOnly ? (
          `${selection.length} face${selection.length > 1 ? "s" : ""} selected — tip: fillet/chamfer need edges`
        ) : selection.length > 0 ? (
          `${selection.length} selected`
        ) : (
          "hover to inspect · click to select · shift+click multi"
        )}
      </span>
      {massProps && (
        <>
          <span data-tip="Volume" data-tip-side="top">V {fmt(massProps.volume)}mm³</span>
          <span data-tip="Surface area" data-tip-side="top">A {fmt(massProps.surfaceArea)}mm²</span>
          <span data-tip="Center of mass" data-tip-side="top">
            com {massProps.centerOfMass.map((v) => v.toFixed(1)).join(" ")}
          </span>
        </>
      )}
      <span data-tip="Regeneration time" data-tip-side="top">{regenMs.toFixed(0)}ms</span>
    </div>
  );
}

function fmt(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}e6 `;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}e3 `;
  return `${v.toFixed(1)} `;
}
