/**
 * Headless GLB renderer.
 *
 * Goal: take a GLB mesh URL (from TRELLIS / Hunyuan3D / future image-to-3D
 * models) plus scene-derived camera + lighting params, return a transparent-bg
 * PNG of the product rendered from that angle.
 *
 * Why this exists: fal.ai's image-to-3D endpoints (trellis, hunyuan3d/v2)
 * return GLB meshes ONLY — no preview image, no turnaround video. Without a
 * server-side renderer, the harmonize pipeline silently falls back to
 * compositing the original 2D input image, defeating the point of paying
 * ~100s of inference latency. With this module, the same mesh becomes a
 * scene-aware render: yaw/pitch matched to the placement surface, key light
 * matched to the scene's lighting direction.
 *
 * Stack: puppeteer + Chromium (SwiftShader software WebGL) + three.js.
 * No GPU required — runs fine on Replit's standard container. Bundled
 * Chromium downloads at npm install. Single browser instance is reused
 * across renders to keep per-call cost low (~1–3s warm, ~5–10s cold).
 *
 * Inputs come from the existing harmonize signal stack:
 *   - yawDeg / pitchDeg: from estimateSceneAngleFromDepth() (depth analysis)
 *   - lightDir: from input.lightingDirection (string like "top-left")
 *   - lightIntensity: from input.lightingIntensity
 *
 * Output: 1024×1024 PNG Buffer with alpha channel. Downstream pipeline can
 * skip the BiRefNet bg-removal step since the canvas already has transparent
 * pixels outside the product silhouette (we leave bg-removal enabled as
 * insurance against shader artifacts).
 */
import puppeteer, { Browser } from "puppeteer";
import { execSync } from "child_process";

let browserPromise: Promise<Browser> | null = null;
let browserPid: number | undefined;

/**
 * Resolve the chromium executable path. Priority:
 *   1. PUPPETEER_EXECUTABLE_PATH env var (explicit override)
 *   2. `which chromium` (nix-provided on Replit)
 *   3. `which chromium-browser` (some distros)
 *   4. undefined → puppeteer uses its bundled chromium (local dev)
 */
function resolveChromiumPath(): string | undefined {
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit) return explicit;
  for (const cmd of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const path = execSync(`command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (path) return path;
    } catch {
      /* not found, try next */
    }
  }
  return undefined;
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
    // Stale handle (browser crashed) — re-launch.
    browserPromise = null;
  }
  const executablePath = resolveChromiumPath();
  browserPromise = puppeteer
    .launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        // Force SwiftShader so we don't need a GPU. Replit containers have
        // no GPU; without this flag Chromium tries to use the host GPU
        // and falls back unreliably.
        "--use-gl=swiftshader",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
      ],
    })
    .then((b) => {
      browserPid = b.process()?.pid;
      console.log(
        `[Harmonize/glbRender] Chromium launched (pid=${browserPid ?? "?"}, path=${executablePath ?? "bundled"})`,
      );
      return b;
    });
  return browserPromise;
}

/**
 * Map the human-readable lighting direction strings used elsewhere in the
 * harmonize pipeline to a 3D unit vector in scene-space (+X right, +Y up,
 * +Z toward camera).
 *
 * The vector points FROM the light source TO the origin (i.e. position of
 * the DirectionalLight when looking at the product).
 */
function lightDirVector(dir?: string): { x: number; y: number; z: number } {
  switch ((dir || "top-left").toLowerCase()) {
    case "top": return { x: 0, y: 1, z: 0.6 };
    case "bottom": return { x: 0, y: -1, z: 0.6 };
    case "left": return { x: -1, y: 0.3, z: 0.6 };
    case "right": return { x: 1, y: 0.3, z: 0.6 };
    case "top-right": return { x: 0.7, y: 1, z: 0.5 };
    case "bottom-left": return { x: -0.7, y: -0.7, z: 0.5 };
    case "bottom-right": return { x: 0.7, y: -0.7, z: 0.5 };
    case "back": case "behind": return { x: 0, y: 0.5, z: -1 };
    case "front": case "ambient": return { x: 0, y: 0.4, z: 1 };
    case "top-left": default: return { x: -0.7, y: 1, z: 0.5 };
  }
}

export interface GlbRenderParams {
  glbUrl: string;
  /** Camera azimuth around Y axis. Positive = camera looks at product's right side. Default 25°. */
  yawDeg?: number;
  /** Camera elevation. Positive = camera looks down on product (typical product shot). Default 10°. */
  pitchDeg?: number;
  /** Output dimensions. */
  width?: number;
  height?: number;
  /** Camera FoV in degrees. */
  fovDeg?: number;
  /** Scene light direction string ("top-left", "right", "ambient", etc.). */
  lightDir?: string;
  /** 0–1+, matches scene lightingIntensity metadata. */
  lightIntensity?: number;
  /** Hard timeout for the entire render. */
  timeoutMs?: number;
}

/**
 * The inline HTML page Chromium loads. Three.js is pulled from unpkg via an
 * ESM importmap — no local bundling required. The page exposes
 * `window.__renderGlb(params)` which resolves to a PNG dataURL.
 *
 * Background is fully transparent so downstream compositing can drop the
 * result straight into the scene without further alpha work.
 */
const PAGE_HTML = `<!doctype html>
<html><head>
<style>html,body{margin:0;background:transparent}canvas{display:block}</style>
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
  }
}
</script>
</head><body>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

