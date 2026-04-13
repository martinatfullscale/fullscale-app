/**
 * Generate the FullScale Studio hero loop video.
 *
 * Procedurally renders a "document → video" transformation loop using
 * SVG composites (via Sharp) assembled by FFmpeg into a seamless 10-second MP4.
 *
 * Outputs:
 *   attached_assets/generated_videos/studio_hero_loop.mp4          (desktop, 1280x720)
 *   attached_assets/generated_videos/studio_hero_loop_mobile.mp4   (mobile, 640x360)
 *
 * Run with: npx tsx scripts/generate-studio-hero.ts
 */

import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

const FPS = 30;
const DURATION_SEC = 10;
const TOTAL_FRAMES = FPS * DURATION_SEC;
const WIDTH = 1280;
const HEIGHT = 720;

// ─── Frame Composition ─────────────────────────────────────────

/**
 * Build the SVG for a single frame.
 * `phase` is 0 → 1 across the whole loop, so Math.sin(phase * 2π) gives seamless wrap.
 */
function buildFrameSVG(phase: number): string {
  // Left-side document: gentle float + subtle rotation
  const docY = Math.sin(phase * Math.PI * 2) * 12;
  const docRotate = Math.sin(phase * Math.PI * 2) * 3;

  // Right-side video player cycles through 4 "scenes" by color
  const sceneIndex = Math.floor(phase * 4) % 4;
  const scenePhase = (phase * 4) % 1;
  const scenes = [
    { hue: 280, label: "Problem" },
    { hue: 330, label: "Solution" },
    { hue: 25,  label: "Traction" },
    { hue: 160, label: "Team"     },
  ];
  const currentScene = scenes[sceneIndex];
  const nextScene = scenes[(sceneIndex + 1) % 4];

  // Connective particle glow pulses
  const glow = 0.5 + Math.sin(phase * Math.PI * 4) * 0.25;

  // Particles flowing left → right along a sine path
  const particles: string[] = [];
  const PARTICLE_COUNT = 12;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = (phase + i / PARTICLE_COUNT) % 1;
    const x = 440 + p * 320;
    const y = 360 + Math.sin(p * Math.PI * 2 + i) * 70;
    const size = 2 + p * 3;
    const opacity = Math.sin(p * Math.PI) * 0.85;
    particles.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size.toFixed(1)}" fill="#c4b5fd" opacity="${opacity.toFixed(2)}" />`);
  }

  // Dash offset for the flowing arrow line
  const dashOffset = -(phase * 64);

  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="25%" cy="25%" r="95%">
      <stop offset="0%" stop-color="#1e1b4b" />
      <stop offset="60%" stop-color="#0f0b2e" />
      <stop offset="100%" stop-color="#030712" />
    </radialGradient>
    <linearGradient id="paper" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fafaf9" />
      <stop offset="100%" stop-color="#e7e5e4" />
    </linearGradient>
    <linearGradient id="scene-${sceneIndex}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="hsl(${currentScene.hue}, 75%, 55%)" />
      <stop offset="100%" stop-color="hsl(${nextScene.hue}, 70%, 45%)" stop-opacity="${scenePhase.toFixed(2)}" />
      <stop offset="100%" stop-color="hsl(${currentScene.hue}, 65%, 35%)" />
    </linearGradient>
    <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />

  <!-- Subtle dotted grid overlay -->
  <g opacity="0.08" fill="#a78bfa">
    ${Array.from({ length: 10 }, (_, row) =>
      Array.from({ length: 16 }, (_, col) =>
        `<circle cx="${col * 90 + 45}" cy="${row * 80 + 40}" r="1.5" />`
      ).join("")
    ).join("")}
  </g>

  <!-- Left side: Document stack -->
  <g transform="translate(240, ${(360 + docY).toFixed(1)}) rotate(${docRotate.toFixed(2)})">
    <!-- Back page offset -->
    <rect x="-130" y="-175" width="260" height="350" rx="6" fill="url(#paper)" opacity="0.35" transform="translate(24, 18)" />
    <rect x="-130" y="-175" width="260" height="350" rx="6" fill="url(#paper)" opacity="0.6" transform="translate(12, 9)" />
    <!-- Front page -->
    <rect x="-130" y="-175" width="260" height="350" rx="6" fill="url(#paper)" filter="url(#soft-glow)" />
    <!-- Header bar -->
    <rect x="-110" y="-150" width="220" height="32" rx="3" fill="#dc2626" />
    <!-- Body lines -->
    <rect x="-110" y="-90" width="210" height="8" rx="2" fill="#6b7280" />
    <rect x="-110" y="-72" width="190" height="8" rx="2" fill="#6b7280" />
    <rect x="-110" y="-54" width="220" height="8" rx="2" fill="#6b7280" />
    <!-- Image placeholder -->
    <rect x="-110" y="-20" width="220" height="80" rx="3" fill="#d4d4d8" />
    <rect x="-100" y="-10" width="200" height="60" rx="2" fill="#a1a1aa" />
    <!-- Bottom lines -->
    <rect x="-110" y="80" width="210" height="8" rx="2" fill="#6b7280" />
    <rect x="-110" y="98" width="175" height="8" rx="2" fill="#6b7280" />
    <rect x="-110" y="116" width="200" height="8" rx="2" fill="#6b7280" />
    <rect x="-110" y="134" width="150" height="8" rx="2" fill="#6b7280" />
    <!-- PDF corner fold -->
    <path d="M 110 -175 L 130 -155 L 110 -155 Z" fill="#a1a1aa" />
  </g>

  <!-- Label under document -->
  <text x="240" y="575" font-family="Inter, Arial, sans-serif" font-size="15" fill="#a78bfa" text-anchor="middle" opacity="0.6" letter-spacing="3">YOUR DECK</text>

  <!-- Flow arrow -->
  <g opacity="${(0.35 + glow * 0.3).toFixed(2)}">
    <path d="M 410 360 Q 640 ${(340 - Math.sin(phase * Math.PI * 2) * 25).toFixed(1)} 730 360"
          stroke="#a78bfa" stroke-width="2.5" fill="none"
          stroke-dasharray="10 8" stroke-dashoffset="${dashOffset.toFixed(1)}" stroke-linecap="round" />
    <!-- Arrow head -->
    <path d="M 725 352 L 745 360 L 725 368" stroke="#a78bfa" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
  </g>

  <!-- Flowing particles -->
  <g>${particles.join("")}</g>

  <!-- Right side: Video player -->
  <g transform="translate(970, 360)">
    <!-- Player frame with soft purple glow -->
    <rect x="-230" y="-160" width="460" height="320" rx="14" fill="#0f172a" stroke="#7c3aed" stroke-width="2.5" opacity="0.95" />
    <rect x="-230" y="-160" width="460" height="320" rx="14" fill="none" stroke="#a78bfa" stroke-width="1" opacity="${(glow * 0.5).toFixed(2)}" filter="url(#soft-glow)" />

    <!-- Video content area -->
    <rect x="-220" y="-150" width="440" height="260" rx="8" fill="url(#scene-${sceneIndex})" />

    <!-- Scene label fading in/out -->
    <text x="0" y="-50" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" fill="white" text-anchor="middle" opacity="${(Math.sin(scenePhase * Math.PI) * 0.9).toFixed(2)}" letter-spacing="2">${currentScene.label.toUpperCase()}</text>

    <!-- Play triangle in center -->
    <g opacity="0.85">
      <circle cx="0" cy="20" r="32" fill="white" opacity="0.15" />
      <polygon points="-12,5 14,22 -12,39" fill="white" />
    </g>

    <!-- Progress bar -->
    <rect x="-220" y="125" width="440" height="4" rx="2" fill="#374151" />
    <rect x="-220" y="125" width="${(440 * phase).toFixed(1)}" height="4" rx="2" fill="#a78bfa" />

    <!-- Time code -->
    <text x="-215" y="155" font-family="monospace" font-size="12" fill="#6b7280">${formatTime(phase * DURATION_SEC)}</text>
    <text x="215" y="155" font-family="monospace" font-size="12" fill="#6b7280" text-anchor="end">${formatTime(DURATION_SEC)}</text>
  </g>

  <!-- Label under video player -->
  <text x="970" y="575" font-family="Inter, Arial, sans-serif" font-size="15" fill="#c4b5fd" text-anchor="middle" opacity="0.7" letter-spacing="3">VIDEO READY</text>

  <!-- Top brand -->
  <text x="640" y="80" font-family="Inter, Arial, sans-serif" font-size="14" fill="#a78bfa" text-anchor="middle" opacity="0.55" letter-spacing="6">FULLSCALE STUDIO</text>
  <line x1="520" y1="95" x2="760" y2="95" stroke="#a78bfa" stroke-width="1" opacity="0.3" />

  <!-- Bottom tagline -->
  <text x="640" y="665" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="500" fill="white" text-anchor="middle" opacity="0.55">Document to Video. Powered by AI.</text>
