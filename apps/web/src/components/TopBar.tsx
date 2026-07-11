import { Download, Moon, Settings2, Sun, Upload } from "lucide-react";
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

  const statusLabel =
    kernelStatus === "loading"
      ? "loading kernel"
      : kernelStatus === "error"
        ? "kernel error"
        : regenBusy
          ? "regenerating"
          : "live";
  const statusColor =
    kernelStatus === "error"
      ? "var(--err)"
      : regenBusy || kernelStatus === "loading"
        ? "var(--status)"
        : "var(--ok)";

  return (
    <div className="glass-panel flex h-11 items-center gap-2 px-3">
      <span className="micro-label flex items-center gap-1.5">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${regenBusy ? "animate-pulse" : ""}`}
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

      <button className="tool-btn" data-tip="Import (soon)" disabled>
        <Upload size={15} strokeWidth={1.8} />
      </button>
      <button
        className="tool-btn"
        data-tip="Export STEP"
        onClick={() => void exportModel("step")}
      >
        <Download size={15} strokeWidth={1.8} />
      </button>
      <span className="micro-label -ml-1 mr-1 hidden lg:inline">step</span>
      <button className="tool-btn" data-tip="Export STL" onClick={() => void exportModel("stl")}>
        <Download size={15} strokeWidth={1.8} />
      </button>
      <span className="micro-label -ml-1 mr-1 hidden lg:inline">stl</span>
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
