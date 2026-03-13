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

Your job is to read a document and produce a narration script that:
- Tells a clear, engaging story
- Breaks the content into scenes (one per slide or logical section)
- Writes in a confident, human voice — no filler, no hedging
- Keeps each scene narration between 20 and 45 seconds when read aloud
- Identifies the single most important visual or data point per scene

Respond ONLY with a valid JSON object. No preamble, no markdown, no explanation.`;

/**
 * Extract a narration story script from a parsed document using Claude.
 */
export async function extractStory(parsedDocument: ParsedDocument): Promise<StoryScript> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const client = new Anthropic({ apiKey });

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

Produce a narration script. For each scene return:
- sceneNumber (integer)
- sourcePages (array of page numbers this scene covers)
- sceneTitle (short, max 6 words)
- narration (the spoken script for this scene)
- visualFocus (what the viewer should be looking at — one sentence)
- estimatedDurationSeconds (integer, 20-45)`;

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
