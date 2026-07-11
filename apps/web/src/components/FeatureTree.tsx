import { useEditorStore } from "../state/document-store.ts";
import type { FeatureStatus } from "@voltcad/model-api";

/** Onshape-style history tree: ordered features with status + controls. */
export function FeatureTree() {
  const features = useEditorStore((s) => s.doc.features);
  const statuses = useEditorStore((s) => s.statuses);
  const activeId = useEditorStore((s) => s.activeFeatureId);
  const setActive = useEditorStore((s) => s.setActiveFeature);
  const toggleSuppress = useEditorStore((s) => s.toggleSuppress);
  const removeFeature = useEditorStore((s) => s.removeFeature);

  return (
    <div className="glass-panel flex w-64 flex-col overflow-hidden">
      <div className="panel-title">Features</div>
      <div className="flex-1 overflow-y-auto py-1">
        {features.length === 0 && (
          <div className="px-3 py-2 text-xs text-slate-500">
            No features yet — add one from the toolbar.
          </div>
        )}
        {features.map((f) => {
          const status = statuses[f.id];
          return (
            <div
              key={f.id}
              className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
                activeId === f.id ? "bg-sky-500/15 text-sky-200" : "hover:bg-white/5"
              } ${f.suppressed ? "opacity-40" : ""}`}
              onClick={() => setActive(activeId === f.id ? null : f.id)}
            >
              <StatusDot status={status} suppressed={f.suppressed} />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="hidden gap-1 group-hover:flex">
                <button
                  className="icon-btn"
                  title={f.suppressed ? "Unsuppress" : "Suppress"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSuppress(f.id);
                  }}
                >
                  {f.suppressed ? "▶" : "⏸"}
                </button>
                <button
                  className="icon-btn text-red-400"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete "${f.name}"? Dependent features may fail.`))
                      removeFeature(f.id);
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {features.some((f) => statuses[f.id]?.status === "error") && (
        <div className="border-t border-white/10 p-2 text-xs text-red-300">
          {features
            .filter((f) => statuses[f.id]?.status === "error")
            .map((f) => (
              <div key={f.id} className="mb-1">
                <b>{f.name}:</b> {statuses[f.id]?.error?.message}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status, suppressed }: { status?: FeatureStatus; suppressed?: boolean }) {
  const color = suppressed
    ? "bg-slate-500"
    : status?.status === "error"
      ? "bg-red-400"
      : status?.status === "ok"
        ? "bg-emerald-400"
        : "bg-slate-500";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}
