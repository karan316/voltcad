import type { PartDocument } from "@voltcad/model-api";
import { partDocumentSchema } from "@voltcad/model-api";

/**
 * OPFS (Origin Private File System) persistence.
 *
 * Documents are saved locally in the browser's private filesystem — no server
 * required, survives reloads, and is fast enough to autosave on every edit.
 * This is also where Yjs update logs will live once P2P collaboration lands.
 */

const DIR = "documents";
const CURRENT = "current.json";

function opfsAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

async function documentsDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable()) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function saveDocumentToOpfs(doc: PartDocument): Promise<void> {
  const dir = await documentsDir();
  if (!dir) return;
  const file = await dir.getFileHandle(CURRENT, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(doc));
  await writable.close();
}

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

/** Debounced autosave helper (one timer app-wide). */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function autosaveDocument(doc: PartDocument, delayMs = 400): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveDocumentToOpfs(doc), delayMs);
}
