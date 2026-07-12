import { create } from "zustand";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createCadTools } from "../lib/ai/tools.ts";
import { aiConfigured, loadAiSettings } from "../lib/ai/settings.ts";
import { useEditorStore } from "./document-store.ts";

/**
 * AI copilot chat — streams directly from the browser to the user's
 * OpenAI-compatible endpoint (key never touches a VoltCAD server).
 *
 * Rendering model: each assistant message is a list of segments (text and
 * tool cards) appended in stream order. The model-facing conversation
 * (`modelHistory`) is kept separately so tool calls/results replay correctly
 * across turns.
 */

export type ChatSegment =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output?: unknown;
      state: "running" | "done" | "error";
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  segments: ChatSegment[];
}

interface ChatState {
  messages: ChatMessage[];
  status: "idle" | "working";
  error: string | null;
  send(text: string): Promise<void>;
  stop(): void;
  clear(): void;
}

const SYSTEM_PROMPT = `You are the VoltCAD copilot — an expert mechanical CAD engineer operating a parametric, history-based modeler (like Onshape) through tools.

CORE MODEL
- Units: millimeters; angles in degrees. Coordinate system is right-handed, Z up.
- Datum planes: XY (normal +Z), XZ (normal -Y), YZ (normal +X). Sketches are 2D (u,v) on a plane; optional "offset" shifts along the normal. A sketch may also live on a planar FACE of an existing body: {"kind":"face","face":"<entity name>"} — (u,v) are then in that face's plane and extrude direction is outward.
- Workflow: a sketch's closed loops become profile faces → extrude/revolve creates solids (op: "new" first body, "add" fuse, "cut" subtract, "intersect") → fillet/chamfer dress edges. Also available: shell (hollow, remove faces), linear_pattern/circular_pattern (copies along direction / around axis), mirror (about datum plane), boolean (between two named bodies; tool consumed).
- A loop nested inside another loop becomes a hole automatically.
- Dimensions accept expressions referencing named parameters, e.g. "thickness * 2". Prefer creating parameters (set_parameter) for dimensions the user will likely tweak.

ENTITY NAMING (persistent, survives edits)
- Faces: "<featureId>/side:<sketchEntityId>" (lateral), "<featureId>/cap:start" / "cap:end" (extrude caps), "<featureId>/face:<n>" (fallback).
- Edges: named by their two adjacent faces joined with "|", e.g. "ext1/cap:end|ext1/side:rect1/e0".
- Edge queries for fillet/chamfer: {"kind":"named","names":[...]} for specific edges; {"kind":"created","feature":"<id>","entity":"edge"} for all edges of a feature; {"kind":"all","entity":"edge"} for everything; union/intersect to combine.

RULES
- Call get_model_state before modifying an existing model.
- When adding a sketch and its extrude in ONE add_features call, give the sketch an explicit "id" and reference it from the extrude's "sketch" field.
- When the user says "this" or "the selected …", use the CURRENT SELECTION from context.
- After every mutation, check the returned statuses. If a feature failed, diagnose from the error code and fix it (e.g. FILLET_TOO_LARGE → smaller radius; OPEN_PROFILE → sketch loops don't close).
- Keep sketches simple: rectangle/circle/line/arc. Rectangle corners are opposite corners. Arcs run CCW from startAngle to endAngle.
- Be concise. Briefly state your plan, execute it with tools, then summarize what was built and the key dimensions/parameters. Do not paste raw JSON at the user.`;

function contextMessage(): string {
  const s = useEditorStore.getState();
  const features = s.doc.features
    .map((f) => `${f.id} [${f.type}] "${f.name}" ${s.statuses[f.id]?.status ?? ""}`)
    .join("\n");
  const params = Object.entries(s.doc.parameters)
    .map(([k, v]) => `${k} = ${v}`)
    .join(", ");
  const sel = s.selection.map((x) => `${x.kind} ${x.name}`).join(", ");
  return `CURRENT DOCUMENT "${s.doc.name}"
Features:
${features || "(empty)"}
Parameters: ${params || "(none)"}
CURRENT SELECTION: ${sel || "(nothing selected)"}`;
}

let abortController: AbortController | null = null;
/** Model-facing history including tool calls/results (not rendered). */
let modelHistory: ModelMessage[] = [];
let idCounter = 0;
const nextId = () => `msg_${++idCounter}`;

export const useChatStore = create<ChatState>((set, get) => {
  /** Mutate the last (assistant) message's segments immutably. */
  function updateAssistant(fn: (segments: ChatSegment[]) => ChatSegment[]): void {
    set((state) => {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant") return {};
      messages[messages.length - 1] = { ...last, segments: fn(last.segments) };
      return { messages };
    });
  }

  return {
    messages: [],
    status: "idle",
    error: null,

    async send(text: string) {
      if (get().status === "working" || !text.trim()) return;
      const settings = loadAiSettings();
      if (!aiConfigured(settings)) {
        set({ error: "Configure your AI endpoint and API key in settings first." });
        return;
      }
      set({
        error: null,
        status: "working",
        messages: [
          ...get().messages,
          { id: nextId(), role: "user", segments: [{ kind: "text", text }] },
          { id: nextId(), role: "assistant", segments: [] },
        ],
      });

      modelHistory.push({ role: "user", content: text });
      abortController = new AbortController();

      try {
        const provider = createOpenAI({
          baseURL: settings.baseUrl,
          apiKey: settings.apiKey,
        });
        const result = streamText({
          model: provider.chat(settings.model),
          system: `${SYSTEM_PROMPT}\n\n${contextMessage()}`,
          messages: modelHistory,
          tools: createCadTools(),
          stopWhen: stepCountIs(12),
          abortSignal: abortController.signal,
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta": {
              const delta =
                (part as { text?: string; delta?: string }).text ??
                (part as { delta?: string }).delta ??
                "";
              updateAssistant((segs) => {
                const last = segs[segs.length - 1];
                if (last?.kind === "text")
                  return [...segs.slice(0, -1), { kind: "text", text: last.text + delta }];
                return [...segs, { kind: "text", text: delta }];
              });
              break;
            }
            case "tool-call":
              updateAssistant((segs) => [
                ...segs,
                {
                  kind: "tool",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                  state: "running",
                },
              ]);
              break;
            case "tool-result":
              updateAssistant((segs) =>
                segs.map((sg) =>
                  sg.kind === "tool" && sg.toolCallId === part.toolCallId
                    ? { ...sg, output: (part as { output?: unknown }).output, state: "done" }
                    : sg,
                ),
              );
              break;
            case "tool-error":
              updateAssistant((segs) =>
                segs.map((sg) =>
                  sg.kind === "tool" && sg.toolCallId === part.toolCallId
                    ? { ...sg, output: String(part.error), state: "error" }
                    : sg,
                ),
              );
              break;
            case "error":
              throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }

        // persist the full step trail (assistant + tool messages) for next turn
        const response = await result.response;
        modelHistory.push(...response.messages);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          set({ error: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        abortController = null;
        set({ status: "idle" });
      }
    },

    stop() {
      abortController?.abort();
    },

    clear() {
      modelHistory = [];
      set({ messages: [], error: null });
    },
  };
});
