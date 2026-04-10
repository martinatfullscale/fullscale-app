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
 * - "seedance": AI image-to-video (Seedance 2.0 → Kling fallback). Pure image slides only.
 * - "kenburns": FFmpeg zoompan (safe pan/zoom, no distortion). Text-heavy slides.
 * - "static_highlight": Hold still, just add drawbox highlight. Data/chart slides.
 */
export type SlideTreatment = "seedance" | "kenburns" | "static_highlight";

/**
 * Narration length target.
 * - "punch": 12-18 words, one line, visual slides
 * - "explain": 3 sentences / 40-60 words, text-heavy slides
 */
export type NarrationStyle = "punch" | "explain";

/**
 * Normalized (0-1) bounding box for highlighting a phrase on the slide.
 * Used by the assembler to draw a highlight box at the right place/time.
 */
export interface HighlightRegion {
  x: number;       // 0-1 from left
  y: number;       // 0-1 from top
  width: number;   // 0-1 width
  height: number;  // 0-1 height
}

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

  // Highlight box (text-heavy slides only)
  keyPhrase?: string;                // The phrase to highlight verbatim on the slide
  highlightRegion?: HighlightRegion; // Where the phrase sits (normalized coords)
  highlightStartSec?: number;        // When the highlight fades in (relative to scene start)
  highlightEndSec?: number;          // When it fades out
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
HIGHLIGHT REGIONS — only for "text" and "data" slides:
═══════════════════════════════════════════════════════════════

When the slide is text-heavy, you MUST return:
- keyPhrase: the exact text to highlight (verbatim as it appears on the slide)
- highlightRegion: where that text sits on the slide (normalized 0-1 coordinates)

Coordinates explanation:
  The slide image you see is 1280x720 pixels (landscape 16:9).
  x = 0.0 is the left edge, x = 1.0 is the right edge
  y = 0.0 is the top edge, y = 1.0 is the bottom edge
  width/height are the normalized size of the bounding box

Look at the image and estimate where the key phrase sits:
- If the phrase is a headline at the top center: { x: 0.2, y: 0.1, width: 0.6, height: 0.15 }
- If the phrase is a bullet on the left: { x: 0.05, y: 0.4, width: 0.5, height: 0.08 }
- If it's a big number in the middle: { x: 0.35, y: 0.4, width: 0.3, height: 0.2 }

Be generous with padding — better for the highlight box to be slightly larger than smaller.

═══════════════════════════════════════════════════════════════
CAMERA DIRECTION — for scenes using seedance treatment:
═══════════════════════════════════════════════════════════════

- "person"  → "slow push-in on subject" or "close-up with shallow depth of field"
- "product" → "slow zoom into key feature" or "gentle parallax depth"
- "graphic" → "wide establishing shot" or "crane shot rising" or "dolly forward"
- "title"   → "dramatic push-in" or "crane shot rising" or "wide pull-back"
- "text"    → "ken burns slow zoom" (not used by AI, just a label)
- "data"    → "static hold" (not used by AI, just a label)

═══════════════════════════════════════════════════════════════
DURATION BUDGET:
═══════════════════════════════════════════════════════════════

Per scene:
- "punch" narration → 6-8 seconds
- "explain" narration → 10-14 seconds

Aim for 70-100 seconds total, NEVER exceed 120.

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
  const targetSceneCount = Math.min(parsedDocument.pageCount, 10);
  contentBlocks.push({
    type: "text",
    text: `\nProduce a narration script with per-slide treatment.

SLIDE SELECTION:
- The deck has ${parsedDocument.pageCount} pages.
- Generate EXACTLY ${targetSceneCount} scenes ${parsedDocument.pageCount > 10 ? "(pick the 10 strongest slides and skip the rest)" : "(one per page)"}.
- Map selected slides to the YC framework: Problem → Solution → Market → Product → Traction → Team → Ask.
- Skip slides that don't advance the story.

HARD LIMITS:
- Visual slides (punch narration): 6-8 seconds, 12-18 words
- Text-heavy slides (explain narration): 10-14 seconds, 40-60 words (3 sentences)
- Total video duration: target 70-100 seconds, absolute maximum 120 seconds.
- ANY slide with readable body text → classify as "text" (not graphic/person/product)

For each scene return ALL of these fields:
- sceneNumber (integer, sequential starting at 1)
- sourcePages (array with the original page number, e.g. [3])
- sceneTitle (short, max 6 words)
- narration (follow narrationStyle rules above)
- visualFocus (one sentence describing what you SEE on the slide)
- cameraDirection (specific camera movement)
- slideCategory ("person" | "product" | "graphic" | "data" | "text" | "title")
- treatment ("seedance" | "kenburns" | "static_highlight")
    * "seedance" for pure image slides (person/product/graphic/title WITHOUT readable text)
    * "kenburns" for text-heavy slides (safe FFmpeg zoom — no AI distortion)
    * "static_highlight" for data/chart slides
- narrationStyle ("punch" | "explain")
    * "punch" goes with "seedance" treatment
    * "explain" goes with "kenburns" or "static_highlight" treatment
- estimatedDurationSeconds (integer, 6-14)
- ycFrameworkRole ("problem" | "solution" | "market" | "product" | "traction" | "team" | "ask" | "hook" | "other")

FOR "text" AND "data" slides ONLY, also return:
- keyPhrase (the EXACT phrase from the slide to highlight on screen — must be verbatim)
- highlightRegion (object with x, y, width, height — all normalized 0-1 relative to the 1280x720 slide)
- highlightStartSec (when the highlight fades in, typically 0.5 or 1.0 seconds into the scene)
- highlightEndSec (when it fades out, typically estimatedDurationSeconds - 0.5)

Example highlightRegion for a bullet at top-left of slide:
  { "x": 0.05, "y": 0.15, "width": 0.6, "height": 0.1 }

Example highlightRegion for a big number in the center:
  { "x": 0.35, "y": 0.35, "width": 0.3, "height": 0.2 }

Also return a top-level field:
- totalDurationSeconds (sum of all scene durations — must be ≤ 120)`,
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
 * Enforce hard limits on the story script:
 * - Maximum 10 scenes (keep the first 10 if Claude returned more)
 * - Maximum 120 seconds total duration (scale down proportionally if exceeded)
 * - Per-scene minimum 5s, maximum 12s
 */
const MAX_SCENES = 10;
const MAX_TOTAL_DURATION = 120;
const MIN_SCENE_DURATION = 5;
const MAX_SCENE_DURATION = 12;

function enforceDurationCap(script: StoryScript): void {
  // Cap scene count
  if (script.scenes.length > MAX_SCENES) {
    console.log(`[StoryExtractor] Trimming ${script.scenes.length} scenes to ${MAX_SCENES}`);
    script.scenes = script.scenes.slice(0, MAX_SCENES);
    script.totalScenes = script.scenes.length;
    // Re-number sequentially
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

  script.totalDurationSeconds = script.scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
  console.log(`[StoryExtractor] Final: ${script.scenes.length} scenes, ${script.totalDurationSeconds}s total`);
}
