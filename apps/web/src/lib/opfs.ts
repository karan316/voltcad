import type { PartDocument } from "@voltcad/model-api";
import { partDocumentSchema } from "@voltcad/model-api";

/**
 * OPFS (Origin Private File System) persistence.
 *
 * The document is persisted as a Yjs binary update (`current.ydoc`) — the
 * same encoding that will flow over the wire for P2P collaboration. Legacy
 * plain-JSON saves (`current.json`) are still readable for migration.
 *
 * Large payloads (imported STEP/IGES text) live outside the document in a
 * content-addressed blob store (`blobs/<sha256>`), so the CRDT stays small.
 */

const DIR = "documents";
const CURRENT = "current.json";
const CURRENT_YDOC = "current.ydoc";
const BLOB_DIR = "blobs";

function opfsAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

async function subDir(name: string): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable()) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

async function documentsDir(): Promise<FileSystemDirectoryHandle | null> {
  return subDir(DIR);
}

// ------------------------------------------------------------- Yjs document

export async function saveYDocToOpfs(update: Uint8Array): Promise<void> {
  const dir = await documentsDir();
  if (!dir) return;
  const file = await dir.getFileHandle(CURRENT_YDOC, { create: true });
  const writable = await file.createWritable();
  await writable.write(update as unknown as BufferSource);
  await writable.close();
}

export async function loadYDocFromOpfs(): Promise<Uint8Array | null> {
  try {
    const dir = await documentsDir();
    if (!dir) return null;
    const file = await dir.getFileHandle(CURRENT_YDOC);
    const buf = await (await file.getFile()).arrayBuffer();
    return buf.byteLength > 0 ? new Uint8Array(buf) : null;
  } catch {
    return null; // no saved ydoc yet
  }
}

/** Debounced autosave of the CRDT state (one timer app-wide). */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function autosaveYDoc(encode: () => Uint8Array, delayMs = 400): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveYDocToOpfs(encode()), delayMs);
}

// ------------------------------------------------------- legacy JSON loader

/** Migration path: read a pre-CRDT plain-JSON document if one exists. */
export async function loadDocumentFromOpfs(): Promise<PartDocument | null> {
  try {
    const dir = await documentsDir();
    if (!dir) return null;
    const file = await dir.getFileHandle(CURRENT);
    const contents = await (await file.getFile()).text();
    // Validate — never trust persisted data blindly (schema may have moved on).
    const parsed = partDocumentSchema.safeParse(JSON.parse(contents));
    return parsed.success ? (parsed.data as PartDocument) : null;
  } catch {
    return null; // no saved document yet
  }
}

// ------------------------------------------------------------- blob store

const textEncoder = new TextEncoder();

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** In-memory cache so regen inflation doesn't hit OPFS every pass. */
const blobCache = new Map<string, string>();

/** Store content, return its sha256 key. Idempotent — same content, same key. */
export async function putBlob(content: string): Promise<string> {
  const bytes = textEncoder.encode(content);
  const hash = await sha256Hex(bytes);
  blobCache.set(hash, content);
  const dir = await subDir(BLOB_DIR);
  if (dir) {
    try {
      await dir.getFileHandle(hash); // already stored — content-addressed
    } catch {
      const file = await dir.getFileHandle(hash, { create: true });
      const writable = await file.createWritable();
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();
    }
  }
  return hash;
}

export async function getBlob(hash: string): Promise<string | null> {
  const cached = blobCache.get(hash);
  if (cached !== undefined) return cached;
  try {
    const dir = await subDir(BLOB_DIR);
    if (!dir) return null;
    const file = await dir.getFileHandle(hash);
    const text = await (await file.getFile()).text();
    blobCache.set(hash, text);
    return text;
  } catch {
    return null;
  }
}
