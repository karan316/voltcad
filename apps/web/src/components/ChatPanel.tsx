import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, CircleAlert, Loader2, Paperclip, Sparkles, Square, Wrench, X } from "lucide-react";
import { useChatStore, type ChatSegment } from "../state/chat-store.ts";
import { aiConfigured } from "../lib/ai/settings.ts";

/** Downscale + re-encode an image file to a JPEG data URL (≤1024px, token-sane). */
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** CHAT tab — the AI copilot conversation. */
export function ChatPanel(props: { onOpenSettings: () => void }) {
  const messages = useChatStore((s) => s.messages);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachFiles = async (files: FileList | File[]) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const urls = await Promise.all(images.map(fileToDataUrl));
    setAttachments((prev) => [...prev, ...urls].slice(0, 4)); // cap at 4
  };

  // keep pinned to bottom while streaming
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || status === "working") return;
    setDraft("");
    const images = attachments;
    setAttachments([]);
    void send(text, images);
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
            <div key={m.id} className="mb-4 flex flex-col items-end gap-1.5">
              {m.images && m.images.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {m.images.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt="attachment"
                      className="h-16 w-16 rounded-lg border object-cover"
                      style={{ borderColor: "var(--border-strong)" }}
                    />
                  ))}
                </div>
              )}
              {m.segments.some((s) => s.kind === "text" && s.text) && (
                <p
                  className="max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13px] font-medium leading-relaxed"
                  style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
                >
                  {m.segments.map((s) => (s.kind === "text" ? s.text : "")).join("")}
                </p>
              )}
            </div>
          ) : (
            <div key={m.id} className="mb-4">
              <div className="micro-label mb-1" style={{ color: "var(--label)" }}>
                Copilot <span style={{ color: "var(--text-muted)" }}>· AI</span>
              </div>
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
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((src, i) => (
              <span key={i} className="relative">
                <img
                  src={src}
                  alt="attachment"
                  className="h-14 w-14 rounded-lg border object-cover"
                  style={{ borderColor: "var(--border-strong)" }}
                />
                <button
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className="flex items-end gap-2 rounded-[10px] border px-2.5 py-1.5"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface-solid)" }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void attachFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-colors hover:bg-[rgb(127_127_127/0.1)]"
            style={{ color: "var(--text-muted)" }}
            data-tip="Attach reference image"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} strokeWidth={1.8} />
          </button>
          {/* leading-5 + py-1 = 28px single-line height, matching the 28px
              send button exactly so placeholder/text sit optically centered */}
          <textarea
            className="max-h-32 flex-1 resize-none bg-transparent py-1 text-[13px] leading-5 outline-none"
            placeholder="describe the part…"
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((item) => item.type.startsWith("image/"))
                .map((item) => item.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length > 0) {
                e.preventDefault();
                void attachFiles(files);
              }
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
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px]"
              style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
              onClick={stop}
              data-tip="Stop"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] transition-opacity disabled:opacity-30"
              style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
              onClick={submit}
              disabled={!draft.trim() && attachments.length === 0}
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
  describe_bodies: "Measuring bodies",
  measure_distance: "Measuring distance",
  capture_viewport: "Looking at viewport",
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
