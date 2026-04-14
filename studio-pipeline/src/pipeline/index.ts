import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { parsePDF, parsePPTX, type ParsedDocument } from "./parser.js";
import { extractStory, type StoryScript, type DeckIntent } from "./storyExtractor.js";
import { slidesToImages, generateVisual } from "./visualLayer.js";
import { generateVoice } from "./voiceSynth.js";
import { assembleVideo, type AssemblyScene } from "./assembler.js";

export interface PipelineOptions {
  visualTier?: "mvp" | "v1" | "v2";
  deckIntent?: DeckIntent;
  onStageChange?: (stage: string, progress: number) => void;
}

export interface PipelineResult {
  jobId: string;
  outputPath: string;
  metadata: {
    title: string;
    sceneCount: number;
    estimatedDurationSeconds: number;
  };
}

/**
 * Run the full FullScale Studio pipeline:
 *   Stage 1: Parse document → ParsedDocument
 *   Stage 2: Convert slides to images (needed for Claude Vision)
 *   Stage 3: Extract story via Claude Vision (sees actual slides) → StoryScript
 *   Stage 4: Generate visuals — animate "visual" slides, keep "text-heavy" static
 *   Stage 5: Generate voice per scene
 *   Stage 6: Assemble video → MP4 at outputPath
 */
