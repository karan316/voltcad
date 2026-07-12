import { useState } from "react";
import { X } from "lucide-react";
import { useSketchStore } from "../state/sketch-store.ts";

/**
 * Constraint bar — visible in sketch mode with the select tool. Pick entities
 * in the viewport, then apply constraints; planegcs solves immediately and
 * geometry snaps to satisfy them. Chips list active constraints (× removes,
 * which also re-solves).
 */
export function ConstraintBar() {
  const active = useSketchStore((s) => s.active);
  const tool = useSketchStore((s) => s.tool);
  const selectedIds = useSketchStore((s) => s.selectedIds);
  const entities = useSketchStore((s) => s.entities);
  const constraints = useSketchStore((s) => s.constraints);
  const solveError = useSketchStore((s) => s.solveError);
  const addConstraint = useSketchStore((s) => s.addConstraint);
  const removeConstraint = useSketchStore((s) => s.removeConstraint);
  const [dimDraft, setDimDraft] = useState<{ type: "distance" | "radius"; value: string } | null>(
    null,
  );

  if (!active || tool !== "select") return null;

  const selected = selectedIds
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e);
  const lines = selected.filter((e) => e.type === "line");
  const rounds = selected.filter((e) => e.type === "circle" || e.type === "arc");

  /** Current measured value, prefilled into dimensional constraint inputs. */
  const measure = (type: "distance" | "radius"): number => {
    if (type === "radius" && rounds[0]) return (rounds[0] as { radius: number }).radius;
    if (type === "distance" && lines[0]) {
      const l = lines[0] as { start: [number, number]; end: [number, number] };
      return Math.round(Math.hypot(l.end[0] - l.start[0], l.end[1] - l.start[1]) * 100) / 100;
    }
    return 10;
  };

  const applyDim = () => {
    if (!dimDraft) return;
    const v = Number(dimDraft.value);
    if (!Number.isFinite(v) || v <= 0) return;
    void addConstraint(dimDraft.type, v);
    setDimDraft(null);
  };

  const buttons: { label: string; tip: string; enabled: boolean; run: () => void }[] = [
    {
      label: "H",
      tip: "Horizontal (line)",
      enabled: lines.length === 1 && selected.length === 1,
      run: () => void addConstraint("horizontal"),
    },
    {
      label: "V",
      tip: "Vertical (line)",
      enabled: lines.length === 1 && selected.length === 1,
      run: () => void addConstraint("vertical"),
    },
    {
      label: "∥",
      tip: "Parallel (two lines)",
      enabled: lines.length === 2 && selected.length === 2,
      run: () => void addConstraint("parallel"),
    },
    {
      label: "⊥",
      tip: "Perpendicular (two lines)",
      enabled: lines.length === 2 && selected.length === 2,
      run: () => void addConstraint("perpendicular"),
    },
    {
      label: "↔",
      tip: "Length (line)",
      enabled: lines.length === 1 && selected.length === 1,
      run: () => setDimDraft({ type: "distance", value: String(measure("distance")) }),
    },
    {
      label: "R",
      tip: "Radius (circle / arc)",
      enabled: rounds.length === 1 && selected.length === 1,
      run: () => setDimDraft({ type: "radius", value: String(measure("radius")) }),
    },
  ];

  return (
    <div className="glass-panel mt-2 flex max-w-2xl flex-wrap items-center gap-1 px-2 py-1.5">
      <span className="micro-label px-1">
        {selected.length === 0 ? "click entities to select" : `${selected.length} selected`}
      </span>
      {buttons.map((b) => (
        <button
          key={b.tip}
          className="tool-btn !h-7 !w-7 font-mono text-[12px] font-semibold"
          data-tip={b.tip}
          disabled={!b.enabled}
          onClick={b.run}
        >
          {b.label}
        </button>
      ))}
      {dimDraft && (
        <span className="flex items-center gap-1.5">
          <input
            autoFocus
            className="field-input !mt-0 !w-20"
            inputMode="decimal"
            value={dimDraft.value}
            onChange={(e) => setDimDraft({ ...dimDraft, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyDim();
              if (e.key === "Escape") setDimDraft(null);
            }}
          />
          <span className="micro-label">mm ⏎</span>
        </span>
      )}
      {constraints.length > 0 && <span className="mx-1 h-4 w-px" style={{ background: "var(--border-strong)" }} />}
      {constraints.map((c) => (
        <span
          key={c.id}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px]"
          style={{ background: "var(--accent-soft)", color: "var(--label)" }}
        >
          {c.type}
          {c.value !== undefined && ` ${c.value}`}
          <button className="opacity-60 hover:opacity-100" onClick={() => void removeConstraint(c.id)}>
            <X size={10} />
          </button>
        </span>
      ))}
      {solveError && (
        <span className="px-1 text-[11px]" style={{ color: "var(--err)" }}>
          {solveError}
        </span>
      )}
    </div>
  );
}
