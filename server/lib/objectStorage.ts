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
 * Generate a signed URL for direct client-side upload to Object Storage.
 * The client PUTs the file directly — the server never touches it.
 *
 * Returns { signedUrl, objectKey, serveUrl }.
 */
export async function getSignedUploadUrl(
  objectKey: string,
  contentType: string,
  expiresInMinutes: number = 30
): Promise<{ signedUrl: string; objectKey: string; serveUrl: string }> {
  const bucket = getBucket();
  const file = bucket.file(objectKey);

  const [signedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + expiresInMinutes * 60 * 1000,
    contentType,
  });

  return {
    signedUrl,
    objectKey,
    serveUrl: storageServeUrl(objectKey),
  };
}