export async function runPipeline(
  documentBuffer: Buffer,
  documentType: "pdf" | "pptx",
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const jobId = randomUUID();
  // Use persistent directory for output (survives Replit redeploys)
  // Work files go to /tmp, but final output goes to persistent storage
  const workDir = path.join(os.tmpdir(), "studio-pipeline", jobId);
  fs.mkdirSync(workDir, { recursive: true });
  const persistentDir = path.join(process.cwd(), "studio-output", jobId);
  fs.mkdirSync(persistentDir, { recursive: true });

  const tier = options.visualTier || (process.env.VISUAL_TIER as "mvp" | "v1" | "v2") || "mvp";
  const deckIntent: DeckIntent = options.deckIntent || "investor-pitch";
  const notify = options.onStageChange || (() => {});

  console.log(`[Pipeline] Deck intent: ${deckIntent}, Visual tier: ${tier}`);

  const logStage = (stage: string, progress: number) => {
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
    console.log(`${timestamp} [Pipeline/${jobId.slice(0, 8)}] ${stage} (${progress}%)`);
    notify(stage, progress);
  };

  try {
    // ─── Stage 1: Parse document ─────────────────────────
    logStage("parsing", 0);
    console.log(`[Pipeline] Parsing ${documentType} document (${documentBuffer.length} bytes)...`);

    let parsedDoc: ParsedDocument;
    if (documentType === "pdf") {
      parsedDoc = await parsePDF(documentBuffer);
    } else {
      parsedDoc = await parsePPTX(documentBuffer);
    }
    logStage("parsing", 100);
    console.log(`  → ${parsedDoc.pageCount} pages, title: "${parsedDoc.documentTitle}"`);

    // ─── Stage 2: Convert slides to images FIRST ─────────
    // We need slide images before calling Claude so it can SEE them
    logStage("extracting", 5);
    console.log(`[Pipeline] Converting slides to images for Claude Vision...`);

    let slideImages: string[];
    if (documentType === "pdf") {
      const tempPdfPath = path.join(workDir, "source.pdf");
      fs.writeFileSync(tempPdfPath, documentBuffer);
      const imagesDir = path.join(workDir, "slides");
      slideImages = await slidesToImages(tempPdfPath, imagesDir);
    } else {
      // For PPTX, create placeholder images
      // TODO: Use LibreOffice headless to convert PPTX → PDF → images
      slideImages = await createTextSlideImages(
        { documentTitle: parsedDoc.documentTitle, totalScenes: parsedDoc.pageCount, scenes: [] } as StoryScript,
        path.join(workDir, "slides")
      );
    }
    logStage("extracting", 15);
    console.log(`  → ${slideImages.length} slide images ready for Claude Vision`);

    // ─── Stage 3: Extract story via Claude Vision ────────
    // Claude now SEES each slide image and can accurately classify
    // which slides have photos (visual) vs. text-heavy content
    logStage("extracting", 20);
    const storyScript = await extractStory(parsedDoc, slideImages, deckIntent);
    logStage("extracting", 100);
    console.log(`  → ${storyScript.totalScenes} scenes extracted`);

    // ─── Stage 4: Generate visuals (animate visual slides) ────
    logStage("generating", 10);

    // Map scenes to visuals (apply tier processing, 2 at a time for V1)
    const sceneVisuals: string[] = new Array(storyScript.scenes.length);
    const VISUAL_CONCURRENCY = tier === "mvp" ? storyScript.scenes.length : 2;
    let completedVisuals = 0;

    for (let batch = 0; batch < storyScript.scenes.length; batch += VISUAL_CONCURRENCY) {
      const batchScenes = storyScript.scenes.slice(batch, batch + VISUAL_CONCURRENCY);
      const batchPromises = batchScenes.map((scene, idx) => {
        const globalIdx = batch + idx;
        const slideIndex = Math.min(
          (scene.sourcePages[0] || 1) - 1,
          slideImages.length - 1
        );
        return generateVisual(scene, slideImages[slideIndex], tier)
          .then((visualPath) => {
            sceneVisuals[globalIdx] = visualPath;
            completedVisuals++;
            const progress = 10 + Math.round((completedVisuals / storyScript.scenes.length) * 80);
            logStage("generating", progress);
          });
      });
      await Promise.all(batchPromises);
    }
    logStage("generating", 100);

    // ─── Stage 5: Generate voice per scene (parallel, 3 at a time) ──
    logStage("adding-voice", 10);
    const audioDir = path.join(workDir, "audio");
    const audioPaths: string[] = new Array(storyScript.scenes.length);
    const CONCURRENCY = 3;
    let completedVoice = 0;

    for (let batch = 0; batch < storyScript.scenes.length; batch += CONCURRENCY) {
      const batchScenes = storyScript.scenes.slice(batch, batch + CONCURRENCY);
      const batchPromises = batchScenes.map((scene, idx) => {
        const globalIdx = batch + idx;
        return generateVoice(scene.narration, scene.sceneNumber, audioDir)
          .then((result) => {
            // generateVoice returns VoiceResult (or a string in legacy callers).
            // runPipelineFromScript already unwraps this; mirror it here.
            audioPaths[globalIdx] = typeof result === "string" ? result : result.audioPath;
            completedVoice++;
            const progress = 10 + Math.round((completedVoice / storyScript.scenes.length) * 80);
            logStage("adding-voice", progress);
          });
      });
      await Promise.all(batchPromises);
    }
    logStage("adding-voice", 100);

    // ─── Stage 6: Assemble final video ───────────────────
    logStage("assembling", 10);
    const assemblyScenes: AssemblyScene[] = storyScript.scenes.map((scene, i) => {
      const visualPath = sceneVisuals[i];
      const isVideo = visualPath.endsWith(".mp4");
      return {
        ...(isVideo ? { videoFile: visualPath } : { imageFile: visualPath }),
        audioFile: audioPaths[i],
        durationSeconds: scene.estimatedDurationSeconds,
        keyPhrase: scene.keyPhrase,
        highlightRegion: scene.highlightRegion,
        highlightStartSec: scene.highlightStartSec,
        highlightEndSec: scene.highlightEndSec,
      };
    });

    const outputPath = path.join(persistentDir, "output.mp4");
    await assembleVideo(assemblyScenes, outputPath);
    logStage("assembling", 100);

    // ─── Done ────────────────────────────────────────────
    const totalDuration = storyScript.scenes.reduce(
      (sum, s) => sum + s.estimatedDurationSeconds,
      0
    );

    logStage("complete", 100);
    console.log(`  → Video: ${outputPath}`);
    console.log(`  → Duration: ~${Math.round(totalDuration / 60)} minutes`);

    return {
      jobId,
      outputPath,
      metadata: {
        title: storyScript.documentTitle,
        sceneCount: storyScript.totalScenes,
        estimatedDurationSeconds: totalDuration,
      },
    };
  } catch (error) {
    logStage("failed", 0);
    throw error;
  }
}

// ─── Two-stage pipeline: extract then generate ────────────────

