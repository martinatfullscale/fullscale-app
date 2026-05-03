/**
 * AI-powered video categorization for imports from external platforms
 * (Instagram, Facebook). Takes title + description, returns the same
 * { category, subcategory, isEvergreen } shape the manual UploadModal
 * collects from the user.
 *
 * Batches all videos in a single Claude Haiku call for cost/latency:
 * 50 videos ≈ 3 sec, ≈ $0.001 total.
 *
 * Falls back to safe defaults on any failure — categorization is best-effort
 * and must not block import.
 */

import Anthropic from "@anthropic-ai/sdk";

// Keep in sync with client/src/components/UploadModal.tsx CONTENT_CATEGORIES + SUBCATEGORIES
const CATEGORIES = [
  "Podcast", "Tech", "Gaming", "Lifestyle", "Education", "Fitness",
  "Beauty", "Fashion", "Food", "Travel", "Music", "Automotive",
  "Finance", "Health", "DIY", "Other",
] as const;

const SUBCATEGORIES = [
  "Sports", "Comedy", "News", "Culture", "Business", "Entertainment",
  "Science", "Politics", "True Crime", "Interviews", "Reviews",
  "Tutorials", "Vlogs", "Reactions", "Storytelling", "Motivation",
  "Relationships", "Parenting", "Spirituality", "History", "Art",
  "Photography", "Real Estate", "Crypto", "AI & Tech", "Outdoor",
  "Pets", "Other",
] as const;

type Category = (typeof CATEGORIES)[number];
type Subcategory = (typeof SUBCATEGORIES)[number];

export interface CategorizeInput {
  title: string;
  description: string;
}

export interface CategorizeResult {
  category: Category;
  subcategory: Subcategory | null;
  isEvergreen: boolean;
}

const FALLBACK: CategorizeResult = {
  category: "Other",
  subcategory: null,
  isEvergreen: false,
};

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
    const config: Record<string, any> = {};
    if (apiKey) config.apiKey = apiKey;
    if (baseURL) config.baseURL = baseURL;
    anthropicClient = new Anthropic(config);
  }
  return anthropicClient;
}

function buildPrompt(items: CategorizeInput[]): string {
  const numbered = items
    .map((item, i) => {
      const desc = (item.description || "").substring(0, 400);
      return `${i + 1}. Title: ${item.title}\n   Description: ${desc}`;
    })
    .join("\n\n");

  return `You are categorizing short-form social videos for a creator analytics platform. For each video below, pick:

1. category — one of: ${CATEGORIES.join(", ")}
2. subcategory — one of: ${SUBCATEGORIES.join(", ")} (or null if nothing fits)
3. isEvergreen — true if the topic stays relevant for 6+ months, false if time-sensitive (news, trending, dated)

Return a JSON array, one object per video, in the same order. No prose, no markdown fencing — just the JSON array.

Schema for each entry: { "category": "...", "subcategory": "..." or null, "isEvergreen": true | false }

Videos:

${numbered}`;
}

function parseResponse(text: string, count: number): CategorizeResult[] {
  // Strip markdown fencing if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find a JSON array within the text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");
    parsed = JSON.parse(match[0]);
  }
  if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  if (parsed.length !== count) {
    console.warn(`[Categorize] Expected ${count} results, got ${parsed.length} — padding with fallback`);
  }

  const results: CategorizeResult[] = [];
  for (let i = 0; i < count; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== "object") {
      results.push(FALLBACK);
      continue;
    }
    const category = (CATEGORIES as readonly string[]).includes(entry.category) ? entry.category : "Other";
    const subcategory = entry.subcategory && (SUBCATEGORIES as readonly string[]).includes(entry.subcategory)
      ? entry.subcategory
      : null;
    const isEvergreen = typeof entry.isEvergreen === "boolean" ? entry.isEvergreen : false;
    results.push({ category, subcategory, isEvergreen });
  }
  return results;
}

/**
 * Categorize a batch of videos. Always returns an array of the same length
 * as the input. On any error, returns fallback values for the whole batch
 * rather than throwing — categorization is best-effort.
 */
export async function categorizeVideos(items: CategorizeInput[]): Promise<CategorizeResult[]> {
  if (items.length === 0) return [];

  if (!process.env.ANTHROPIC_API_KEY && !process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
    console.warn("[Categorize] No Anthropic credentials — returning fallback for all videos");
    return items.map(() => FALLBACK);
  }

  try {
    const client = getClient();
    const prompt = buildPrompt(items);
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: Math.min(8192, 80 * items.length + 200),
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const results = parseResponse(text, items.length);
    console.log(`[Categorize] Categorized ${results.length} videos`);
    return results;
  } catch (err: any) {
    console.error("[Categorize] Failed, returning fallback for all:", err?.message || err);
    return items.map(() => FALLBACK);
  }
}
