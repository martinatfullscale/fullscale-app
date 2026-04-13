import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { ParsedDocument } from "./parser.js";

/**
 * Slide categories — Claude classifies each slide into one of these.
 * Each category has specific animation rules in visualLayer.ts.
 */
export type SlideCategory =
  | "person"        // Slide features a photo of a person/people → subtle animation (blink, head turn)
  | "product"       // Product screenshot, app UI, demo → gentle parallax/zoom into key feature
  | "graphic"       // Illustrations, icons, imagery, lifestyle photos → ken burns / cinematic pan
  | "data"          // Charts, graphs, metrics, numbers → keep static, VO carries it
  | "text"          // Bullet points, paragraphs, lists → keep static, clean
  | "title";        // Title slide, section divider → dramatic camera move, transition moment

/**
 * Deck intent — what the founder is using this deck for.
 * Changes narration tone and pacing.
 */
export type DeckIntent =
  | "investor-pitch"   // Fast, punchy, confident — "here's why you should invest"
  | "sales-deck"       // Persuasive, benefits-focused — "here's how we solve your problem"
  | "team-update"      // Calm, authoritative — "here's where we stand"
  | "marketing";       // Energetic, inspiring — "here's what we're building"

export type YcFrameworkRole =
  | "hook"
  | "problem"
  | "solution"
  | "market"
  | "product"
  | "traction"
  | "team"
  | "ask"
  | "other";

/**
 * How to render the scene visually.
 * - "seedance": AI image-to-video (Kling 3.0). Pure image slides only.
 * - "kenburns": FFmpeg zoompan (safe pan/zoom, no distortion). Text-heavy slides.
 * - "static_highlight": Very subtle zoom. Data/chart slides.
 */
export type SlideTreatment = "seedance" | "kenburns" | "static_highlight";

/**
 * Narration length target.
 * - "punch": 12-18 words, one line, visual slides
 * - "explain": 3 sentences / 40-60 words, text-heavy slides
 */
export type NarrationStyle = "punch" | "explain";

/**
 * Normalized (0-1) bounding box.
 */
export interface HighlightRegion {
  x: number;       // 0-1 from left
  y: number;       // 0-1 from top
  width: number;   // 0-1 width
  height: number;  // 0-1 height
}

// ── Per-Region Types (Studio v4) ────────────────────────────────

/**
 * How an individual region within a slide should be animated.
 */
export type RegionAnimationType =
  | "kling_motion"    // Full-slide Kling call, this region cropped from the result
  | "raise"           // Text block lifts forward with depth (scale + shadow)
  | "fade_in"         // Simple opacity fade from 0→1
  | "glow"            // Subtle radial glow pulse
  | "none";           // No animation — stays as part of the flat base layer

/**
 * What kind of content this region contains.
 */
export type RegionType =
  | "image"           // Photo, product shot, headshot, illustration
  | "text_block"      // Paragraph or bullet group
  | "logo"            // Company / brand logo mark
  | "heading"         // Slide title or section header
  | "diagram";        // Chart, graph, process diagram, icon arrangement

/**
 * A detected region within a slide that gets independent visual treatment.
 * Claude Vision identifies these by looking at the slide image.
 */
export interface SlideRegion {
  id: string;                         // e.g. "s2_r1" (scene 2, region 1)
  type: RegionType;
  bounds: HighlightRegion;            // Normalized 0-1 coordinates
  description: string;                // "headshot of CEO on right side"
  animationType: RegionAnimationType;
  activateAtWord?: string;            // Narration word/phrase that triggers this region
  activateAtSec: number;              // Estimated seconds from scene start
  deactivateAtSec: number;            // Estimated seconds from scene start
}

// ── Scene + StoryScript ─────────────────────────────────────────

export interface Scene {
  sceneNumber: number;
  sourcePages: number[];
  sceneTitle: string;
  narration: string;
  visualFocus: string;
  cameraDirection: string;
  slideCategory: SlideCategory;
  estimatedDurationSeconds: number;
  ycFrameworkRole?: YcFrameworkRole;

