/**
 * VoltCAD collaboration relay.
 *
 * - WebSocket: y-websocket wire protocol (sync + awareness), implemented
 *   directly on yjs 13 + y-protocols so client and server share one Yjs
 *   major version. Rooms are keyed by URL path.
 * - HTTP:      content-addressed blob exchange for imported STEP/IGES payloads
 *              (GET/PUT /blobs/<sha256>) so large files never enter the CRDT.
 *
 * Run: node scripts/collab-relay.mjs   (PORT env, default 1234)
 * Blobs persist on disk under scripts/.collab-blobs/.
 */
import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const PORT = Number(process.env.PORT ?? 1234);
const BLOB_DIR = join(dirname(fileURLToPath(import.meta.url)), ".collab-blobs");
mkdirSync(BLOB_DIR, { recursive: true });

// ---------------------------------------------------------------- rooms

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** @type {Map<string, {doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<import("ws").WebSocket, Set<number>>}>} */
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (room) return room;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  room = { doc, awareness, conns: new Map() };

  // broadcast doc updates to every connection in the room
  doc.on("update", (update) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    broadcast(room, encoding.toUint8Array(enc));
  });

  // broadcast awareness changes
  awareness.on("update", ({ added, updated, removed }) => {
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    broadcast(room, encoding.toUint8Array(enc));
  });

  rooms.set(name, room);
  return room;
}

function broadcast(room, message) {
  for (const conn of room.conns.keys()) {
    if (conn.readyState === conn.OPEN) conn.send(message);
  }
}

function handleConnection(conn, roomName) {
  const room = getRoom(roomName);
  room.conns.set(conn, new Set());
  conn.binaryType = "arraybuffer";

  conn.on("message", (data) => {
    try {
      const message = new Uint8Array(data);
      const dec = decoding.createDecoder(message);
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
        if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        const update = decoding.readVarUint8Array(dec);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn);
        // remember which clientIDs this socket owns, to clean up on close
        const ids = room.conns.get(conn);
        if (ids) {
          const awDec = decoding.createDecoder(update);
          const n = decoding.readVarUint(awDec);
          for (let i = 0; i < n; i++) {
            ids.add(decoding.readVarUint(awDec));
            decoding.readVarUint(awDec); // clock
            decoding.readVarString(awDec); // state json
          }
        }
      }
    } catch (e) {
      console.error("[voltcad-relay] message error:", e.message);
    }
  });

  conn.on("close", () => {
    const ids = room.conns.get(conn);
    room.conns.delete(conn);
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
    }
  });

  // handshake: sync step 1 + current awareness snapshot
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, room.doc);
  conn.send(encoding.toUint8Array(enc));
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awEnc = encoding.createEncoder();
    encoding.writeVarUint(awEnc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      awEnc,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
    );
    conn.send(encoding.toUint8Array(awEnc));
  }
}

// ---------------------------------------------------------------- http

const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const match = url.pathname.match(/^\/blobs\/([0-9a-f]{64})$/);
  if (!match) return void res.writeHead(404).end("not found");
  const hash = match[1];
  if (!HASH_RE.test(hash)) return void res.writeHead(400).end("bad hash");
  const file = join(BLOB_DIR, hash); // hash is validated hex — no traversal

  if (req.method === "GET") {
    if (!existsSync(file)) return void res.writeHead(404).end("no such blob");
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    return void res.end(readFileSync(file));
  }

  if (req.method === "PUT") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BLOB_BYTES) {
        res.writeHead(413).end("too large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      if (!existsSync(file)) writeFileSync(file, Buffer.concat(chunks));
      res.writeHead(200).end("ok"); // idempotent — content-addressed
    });
    return;
  }

  res.writeHead(405).end("method not allowed");
});

const wss = new WebSocketServer({ server });
wss.on("connection", (conn, req) => {
  const room = decodeURIComponent(
    new URL(req.url ?? "/", "http://x").pathname.replace(/^\//, "") || "default",
  );
  handleConnection(conn, room);
});

server.listen(PORT, () => {
  console.log(`[voltcad-relay] ws+http on :${PORT}  blobs → ${BLOB_DIR}`);
});
