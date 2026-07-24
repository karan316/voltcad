import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Moon, Settings2, Sun, Upload, Users } from "lucide-react";
import { newFeatureId } from "@voltcad/model-api";
import { useEditorStore } from "../state/document-store.ts";
import { useThemeStore } from "../state/theme-store.ts";
import { useCollabStore } from "../state/collab-store.ts";
import { putBlob } from "../lib/opfs.ts";
import { pushRelayBlob } from "../lib/blob-sync.ts";

/** Top document bar: document name, import/export, theme, settings. */
export function TopBar(props: { onOpenSettings: () => void }) {
  const doc = useEditorStore((s) => s.doc);
  const renameDocument = useEditorStore((s) => s.renameDocument);
  const exportModel = useEditorStore((s) => s.exportModel);
  const regenBusy = useEditorStore((s) => s.regenBusy);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tiny gray spinner, debounced: fast regens (incremental cache) show
  // nothing; only genuinely slow rebuilds get quiet feedback.
  const [showBusy, setShowBusy] = useState(false);
  useEffect(() => {
    if (!regenBusy) {
      setShowBusy(false);
      return;
    }
    const timer = setTimeout(() => setShowBusy(true), 300);
    return () => clearTimeout(timer);
  }, [regenBusy]);

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const format = /\.(igs|iges)$/i.test(file.name) ? "iges" : "step";
    // Payload goes to the content-addressed blob store; the document only
    // carries the hash so the CRDT stays small enough to sync.
    const blobHash = await putBlob(text);
    void pushRelayBlob(blobHash, text); // no-op unless collab is connected
    useEditorStore.getState().addFeatures([
      {
        id: newFeatureId("imp"),
        type: "import",
        name: file.name,
        params: { format, blobHash },
      },
    ]);
    useEditorStore.getState().requestFit();
  };

  return (
    <div className="glass-panel flex h-11 items-center gap-2 px-3">
      {/* spacer balancing the right-side buttons so the name stays centered;
          hosts the quiet regen spinner */}
      <div className="flex w-40 items-center">
        {showBusy && (
          <Loader2
            size={13}
            className="animate-spin"
            style={{ color: "var(--text-muted)" }}
            aria-label="regenerating"
          />
        )}
      </div>

      <div className="flex flex-1 justify-center">
        <input
          className="w-56 rounded-md bg-transparent px-2 py-1 text-center text-[13px] font-semibold tracking-tight outline-none transition-colors hover:bg-[rgb(127_127_127/0.08)] focus:bg-[rgb(127_127_127/0.08)]"
          value={doc.name}
          onChange={(e) => renameDocument(e.target.value)}
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
      <CollabControls />
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

/** Presence avatars + join/leave room popover. */
function CollabControls() {
  const status = useCollabStore((s) => s.status);
  const room = useCollabStore((s) => s.room);
  const peers = useCollabStore((s) => s.peers);
  const connect = useCollabStore((s) => s.connect);
  const disconnect = useCollabStore((s) => s.disconnect);
  const [open, setOpen] = useState(false);
  const [roomInput, setRoomInput] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const join = () => {
    const r = roomInput.trim();
    if (r) connect(r);
  };

  return (
    <div className="relative flex items-center gap-1" ref={popoverRef}>
      {peers.map((p) => (
        <div
          key={p.clientId}
          data-tip={p.selection.length > 0 ? `${p.name} · ${p.selection.length} selected` : p.name}
          className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
          style={{ backgroundColor: p.color }}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </div>
      ))}
      <button
        className="tool-btn"
        data-tip={status === "off" ? "Collaborate" : `Room “${room}” · ${status}`}
        aria-label="Collaborate"
        onClick={() => setOpen((v) => !v)}
        style={status === "connected" ? { color: "#22c55e" } : undefined}
      >
        <Users size={15} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="glass-panel absolute right-0 top-9 z-50 flex w-64 flex-col gap-2 rounded-lg p-3 shadow-lg">
          {status === "off" ? (
            <>
              <div className="text-[12px] font-semibold">Join a session</div>
              <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Everyone in the same room edits this document live.
              </div>
              <div className="flex gap-1.5">
                <input
                  className="min-w-0 flex-1 rounded-md border border-[rgb(127_127_127/0.25)] bg-transparent px-2 py-1 text-[12px] outline-none"
                  placeholder="room name"
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && join()}
                  spellCheck={false}
                />
                <button
                  className="rounded-md bg-[rgb(127_127_127/0.15)] px-2.5 py-1 text-[12px] font-medium hover:bg-[rgb(127_127_127/0.25)]"
                  onClick={join}
                >
                  Join
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-[12px] font-semibold">
                Room “{room}” — {status}
              </div>
              <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {peers.length === 0
                  ? "No one else is here yet."
                  : `${peers.length} collaborator${peers.length > 1 ? "s" : ""}: ${peers.map((p) => p.name).join(", ")}`}
              </div>
              <button
                className="rounded-md bg-[rgb(127_127_127/0.15)] px-2.5 py-1 text-[12px] font-medium hover:bg-[rgb(127_127_127/0.25)]"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Leave session
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
