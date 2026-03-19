import Anthropic from "@anthropic-ai/sdk";
import type { ParsedDocument } from "./parser.js";

export interface Scene {
  sceneNumber: number;
  sourcePages: number[];
  sceneTitle: string;
  narration: string;
  visualFocus: string;
  estimatedDurationSeconds: number;
}

export interface StoryScript {
  documentTitle: string;
  totalScenes: number;
  scenes: Scene[];
}

const SYSTEM_PROMPT = `You are a video script writer for FullScale Studio.

Your job is to read a document and produce a concise narration script that:
- Tells a clear, engaging story
- Creates ONE scene per slide/page — do NOT combine pages unless they are clearly continuation of the same point
- Writes in a confident, punchy voice — no filler, no hedging, no "let's dive in"
- Keeps each scene narration SHORT: 2-3 sentences max, 10-15 seconds when read aloud (~30-40 words)
- Identifies the single most important visual or data point per scene
- Captures the KEY insight from each slide, not a summary of everything on it

The goal is a tight, fast-paced narrated video — like a 60-second pitch, not a lecture.

Respond ONLY with a valid JSON object. No preamble, no markdown, no explanation.`;

/**
 * Extract a narration story script from a parsed document using Claude.
 */
export async function extractStory(parsedDocument: ParsedDocument): Promise<StoryScript> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const client = new Anthropic({ apiKey, timeout: 120_000 });

  // Build the pages content string
  const pagesContent = parsedDocument.pages
    .map((page) => {
      let content = `--- Page ${page.pageNumber} ---\nTitle: ${page.title}\n`;
      if (page.body) content += `Content: ${page.body}\n`;
      if (page.notes) content += `Speaker Notes: ${page.notes}\n`;
      return content;
    })
    .join("\n");

  const userPrompt = `Document title: ${parsedDocument.documentTitle}
Total pages: ${parsedDocument.pageCount}

Here is the document content, page by page:

${pagesContent}

Produce a narration script with ONE scene per page/slide (${parsedDocument.pageCount} scenes total).
If a page is a title page or has minimal content, still create a brief scene for it (5-8 seconds).

For each scene return:
- sceneNumber (integer, sequential)
- sourcePages (array with the single page number, e.g. [3])
- sceneTitle (short, max 6 words)
- narration (2-3 sentences, ~30-40 words MAX — this is the spoken script)
- visualFocus (what the viewer should see — one sentence)
- estimatedDurationSeconds (integer, 8-15 for most slides, 5-8 for title/minimal slides)`;

  console.log(`[StoryExtractor] Calling Claude API with ${parsedDocument.pageCount} pages...`);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

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

  // Ensure documentTitle and totalScenes are set
  storyScript.documentTitle = storyScript.documentTitle || parsedDocument.documentTitle;
  storyScript.totalScenes = storyScript.scenes.length;

  console.log(`[StoryExtractor] Got ${storyScript.totalScenes} scenes from Claude`);

  return storyScript;
}
