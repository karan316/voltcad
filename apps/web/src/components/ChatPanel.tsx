import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, CircleAlert, Loader2, Sparkles, Square, Wrench } from "lucide-react";
import { useChatStore, type ChatSegment } from "../state/chat-store.ts";
import { aiConfigured } from "../lib/ai/settings.ts";

/** CHAT tab — the AI copilot conversation. */
export function ChatPanel(props: { onOpenSettings: () => void }) {
  const messages = useChatStore((s) => s.messages);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // keep pinned to bottom while streaming
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || status === "working") return;
    setDraft("");
    void send(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="chat-scroll flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mt-8 flex flex-col items-center gap-3 text-center">
            <Sparkles size={20} strokeWidth={1.5} style={{ color: "var(--text-muted)" }} />
            <p className="max-w-52 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Describe a part to build, or select geometry and tell me what to change.
            </p>
            {!aiConfigured() && (
              <button
                className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[rgb(127_127_127/0.08)]"
                style={{ borderColor: "var(--border-strong)" }}
                onClick={props.onOpenSettings}
              >
                Configure AI endpoint
              </button>
            )}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="mb-4">
              <div className="micro-label mb-1">You</div>
              <p className="text-[13px] font-medium leading-relaxed">
                {m.segments.map((s) => (s.kind === "text" ? s.text : "")).join("")}
              </p>
            </div>
          ) : (
            <div key={m.id} className="mb-4">
              <div className="micro-label mb-1">Copilot</div>
              {m.segments.length === 0 && status === "working" && (
                <Loader2 size={14} className="animate-spin" style={{ color: "var(--text-muted)" }} />
              )}
              {m.segments.map((seg, i) => (
                <Segment key={i} segment={seg} />
              ))}
            </div>
          ),
        )}
        {error && (
          <div
            className="mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-snug"
            style={{ borderColor: "var(--err)", color: "var(--err)" }}
          >
            <CircleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="select-text">{error}</span>
          </div>
        )}
      </div>

      <div className="border-t p-3" style={{ borderColor: "var(--border)" }}>
        <div
          className="flex items-end gap-2 rounded-xl border px-3 py-2"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface-solid)" }}
        >
          <textarea
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none"
            placeholder="describe the part…"
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {status === "working" ? (
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
              onClick={stop}
              data-tip="Stop"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
              onClick={submit}
              disabled={!draft.trim()}
              data-tip="Send"
            >
              <ArrowUp size={14} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  get_model_state: "Reading model",
  add_features: "Adding features",
  update_feature: "Updating feature",
  delete_feature: "Deleting feature",
  set_parameter: "Setting parameter",
};

function Segment({ segment }: { segment: ChatSegment }) {
  if (segment.kind === "text") {
    return (
      <p className="mb-2 select-text whitespace-pre-wrap text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {segment.text}
      </p>
    );
  }
  const label = TOOL_LABELS[segment.toolName] ?? segment.toolName;
  const summary = toolSummary(segment);
  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
      style={{ borderColor: "var(--border)", background: "rgb(127 127 127 / 0.05)" }}
    >
      {segment.state === "running" ? (
        <Loader2 size={12} className="animate-spin shrink-0" style={{ color: "var(--status)" }} />
      ) : segment.state === "error" ? (
        <CircleAlert size={12} className="shrink-0" style={{ color: "var(--err)" }} />
      ) : (
        <Check size={12} className="shrink-0" style={{ color: "var(--ok)" }} />
      )}
      <Wrench size={11} className="shrink-0" style={{ color: "var(--text-muted)" }} />
      <span className="micro-label !text-[9px]">{label}</span>
      {summary && (
        <span className="truncate font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
          {summary}
        </span>
      )}
    </div>
  );
}

/** One-line human summary of a tool call for the card. */
function toolSummary(seg: Extract<ChatSegment, { kind: "tool" }>): string {
  const input = seg.input as Record<string, unknown> | undefined;
  if (seg.toolName === "add_features" && Array.isArray(input?.features))
    return (input.features as { type: string }[]).map((f) => f.type).join(" + ");
  if (seg.toolName === "update_feature" || seg.toolName === "delete_feature")
    return String(input?.id ?? "");
  if (seg.toolName === "set_parameter") return `${input?.name} = ${input?.value}`;
  const out = seg.output as { features?: { status: string }[] } | undefined;
  if (out?.features) {
    const errs = out.features.filter((f) => f.status === "error").length;
    return errs > 0 ? `${errs} feature(s) failed` : "ok";
  }
  return "";
}
