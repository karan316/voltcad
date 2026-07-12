import { useEffect, useRef, useState } from "react";
import { Download, Moon, Settings2, Sun, Upload } from "lucide-react";
import { newFeatureId } from "@voltcad/model-api";
import { useEditorStore } from "../state/document-store.ts";
import { useThemeStore } from "../state/theme-store.ts";

/** Top document bar: status pill, document name, export/theme/settings. */
export function TopBar(props: { onOpenSettings: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const replaceDocument = useEditorStore((s) => s.replaceDocument);
  const regenBusy = useEditorStore((s) => s.regenBusy);
  const kernelStatus = useEditorStore((s) => s.kernelStatus);
  const exportModel = useEditorStore((s) => s.exportModel);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debounced busy indicator: most regens finish in <100ms thanks to the
  // incremental cache — flashing "regenerating" for one frame is just noise.
  // Only surface the busy state when the kernel is genuinely working.
  const [showBusy, setShowBusy] = useState(false);
  useEffect(() => {
    if (!regenBusy) {
      setShowBusy(false);
      return;
    }
    const timer = setTimeout(() => setShowBusy(true), 250);
    return () => clearTimeout(timer);
  }, [regenBusy]);

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const format = /\.(igs|iges)$/i.test(file.name) ? "iges" : "step";
    useEditorStore.getState().addFeatures([
      {
        id: newFeatureId("imp"),
        type: "import",
        name: file.name,
        params: { format, data: text },
      },
    ]);
    useEditorStore.getState().requestFit();
  };

  const statusLabel =
    kernelStatus === "loading"
      ? "loading kernel"
      : kernelStatus === "error"
        ? "kernel error"
        : showBusy
          ? "regenerating"
          : "live";
  const statusColor =
    kernelStatus === "error"
      ? "var(--err)"
      : showBusy || kernelStatus === "loading"
        ? "var(--status)"
        : "var(--ok)";

  return (
    <div className="glass-panel flex h-11 items-center gap-2 px-3">
      <span
        className="status-pill"
        style={{
          background: kernelStatus === "error" ? "rgb(214 69 69 / 0.12)" : showBusy || kernelStatus === "loading" ? "rgb(232 89 12 / 0.12)" : "var(--ok-bg)",
          color: statusColor,
        }}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${showBusy ? "animate-pulse" : ""}`}
          style={{ background: statusColor }}
        />
        {statusLabel}
      </span>

      <div className="flex flex-1 justify-center">
        <input
          className="w-56 rounded-md bg-transparent px-2 py-1 text-center text-[13px] font-semibold tracking-tight outline-none transition-colors hover:bg-[rgb(127_127_127/0.08)] focus:bg-[rgb(127_127_127/0.08)]"
          value={doc.name}
          onChange={(e) => replaceDocument({ ...doc, name: e.target.value })}
          spellCheck={false}
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".step,.stp,.iges,.igs"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImportFile(file);
          e.target.value = ""; // allow re-importing the same file
        }}
      />
      <button
        className="tool-btn"
        data-tip="Import STEP / IGES"
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload size={15} strokeWidth={1.8} />
      </button>
      <button
        className="tool-btn"
        data-tip="Export STEP"
        onClick={() => void exportModel("step")}
      >
        <Download size={15} strokeWidth={1.8} />
      </button>
      <button className="tool-btn" data-tip="Export STL" onClick={() => void exportModel("stl")}>
        <Download size={15} strokeWidth={1.8} />
      </button>
      <div className="tool-sep" />
      <button
        className="tool-btn"
        data-tip={theme === "dark" ? "Light mode" : "Dark mode"}
        onClick={toggleTheme}
      >
        {theme === "dark" ? <Sun size={15} strokeWidth={1.8} /> : <Moon size={15} strokeWidth={1.8} />}
      </button>
      <button
        className="tool-btn"
        data-tip="AI settings"
        data-tip-side="bottom-left"
        onClick={props.onOpenSettings}
      >
        <Settings2 size={15} strokeWidth={1.8} />
      </button>
    </div>
  );
}