export interface ExtractOnlyResult {
  jobId: string;
  workDir: string;
  slideImages: string[];
  storyScript: StoryScript;
  parsedDoc: ParsedDocument;
  documentType: "pdf" | "pptx";
}

/**
 * Stages 1-3: Parse + render slides + extract story.
 * Returns the story script for user review BEFORE generating the video.
 *
 * The caller is responsible for calling runPipelineFromScript() later with
 * the (possibly edited) script to produce the final video. The jobId + workDir
 * are used to pass state between the two stages.
 */
export async function extractStoryOnly(
  documentBuffer: Buffer,
  documentType: "pdf" | "pptx",
  options: PipelineOptions = {}
): Promise<ExtractOnlyResult> {
  const jobId = randomUUID();
  // Persist the work directory inside studio-output so it survives between extract + generate calls
  const workDir = path.join(process.cwd(), "studio-output", jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const deckIntent: DeckIntent = options.deckIntent || "investor-pitch";
  const notify = options.onStageChange || (() => {});

  const logStage = (stage: string, progress: number) => {
    console.log(`[Pipeline/${jobId.slice(0, 8)}] ${stage} (${progress}%)`);
    notify(stage, progress);
  };

  // Stage 1: Parse document
  logStage("parsing", 0);
  let parsedDoc: ParsedDocument;
  if (documentType === "pdf") {
    parsedDoc = await parsePDF(documentBuffer);
  } else {
    parsedDoc = await parsePPTX(documentBuffer);
  }
  logStage("parsing", 100);

  // Save the source file to workDir so runPipelineFromScript can find the images
  const sourcePath = path.join(workDir, `source.${documentType}`);
  fs.writeFileSync(sourcePath, documentBuffer);

  // Stage 2: Render slides to images
  logStage("extracting", 5);
  let slideImages: string[];
  if (documentType === "pdf") {
    const imagesDir = path.join(workDir, "slides");
    slideImages = await slidesToImages(sourcePath, imagesDir);
  } else {
    slideImages = await createTextSlideImages(
      { documentTitle: parsedDoc.documentTitle, totalScenes: parsedDoc.pageCount, scenes: [] } as StoryScript,
      path.join(workDir, "slides")
    );
  }
  logStage("extracting", 30);

  // Stage 3: Extract story via Claude Vision
  const storyScript = await extractStory(parsedDoc, slideImages, deckIntent);
  logStage("extracting", 100);

  return { jobId, workDir, slideImages, storyScript, parsedDoc, documentType };
}

/**
 * Stages 4-6: Generate visuals + voice + assemble.
 * Takes a (possibly edited) story script and the workDir from extractStoryOnly().
 */
export async function runPipelineFromScript(
  storyScript: StoryScript,
  slideImages: string[],
  workDir: string,
  jobId: string,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const tier = options.visualTier || (process.env.VISUAL_TIER as "mvp" | "v1" | "v2") || "mvp";
  const notify = options.onStageChange || (() => {});

  const persistentDir = path.join(process.cwd(), "studio-output", jobId);
  fs.mkdirSync(persistentDir, { recursive: true });

  const logStage = (stage: string, progress: number) => {
    console.log(`[Pipeline/${jobId.slice(0, 8)}] ${stage} (${progress}%)`);
    notify(stage, progress);
  };

  try {
    // Stage 4: Generate visuals
    logStage("generating", 10);
    const sceneVisuals: string[] = new Array(storyScript.scenes.length);
    const VISUAL_CONCURRENCY = tier === "mvp" ? storyScript.scenes.length : 2;
    let completedVisuals = 0;

    for (let batch = 0; batch < storyScript.scenes.length; batch += VISUAL_CONCURRENCY) {
      const batchScenes = storyScript.scenes.slice(batch, batch + VISUAL_CONCURRENCY);
      const batchPromises = batchScenes.map((scene, idx) => {
        const globalIdx = batch + idx;
        const slideIndex = Math.min((scene.sourcePages[0] || 1) - 1, slideImages.length - 1);
        return generateVisual(scene, slideImages[slideIndex], tier).then((visualPath) => {
          sceneVisuals[globalIdx] = visualPath;
          completedVisuals++;
          const progress = 10 + Math.round((completedVisuals / storyScript.scenes.length) * 80);
          logStage("generating", progress);
        });
      });
      await Promise.all(batchPromises);
    }
    logStage("generating", 100);

    // Stage 5: Voice
    logStage("adding-voice", 10);
    const audioDir = path.join(workDir, "audio");
    const audioPaths: string[] = new Array(storyScript.scenes.length);
    const CONCURRENCY = 3;
    let completedVoice = 0;

    for (let batch = 0; batch < storyScript.scenes.length; batch += CONCURRENCY) {
      const batchScenes = storyScript.scenes.slice(batch, batch + CONCURRENCY);
      const batchPromises = batchScenes.map((scene, idx) => {
        const globalIdx = batch + idx;
        return generateVoice(scene.narration, scene.sceneNumber, audioDir).then((result) => {
          audioPaths[globalIdx] = typeof result === "string" ? result : result.audioPath;
          completedVoice++;
          const progress = 10 + Math.round((completedVoice / storyScript.scenes.length) * 80);
          logStage("adding-voice", progress);
        });
      });
      await Promise.all(batchPromises);
    }
    logStage("adding-voice", 100);

    // Stage 6: Assemble
    logStage("assembling", 10);
    const assemblyScenes: AssemblyScene[] = storyScript.scenes.map((scene, i) => {
      const visualPath = sceneVisuals[i];
      const isVideo = visualPath.endsWith(".mp4");
      return {
        ...(isVideo ? { videoFile: visualPath } : { imageFile: visualPath }),
        audioFile: audioPaths[i],
        durationSeconds: scene.estimatedDurationSeconds,
        // Pass through highlight data for the assembler to render overlays
        keyPhrase: scene.keyPhrase,
        highlightRegion: scene.highlightRegion,
        highlightStartSec: scene.highlightStartSec,
        highlightEndSec: scene.highlightEndSec,
      };
    });

    const outputPath = path.join(persistentDir, "output.mp4");
    await assembleVideo(assemblyScenes, outputPath);
    logStage("assembling", 100);

    const totalDuration = storyScript.scenes.reduce(
      (sum, s) => sum + s.estimatedDurationSeconds, 0
    );

    logStage("complete", 100);
    console.log(`[Pipeline] → Video: ${outputPath}`);

    return {
      jobId,
      outputPath,
      metadata: {
        title: storyScript.documentTitle,
        sceneCount: storyScript.totalScenes,
        estimatedDurationSeconds: totalDuration,
      },
    };
  } catch (error) {
    logStage("failed", 0);
    throw error;
  }
}

/**
 * Create simple text-on-black slide images for PPTX files
 * when we can't convert PPTX to images directly.
 * (MVP fallback — proper PPTX rendering via LibreOffice in V1)
 */
async function createTextSlideImages(
  storyScript: StoryScript,
  outputDir: string
): Promise<string[]> {
  fs.mkdirSync(outputDir, { recursive: true });
  const images: string[] = [];

  for (const scene of storyScript.scenes) {
    const imagePath = path.join(outputDir, `slide-${String(scene.sceneNumber).padStart(2, "0")}.jpg`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
      <rect width="1280" height="720" fill="#1a1a2e"/>
      <text x="640" y="320" text-anchor="middle" fill="white" font-size="48" font-family="Arial, sans-serif">${escapeXml(scene.sceneTitle)}</text>
      <text x="640" y="400" text-anchor="middle" fill="#8888aa" font-size="24" font-family="Arial, sans-serif">${escapeXml(scene.visualFocus.slice(0, 80))}</text>
    </svg>`;

    const svgPath = imagePath.replace(".jpg", ".svg");
    fs.writeFileSync(svgPath, svg);
    const { execFileSync } = await import("child_process");
    try {
      execFileSync("ffmpeg", [
        "-y", "-i", svgPath,
        "-vf", "scale=1280:720",
        imagePath,
      ], { stdio: "pipe" });
    } catch {
      fs.copyFileSync(svgPath, imagePath);
    }
    images.push(imagePath);
    try { fs.unlinkSync(svgPath); } catch {}
  }
  return images;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Re-export types for convenience
export type { ParsedDocument } from "./parser.js";
export type { StoryScript, Scene, DeckIntent, SlideCategory } from "./storyExtractor.js";
export type { AssemblyScene } from "./assembler.js";
