import { useEffect, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { useSketchStore } from "../state/sketch-store.ts";

/**
 * Floating dimension input, shown while a sketch tool has a pending point.
 * Type exact sizes instead of eyeballing: line length, rect width×height,
 * circle radius. Enter applies using the cursor for direction/quadrant.
 */
export function DimensionInput() {
  const tool = useSketchStore((s) => s.tool);
  const hasPending = useSketchStore((s) => s.pending !== null);
  const applyDimension = useSketchStore((s) => s.applyDimension);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const firstRef = useRef<HTMLInputElement>(null);

  // reset drafts whenever a new pending point starts
  useEffect(() => {
    if (hasPending) {
      setA("");
      setB("");
    }
  }, [hasPending, tool]);

  if (!hasPending || tool === "select") return null;

  const fields =
    tool === "line"
      ? [{ label: "length", value: a, set: setA }]
      : tool === "rectangle"
        ? [
            { label: "width", value: a, set: setA },
            { label: "height", value: b, set: setB },
          ]
        : [{ label: "radius", value: a, set: setA }];

  const apply = () => {
    const values = fields.map((f) => Number(f.value));
    if (values.some((v) => !Number.isFinite(v) || v <= 0)) return;
    applyDimension(values);
    setA("");
    setB("");
    firstRef.current?.focus();
  };

  return (
    <div className="glass-panel mt-2 flex items-center gap-2 px-2.5 py-1.5">
      {fields.map((f, i) => (
        <label key={f.label} className="flex items-center gap-1.5">
          <span className="micro-label">{f.label}</span>
          <input
            ref={i === 0 ? firstRef : undefined}
            className="field-input !mt-0 !w-20"
            placeholder="mm"
            inputMode="decimal"
            value={f.value}
            onChange={(e) => f.set(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                apply();
              }
              if (e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
      ))}
      <button className="icon-btn" data-tip="Apply ⏎" onClick={apply}>
        <CornerDownLeft size={13} />
      </button>
    </div>
  );
}
