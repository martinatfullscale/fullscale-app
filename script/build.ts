import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  let buildCommit = "unknown";
  try {
    const { execSync } = await import("child_process");
    buildCommit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout (or git missing) — the stamp is a nicety, never a
    // build blocker.
  }
  console.log(`building server... (commit ${buildCommit})`);

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
      // Stamp the built commit into the bundle so the running deployment
      // can state WHICH code it is. Replit's per-line deployment id looks
      // like a short SHA but isn't one, and "did my fix deploy?" cost
      // several diagnosis cycles before this existed.
      "process.env.BUILD_COMMIT": JSON.stringify(buildCommit),
    },
    // Minify is the memory hog during esbuild — on Replit's deploy
    // container this was OOMing silently and the deploy step would
    // fail with "There was an issue publishing your artifact" without
    // any error visible in logs. Bundle-only (no minify) saves the
    // most memory; the resulting dist/index.cjs is ~2x bigger but
    // we're shipping a CJS bundle to a Node runtime, not over the
    // wire to a browser, so size is a non-concern.
    minify: false,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
