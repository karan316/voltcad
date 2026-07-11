import { useState } from "react";
import { useEditorStore } from "../state/document-store.ts";

/**
 * Feature inspector — edits the active feature's parameters.
 *
 * v1 renders hand-picked fields per feature type; the schema-driven form
 * generator (zod → form) replaces this once the field set stabilizes.
 * Every edit goes through updateFeatureParams → full validation → regen.
 */
export function Inspector() {
  const activeId = useEditorStore((s) => s.activeFeatureId);
  const feature = useEditorStore((s) => s.doc.features.find((f) => f.id === s.activeFeatureId));
  const update = useEditorStore((s) => s.updateFeatureParams);
  const rename = useEditorStore((s) => s.renameFeature);

  if (!activeId || !feature) return null;
  const params = feature.params as Record<string, unknown>;

  const setField = (key: string, value: unknown) => update(feature.id, { ...params, [key]: value });

  return (
    <div className="glass-panel w-60 p-3">
      <div className="panel-title -m-3 mb-2">Edit {feature.type}</div>
      <label className="field-label">Name</label>
      <input
        className="field-input"
        value={feature.name}
        onChange={(e) => rename(feature.id, e.target.value)}
      />
      {(feature.type === "extrude" || feature.type === "revolve") && (
        <>
          <ExpressionField
            label={feature.type === "extrude" ? "Distance (mm)" : "Angle (deg)"}
            value={String(params[feature.type === "extrude" ? "distance" : "angle"] ?? "")}
            onCommit={(v) => setField(feature.type === "extrude" ? "distance" : "angle", v)}
          />
          <label className="field-label">Result</label>
          <select
            className="field-input"
            value={String(params.op ?? "new")}
            onChange={(e) => setField("op", e.target.value)}
          >
            <option value="new">New body</option>
            <option value="add">Add</option>
            <option value="cut">Cut</option>
            <option value="intersect">Intersect</option>
          </select>
          {feature.type === "extrude" && (
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={Boolean(params.symmetric)}
                onChange={(e) => setField("symmetric", e.target.checked)}
              />
              Symmetric
            </label>
          )}
        </>
      )}
      {feature.type === "fillet" && (
        <ExpressionField
          label="Radius (mm)"
          value={String(params.radius ?? "")}
          onCommit={(v) => setField("radius", v)}
        />
      )}
      {feature.type === "chamfer" && (
        <ExpressionField
          label="Distance (mm)"
          value={String(params.distance ?? "")}
          onCommit={(v) => setField("distance", v)}
        />
      )}
      {feature.type === "sketch" && (
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          {(params.entities as unknown[])?.length ?? 0} entities on{" "}
          {(params.plane as { plane?: string })?.plane}. Interactive sketch editing arrives with
          the 2D sketcher milestone.
        </p>
      )}
    </div>
  );
}

/** Text input that commits on blur/Enter — avoids regen on every keystroke. */
function ExpressionField(props: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  return (
    <>
      <label className="field-label">{props.label}</label>
      <input
        className="field-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== props.value && props.onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </>
  );
}
