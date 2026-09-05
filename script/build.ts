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
    // SHA + date + subject: Replit auto-commits on Publish ("Published your
    // App"), so the deployed SHA is often one THEY made and never appears in
    // the GitHub branch — the date and subject make it obvious at a glance
    // whether the running build is today's work or last week's.
    buildCommit = execSync('git log -1 --format="%h %cd %s" --date=format:"%Y-%m-%d %H:%M"', { encoding: "utf8" })
      .trim()
      .slice(0, 120);
  } catch {
    // Not a git checkout (or git missing) — the stamp is a nicety, never a
    // build blocker.
  }
  console.log(`building server... (${buildCommit})`);

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

  // Face-detection child. TensorFlow inference runs in a forked process so
  // its synchronous compute can't block the server's event loop (see
  // faceTracker.ts); the fork target has to exist as its own bundle next to
  // index.cjs. Same externals — tfjs-node and sharp are native and resolve
  // from node_modules at runtime either way.
  console.log("building face-detection child...");
  await esbuild({
    entryPoints: ["server/lib/remix/faceDetectChild.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/facetrack-child.cjs",
    define: { "process.env.NODE_ENV": '"production"' },
    minify: false,
    external: externals,
    logLevel: "info",
  });
}

/**
 * Push the schema as part of the BUILD, not as a separate manual step.
 *
 * The deploy build runs in the deployment environment, so it holds the
 * deployment's own DATABASE_URL — which is the whole reason this belongs
 * here. Running `npm run db:push` from the workspace shell pushes to the
 * WORKSPACE database and reports "no changes" while the deployed database
 * silently falls behind; that mismatch caused three outages in one day,
 * each presenting as "the site is laggy and everything spins" because
 * Drizzle names every column explicitly and a missing one fails every
 * query touching that table.
 *
 * Non-interactive by construction:
 *   - no --force, so a genuinely destructive statement is REFUSED rather
 *     than auto-approved. Additive changes (the normal case) apply cleanly;
 *     a drop/rename fails the build loudly, which is the correct outcome —
 *     that decision should never be made by a deploy script.
 *   - a hard timeout, so a prompt or a hung connection can never wedge the
 *     deploy indefinitely.
 *
 * Skips cleanly when DATABASE_URL is absent (a CI build with no database)
 * and when DB_PUSH_ON_BUILD=false, so the step is always escapable.
 */
async function pushSchema(): Promise<void> {
  if (process.env.DB_PUSH_ON_BUILD === "false") {
    console.log("[build] schema push skipped (DB_PUSH_ON_BUILD=false)");
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.log("[build] schema push skipped — no DATABASE_URL in this environment");
    return;
  }
  const { spawn } = await import("child_process");
  console.log("[build] pushing schema to this environment's database...");

  // Output is CAPTURED, not inherited, because drizzle-kit's exit code is not
  // trustworthy: pointed at an unreachable database it prints ECONNREFUSED and
  // still exits 0. Verified directly — trusting the code produced a confident
  // "schema push complete" on a push that never connected, which is the exact
  // class of false success this whole incident was about. Success is confirmed
  // from drizzle's own completion markers instead, and the raw output is echoed
  // either way so the deploy log still shows everything it said.
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const proc = spawn("npx", ["drizzle-kit", "push", "--verbose"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let buf = "";
    proc.stdout.on("data", (d) => { const s = d.toString(); buf += s; process.stdout.write(s); });
    proc.stderr.on("data", (d) => { const s = d.toString(); buf += s; process.stderr.write(s); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("drizzle-kit push timed out after 5 minutes — it may be waiting on an interactive prompt"));
    }, 5 * 60 * 1000);
    proc.on("close", (c) => { clearTimeout(timer); resolve({ code: c, output: buf }); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });

  // drizzle-kit says one of these on a push that actually reached the database.
  const reachedDb = /No changes detected|Changes applied|changes applied/i.test(output);
  const errored = /\bError\b|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|password authentication failed/i.test(output);
  if (code !== 0 || errored || !reachedDb) {
    throw new Error(
      `drizzle-kit push did not confirm success (exit ${code}` +
      `${errored ? ", error in output" : ""}${reachedDb ? "" : ", no completion marker"}). ` +
      `Last output: ${output.trim().split("\n").slice(-3).join(" / ").slice(0, 300)}`,
    );
  }
  console.log("[build] schema push complete");
}

buildAll()
  .then(async () => {
    // A schema-push failure must NOT fail the deploy. drizzle-kit is a dev
    // dependency and a production-only install would not have it; failing
    // here would turn a degraded database into a site that does not deploy
    // at all — strictly worse. The app's boot-time schema check and the
    // admin repair endpoint are the backstop, so a miss here is loud and
    // recoverable rather than fatal.
    try {
      await pushSchema();
    } catch (err: any) {
      const bar = "=".repeat(72);
      console.error(`\n${bar}`);
      console.error("[build] SCHEMA PUSH FAILED — the build itself succeeded.");
      console.error(`[build] ${err?.message ?? err}`);
      console.error("[build] The deployed app will log its exact schema drift at boot");
      console.error("[build] ([SchemaCheck]) and can repair itself from the admin UI.");
      console.error(`${bar}\n`);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