window.__renderGlb = async (p) => {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(p.width, p.height);
  renderer.setClearColor(0x000000, 0); // fully transparent
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // PMREM-filtered RoomEnvironment gives realistic PBR reflections without
  // requiring an HDR file. Subtle enough that scene compositing dominates.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Load the GLB. fal-hosted URLs serve correct CORS headers, so this works
  // from a chromium-headless page without any proxy.
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) =>
    loader.load(p.glbUrl, resolve, undefined, reject)
  );
  const model = gltf.scene;

  // Auto-fit: center the model at the origin and remember its max dimension
  // so we can choose a camera distance that frames it with a small margin.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  model.position.sub(center);
  scene.add(model);

  const camera = new THREE.PerspectiveCamera(p.fovDeg, p.width / p.height, 0.01, 100);
  // Distance: place camera so the product fills ~70% of frame.
  const halfFovRad = (camera.fov * Math.PI / 180) / 2;
  const dist = (maxDim / 2) / Math.tan(halfFovRad) * 1.4;

  // Spherical coords: yaw around Y, pitch up/down. Convention: yawDeg=0,
  // pitchDeg=0 puts the camera on +Z looking at -Z (i.e. front of model).
  const yawRad = p.yawDeg * Math.PI / 180;
  const pitchRad = p.pitchDeg * Math.PI / 180;
  camera.position.set(
    dist * Math.sin(yawRad) * Math.cos(pitchRad),
    dist * Math.sin(pitchRad),
    dist * Math.cos(yawRad) * Math.cos(pitchRad)
  );
  camera.lookAt(0, 0, 0);

  // Lighting: low ambient + key directional. Key direction uses the scene's
  // lightingDirection metadata so the product highlights line up with the
  // rest of the frame.
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, Math.max(0.4, p.lightIntensity));
  key.position.set(p.lightDirX, p.lightDirY, p.lightDirZ).normalize();
  scene.add(key);
  // Subtle fill from opposite side to avoid totally black shadows.
  const fill = new THREE.DirectionalLight(0xffffff, 0.25);
  fill.position.set(-p.lightDirX, -p.lightDirY * 0.5, p.lightDirZ).normalize();
  scene.add(fill);

  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");

  // Free GPU resources — important if browser is reused.
  renderer.dispose();
  pmrem.dispose();
  return url;
};
window.__ready = true;
</script>
</body></html>`;

/**
 * Render a GLB at the given camera angle and lighting. Returns a PNG buffer
 * (1024×1024 by default) with a transparent background.
 *
 * Reuses a singleton Chromium instance across calls. The first call eats
 * the cold-start cost (~5–10s); subsequent calls are ~1–3s.
 *
 * Throws on render failure — caller should catch and fall back to the
 * existing 2D/depth-shear path.
 */
export async function renderGlbAtAngle(params: GlbRenderParams): Promise<Buffer> {
  const {
    glbUrl,
    yawDeg = 25,
    pitchDeg = 10,
    width = 1024,
    height = 1024,
    fovDeg = 35,
    lightDir = "top-left",
    lightIntensity = 1.0,
    timeoutMs = 60000,
  } = params;

  const t0 = Date.now();
  const dirVec = lightDirVector(lightDir);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height });
    await page.setContent(PAGE_HTML, { waitUntil: "load", timeout: timeoutMs });
    // Wait for the importmap-loaded module to finish wiring up.
    await page.waitForFunction("window.__ready === true", { timeout: 30000 });

    const dataUrl = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (p: any) => (window as any).__renderGlb(p),
      {
        glbUrl,
        yawDeg,
        pitchDeg,
        width,
        height,
        fovDeg,
        lightDirX: dirVec.x,
        lightDirY: dirVec.y,
        lightDirZ: dirVec.z,
        lightIntensity,
      } as any,
    );

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const buf = Buffer.from(base64, "base64");
    console.log(
      `[Harmonize/glbRender] Rendered yaw:${yawDeg.toFixed(1)}° pitch:${pitchDeg.toFixed(1)}° ` +
        `light:${lightDir}@${lightIntensity.toFixed(2)} → ${buf.length} bytes in ${Date.now() - t0}ms`,
    );
    return buf;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Best-effort browser shutdown — used during graceful server shutdown. */
export async function closeRendererBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {
    /* already gone */
  } finally {
    browserPromise = null;
  }
}

process.on("SIGTERM", () => {
  void closeRendererBrowser();
});
process.on("SIGINT", () => {
  void closeRendererBrowser();
});
