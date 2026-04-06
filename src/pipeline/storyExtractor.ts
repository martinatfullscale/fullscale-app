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

export interface Scene {
  sceneNumber: number;
  sourcePages: number[];
  sceneTitle: string;
  narration: string;
  visualFocus: string;
  cameraDirection: string;
  slideCategory: SlideCategory;
  estimatedDurationSeconds: number;
}

export interface StoryScript {
  documentTitle: string;
  totalScenes: number;
  scenes: Scene[];
}

function buildSystemPrompt(deckIntent: DeckIntent): string {
  const toneGuide: Record<DeckIntent, string> = {
    "investor-pitch":
      "Narration tone: CONFIDENT and PUNCHY. You're pitching to investors. " +
      "Lead with the opportunity, emphasize traction and market size. " +
      "Pacing: fast, 8-12 seconds per slide. No hedging. Every sentence should build conviction.",
    "sales-deck":
      "Narration tone: PERSUASIVE and BENEFIT-FOCUSED. You're selling to a prospect. " +
      "Lead with their pain point, show the solution, prove it works. " +
      "Pacing: moderate, 10-15 seconds per slide. Speak to outcomes, not features.",
    "team-update":
      "Narration tone: CALM and AUTHORITATIVE. You're updating leadership or the board. " +
      "Lead with key metrics, be transparent about challenges, end with next steps. " +
      "Pacing: measured, 12-15 seconds per slide. No hype — just clarity.",
    "marketing":
      "Narration tone: ENERGETIC and INSPIRING. You're telling a brand story. " +
      "Lead with vision, make the audience feel something, end with a call to action. " +
      "Pacing: dynamic, 8-12 seconds per slide. Use vivid language.",
  };

  return `You are a video director and script writer for FullScale Studio.
You will receive BOTH the text content AND the actual slide images from a presentation.
LOOK AT EACH IMAGE CAREFULLY — your job depends on accurately seeing what's on each slide.

${toneGuide[deckIntent]}

Your job is to produce a concise narration script that:
- Tells a clear, engaging story
- Creates ONE scene per slide/page — do NOT combine pages
- Writes in a confident, punchy voice — no filler, no hedging, no "let's dive in"
- Keeps each scene narration SHORT: 2-3 sentences max, ~30-40 words
- Captures the KEY insight from each slide, not a summary of everything on it

SLIDE CATEGORY CLASSIFICATION — this is the MOST IMPORTANT part of your job:
Look at each slide image and classify it into EXACTLY ONE category:

- "person" = the slide has a PHOTO of a real person or people. Headshots, team photos, founder photos, customer photos. If you see a human face, this is "person".
- "product" = the slide shows a PRODUCT SCREENSHOT, app UI, software demo, website screenshot, or device mockup. The visual is a product being shown.
- "graphic" = the slide has ILLUSTRATIONS, icons, lifestyle imagery, stock photos (not of specific people), diagrams, or visual graphics that aren't data.
- "data" = the slide has CHARTS, GRAPHS, METRICS, NUMBERS, data tables, or financial figures. The point of the slide is quantitative.
- "text" = the slide is MOSTLY TEXT — bullet points, paragraphs, lists, quotes. 80%+ text with no meaningful imagery.
- "title" = this is a TITLE SLIDE or SECTION DIVIDER. Big text, minimal content. Used as a transition.

RULES:
- If a slide has a person's face AND text, classify as "person" (the face is the visual anchor)
- If a slide has a product screenshot AND text, classify as "product"
- If a slide has both a chart AND text, classify as "data"
- Only use "text" if the slide is genuinely JUST text with no meaningful visual
- Title slides / section dividers are always "title"
- When in doubt between "graphic" and "text", choose "graphic" — we want to animate when possible

CAMERA DIRECTION — for each scene, provide a camera movement that matches the slide category:
- "person" slides: "slow push-in on subject" or "close-up with shallow depth of field" or "steadicam orbit"
- "product" slides: "slow zoom into key feature" or "gentle parallax depth" or "tracking shot across interface"
- "graphic" slides: "wide establishing shot" or "crane shot rising" or "dolly forward"
- "data" slides: "static — clean hold" (no camera movement)
- "text" slides: "static — clean hold" (no camera movement)
- "title" slides: "dramatic push-in" or "crane shot rising" or "wide pull-back"
Never use the same camera direction twice in a row.

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
  contentBlocks.push({
    type: "text",
    text: `\nProduce a narration script with ONE scene per page/slide (${parsedDocument.pageCount} scenes total).
If a page is a title page or has minimal content, still create a brief scene for it (5-8 seconds).

CRITICAL: Look at each slide image above and classify it into one of: "person", "product", "graphic", "data", "text", "title".

For each scene return:
- sceneNumber (integer, sequential)
- sourcePages (array with the single page number, e.g. [3])
- sceneTitle (short, max 6 words)
- narration (2-3 sentences, ~30-40 words MAX — this is the spoken script)
- visualFocus (describe what you SEE on the slide — one sentence)
- cameraDirection (a specific camera movement matching the slide category)
- slideCategory ("person" | "product" | "graphic" | "data" | "text" | "title")
- estimatedDurationSeconds (integer, based on deck intent pacing)`,
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

    return storyScript;
  } catch (error: any) {
    console.error(`[StoryExtractor] Claude Vision API FAILED: ${error.message}`);
    if (error.status) console.error(`[StoryExtractor] HTTP status: ${error.status}`);
    if (error.error) console.error(`[StoryExtractor] Error details:`, JSON.stringify(error.error).slice(0, 500));
    throw error;
  }
}
