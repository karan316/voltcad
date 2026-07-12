import { MessageSquare, Layers, Zap } from "lucide-react";
import { ChatPanel } from "./ChatPanel.tsx";
import { ModelPanel } from "./ModelPanel.tsx";
import { useEditorStore } from "../state/document-store.ts";

/** Left sidebar: floating glass panel with brand header + CHAT / MODEL tabs. */
export function Sidebar(props: { onOpenSettings: () => void }) {
  const tab = useEditorStore((s) => s.sidebarTab);
  const setTab = useEditorStore((s) => s.setSidebarTab);
  const featureCount = useEditorStore((s) => s.doc.features.length);
  const paramCount = useEditorStore((s) => s.doc.parameters ? Object.keys(s.doc.parameters).length : 0);
  const hasErrors = useEditorStore((s) =>
    Object.values(s.statuses).some((x) => x.status === "error"),
  );

  return (
    <aside className="glass-panel z-10 flex w-80 shrink-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-md"
          style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
        >
          <Zap size={13} strokeWidth={2.2} style={{ color: "var(--status)" }} fill="var(--status)" />
        </span>
        <span className="text-[14px] font-bold tracking-[0.16em]">VOLTCAD</span>
      </div>

      <div className="flex items-center gap-4 border-b px-4" style={{ borderColor: "var(--border)" }}>
        <TabButton
          icon={<MessageSquare size={12} />}
          label="Chat"
          active={tab === "chat"}
          onClick={() => setTab("chat")}
        />
        <TabButton
          icon={<Layers size={12} />}
          label={`Model · ${featureCount}`}
          active={tab === "model"}
          onClick={() => setTab("model")}
          dot={hasErrors}
        />
        <span className="micro-label ml-auto pb-2">{paramCount} params</span>
      </div>

      {tab === "chat" ? <ChatPanel onOpenSettings={props.onOpenSettings} /> : <ModelPanel />}
    </aside>
  );
}

function TabButton(props: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="micro-label relative flex items-center gap-1.5 border-b-2 pb-2 pt-1 transition-colors"
      style={{
        borderColor: props.active ? "var(--label)" : "transparent",
        color: props.active ? "var(--label)" : "var(--text-muted)",
      }}
      onClick={props.onClick}
    >
      {props.icon}
      {props.label}
      {props.dot && (
        <span className="h-1 w-1 rounded-full" style={{ background: "var(--err)" }} />
      )}
    </button>
  );
}
