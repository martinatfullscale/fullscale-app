import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";
import mime from "mime-types";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function getBucket() {
  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return storage.bucket(bucketId);
}

/**
 * Configure CORS on the bucket so the browser can PUT directly to resumable
 * upload session URLs at storage.googleapis.com from the app's origin.
 *
 * Without this, the browser's CORS preflight against the resumable session
 * URL fails and XHR surfaces a generic "Network error during storage upload".
 *
 * One-time setup per bucket. Idempotent — safe to call repeatedly.
 */
export async function ensureBucketCors(): Promise<{ origin: string[]; method: string[]; responseHeader: string[]; maxAgeSeconds: number }> {
  const bucket = getBucket();
  const corsConfig = [
    {
      origin: ["*"],
      method: ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
      responseHeader: [
        "Content-Type",
        "Content-Length",
        "Content-Range",
        "Content-Disposition",
        "Authorization",
        "X-Goog-Resumable",
        "X-Goog-Content-Length-Range",
        "x-goog-resumable",
      ],
      maxAgeSeconds: 3600,
    },
  ];
  await bucket.setCorsConfiguration(corsConfig);
  return corsConfig[0];
}

export async function uploadBufferToStorage(
  buffer: Buffer,
  objectKey: string,
  contentType?: string
): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);
  const ct = contentType || mime.lookup(objectKey) || "application/octet-stream";

  await file.save(buffer, { contentType: ct, resumable: false });
  return `/${objectKey.replace(/^public\//, "storage/")}`;
}

export async function uploadFileToStorage(
  localPath: string,
  objectKey: string
): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);
  const contentType = mime.lookup(localPath) || "application/octet-stream";

  const readStream = fs.createReadStream(localPath);
  await new Promise<void>((resolve, reject) => {
    readStream
      .pipe(file.createWriteStream({ contentType, resumable: false }))
      .on("error", reject)
      .on("finish", resolve);
  });

  return `/${objectKey.replace(/^public\//, "storage/")}`;
}

/**
 * Pipe a readable stream straight into Object Storage with no disk roundtrip.
 * For large video uploads this avoids multer's two-pass /tmp write that was
 * stalling client uploads at ~80% on Replit deploy.
 *
 * resumable: false uses a one-shot upload — simpler, fewer moving parts than
 * the chunked resumable session (which silently hangs on Replit's network
 * path with the workload-identity sidecar credentials). The library will
 * still stream chunks as they arrive; "non-resumable" just means no chunked
 * session protocol, not "buffer the whole file in RAM."
 */
export async function uploadStreamToStorage(
  readStream: NodeJS.ReadableStream,
  objectKey: string,
  contentType?: string,
): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);
  const ct = contentType || mime.lookup(objectKey) || "application/octet-stream";

  await new Promise<void>((resolve, reject) => {
    const writeStream = file.createWriteStream({
      contentType: ct,
      resumable: false,
      // Generous timeout for large multi-GB uploads on Replit's network path.
      // Default is ~60s which is too short for anything over a few hundred MB.
      timeout: 30 * 60 * 1000, // 30 minutes
    });
    readStream
      .pipe(writeStream)
      .on("error", reject)
      .on("finish", resolve);
    readStream.on("error", reject);
    writeStream.on("error", reject);
  });

  return `/${objectKey.replace(/^public\//, "storage/")}`;
}

export async function downloadToTempFile(
  objectKey: string,
  tempDir?: string
): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);

  const dir = tempDir || "/tmp/storage-downloads";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const localPath = path.join(dir, path.basename(objectKey));
  await file.download({ destination: localPath });
  return localPath;
}

export async function readFileFromStorage(objectKey: string): Promise<Buffer> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);
  const [contents] = await file.download();
  return contents;
}

export async function fileExistsInStorage(objectKey: string): Promise<boolean> {
  try {
    const bucket = getBucket();
    const file = bucket.file(objectKey);
    const [exists] = await file.exists();
    return exists;
  } catch {
    return false;
  }
}

export async function deleteFromStorage(objectKey: string): Promise<void> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);
  await file.delete({ ignoreNotFound: true });
}

export function storageServeUrl(objectKey: string): string {
  return `/${objectKey.replace(/^public\//, "storage/")}`;
}

export function objectKeyFromServeUrl(serveUrl: string): string {
  return serveUrl.replace(/^\/storage\//, "public/");
}

export function getStorageStream(objectKey: string) {
  const bucket = getBucket();
  const file = bucket.file(objectKey);
  return { file, stream: file.createReadStream() };
}

/**
 * Generate a one-time upload URL for direct client-side upload to Object Storage.
 * The client PUTs the file body directly — the server never touches the bytes.
 *
 * On Replit, ADC is provided via the workload-identity sidecar — there is NO
 * `client_email` available locally, so v4 signed-URL local signing fails with
 * "Cannot sign data without `client_email`". Instead we create a GCS resumable
 * upload session: ADC is sufficient to AUTHORIZE the session creation, and the
 * returned session URL accepts a single full-body PUT from the client without
 * any further signing. Same client semantics as a presigned PUT URL.
 *
 * Returns { signedUrl, objectKey, serveUrl }. The `signedUrl` field name is
 * preserved for client-side back-compat.
 */
export async function getSignedUploadUrl(
  objectKey: string,
  contentType: string,
  _expiresInMinutes: number = 30
): Promise<{ signedUrl: string; objectKey: string; serveUrl: string }> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);

  // createResumableUpload returns a session URL the client can PUT to. The
  // entire file can be sent in a single PUT — chunking is optional.
  // Content-Type is bound to the session at creation, but we also re-send it
  // in the client PUT for safety.
  const [signedUrl] = await file.createResumableUpload({
    metadata: { contentType },
  });

  return {
    signedUrl,
    objectKey,
    serveUrl: storageServeUrl(objectKey),
  };
}
