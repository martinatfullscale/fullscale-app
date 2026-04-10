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
NORTH STAR: Turn this deck into a 60-90 second video that a busy
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
If the deck is missing sections (e.g. no traction slide), work with what's there.

═══════════════════════════════════════════════════════════════
NARRATION RULES — these are non-negotiable:
═══════════════════════════════════════════════════════════════

LENGTH:  12-18 words per scene. ONE punchy line. Maximum two sentences.
         Never write "in this slide", "as you can see", "let's explore", "now let's",
         "moving on", "next up", or any transition filler.

HOOK:    Start with the hook, not the setup. Not "We built X to solve Y."
         Yes "X is broken. We fixed it."

STYLE:   Write like you talk. Short sentences. Active verbs. Specific numbers.
         Cut every adjective you don't need.

═══════════════════════════════════════════════════════════════
TEXT-HEAVY SLIDES — special rule. Read this twice:
═══════════════════════════════════════════════════════════════

If a slide is mostly bullets, paragraphs, or lists:
  DO NOT read the bullets. DO NOT summarize them.
  INSTEAD: pick the ONE phrase or number that matters most and riff on it.
  Say what it MEANS, not what it SAYS.

EXAMPLE — slide shows "99% of creators locked out of product placement economy":
  BAD:  "99% of creators are locked out of the product placement economy,
        meaning they miss out on revenue opportunities." (recitation — boring)
  GOOD: "Ninety-nine percent of creators. Locked out." (punch — memorable)

EXAMPLE — slide shows 5 bullets about market size:
  BAD:  "The market is growing at 40% a year, with $50B in revenue..." (list)
  GOOD: "Fifty billion dollars. Growing forty percent. This is where we play." (hook)

═══════════════════════════════════════════════════════════════
SLIDE CATEGORY CLASSIFICATION — drives how we animate the slide:
═══════════════════════════════════════════════════════════════

- "person"  = slide has a PHOTO of a real person. Headshots, team, founders, customers.
- "product" = slide shows a PRODUCT SCREENSHOT, app UI, device mockup, clean hero shot.
- "graphic" = slide has ILLUSTRATIONS, lifestyle imagery, icons, diagrams — with minimal text.
- "data"    = slide is CHARTS, GRAPHS, METRICS, NUMBERS, financial tables.
- "text"    = slide is MOSTLY TEXT — bullets, paragraphs, lists, quotes. 20%+ readable text.
- "title"   = TITLE SLIDE or SECTION DIVIDER. Big heading, minimal content.

PRIORITY RULES (most important first):
1. If ≥20% of the visual is readable text/bullets/paragraphs → "text"
   (This prevents AI motion from warping readable characters. CRITICAL.)
2. If there's a human face → "person" (even if there's text around it)
3. If it's a product screenshot with UI elements → "product"
4. If it's charts/numbers as the main visual → "data"
5. If it's a section divider or big headline → "title"
6. Only use "graphic" for slides that are genuinely visual with NO readable text

When in doubt between "graphic" and "text", choose "text". Better to hold still
than to produce gibberish motion across letters.

═══════════════════════════════════════════════════════════════
CAMERA DIRECTION — specific movement per scene:
═══════════════════════════════════════════════════════════════

- "person"  → "slow push-in on subject" or "close-up with shallow depth of field" or "steadicam orbit"
- "product" → "slow zoom into key feature" or "gentle parallax depth" or "tracking shot across interface"
- "graphic" → "wide establishing shot" or "crane shot rising" or "dolly forward"
- "data"    → "static — clean hold"
- "text"    → "static — clean hold"
- "title"   → "dramatic push-in" or "crane shot rising" or "wide pull-back"

Never use the same camera direction twice in a row.

═══════════════════════════════════════════════════════════════
DURATION BUDGET — aim for 60-90s total, 120s MAX:
═══════════════════════════════════════════════════════════════

Per scene: 6-10 seconds (enough to speak 12-18 words).
If the deck has 10 slides, aim for ~8 seconds each = 80 seconds total.
If the deck has 7 slides, 10 seconds each = 70 seconds total.
NEVER let any scene exceed 12 seconds.

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
    text: `\nProduce a punchy narration script.

SLIDE SELECTION:
- The deck has ${parsedDocument.pageCount} pages.
- Generate EXACTLY ${targetSceneCount} scenes ${parsedDocument.pageCount > 10 ? "(you must pick the 10 strongest slides and skip the rest)" : "(one per page)"}.
- Map selected slides to the YC framework: Problem → Solution → Market → Product → Traction → Team → Ask.
- Skip slides that don't advance the story.

HARD LIMITS:
- Each scene's narration: 12-18 words. ONE punchy line. Two sentences max.
- Each scene's estimatedDurationSeconds: 6-10 (never more than 12).
- Total video duration: target 60-90 seconds, absolute maximum 120 seconds.
- If a slide has ≥20% readable text, classify it as "text" (not "graphic") so it stays static and AI doesn't warp the characters.

For each scene return:
- sceneNumber (integer, sequential starting at 1)
- sourcePages (array with the original page number, e.g. [3])
- sceneTitle (short, max 6 words)
- narration (12-18 words. ONE punchy line. Never read bullets verbatim.)
- visualFocus (one sentence describing what you SEE on the slide)
- cameraDirection (specific camera movement matching the slide category)
- slideCategory ("person" | "product" | "graphic" | "data" | "text" | "title")
- estimatedDurationSeconds (integer 6-10, based on narration length)
- ycFrameworkRole (one of: "problem" | "solution" | "market" | "product" | "traction" | "team" | "ask" | "hook" | "other")

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
