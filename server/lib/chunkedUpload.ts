// Chunked upload session management.
//
// The Replit deploy proxy kills request bodies after ~5 minutes. Multi-GB
// video uploads at our observed 4.8 MB/s throughput exceed that window —
// they cap at ~1.4 GB before the proxy aborts the connection. The fix:
// chunk the file client-side (5-10 MB chunks), send each chunk as its
// own short-lived HTTP request, server relays each chunk into a GCS
// resumable upload session it holds open. Each chunk request takes
// ~2 seconds and never approaches any proxy timeout.
//
// Session storage is in-memory per-process. If the Replit container
// restarts mid-upload, the session is lost and the client has to start
// over. Acceptable for now — uploads are interactive and rare.

import { createResumableSession, storageServeUrl } from "./objectStorage";

export interface ChunkedUploadSession {
  sessionId: string;
  sessionUrl: string;
  objectKey: string;
  serveUrl: string;
  filename: string;
  contentType: string;
  totalSize: number;
  bytesReceived: number;
  createdAt: number;
  lastActivityAt: number;
  finalized: boolean;
}

const SESSIONS = new Map<string, ChunkedUploadSession>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1hr — generous; chunked upload should finish well before this
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function newSessionId(): string {
  return `cu-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function createUploadSession(opts: {
  filename: string;
  contentType: string;
  totalSize: number;
}): Promise<ChunkedUploadSession> {
  const safeName = opts.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectKey = `public/videos/${Date.now()}-${safeName}`;
  const { sessionUrl, serveUrl } = await createResumableSession(objectKey, opts.contentType);
  const sessionId = newSessionId();
  const session: ChunkedUploadSession = {
    sessionId,
    sessionUrl,
    objectKey,
    serveUrl,
    filename: opts.filename,
    contentType: opts.contentType,
    totalSize: opts.totalSize,
    bytesReceived: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    finalized: false,
  };
  SESSIONS.set(sessionId, session);
  console.log(`[ChunkedUpload] Created session ${sessionId} for ${opts.filename} (${(opts.totalSize / 1024 / 1024).toFixed(1)} MB) → ${objectKey}`);
  return session;
}

export function getUploadSession(sessionId: string): ChunkedUploadSession | undefined {
  return SESSIONS.get(sessionId);
}

/**
 * Relay a chunk into the GCS resumable session. The chunk is uploaded via
 * a PUT to the session URL with a Content-Range header indicating which
 * byte range this chunk covers. GCS responds with 308 (Resume Incomplete)
 * when more chunks are expected, or 200/201 when the upload finalizes.
 *
 * `isFinal` should be true for the LAST chunk so the Content-Range total
 * is set correctly; otherwise the total is "*" (unknown so far).
 */
export async function relayChunkToGcs(opts: {
  session: ChunkedUploadSession;
  chunk: Buffer;
  startByte: number;
  isFinal: boolean;
}): Promise<{ status: number; bytesReceivedNow: number; finalized: boolean }> {
  const { session, chunk, startByte, isFinal } = opts;
  const endByte = startByte + chunk.length - 1;
  const total = isFinal ? String(startByte + chunk.length) : "*";
  const contentRange = `bytes ${startByte}-${endByte}/${total}`;

  const res = await fetch(session.sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(chunk.length),
      "Content-Range": contentRange,
    },
    // Buffer is a Uint8Array subclass — fetch accepts it.
    body: chunk as any,
  });

  session.bytesReceived = startByte + chunk.length;
  session.lastActivityAt = Date.now();

  // 308 = Resume Incomplete (more chunks expected). 200/201 = upload done.
  // Anything else is an error from GCS.
  if (res.status === 308) {
    return { status: 308, bytesReceivedNow: session.bytesReceived, finalized: false };
  }
  if (res.status === 200 || res.status === 201) {
    session.finalized = true;
    return { status: res.status, bytesReceivedNow: session.bytesReceived, finalized: true };
  }
  const body = await res.text().catch(() => "");
  throw new Error(`GCS chunk relay failed: status=${res.status}, body=${body.slice(0, 300)}`);
}

export function deleteUploadSession(sessionId: string): void {
  SESSIONS.delete(sessionId);
}

function sweep() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let removed = 0;
  for (const [id, s] of SESSIONS.entries()) {
    if (s.lastActivityAt < cutoff) {
      SESSIONS.delete(id);
      removed++;
    }
  }
  if (removed > 0) console.log(`[ChunkedUpload] Swept ${removed} stale upload session(s)`);
}

setInterval(sweep, SWEEP_INTERVAL_MS).unref();

export function _serveUrlFor(objectKey: string): string {
  return storageServeUrl(objectKey);
}
