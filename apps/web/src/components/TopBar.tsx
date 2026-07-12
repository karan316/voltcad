import { useRef } from "react";
import { Download, Moon, Settings2, Sun, Upload } from "lucide-react";
import { newFeatureId } from "@voltcad/model-api";
import { useEditorStore } from "../state/document-store.ts";
import { useThemeStore } from "../state/theme-store.ts";

/** Top document bar: document name, import/export, theme, settings. */
export function TopBar(props: { onOpenSettings: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const replaceDocument = useEditorStore((s) => s.replaceDocument);
  const exportModel = useEditorStore((s) => s.exportModel);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="glass-panel flex h-11 items-center gap-2 px-3">
      {/* spacer balancing the right-side buttons so the name stays centered */}
      <div className="w-40" />

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
