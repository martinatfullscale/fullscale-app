import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { ParsedDocument } from "./parser.js";

export interface Scene {
  sceneNumber: number;
  sourcePages: number[];
  sceneTitle: string;
  narration: string;
  visualFocus: string;
  cameraDirection: string;
  slideType: "visual" | "text-heavy";
  estimatedDurationSeconds: number;
}

export interface StoryScript {
  documentTitle: string;
  totalScenes: number;
  scenes: Scene[];
}

const SYSTEM_PROMPT = `You are a video script writer for FullScale Studio.
You will receive BOTH the text content AND the actual slide images from a presentation.
LOOK AT EACH IMAGE CAREFULLY — your job depends on accurately seeing what's on each slide.

Your job is to produce a concise narration script that:
- Tells a clear, engaging story
- Creates ONE scene per slide/page — do NOT combine pages
- Writes in a confident, punchy voice — no filler, no hedging, no "let's dive in"
- Keeps each scene narration SHORT: 2-3 sentences max, 10-15 seconds when read aloud (~30-40 words)
- Captures the KEY insight from each slide, not a summary of everything on it

SLIDE TYPE CLASSIFICATION — this is the MOST IMPORTANT part of your job:
Look at each slide image and classify it:
- "visual" = the slide has PHOTOS of real people, product screenshots with images, graphics, illustrations, or any visual imagery that would look good animated. Examples: headshots, team photos, product demos with screenshots, lifestyle imagery.
- "text-heavy" = the slide is MOSTLY text, bullet points, numbers, data tables, charts, logos, or branding. These slides will stay STATIC because AI animation mangles text and numbers.

BE AGGRESSIVE about marking slides as "visual" — if a slide has BOTH text AND photos/images, mark it "visual". Only mark as "text-heavy" if the slide is genuinely 80%+ text with no meaningful imagery.

CAMERA DIRECTION — for each scene, provide a DYNAMIC and UNIQUE camera movement:
- "slow push-in" / "dolly forward"
- "wide establishing shot pulling back"
- "tracking shot following subject left to right"
- "close-up with shallow depth of field"
- "aerial/overhead looking down"
- "handheld documentary style"
- "steadicam orbit around subject"
- "low angle looking up"
- "rack focus from foreground to background"
- "crane shot rising upward"
Never use the same camera direction twice in a row.

Respond ONLY with a valid JSON object. No preamble, no markdown, no explanation.`;

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
  slideImages?: string[]
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
    text: `Document title: ${parsedDocument.documentTitle}\nTotal pages: ${parsedDocument.pageCount}\n\nHere is the text content extracted from the document:\n\n${pagesText}\n\n--- SLIDE IMAGES FOLLOW ---\nBelow are the actual slide images. LOOK AT EACH ONE to determine slideType and write accurate narration.\n`,
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

CRITICAL: Look at each slide image above. If it has photos of people, product screenshots, or visual imagery — mark it "visual". If it's mostly text/bullets/numbers — mark it "text-heavy".

For each scene return:
- sceneNumber (integer, sequential)
- sourcePages (array with the single page number, e.g. [3])
- sceneTitle (short, max 6 words)
- narration (2-3 sentences, ~30-40 words MAX — this is the spoken script)
- visualFocus (describe what you SEE on the slide — one sentence)
- cameraDirection (a specific, dynamic camera movement — different for each scene)
- slideType ("visual" or "text-heavy" based on what you SEE in the image)
- estimatedDurationSeconds (integer, 8-15 for most slides, 5-8 for title/minimal slides)`,
  });

  const imageCount = slideImages?.filter((p) => fs.existsSync(p)).length || 0;
  console.log(`[StoryExtractor] Calling Claude Vision API with ${parsedDocument.pageCount} pages and ${imageCount} slide images...`);

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
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

    // Log slideType breakdown
    const visualCount = storyScript.scenes.filter((s) => s.slideType === "visual").length;
    const textCount = storyScript.scenes.filter((s) => s.slideType === "text-heavy").length;
    console.log(`[StoryExtractor] Got ${storyScript.scenes.length} scenes: ${visualCount} visual, ${textCount} text-heavy`);

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