</svg>`;
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const ms = Math.floor((seconds - s) * 10);
  return `0:0${s}.${ms}`;
}

// ─── Frame Rendering ───────────────────────────────────────────

async function renderFrame(frameIndex: number, outputPath: string): Promise<void> {
  const phase = frameIndex / TOTAL_FRAMES;
  const svg = buildFrameSVG(phase);
  await sharp(Buffer.from(svg))
    .resize(WIDTH, HEIGHT)
    .jpeg({ quality: 88 })
    .toFile(outputPath);
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const tempDir = path.join("/tmp", `studio-hero-frames-${Date.now()}`);
  const outputDir = path.join(repoRoot, "attached_assets", "generated_videos");
  const desktopPath = path.join(outputDir, "studio_hero_loop.mp4");
  const mobilePath = path.join(outputDir, "studio_hero_loop_mobile.mp4");

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[StudioHero] Rendering ${TOTAL_FRAMES} frames at ${WIDTH}x${HEIGHT}...`);
  const startTime = Date.now();
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const framePath = path.join(tempDir, `frame_${String(i).padStart(4, "0")}.jpg`);
    await renderFrame(i, framePath);
    if (i % 30 === 0 || i === TOTAL_FRAMES - 1) {
      const pct = Math.round(((i + 1) / TOTAL_FRAMES) * 100);
      process.stdout.write(`\r[StudioHero]   ${i + 1}/${TOTAL_FRAMES} frames (${pct}%)`);
    }
  }
  console.log();
  console.log(`[StudioHero] Frames rendered in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  console.log(`[StudioHero] Stitching desktop video → ${desktopPath}`);
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(FPS),
    "-i", path.join(tempDir, "frame_%04d.jpg"),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "slow",
    "-crf", "23",
    "-movflags", "+faststart",
    desktopPath,
  ]);

  console.log(`[StudioHero] Encoding mobile variant → ${mobilePath}`);
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", desktopPath,
    "-vf", "scale=640:360",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "slow",
    "-crf", "28",
    "-movflags", "+faststart",
    mobilePath,
  ]);

  fs.rmSync(tempDir, { recursive: true, force: true });

  const desktopSize = (fs.statSync(desktopPath).size / 1024 / 1024).toFixed(2);
  const mobileSize = (fs.statSync(mobilePath).size / 1024).toFixed(0);
  console.log();
  console.log(`[StudioHero] ✓ Desktop: ${desktopPath} (${desktopSize} MB)`);
  console.log(`[StudioHero] ✓ Mobile:  ${mobilePath} (${mobileSize} KB)`);
}

main().catch((err) => {
  console.error("[StudioHero] Failed:", err);
  process.exit(1);
});
