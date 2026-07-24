import { create } from "zustand";
import { WebsocketProvider } from "y-websocket";
import { ydoc } from "./ydoc.ts";
import { useEditorStore } from "./document-store.ts";
import { getBlob } from "../lib/opfs.ts";
import { pushRelayBlob, setRelayHttpBase } from "../lib/blob-sync.ts";

/**
 * Realtime collaboration — y-websocket provider + awareness (presence).
 *
 * Only the feature document syncs; geometry regenerates locally on every
 * client (deterministic from the doc), so payloads stay tiny. Remote edits
 * arrive as Y transactions and flow through the exact same pipeline as local
 * ones (ydoc "update" → snapshot → regen). The UndoManager only tracks
 * LOCAL_ORIGIN, so ⌘Z never reverts a collaborator's work.
 */

const DEFAULT_RELAY = "ws://localhost:1234";
const COLORS = [
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
  "#eab308",
  "#14b8a6",
];

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  /** Persistent entity names the peer currently has selected. */
  selection: string[];
}

interface CollabState {
  status: "off" | "connecting" | "connected";
  room: string | null;
  peers: Peer[];
  userName: string;
  connect(room: string): void;
  disconnect(): void;
  setUserName(name: string): void;
}

function relayUrl(): string {
  return localStorage.getItem("voltcad.relay") ?? DEFAULT_RELAY;
}

function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http").replace(/\/$/, "");
}

function defaultUserName(): string {
  const saved = localStorage.getItem("voltcad.userName");
  if (saved) return saved;
  const name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("voltcad.userName", name);
  return name;
}

/** Push every blob referenced by the doc so joining peers can regen imports. */
async function pushReferencedBlobs(): Promise<void> {
  const doc = useEditorStore.getState().doc;
  for (const f of doc.features) {
    if (f.type !== "import") continue;
    const hash = (f.params as { blobHash?: string }).blobHash;
    if (!hash) continue;
    const content = await getBlob(hash);
    if (content !== null) await pushRelayBlob(hash, content);
  }
}

let provider: WebsocketProvider | null = null;
let unsubscribeSelection: (() => void) | null = null;

export const useCollabStore = create<CollabState>((set, get) => ({
  status: "off",
  room: null,
  peers: [],
  userName: typeof localStorage === "undefined" ? "Guest" : defaultUserName(),

  connect(room) {
    if (provider) get().disconnect();
    const url = relayUrl();
    set({ status: "connecting", room });
    setRelayHttpBase(httpBase(url));

    provider = new WebsocketProvider(url, `voltcad-${room}`, ydoc);
    const awareness = provider.awareness;
    awareness.setLocalState({
      user: {
        name: get().userName,
        color: COLORS[awareness.clientID % COLORS.length],
      },
      selection: useEditorStore.getState().selection.map((s) => s.name),
    });

    provider.on("status", ({ status }: { status: string }) => {
      set({ status: status === "connected" ? "connected" : "connecting" });
      if (status === "connected") void pushReferencedBlobs();
    });

    awareness.on("change", () => {
      const peers: Peer[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID || !state.user) continue;
        peers.push({
          clientId,
          name: state.user.name ?? "Guest",
          color: state.user.color ?? COLORS[clientId % COLORS.length],
          selection: state.selection ?? [],
        });
      }
      set({ peers });
    });

    // broadcast local selection changes to peers
    unsubscribeSelection = useEditorStore.subscribe((s, prev) => {
      if (s.selection !== prev.selection) {
        provider?.awareness.setLocalStateField(
          "selection",
          s.selection.map((sel) => sel.name),
        );
      }
    });
  },

  disconnect() {
    unsubscribeSelection?.();
    unsubscribeSelection = null;
    provider?.destroy();
    provider = null;
    setRelayHttpBase(null);
    set({ status: "off", room: null, peers: [] });
  },

  setUserName(name) {
    localStorage.setItem("voltcad.userName", name);
    set({ userName: name });
    provider?.awareness.setLocalStateField("user", {
      name,
      color: COLORS[provider.awareness.clientID % COLORS.length],
    });
  },
}));