  // Per-slide treatment — determines visual pipeline branch
  treatment?: SlideTreatment;
  narrationStyle?: NarrationStyle;

  // Legacy highlight fields (v3 compat — still used if regions[] is empty)
  keyPhrase?: string;
  highlightRegion?: HighlightRegion;
  highlightStartSec?: number;
  highlightEndSec?: number;

  // Per-region animation plan (v4) — replaces the single highlight approach
  regions?: SlideRegion[];
}

export interface StoryScript {
  documentTitle: string;
  totalScenes: number;
  scenes: Scene[];
  totalDurationSeconds?: number;
}

function buildSystemPrompt(deckIntent: DeckIntent): string {
  const toneGuide: Record<DeckIntent, string> = {
    "investor-pitch":
      "VOICE: a founder pitching in a bar — not a narrator reading a teleprompter. " +
      "Confident, conversational, zero hype. Lead with the hook. You're selling belief.",
    "sales-deck":
      "VOICE: a senior AE who knows the prospect's pain by heart. " +
      "Direct, benefit-focused, zero fluff. You speak to outcomes. You make them nod.",
    "team-update":
      "VOICE: a calm operator briefing leadership. " +
      "Clear, measured, transparent. You lead with numbers and end with the next move.",
    "marketing":
      "VOICE: a copywriter who obsesses over hooks. " +
      "Energetic, vivid, emotional. Make them feel something in under 2 seconds.",
  };

  return `You are a video director and script writer for FullScale Studio.
You will receive BOTH the text content AND the actual slide images from a presentation.
LOOK AT EACH IMAGE CAREFULLY — your job depends on accurately seeing what's on each slide.

${toneGuide[deckIntent]}

═══════════════════════════════════════════════════════════════
NORTH STAR: Turn this deck into a 60-120 second video that a busy
person will actually watch to the end. Never longer than 120s.
═══════════════════════════════════════════════════════════════

THE YC PITCH FRAMEWORK — use this as your backbone:
1. Problem   — what's broken, who feels it, how bad is it
2. Solution  — what you built and why it works
3. Market    — how big, how fast it's growing
4. Product   — what it does, what makes it different
5. Traction  — proof (numbers, logos, growth)
6. Team      — why this team wins
7. Ask       — what you want next

If the deck has more than 10 slides, pick the 10 strongest and map them
to this framework. Skip slides that don't push the narrative forward.

═══════════════════════════════════════════════════════════════
TWO NARRATION STYLES — pick the right one per slide:
═══════════════════════════════════════════════════════════════

STYLE "punch" — for VISUAL slides (person, product, graphic, title):
  - 12-18 words, ONE punchy line. Maximum two sentences.
  - Start with the hook, not the setup.
  - Example (product): "Upload a deck. Get a video. That's the entire pitch."

STYLE "explain" — for TEXT-HEAVY slides (text, data, mixed):
  - 3 sentences, 40-60 words.
  - Explain the INSIGHT, not the bullets. Say what it MEANS, not what it SAYS.
  - Pick ONE key phrase from the slide to highlight visually (return it in keyPhrase field).
  - Example (bullets about market size): "Fifty billion dollars. Growing forty percent a year.
    This is where we play — and almost no one has figured out how to reach them."

NEVER write "in this slide", "as you can see", "let's explore", "now let's", "moving on",
"next up", or any transition filler. You're writing for a video, not a tour guide.

═══════════════════════════════════════════════════════════════
SLIDE CLASSIFICATION & TREATMENT — drives the visual pipeline:
═══════════════════════════════════════════════════════════════

🚨 MOST IMPORTANT RULE — APPLY BEFORE PICKING ANY CATEGORY:

Scan the slide for ANY text a reader could stop and read — captions
under images, bullet points, team bios, feature descriptions, sub-headings,
column labels, paragraphs, quotes, section dividers with multi-word copy.

If you find text that takes more than 1 second to read, classify the slide
as "text" and use treatment "kenburns". This rule OVERRIDES person, product,
and graphic. Seedance (AI motion) is ONLY for slides with ZERO readable body text.

EXAMPLE 1: A slide with 3 product screenshots and a caption beneath each
  ("The Shorts Factory", "From Archive to Algorithm", "Net-New Revenue")
  → This IS "text" treatment. The captions make it text-heavy.
  → Do NOT classify as "product" just because the images are prominent.

EXAMPLE 2: A slide with 5 headshots and a paragraph bio under each name
  → This IS "text" treatment, NOT "person".

EXAMPLE 3: A slide with a big chart AND a paragraph explanation
  → This IS "data" treatment (static_highlight) since there's readable text
     that must not distort.

Look at each slide and pick ONE category AND one treatment:

"person"  → PHOTO of real people (headshots, team, founders) with MINIMAL text
            TREATMENT: "seedance" (AI motion — blink, breathe, subtle push-in)
            NARRATION: "punch"

"product" → PRODUCT SCREENSHOT, app UI, device mockup — clean hero shot with minimal UI text
            TREATMENT: "seedance" (AI zoom into feature)
            NARRATION: "punch"

"graphic" → ILLUSTRATIONS, lifestyle imagery, icons, diagrams — NO readable text
            TREATMENT: "seedance" (ken burns cinematic pan)
            NARRATION: "punch"

"title"   → Big title / section divider — minimal content
            TREATMENT: "seedance" (dramatic push-in)
            NARRATION: "punch"

"text"    → Slide is MOSTLY TEXT — bullets, paragraphs, lists, quotes, team bios,
            mixed content with headshots AND text
            TREATMENT: "kenburns" (FFmpeg slow zoom — no AI, no distortion)
            NARRATION: "explain" (3 sentences)
            REQUIRED: return keyPhrase + highlightRegion

"data"    → CHARTS, GRAPHS, METRICS, NUMBERS, financial tables
            TREATMENT: "static_highlight" (hold still, highlight key number)
            NARRATION: "explain" (3 sentences)
            REQUIRED: return keyPhrase + highlightRegion

CRITICAL CLASSIFICATION RULES — prevents text distortion:

1. If the slide has ANY readable body text (bullets, paragraphs, descriptions) → "text"
   Even if it also has images, headshots, or graphics. Text distortion is the worst
   possible outcome. When unsure, choose "text".

2. ONLY classify as "person" if the slide is a clean headshot with NO body text.
   Team slides with bios are "text", not "person".

3. ONLY classify as "product" if the slide is a clean product shot with NO descriptions.
   Product feature slides with bullet points are "text".

4. "graphic" is reserved for slides that are pure visual (like a lifestyle photo fills
   the whole slide with minimal text overlay).

═══════════════════════════════════════════════════════════════
REGION DETECTION — the most important part of your output:
═══════════════════════════════════════════════════════════════

For EVERY scene, scan the slide image and identify 1-4 distinct visual
regions that deserve independent animation. Return them in a "regions" array.

A "region" is a bounded visual area: a photo, a logo, a text block, a heading,
a diagram column, a chart. NOT every pixel — just the 1-4 most important areas.

REGION TYPES and their animation:

"image" regions (photos, headshots, product shots, illustrations):
  animationType: "kling_motion"
  We send the full slide to Kling AI and crop this region from the animated result.
  The image gets natural, human-like motion (breathing, subtle head movement, parallax).

"text_block" regions (paragraphs, bullet groups, descriptions):
  animationType: "raise"
  The text block lifts forward with depth separation — like a card rising off the page.
  Subtle scale-up + shadow underneath. Makes the text the focal point.

"heading" regions (slide titles, section headers, big red text):
  animationType: "raise"
  Same depth lift as text_block, but for single-line headings.

"logo" regions (company logos, brand marks):
  animationType: "kling_motion" or "raise"
  Logos with visual detail → kling_motion (subtle pulse). Simple text logos → raise.

"diagram" regions (process flows, multi-column layouts, icon grids):
  animationType: "raise"
  Each major section could be a separate region that activates sequentially.

For each region, return:
- id: "s{sceneNumber}_r{index}" starting at 1
- type: "image" | "text_block" | "logo" | "heading" | "diagram"
- bounds: { x, y, width, height } — normalized 0-1 coordinates
    x=0 is left edge, x=1 is right edge
    y=0 is top edge, y=1 is bottom edge
    Be generous with padding — slightly larger is better than clipping content.
- description: one sentence describing what's in this region
- animationType: "kling_motion" | "raise" | "fade_in" | "none"
- activateAtWord: the EXACT word or short phrase from the narration that should
    trigger this region. Pick the most relevant keyword.
- activateAtSec: estimated seconds from scene start when the trigger word is spoken
- deactivateAtSec: when the region de-emphasizes (activateAtSec + 3 to 5 seconds)

EXAMPLE — slide with a company logo on the left and body text on the right:
"regions": [
  {
    "id": "s2_r1",
    "type": "logo",
    "bounds": { "x": 0.02, "y": 0.1, "width": 0.35, "height": 0.75 },
    "description": "FullScale FS logo in black circle",
    "animationType": "kling_motion",
    "activateAtWord": "FullScale",
    "activateAtSec": 0.5,
    "deactivateAtSec": 5.0
  },
  {
    "id": "s2_r2",
    "type": "text_block",
    "bounds": { "x": 0.45, "y": 0.2, "width": 0.52, "height": 0.5 },
    "description": "product description paragraph",
    "animationType": "raise",
    "activateAtWord": "marketplace",
    "activateAtSec": 2.0,
    "deactivateAtSec": 8.0
  }
]

EXAMPLE — slide with 4 process columns:
"regions": [
  { "id": "s4_r1", "type": "diagram", "bounds": { "x": 0.0, "y": 0.3, "width": 0.25, "height": 0.5 },
    "description": "step 1 column: Ingest & Scan", "animationType": "raise",
    "activateAtWord": "scans", "activateAtSec": 1.0, "deactivateAtSec": 4.0 },
  { "id": "s4_r2", "type": "diagram", "bounds": { "x": 0.25, "y": 0.3, "width": 0.25, "height": 0.5 },
    "description": "step 2 column: Creator Enablement", "animationType": "raise",
    "activateAtWord": "approve", "activateAtSec": 3.0, "deactivateAtSec": 6.0 },
  { "id": "s4_r3", "type": "diagram", "bounds": { "x": 0.5, "y": 0.3, "width": 0.25, "height": 0.5 },
    "description": "step 3 column: Marketplace Matching", "animationType": "raise",
    "activateAtWord": "bid", "activateAtSec": 5.0, "deactivateAtSec": 8.0 },
  { "id": "s4_r4", "type": "heading", "bounds": { "x": 0.05, "y": 0.82, "width": 0.5, "height": 0.15 },
    "description": "punchline: THIS IS TARGETED SCENE INTEGRATION", "animationType": "raise",
    "activateAtWord": "targeted", "activateAtSec": 8.0, "deactivateAtSec": 12.0 }
]

═══════════════════════════════════════════════════════════════
CAMERA DIRECTION — for the base layer Ken Burns:
═══════════════════════════════════════════════════════════════

Every scene gets a very subtle base Ken Burns zoom on the full slide (1.0→1.02).
The cameraDirection field describes the general feel:
- "slow drift right" or "slow drift left" or "gentle zoom center"
- Keep it minimal — the per-region animations carry the visual interest.

═══════════════════════════════════════════════════════════════
DURATION BUDGET:
═══════════════════════════════════════════════════════════════

Per scene:
- "punch" narration → 6-8 seconds
- "explain" narration → 10-14 seconds

11-12 scenes is fine. Only condense if genuinely above 15 slides.
Aim for 70-120 seconds total.

Respond ONLY with a valid JSON object. No preamble, no markdown, no explanation.`;
}

