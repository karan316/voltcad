import { useEffect, useState } from "react";
import { CircleAlert, Loader2, PenLine, Sparkles } from "lucide-react";
import { useEditorStore } from "../state/document-store.ts";
import { useSketchStore } from "../state/sketch-store.ts";
import { humanizeError } from "../lib/pretty.ts";

/**
 * Viewport overlays: kernel-loading card, empty-document guidance, a subtle
 * regeneration loader line, and a regeneration-error banner that is visible
 * regardless of which sidebar tab is open (errors must never be silent).
 */
export function ViewportOverlays() {
  const kernelStatus = useEditorStore((s) => s.kernelStatus);
  const featureCount = useEditorStore((s) => s.doc.features.length);
  const sketchActive = useSketchStore((s) => s.active);
  const regenBusy = useEditorStore((s) => s.regenBusy);

  // debounced: most regens are <100ms thanks to the incremental cache —
  // only show the loader when the kernel is genuinely working
  const [showBusy, setShowBusy] = useState(false);
  useEffect(() => {
    if (!regenBusy) {
      setShowBusy(false);
      return;
    }
    const timer = setTimeout(() => setShowBusy(true), 300);
    return () => clearTimeout(timer);
  }, [regenBusy]);
  const doc = useEditorStore((s) => s.doc);
  // selector must return a primitive (string) — returning a fresh object every
  // call makes React's useSyncExternalStore loop forever
  const firstErrorKey = useEditorStore((s) => {
    for (const f of s.doc.features) {
      const st = s.statuses[f.id];
      if (st?.status === "error") return `${f.id}\u0000${f.name}\u0000${st.error?.message ?? ""}`;
    }
    return null;
  });
  const firstError = firstErrorKey
    ? (([id, name, message]) => ({ id, name, message }))(firstErrorKey.split("\u0000") as [string, string, string])
    : null;

  return (
    <>
      {/* subtle indeterminate loader along the top edge while regenerating */}
      {showBusy && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] overflow-hidden">
          <div className="regen-loader h-full w-2/5 rounded-full" style={{ background: "var(--label)" }} />
        </div>
      )}

      {kernelStatus === "loading" && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="glass-panel flex items-center gap-3 px-5 py-3.5">
            <Loader2 size={16} className="animate-spin" style={{ color: "var(--label)" }} />
            <div>
              <div className="text-[13px] font-semibold">Starting geometry kernel</div>
              <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                one-time download, cached afterwards
              </div>
            </div>
          </div>
        </div>
      )}

      {kernelStatus === "ready" && featureCount === 0 && !sketchActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="glass-panel max-w-72 px-5 py-4 text-center">
            <div className="mb-2 flex justify-center gap-3" style={{ color: "var(--text-muted)" }}>
              <PenLine size={16} />
              <Sparkles size={16} />
            </div>
            <p className="text-[13px] font-medium">Empty part</p>
            <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Start a sketch from the toolbar, insert a primitive, import a STEP file, or describe
              the part to the copilot.
            </p>
          </div>
        </div>
      )}

      {firstError && !sketchActive && (
        <div className="absolute inset-x-0 bottom-12 z-20 flex justify-center px-3">
          <button
            className="glass-panel flex max-w-xl items-center gap-2.5 px-4 py-2 text-left transition-transform hover:scale-[1.01]"
            style={{ borderColor: "var(--err)" }}
            onClick={() => {
              const store = useEditorStore.getState();
              store.setSidebarTab("model");
              store.setActiveFeature(firstError.id);
            }}
          >
            <CircleAlert size={15} className="shrink-0" style={{ color: "var(--err)" }} />
            <span className="min-w-0 text-[12px] leading-snug">
              <b>{firstError.name}</b> failed — {humanizeError(firstError.message, doc)}
              <span className="ml-1" style={{ color: "var(--text-muted)" }}>
                Click to review.
              </span>
            </span>
          </button>
        </div>
      )}
    </>
  );
}
