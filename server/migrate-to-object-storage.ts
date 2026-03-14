import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";
import mime from "mime-types";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID!;

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

const bucket = storage.bucket(BUCKET_ID);

async function uploadFile(localPath: string, objectKey: string): Promise<boolean> {
  try {
    const contentType = mime.lookup(localPath) || "application/octet-stream";
    const fileStream = fs.createReadStream(localPath);
    const file = bucket.file(objectKey);
    
    await new Promise<void>((resolve, reject) => {
      fileStream
        .pipe(file.createWriteStream({ contentType, resumable: false }))
        .on("error", reject)
        .on("finish", resolve);
    });
    
    console.log(`  OK: ${localPath} -> ${objectKey}`);
    return true;
  } catch (err: any) {
    console.error(`  FAIL: ${localPath} -> ${objectKey}: ${err.message}`);
    return false;
  }
}

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  const baseDir = process.cwd();
  const mapping: Array<{ localPath: string; objectKey: string; servePath: string }> = [];
  let uploaded = 0;
  let failed = 0;

  console.log("=== Phase 1: Migrating videos ===");
  const videoFiles = [
    { local: "public/hero_video.mp4", key: "public/videos/hero_video.mp4" },
    { local: "public/many_jobs.mov", key: "public/videos/many_jobs.mov" },
    { local: "public/videos/test_video2.mov", key: "public/videos/test_video2.mov" },
    { local: "public/videos/TQT-S1EP1.mov", key: "public/videos/TQT-S1EP1.mov" },
    { local: "public/uploads/TQT-S1EP16.mp4", key: "public/videos/TQT-S1EP16.mp4" },
  ];

  for (const v of videoFiles) {
    const fullLocal = path.join(baseDir, v.local);
    if (fs.existsSync(fullLocal)) {
      const ok = await uploadFile(fullLocal, v.key);
      if (ok) {
        uploaded++;
        mapping.push({ localPath: v.local, objectKey: v.key, servePath: `/storage/videos/${path.basename(v.key)}` });
      } else failed++;
    } else {
      console.log(`  SKIP (not found): ${v.local}`);
    }
  }

  console.log("\n=== Phase 2: Migrating thumbnails ===");
  const thumbDir = path.join(baseDir, "public/thumbnails");
  if (fs.existsSync(thumbDir)) {
    const thumbFiles = await walkDir(thumbDir);
    for (const f of thumbFiles) {
      const relativePath = path.relative(path.join(baseDir, "public"), f);
      const objectKey = `public/${relativePath}`;
      const ok = await uploadFile(f, objectKey);
      if (ok) {
        uploaded++;
        mapping.push({ localPath: `public/${relativePath}`, objectKey, servePath: `/storage/${relativePath}` });
      } else failed++;
    }
  }

  console.log("\n=== Phase 3: Migrating frames ===");
  const framesDir = path.join(baseDir, "public/uploads/frames");
  if (fs.existsSync(framesDir)) {
    const frameFiles = await walkDir(framesDir);
    for (const f of frameFiles) {
      const relativePath = path.relative(path.join(baseDir, "public/uploads"), f);
      const objectKey = `public/uploads/${relativePath}`;
      const ok = await uploadFile(f, objectKey);
      if (ok) {
        uploaded++;
        mapping.push({ localPath: `public/uploads/${relativePath}`, objectKey, servePath: `/storage/uploads/${relativePath}` });
      } else failed++;
    }
  }

  console.log("\n=== Phase 4: Migrating exports ===");
  const exportsDir = path.join(baseDir, "public/exports");
  if (fs.existsSync(exportsDir)) {
    const exportFiles = await walkDir(exportsDir);
    for (const f of exportFiles) {
      const relativePath = path.relative(path.join(baseDir, "public"), f);
      const objectKey = `public/${relativePath}`;
      const ok = await uploadFile(f, objectKey);
      if (ok) {
        uploaded++;
        mapping.push({ localPath: `public/${relativePath}`, objectKey, servePath: `/storage/${relativePath}` });
      } else failed++;
    }
  }

  console.log("\n=== Phase 5: Migrating product uploads ===");
  const productsDir = path.join(baseDir, "public/uploads/products");
  if (fs.existsSync(productsDir)) {
    const productFiles = await walkDir(productsDir);
    for (const f of productFiles) {
      const relativePath = path.relative(path.join(baseDir, "public/uploads"), f);
      const objectKey = `public/uploads/${relativePath}`;
      const ok = await uploadFile(f, objectKey);
      if (ok) {
        uploaded++;
        mapping.push({ localPath: `public/uploads/${relativePath}`, objectKey, servePath: `/storage/uploads/${relativePath}` });
      } else failed++;
    }
  }

  console.log("\n=== Phase 6: Migrating default thumbnail ===");
  const defaultThumb = path.join(baseDir, "public/uploads/default-thumbnail.png");
  if (fs.existsSync(defaultThumb)) {
    const ok = await uploadFile(defaultThumb, "public/uploads/default-thumbnail.png");
    if (ok) {
      uploaded++;
      mapping.push({ localPath: "public/uploads/default-thumbnail.png", objectKey: "public/uploads/default-thumbnail.png", servePath: "/storage/uploads/default-thumbnail.png" });
    } else failed++;
  }

  console.log(`\n=== COMPLETE ===`);
  console.log(`Uploaded: ${uploaded}, Failed: ${failed}`);
  
  fs.writeFileSync(path.join(baseDir, "server/migration-file-mapping.json"), JSON.stringify(mapping, null, 2));
  console.log("Mapping saved to server/migration-file-mapping.json");
}

main().catch(console.error);