/**
 * Resize an image to max 800px wide using ImageMagick (available on Replit).
 * Returns path to resized image. Falls back to original if resize fails.
 */
function resizeForVision(imagePath: string): string {
  try {
    const resizedPath = imagePath.replace(/\.(jpg|jpeg|png)$/i, "_sm.jpg");
    execSync(
      `convert "${imagePath}" -resize 800x600\\> -quality 70 "${resizedPath}"`,
      { timeout: 10_000 }
    );
    if (fs.existsSync(resizedPath) && fs.statSync(resizedPath).size > 0) {
      return resizedPath;
    }
  } catch {
    console.log(`[StoryExtractor] Resize failed for ${path.basename(imagePath)}, using original`);
  }
  return imagePath;
}

/**
 * Extract a narration story script from a parsed document using Claude Vision.
 * Sends the actual slide images so Claude can SEE what's on each slide.
 */
export async function extractStory(
  parsedDocument: ParsedDocument,
  slideImages?: string[],
  deckIntent: DeckIntent = "investor-pitch"
): Promise<StoryScript> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const client = new Anthropic({ apiKey, timeout: 300_000 });

  // Build multimodal content: interleave slide images with text
  const contentBlocks: Anthropic.MessageCreateParams["messages"][0]["content"] = [];

  // Add intro text
  const pagesText = parsedDocument.pages
    .map((page) => {
      let content = `--- Page ${page.pageNumber} ---\nTitle: ${page.title}\n`;
      if (page.body) content += `Content: ${page.body}\n`;
      if (page.notes) content += `Speaker Notes: ${page.notes}\n`;
      return content;
    })
    .join("\n");

  contentBlocks.push({
    type: "text",
    text: `Document title: ${parsedDocument.documentTitle}\nTotal pages: ${parsedDocument.pageCount}\nDeck intent: ${deckIntent}\n\nHere is the text content extracted from the document:\n\n${pagesText}\n\n--- SLIDE IMAGES FOLLOW ---\nBelow are the actual slide images. LOOK AT EACH ONE to determine slideCategory and write accurate narration.\n`,
  });

  // Add each slide image if available — resize first to keep payload small
  if (slideImages && slideImages.length > 0) {
    let totalSize = 0;
    for (let i = 0; i < slideImages.length; i++) {
      const imgPath = slideImages[i];
      if (fs.existsSync(imgPath)) {
        // Resize to reduce payload
        const smallPath = resizeForVision(imgPath);
        const imageData = fs.readFileSync(smallPath);
        totalSize += imageData.length;
        const base64 = imageData.toString("base64");
        const ext = path.extname(smallPath).toLowerCase();
        const mediaType = ext === ".png" ? "image/png" : "image/jpeg";

        contentBlocks.push({
          type: "text",
          text: `\n--- Slide ${i + 1} image: ---`,
        });
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64,
          },
        });
      }
    }
    console.log(`[StoryExtractor] Total image payload: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  } else {
    contentBlocks.push({
      type: "text",
      text: "\n(No slide images available — classify based on text content alone.)\n",
    });
  }

  // Add the output instructions
  const maxScenes = Math.min(parsedDocument.pageCount, 15);
  contentBlocks.push({
    type: "text",
    text: `\nProduce a narration script with per-slide treatment and per-region animation.

SLIDE SELECTION:
- The deck has ${parsedDocument.pageCount} pages.
- Generate up to ${maxScenes} scenes. ${parsedDocument.pageCount > 12 ? "Pick the strongest slides and skip filler." : "One per page is fine."}
- Map selected slides to the YC framework: Problem → Solution → Market → Product → Traction → Team → Ask.

DURATION:
- "punch" narration → 6-8 seconds, 12-18 words
- "explain" narration → 10-14 seconds, 40-60 words (3 sentences)
- Total: aim for 70-120 seconds. 11-12 scenes is fine.

For each scene return ALL of these fields:
- sceneNumber (integer, sequential starting at 1)
- sourcePages (array with the original page number, e.g. [3])
- sceneTitle (short, max 6 words)
- narration (follow narrationStyle rules above)
- visualFocus (one sentence describing what you SEE on the slide)
- cameraDirection ("slow drift right" or "slow drift left" or "gentle zoom center")
- slideCategory ("person" | "product" | "graphic" | "data" | "text" | "title")
- treatment ("seedance" | "kenburns" | "static_highlight")
- narrationStyle ("punch" | "explain")
- estimatedDurationSeconds (integer, 6-14)
- ycFrameworkRole ("problem" | "solution" | "market" | "product" | "traction" | "team" | "ask" | "hook" | "other")
- regions (array of 1-4 SlideRegion objects — see REGION DETECTION section above)

Each region object must have:
  id, type, bounds (object with x/y/width/height 0-1), description,
  animationType, activateAtWord, activateAtSec, deactivateAtSec

Also return a top-level field:
- totalDurationSeconds (sum of all scene durations)`,
  });

  const imageCount = slideImages?.filter((p) => fs.existsSync(p)).length || 0;
  console.log(`[StoryExtractor] Calling Claude Vision API with ${parsedDocument.pageCount} pages, ${imageCount} images, intent: ${deckIntent}`);

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: buildSystemPrompt(deckIntent),
      messages: [
        {
          role: "user",
          content: contentBlocks as any,
        },
      ],
    });

    console.log(`[StoryExtractor] Claude responded: ${response.usage?.input_tokens} input tokens, ${response.usage?.output_tokens} output tokens`);

    // Extract text content from response
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no text content");
    }

    // Strip markdown code fences if present (```json ... ```)
    let rawResponse = textBlock.text.trim();
    if (rawResponse.startsWith("```")) {
      rawResponse = rawResponse.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Parse JSON response
    let storyScript: StoryScript;
    try {
      storyScript = JSON.parse(rawResponse);
    } catch (parseError) {
      console.error("[StoryExtractor] Failed to parse Claude response as JSON.");
      console.error("[StoryExtractor] Raw response (first 500 chars):", rawResponse.slice(0, 500));
      throw new Error(`Failed to parse Claude response: ${parseError}`);
    }

    // Validate shape
    if (!storyScript.scenes || !Array.isArray(storyScript.scenes)) {
      throw new Error("Claude response missing 'scenes' array");
    }

    // Log category breakdown
    const categories = storyScript.scenes.reduce((acc, s) => {
      const cat = s.slideCategory || "unknown";
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const breakdown = Object.entries(categories).map(([k, v]) => `${v} ${k}`).join(", ");
    console.log(`[StoryExtractor] Got ${storyScript.scenes.length} scenes: ${breakdown}`);

    // Count animated vs static
    const animatedCount = storyScript.scenes.filter((s) =>
      ["person", "product", "graphic", "title"].includes(s.slideCategory)
    ).length;
    const staticCount = storyScript.scenes.filter((s) =>
      ["data", "text"].includes(s.slideCategory)
    ).length;
    console.log(`[StoryExtractor] Animation plan: ${animatedCount} animated, ${staticCount} static`);

    // Ensure documentTitle and totalScenes are set
    storyScript.documentTitle = storyScript.documentTitle || parsedDocument.documentTitle;
    storyScript.totalScenes = storyScript.scenes.length;

    // ── Enforce duration + slide count caps (in case Claude ignored them) ──
    enforceDurationCap(storyScript);

    return storyScript;
  } catch (error: any) {
    console.error(`[StoryExtractor] Claude Vision API FAILED: ${error.message}`);
    if (error.status) console.error(`[StoryExtractor] HTTP status: ${error.status}`);
    if (error.error) console.error(`[StoryExtractor] Error details:`, JSON.stringify(error.error).slice(0, 500));
    throw error;
  }
}

/**
 * Enforce limits on the story script:
 * - Soft cap at 15 scenes (11-12 is fine per founder)
 * - Maximum 120 seconds total duration (scale down proportionally if exceeded)
 * - Per-scene minimum 5s, maximum 14s
 * - Validate + clamp region bounds and timing
 */
const MAX_SCENES = 15;
const MAX_TOTAL_DURATION = 120;
const MIN_SCENE_DURATION = 5;
const MAX_SCENE_DURATION = 14;

function enforceDurationCap(script: StoryScript): void {
  // Soft cap scene count — only trim if genuinely excessive
  if (script.scenes.length > MAX_SCENES) {
    console.log(`[StoryExtractor] Trimming ${script.scenes.length} scenes to ${MAX_SCENES}`);
    script.scenes = script.scenes.slice(0, MAX_SCENES);
    script.totalScenes = script.scenes.length;
    script.scenes.forEach((s, i) => { s.sceneNumber = i + 1; });
  }

  // Fill in missing treatment / narrationStyle defaults from slideCategory
  script.scenes.forEach((s) => {
    if (!s.treatment) {
      s.treatment = ["text", "data"].includes(s.slideCategory) ? "kenburns" : "seedance";
      if (s.slideCategory === "data") s.treatment = "static_highlight";
    }
    if (!s.narrationStyle) {
      s.narrationStyle = ["text", "data"].includes(s.slideCategory) ? "explain" : "punch";
    }
  });

  // Clamp per-scene durations
  script.scenes.forEach((s) => {
    if (!s.estimatedDurationSeconds || s.estimatedDurationSeconds < MIN_SCENE_DURATION) {
      s.estimatedDurationSeconds = MIN_SCENE_DURATION;
    }
    if (s.estimatedDurationSeconds > MAX_SCENE_DURATION) {
      s.estimatedDurationSeconds = MAX_SCENE_DURATION;
    }
  });

  // Cap total duration — scale all scenes proportionally
  const total = script.scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
  if (total > MAX_TOTAL_DURATION) {
    const scale = MAX_TOTAL_DURATION / total;
    script.scenes.forEach((s) => {
      s.estimatedDurationSeconds = Math.max(
        MIN_SCENE_DURATION,
        Math.round(s.estimatedDurationSeconds * scale)
      );
    });
    const newTotal = script.scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
    console.log(`[StoryExtractor] Scaled total duration from ${total}s to ${newTotal}s (cap: ${MAX_TOTAL_DURATION}s)`);
  }

  // Validate + clamp region bounds and timing
  script.scenes.forEach((s) => {
    if (s.regions && Array.isArray(s.regions)) {
      s.regions.forEach((r) => {
        // Clamp bounds to 0-1
        r.bounds.x = Math.max(0, Math.min(1, r.bounds.x || 0));
        r.bounds.y = Math.max(0, Math.min(1, r.bounds.y || 0));
        r.bounds.width = Math.max(0.02, Math.min(1 - r.bounds.x, r.bounds.width || 0.1));
        r.bounds.height = Math.max(0.02, Math.min(1 - r.bounds.y, r.bounds.height || 0.1));
        // Clamp timing to scene duration
        r.activateAtSec = Math.max(0, Math.min(s.estimatedDurationSeconds, r.activateAtSec || 0));
        r.deactivateAtSec = Math.max(
          r.activateAtSec + 0.5,
          Math.min(s.estimatedDurationSeconds, r.deactivateAtSec || s.estimatedDurationSeconds)
        );
        // Default animationType
        if (!r.animationType) {
          r.animationType = r.type === "image" || r.type === "logo" ? "kling_motion" : "raise";
        }
      });
    } else {
      s.regions = [];
    }
  });

  script.totalDurationSeconds = script.scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
  const regionCount = script.scenes.reduce((sum, s) => sum + (s.regions?.length || 0), 0);
  console.log(`[StoryExtractor] Final: ${script.scenes.length} scenes, ${script.totalDurationSeconds}s total, ${regionCount} regions`);
}
