/**
 * ============================================================================
 * SCANNER V2 - Resource-Safe Surface Detection for Replit
 * ============================================================================
 * 
 * This is a lightweight, production-safe replacement for scanner.ts.
 * 
 * DETECTION METHODS:
 * - Gemini AI: Deep understanding of scene content, product placement zones
 * - Sharp edge detection: Fast fallback for desk/table horizontal lines
 * 
 * KEY FEATURES:
 * - Deletes frames IMMEDIATELY after processing (disk-safe)
 * - Never throws - all errors caught and returned gracefully
 * - Pre-flight disk space check before extraction
 * - Processes one frame at a time (memory-safe)
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";
import { storage } from "./storage";
import type { InsertDetectedSurface, RoomModel } from "@shared/schema";
import { GoogleGenAI } from "@google/genai";
import { uploadFileToStorage, downloadToTempFile, storageServeUrl } from "./lib/objectStorage";
import { downloadVideo as downloadYouTubeVideo, getYoutubeVideoDuration } from "./lib/scanner";
import { downloadFacebookVideo, downloadInstagramVideo } from "./lib/socialDownloader";
import { seedSourceCache } from "./lib/sourceCache";
import { safeDecrypt } from "./lib/socialAnalytics";
import { getFreshYoutubeTokenForUser } from "./lib/youtubeAuth";
import { resolveYoutubeStreamUrl, resolveGraphStreamUrl, type StreamSource } from "./lib/streamResolver";
import { buildSceneIndex, sceneIdForTimestamp, sampleMultiTimestampsPerScene, computeDHash, hammingDistance, clusterHashes, type SceneIndex, type SceneShot } from "./lib/scenes/sceneIndex";
import { buildSceneConsensus, type FrameDetection, type ConsensusSurface } from "./lib/scenes/surfaceConsensus";

// ============================================================================
// GEMINI AI CLIENT
// ============================================================================

// Startup diagnostics — logs once at module load time so you can see the config in Replit logs
console.log(`[Scanner V2] =============================================`);
console.log(`[Scanner V2] AI_INTEGRATIONS_GEMINI_API_KEY exists: ${!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY}`);
console.log(`[Scanner V2] AI_INTEGRATIONS_GEMINI_API_KEY length: ${process.env.AI_INTEGRATIONS_GEMINI_API_KEY?.length || 0}`);
console.log(`[Scanner V2] AI_INTEGRATIONS_GEMINI_BASE_URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(NOT SET — will use Google default)'}`);
console.log(`[Scanner V2] =============================================`);

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

// Direct Google API fallback. The Replit modelfarm sidecar (the localhost
// AI_INTEGRATIONS_GEMINI_BASE_URL) has been observed unreachable in
// DEPLOYMENTS while the env vars are present — every call times out and the
// scan silently degrades to edge detection. When GEMINI_API_KEY (a real
// Google AI Studio key) is set, failed proxy calls retry against Google
// directly instead of degrading.
/**
 * Find a real Google Gemini key in the environment, whatever the operator
 * named it. Two hard-won details:
 *  - Env names are CASE-SENSITIVE on Linux, and secrets panels invite
 *    "Gemini_API_Key". Matching only GEMINI_API_KEY left a perfectly good
 *    key invisible while the UI showed it plainly, and every scan silently
 *    degraded to edge detection.
 *  - Key FORMATS change: classic AI Studio keys are "AIza…" (39 chars),
 *    newer ones are "AQ.…" (~53). So we reject the known placeholder
 *    rather than allow-listing prefixes — anything short or literally
 *    _DUMMY_API_KEY_ (Replit's proxy credential) isn't a usable key.
 * Returns the variable NAME too, so boot logs can name what they found
 * without ever printing the value.
 */
function resolveDirectGeminiKey(): { key: string; source: string } | null {
  const looksReal = (v: string | undefined): v is string =>
    !!v && v.length >= 20 && !v.includes("DUMMY");
  const preferred = ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"];
  for (const name of preferred) {
    if (looksReal(process.env[name])) return { key: process.env[name]!, source: name };
  }
  // Case/separator-insensitive sweep: Gemini_API_Key, gemini-api-key, …
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const wanted = new Set(["geminiapikey", "googlegeminiapikey"]);
  for (const name of Object.keys(process.env)) {
    if (wanted.has(normalize(name)) && looksReal(process.env[name])) {
      return { key: process.env[name]!, source: name };
    }
  }
  // The integration slot holds Replit's proxy placeholder in normal setups,
  // but an operator may have pasted a genuine key there.
  if (looksReal(process.env.AI_INTEGRATIONS_GEMINI_API_KEY)) {
    return { key: process.env.AI_INTEGRATIONS_GEMINI_API_KEY!, source: "AI_INTEGRATIONS_GEMINI_API_KEY" };
  }
  return null;
}

const resolvedDirectGemini = resolveDirectGeminiKey();
const directGeminiKey = resolvedDirectGemini?.key;
const aiDirect = directGeminiKey ? new GoogleGenAI({ apiKey: directGeminiKey }) : null;
console.log(`[Scanner V2] Direct Gemini: ${aiDirect ? `CONFIGURED from ${resolvedDirectGemini!.source} (${directGeminiKey!.length} chars)` : "NOT SET — scans will degrade to edge detection if the proxy is unreachable"}`);

/**
 * Gemini call with a per-attempt timeout and automatic proxy→direct
 * failover. The old pattern raced ONE attempt against a timeout, so a dead
 * proxy meant an unconditional loss; here the timeout applies to each
 * attempt and the direct client gets its own try.
 */
// Model ids ROT: Google retired gemini-2.5-flash for new accounts and the
// hardcoded name 404'd every frame of a scan ("no longer available to new
// users"). Instead of pinning one id, walk a candidate ladder — operator
// override first, then Google's rolling alias, then explicit generations —
// and MEMOIZE the first id the key accepts so discovery costs one frame,
// not the whole scan. A NOT_FOUND on the working id (mid-flight retirement)
// just advances the ladder.
export const GEMINI_MODEL_CANDIDATES: string[] = [
  process.env.GEMINI_MODEL,        // explicit operator pin wins
  "gemini-flash-latest",           // Google's rolling latest-flash alias
  "gemini-3-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",              // legacy accounts + the Replit proxy
].filter((m): m is string => !!m);
let geminiModelIdx = 0;
const isModelGoneError = (err: any): boolean =>
  /NOT_FOUND|not found|no longer available|is not supported/i.test(String(err?.message ?? err));

// Google-side capacity spikes surface as 503 UNAVAILABLE "high demand" —
// transient by Google's own message, but the old handling treated them as
// terminal for the direct client and fell to the proxy (a black hole in
// deployment) → 30s timeout → edge detection. A whole scan run during one
// spike came back degraded. 503s get a short same-model retry, then a
// PER-CALL fallback down the model ladder (the preferred model isn't gone,
// just busy — no sticky advance), and only then the proxy.
const isOverloadedError = (err: any): boolean =>
  /UNAVAILABLE|high demand|overloaded|\b503\b/i.test(String(err?.message ?? err));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function geminiGenerate(params: any, timeoutMs: number = CONFIG.GEMINI_TIMEOUT_MS): Promise<any> {
  const tryModel = (client: GoogleGenAI, model: string) =>
    Promise.race([
      client.models.generateContent({ ...params, model }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)),
    ]);
  // A real Google key goes FIRST. The Replit modelfarm proxy only exists
  // inside the workspace sidecar — in a deployment it is a black hole that
  // burns the full per-attempt timeout on every frame before failing over.
  // When we hold a direct key, the proxy is the fallback, not the primary.
  const primary = aiDirect ?? ai;
  const secondary = aiDirect ? ai : null;

  let callModelIdx = geminiModelIdx;
  let busyRetried = false;
  const maxIterations = GEMINI_MODEL_CANDIDATES.length + 3;
  for (let iter = 0; iter < maxIterations; iter++) {
    const model = GEMINI_MODEL_CANDIDATES[callModelIdx];
    try {
      return await tryModel(primary, model);
    } catch (err: any) {
      if (isModelGoneError(err) && callModelIdx < GEMINI_MODEL_CANDIDATES.length - 1) {
        callModelIdx++;
        // Retirement is permanent — advance the sticky index for everyone.
        if (callModelIdx > geminiModelIdx) geminiModelIdx = callModelIdx;
        console.warn(`[Gemini] Model "${model}" unavailable to this key — advancing to "${GEMINI_MODEL_CANDIDATES[callModelIdx]}"`);
        continue;
      }
      if (isOverloadedError(err)) {
        if (!busyRetried) {
          busyRetried = true;
          console.warn(`[Gemini] "${model}" overloaded (503) — retrying in 2s`);
          await sleep(2000);
          continue;
        }
        if (callModelIdx < GEMINI_MODEL_CANDIDATES.length - 1) {
          callModelIdx++;
          busyRetried = false;
          console.warn(`[Gemini] "${model}" still overloaded — trying "${GEMINI_MODEL_CANDIDATES[callModelIdx]}" for this call`);
          continue;
        }
      }
      if (!secondary) throw err;
      console.warn(`[Gemini] Direct attempt failed (${err?.message || err}) — retrying via proxy`);
      // The proxy speaks the legacy model id regardless of what the direct
      // key supports — it predates the newer generations.
      return await tryModel(secondary, "gemini-2.5-flash");
    }
  }
  throw new Error("Gemini: exhausted model candidates");
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Frame extraction - every 2 seconds for better coverage
  FRAME_INTERVAL_SECONDS: 2,
  MAX_FRAMES_PER_VIDEO: 24,
  FRAME_MAX_DIMENSION: 1280,
  FRAME_QUALITY: 85,
  
  // Disk safety
  MIN_DISK_SPACE_MB: 100,
  
  // Detection method: 'gemini' or 'edge'
  // Gemini AI provides accurate surface classification and tight bounding boxes
  // Edge detection is a fast fallback but can't distinguish real surfaces from random edges
  DETECTION_METHOD: 'gemini' as 'gemini' | 'edge',
  
  // Detection thresholds (for edge detection)
  EDGE_THRESHOLD: 20,
  HORIZONTAL_LINE_MIN_LENGTH: 0.20,
  SURFACE_CONFIDENCE_THRESHOLD: 0.25, // Require reasonable confidence

  // Fallback detection - add placeholder surfaces when Gemini finds fewer than this count
  // Set to 1 so that videos scanned without Gemini (missing API key) still get placeholders
  MIN_SURFACES_BEFORE_FALLBACK: 1,
  FALLBACK_CONFIDENCE: 0.15,
  
  // Timeouts
  FFMPEG_TIMEOUT_MS: 60000,
  FRAME_PROCESS_TIMEOUT_MS: 5000,
  GEMINI_TIMEOUT_MS: 30000,
  
  // Vertical video handling
  VERTICAL_ASPECT_THRESHOLD: 1.0,
  VERTICAL_ROI_TOP: 0.4,
} as const;

// ============================================================================
// SCAN MODE CONFIGURATION
// ============================================================================
// Standard mode: strict rules for manual placement flow
// AutoRemix mode: relaxed rules for narrative-first approach (auto-remix engine)

export interface ScanModeConfig {
  maxPersonOccupancy: number;
  minSurfaceArea: number;
  maxBboxHeight: number;
  requireTableEdge: boolean;
  allowBackgroundPlacements: boolean;
  fallbackToGeneration: boolean;
}

export const scanModes: Record<string, ScanModeConfig> = {
  standard: {
    maxPersonOccupancy: 0.5,
    minSurfaceArea: 0.08,
    maxBboxHeight: 0.3,
    requireTableEdge: true,
    allowBackgroundPlacements: false,
    fallbackToGeneration: false,
  },
  autoRemix: {
    maxPersonOccupancy: 0.7,
    minSurfaceArea: 0.05,
    maxBboxHeight: 0.4,
    requireTableEdge: false,
    allowBackgroundPlacements: true,
    fallbackToGeneration: true,
  },
};

// ============================================================================
// TYPES
// ============================================================================

interface ScanResult {
  success: boolean;
  videoId: number;
  surfacesDetected: number;
  error?: string;
}

interface DetectedSurface {
  surfaceType: string;
  orientation?: "horizontal" | "vertical";  // horizontal = product placement, vertical = signage/poster
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  timestamp: number;
  frameUrl?: string;
  // Lighting & camera data for realistic product placement
  lightingDirection?: string;  // left, right, top, top-left, top-right, ambient
  lightingIntensity?: number;  // 0.0-1.0
  cameraAngle?: string;        // eye-level, slightly-above, top-down, low-angle
  // Set when this detection is a CONFIRMATION of a room-model surface (the
  // model's stable per-surface index, not a fresh discovery). Confirmations
  // carry the model's canonical surfaceType/orientation and bypass the
  // fresh-detection consensus — identity is exact, no IoU chaining needed.
  knownIdx?: number;
}

interface FrameAnalysisResult {
  hasSurface: boolean;
  confidence: number;
  surfaces: DetectedSurface[];
  isVertical: boolean;
  /** True if AI successfully analyzed the frame (even if it found no surfaces) */
  aiAnalyzed?: boolean;
  /** True when every retry was consumed by 429s — the frame was never actually
   *  seen by the model. An ABSTENTION, not a "no surfaces here" verdict: the
   *  consensus vote must drop this frame from its denominator instead of
   *  letting it veto surfaces the scene's other frames agreed on. */
  rateLimited?: boolean;
  /** Fraction of the frame covered by person boxes (sum of areas, clamped to
   *  1). Only set when the response carried people data — it powers the
   *  clean-frame re-sampling pass, which skips frames it can't measure. */
  personCoverage?: number;
  /** Known-surface idx values the ghost filter vetoed in this frame. Taught
   *  surfaces are exempt from that filter, so a non-zero count for a taught
   *  idx means the exemption regressed — feeds the [Taught] fate line. */
  knownGhostVetoedIdx?: number[];
}

// EdgeAnalysisResult removed — replaced by band-based detection in analyzeFrameForSurfaces

// Gemini AI types
interface GeminiBoundingBox {
  x: number;      // percentage 0-100
  y: number;      // percentage 0-100  
  width: number;  // percentage 0-100
  height: number; // percentage 0-100
}

interface GeminiDetectedSurface {
  location: GeminiBoundingBox;
  surface_type: string;
  orientation?: "horizontal" | "vertical";
  confidence: number;
  reasoning: string;
  lighting_direction?: string;  // left, right, top, top-left, top-right, ambient
  lighting_intensity?: number;  // 0.0-1.0
  camera_angle?: string;        // eye-level, slightly-above, top-down, low-angle
}

interface GeminiSurfaceDetectionResult {
  surfaces_found: boolean;
  frame_description: string;
  surfaces: GeminiDetectedSurface[];
  // Bounding boxes of every visible person (including the chair section they
  // occupy). Powers the person-overlap ghost filter: with real person
  // positions we only reject surfaces that actually overlap someone, instead
  // of geometric center/side-of-frame zone guessing that also kills the real
  // side table next to a host and the backdrop wall between two subjects.
  people?: Array<{ location: GeminiBoundingBox }>;
  // Per-known-surface visibility verdicts, present only when the prompt
  // carried a KNOWN SET SURFACES section (room-model confirm mode). Each
  // entry re-locates one known surface in THIS frame's framing.
  known_surfaces?: Array<{
    idx: number;
    present: boolean;
    location?: GeminiBoundingBox | null;
    confidence?: number;
  }>;
  recommended_placement: {
    location: GeminiBoundingBox;
    reason: string;
  } | null;
  no_surface_reason?: string;
}

// ============================================================================
// ROOM MODEL — persistent set memory
// ============================================================================
//
// A creator's recurring scene class (same studio, same camera setup) gets ONE
// authoritative surface set — the "room model" — built from the cleanest
// frames and reused: within a scan (consistent labels/boxes), across rescans
// (stable identity → placements survive), and across episodes shot in the
// same room (instant, consistent inventory). Matching is perceptual: a scene
// class whose exemplar dHashes land within hamming range of a stored model's
// exemplars IS that set coming back.

/** One surface in a room model's `surfaces` jsonb. `idx` is the stable
 *  per-model surface index — never reused after deletion (append-only), and
 *  the anchor of the cross-scan groupId `rm{modelId}-s{idx}`. */
interface RoomModelSurface {
  idx: number;
  surfaceType: string;
  orientation: "horizontal" | "vertical";
  bbox: { x: number; y: number; w: number; h: number }; // 0-1 floats
  confidence: number;
  frameUrl: string | null;
  // Creator drew this one by hand (teach-a-surface). Human ground truth:
  // the person-overlap ghost check must never veto its confirmations.
  taught?: boolean;
}

/** Defensive read of a model's jsonb surface list — malformed entries are
 *  dropped rather than crashing the scan against old/hand-edited rows. */
function parseRoomModelSurfaces(raw: unknown): RoomModelSurface[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s: any): s is RoomModelSurface =>
    s &&
    typeof s.idx === "number" &&
    typeof s.surfaceType === "string" &&
    (s.orientation === "horizontal" || s.orientation === "vertical") &&
    s.bbox &&
    typeof s.bbox.x === "number" && typeof s.bbox.y === "number" &&
    typeof s.bbox.w === "number" && typeof s.bbox.h === "number" &&
    typeof s.confidence === "number"
  );
}

/** Per scene class: up to `cap` non-sentinel shot hashes, longest shots
 *  first. These are the class's exemplars for model matching and the hash
 *  material persisted into new/updated models. 'fail'-prefixed sentinel
 *  hashes (unextractable keyframes) are never exemplars. */
function collectClassExemplarHashes(index: SceneIndex, cap: number): Map<number, string[]> {
  const shotsByClass = new Map<number, SceneShot[]>();
  for (const shot of index.shots) {
    const arr = shotsByClass.get(shot.sceneId) ?? [];
    arr.push(shot);
    shotsByClass.set(shot.sceneId, arr);
  }
  const out = new Map<number, string[]>();
  for (const [classId, shots] of Array.from(shotsByClass.entries())) {
    const hashes: string[] = [];
    const sorted = [...shots].sort((a, b) => (b.tEnd - b.tStart) - (a.tEnd - a.tStart));
    for (const shot of sorted) {
      if (hashes.length >= cap) break;
      if (!shot.hash || shot.hash.startsWith("fail")) continue;
      if (!hashes.includes(shot.hash)) hashes.push(shot.hash);
    }
    if (hashes.length > 0) out.set(classId, hashes);
  }
  return out;
}

/** The known-surface list handed to detection for a matched scene class.
 *  Shape mirrors RoomModelSurface minus frameUrl; confidence rides along so
 *  confirmations without a fresh score inherit the model's. */
type KnownSurfaceSpec = Pick<RoomModelSurface, "idx" | "surfaceType" | "orientation" | "bbox" | "confidence" | "taught">;

/** Prompt section appended when a frame's scene class matched a room model.
 *  Gemini re-locates each known surface instead of re-discovering the room —
 *  canonical labels stay pinned, only bboxes adjust to this frame's framing. */
function buildKnownSurfacesPromptSection(known: KnownSurfaceSpec[]): string {
  const list = known
    .map((k) => `#${k.idx}: ${k.surfaceType} (${k.orientation}) at approx x ${(k.bbox.x * 100).toFixed(0)}%, y ${(k.bbox.y * 100).toFixed(0)}%, w ${(k.bbox.w * 100).toFixed(0)}%, h ${(k.bbox.h * 100).toFixed(0)}%`)
    .join("\n");
  return `

KNOWN SET SURFACES (this exact set was scanned before):
${list}

This exact set / camera setup has been scanned in previous episodes and the
surfaces above are its confirmed inventory. For EACH known surface listed,
report whether it is visible in THIS frame, with an ADJUSTED bounding box for
this frame's framing. Add a "known_surfaces" array to your JSON response,
with exactly one entry per known surface:
"known_surfaces": [
  {"idx": 0, "present": true, "location": {"x": 5, "y": 5, "width": 35, "height": 45}},
  {"idx": 1, "present": false, "location": null}
]
- "location" uses the same percent (0-100) convention as "surfaces"
- Do NOT re-list known surfaces in "surfaces" — "surfaces" is ONLY for NEW
  placement surfaces that are not in the known list above
- The "people" boxes are still required exactly as described`;
}

// ============================================================================
// GEMINI AI PROMPT
// ============================================================================

const SURFACE_DETECTION_PROMPT = `You are analyzing a video frame to identify REAL, PHYSICAL surfaces where a brand could naturally place product or signage.

CRITICAL FRAMING — READ FIRST:
This footage is almost entirely podcast / interview / talking-head content:
one or two people seated in a studio or room, talking to camera. In this
content there are almost ALWAYS two genuinely usable placement surfaces,
and your job is to FIND them reliably — not to return empty:
  A) The BACKDROP WALL behind / beside the speaker — the empty vertical
     plane a sponsor banner, poster, or logo would hang on. This is the
     single most valuable surface in podcast content. Look for it in EVERY
     frame, including tight close-ups: there is almost always empty wall to
     the LEFT and/or RIGHT of the person's head and shoulders.
  B) The STUDIO DESK / TABLE in front of the speaker — the flat top where
     the mic, water bottle, or notes sit. A prime horizontal surface.
Your default posture is NOT "return empty." It is: "inventory the ROOM."
Locate the backdrop wall and the desk first, then sweep the rest of the
set: the FLOOR area, side tables, coffee tables, shelves, counters, rugs,
and clearly EMPTY couch/sofa sections (seat or armrest with no person on
or adjacent to them). A typical furnished studio/podcast set has 4-6 real
placement surfaces — walls, floor, and multiple furniture tops. Box the
EMPTY part of each, and reject the person.
The ONE thing you must never do is box a PERSON — their body, face, hair,
lap, hands, clothing, or the chair they sit in (see the anti-hallucination
rules below). Reject the person, not the room. Only return zero surfaces
when the background is genuinely unusable (pure outdoor, total blur, or the
person completely fills the frame edge to edge with no wall visible).

BEFORE PICKING ANY SURFACE — describe the 3D layout:
- What is in the foreground (person, microphone, hands)?
- What is in the mid-ground (furniture, props)?
- What is in the background (walls, plants, decor)?
- Where is the camera positioned (eye-level, above, below, behind)?
This 3D understanding is required to avoid the most common error: treating
a flat-looking 2D region as a horizontal surface when it's actually a
wall, a curtain, a couch back, or empty space.

TASK: Find UP TO 8 of the best placement surfaces visible in the frame.
Surfaces fall into two distinct categories with different placement use cases:

  1. HORIZONTAL surfaces (orientation: "horizontal") — flat surfaces where physical objects can sit.
     Examples: desks, tables, countertops, shelves, nightstands, coffee tables, studio desks.
     Plus FLOOR space — indoor floor area with usable empty room for floor-resting products.
     Use case: bottles, cans, phones, gadgets, books, packaged goods (table-top sized);
     sneakers, shoe boxes, large bottles, plants, decorative props (floor-sized).

  2. VERTICAL surfaces (orientation: "vertical") — flat upright planes where signage/posters/art belong.
     Examples: walls (the empty parts), doors, windows, large empty backdrops.
     Use case: posters, brand banners, framed art, logos, projected signage.

Return them ranked by suitability. Quality > quantity — if only one surface is genuinely usable, return only one. If none, return zero. Never inflate to hit 2.

CRITICAL RULES:
- Maximum 8 surfaces total across both orientations — furnished sets have
  walls AND floor AND several furniture tops all visible at once, and each
  is real inventory. Still: quality > quantity. Every returned surface must
  individually pass the verification rules; if only 2 are genuinely usable,
  return only 2. Never invent surfaces to fill the budget.
- Only detect REAL physical surfaces that exist in the 3D scene
- Each surface must occupy at least 5% of total frame area
- Each surface must have CLEAR visual separation from people in the frame
- Do NOT flag roads, sidewalks, or outdoor ground (concrete, asphalt, dirt)
- Do NOT flag ceilings or curtains
- Indoor floors ARE valid (see FLOOR rules below) — but only when usable empty floor area is clearly visible
- Do NOT flag bridges, vehicles, or outdoor structures
- Do NOT flag areas with heavy motion blur or out-of-focus regions
- Do NOT flag surfaces blocked by people's bodies, hands, or large objects
- Even in a close-up / bust shot where a person fills the center of the frame,
  do NOT default to surfaces_found: false — look for the empty backdrop wall to
  the LEFT and RIGHT of the person's head/shoulders and flag it as a vertical
  "wall" surface. Return false only if the background is genuinely unusable
  (pure outdoor, total blur, or the person covers the wall entirely)
- If the frame is exterior/outdoor with no architectural features, return surfaces_found: false

ANTI-HALLUCINATION RULES (CRITICAL — READ CAREFULLY):
- You MUST be able to clearly see the physical surface material (wood, paint, drywall, glass, metal, stone)
- The bounding box MUST NOT overlap with any person's body, clothing, arms, hands, lap, legs, knees, or feet
- A laptop on someone's lap is NOT a desk surface — it is a laptop on a person
- Dark clothing is NOT a desk — it is clothing
- A microphone boom, monitor arm, or equipment mount is NOT a surface
- Do NOT bounding-box someone's chest/torso/lap area and call it a "desk"
- The surface must be GEOMETRICALLY SEPARATE from any person — clear visual separation between body and surface edge
- A wall texture you can't actually see (out of focus, behind people, in shadow) is NOT a wall placement surface
- If unsure whether something is a real surface vs a shadow/dark region near a person, do NOT include it

PEOPLE / CHAIRS / FURNITURE-WITH-PEOPLE — STRICT BAN LIST (MOST COMMON HALLUCINATION):
The single most common error in podcast/interview frames is labeling a person
or the chair they're sitting in as a "coffee_table" / "table" / "studio_desk".
These are NEVER placement surfaces — never flag them, never bound-box them:
- A person's body, head, face, hair, neck, shoulders, arms, hands, lap, legs, knees, or feet
- Clothing of any kind (shirt, jacket, hoodie, pants, suit, tracksuit) — even if it looks flat
- The arm-rest, seat, back, or cushion of a chair, armchair, sofa, or couch
- A leather/upholstered surface that has a person sitting on, against, or near it
- A chair that contains a person — even the empty parts of the chair around them
- The empty AIR GAP between two seated people is not a horizontal surface — do
  NOT invent a "coffee_table" there unless a real table top is clearly visible
  in that gap. But do not skip that zone either: the BACKDROP WALL visible
  BETWEEN two subjects is a valid vertical surface (box the empty wall slice,
  label it "wall"), and a REAL table/side table between or beside the hosts
  with its flat top visible is prime inventory — flag both.
- A pillow, throw, blanket, or cushion on a chair or couch

VERIFICATION CHECK before flagging ANY horizontal surface (run this mentally):
1. Is there a person occupying or touching the bounding box region? → REJECT
2. Is the box on or against a chair/sofa/armchair seat or back? → REJECT
3. Could the entire bounding box be replaced by "person sitting" without changing the frame meaning? → REJECT
4. Is the box on cushy/fabric/leather upholstery rather than a wood/glass/stone top? → REJECT
5. Can I see a clear flat HORIZONTAL plane (a top edge where a glass would rest) inside the box? → If NO, REJECT

PODCAST CHAIR SPECIFIC: In talking-head shows, hosts sit in chesterfield/leather
armchairs. The LEATHER SEAT, ARM-REST, and CHAIR-BACK are NEVER coffee tables.
Even if a chair arm looks like it could hold a small object, do NOT flag it.

LABEL ACCURACY RULES (CRITICAL):
- Before assigning a surface_type, look at the bounding box region and ask:
  "What is physically there?" — match the LABEL to what you actually see.
- If the region shows a vertical plane (wall, painted backdrop, curtain-back-panel,
  textured background, mural, art on wall): label as "wall" with orientation:"vertical".
  Do NOT label vertical regions as desk/table/countertop just because something brand-
  shaped could go there. Wrong label = wrong placement physics downstream.
- If the region shows a flat horizontal plane (table top, desk top, counter top, shelf
  top): label as the appropriate horizontal type.
- "studio_desk" specifically requires a visible HORIZONTAL desk surface (the flat top
  where a podcaster would set their water bottle). Do NOT use "studio_desk" for an
  upper-frame area, an arm-rest, a couch back, or anything that is not a flat horizontal
  desk top. If you see a podcast/interview studio but the actual desk top is NOT visible
  in the frame, do NOT flag a "studio_desk" surface.
- "table" / "coffee_table" / "side_table" require a visible horizontal table top. If the
  bbox is centered above floor level on a vertical plane, it is NOT a table.
- A common error to AVOID: labeling the empty wall/backdrop next to a person as
  "studio_desk" or "table". Walls behind/beside subjects in podcast scenes are walls.
  Label them as "wall" with orientation:"vertical".
- Couch backs, chair backs, headboards: not desks. If they're flat enough to hold a
  poster they could be "wall" (vertical). If they're horizontal arm-rests with width,
  they could be "table" but only if visible flat top is wide enough for a product.
- When in doubt between desk and wall, ask: would a glass of water naturally rest on
  this surface without falling? If no → it's not horizontal → it's wall (or filter).

HORIZONTAL surface bounding box rules:
- The box must cover ONLY the visible flat top where a product could sit
- Do NOT include table legs, chairs, people, or the area BELOW or ABOVE the table
- A wide table at eye level is a THIN horizontal strip: x:15, y:55, width:70, height:10
- A desk slightly above eye level: x:20, y:50, width:40, height:20
- Box height should rarely exceed 30% of frame unless viewed top-down
- For eye-level tables/desks, box center y > 40% (lower portion of frame)

FLOOR surface rules (use surface_type:"floor", orientation:"horizontal"):
- Only flag floor space when there's a CLEARLY VISIBLE empty patch of indoor
  floor — wood, carpet, tile, concrete (interior), polished surfaces.
- Use case is products that rest on the floor: sneakers, shoe boxes, large
  drink bottles, decorative plants, suitcases, gym equipment, branded props.
- The floor patch must be:
  * IN FOCUS (not background blur)
  * Empty of clutter — no shoes/cables/feet currently on that exact spot
  * Big enough for a sneaker — at least 8% of frame area
  * In the LOWER portion of the frame (box center y > 60%)
- Box typically lives at the bottom of the frame: x:10, y:65, width:35, height:25
  (a clear patch of carpet at someone's feet but not under their feet).
- Do NOT flag the floor BENEATH a person's feet — they're standing on it.
- Do NOT flag floor that's mostly out of focus (depth-of-field background).
- Outdoor ground (sidewalks, asphalt, grass) is NOT floor — those stay excluded.
- IN SEATED / TALKING-HEAD CONTENT, floor is LOW priority and error-prone: a lap,
  dark clothing, a shadow, or a letterbox/black bar is NOT floor. Only flag floor
  if you see an unmistakable clean patch of real indoor floor in the LOWER THIRD of
  the frame (box center y > 65). When unsure, drop the floor and return the
  backdrop wall instead — the wall is almost always the better placement anyway.

VERTICAL surface bounding box rules:
- The box must cover only the EMPTY/UNOBSTRUCTED part of the wall/door/window
- Do NOT include picture frames already on the wall, light switches, or wall fixtures
- Do NOT include parts blocked by furniture or people
- Walls usually have generous height: x:10, y:10, width:30, height:50 is normal
- Box should be a substantial usable plane, not tiny patches between objects
- The wall must be IN FOCUS — out-of-focus background walls are not placement surfaces

PODCAST / INTERVIEW / TALKING-HEAD RULES (this is the primary content — get it right):
- These frames almost ALWAYS have at least one usable surface: the backdrop wall
  behind/beside the speaker. Find it. "Default to empty" is WRONG for this content.
- BACKDROP WALL (highest-value surface): the vertical plane behind the speaker.
  Flag it as surface_type:"wall", orientation:"vertical". Box the EMPTY region to
  the LEFT or RIGHT of the speaker's head and shoulders — the box must NOT overlap
  the person's head, face, or body. If wall is visible on both sides, pick the
  larger/cleaner empty side. A softly-lit or lightly-textured studio backdrop
  still counts — it does NOT have to be a pristine blank wall. Skip it only if it
  is FULLY blocked by the person or completely out of focus.
- A plain painted / curtained / panelled studio backdrop IS a valid placement wall
  — that is exactly where sponsor signage goes. Only an EXISTING framed artwork or
  a wall already packed with posters/shelves is off-limits, and then you place in
  the empty area BESIDE it, not on it.
- STUDIO DESK / TABLE in front of the speaker: flag as "studio_desk" or "table"
  (horizontal) when the flat top plane is visible (where the mic / water bottle
  rests). Box only the visible empty top — not the front edge, not the equipment.
  If you can see only the front edge or the gear but not the top plane, skip it.
- The COUCH / CHAIR the person sits IN is never a surface — arm-rests, cushions,
  seat-backs, and throw pillows are all excluded — but the WALL behind that couch
  still is, so return the wall.
- A coffee/side table counts only if its flat TOP is clearly visible (not fully
  occluded by legs, drinks already on it, or too low a camera angle).
- If you cannot describe in one sentence "there is a [surface_type] at [location]
  made of [material]," then it is not a real surface and should not be flagged.

GOOD SURFACES (flag up to 4 of these):
- Studio desks in podcast/recording setups (when desk top is visible)
- Desks, tables, countertops with visible flat area
- Shelves with clear space
- Nightstands, side tables, coffee tables
- Kitchen counters with some clear space
- Indoor FLOOR — clear empty patch of wood, carpet, tile, polished concrete
  (in focus, not under someone's feet, big enough for a sneaker/large product)
- Walls with substantial empty/unobstructed sections (in focus)
- Doors (when prominently visible in frame, not just edges)
- Large windows (when behind something brand-relevant could go)

PRIORITY GUIDANCE — DON'T LET TABLES CROWD OUT EVERYTHING:
A common failure mode: when a frame has a side table + a clearly visible
bookshelf + visible floor + visible wall, you return TWO instances of the
side table (or duplicate detections of one table) and miss the bookshelf,
floor, and wall. With the 4-surface cap, prefer DIVERSITY over duplicates:
- If a substantial bookshelf is clearly visible (in focus, books/items
  visible, multiple shelves), it MUST be one of your returned surfaces.
  Don't skip it for a third side-table detection.
- If a clear empty patch of indoor floor is visible in the lower frame
  (carpet, wood, tile — at someone's feet but not under them), include it
  as surface_type:"floor", orientation:"horizontal".
- If a substantial empty wall is visible (in focus, not blurred, not
  covered in art), include it as surface_type:"wall", orientation:"vertical".
- Among the 4 returned: aim for at most ONE of each
  {coffee_table, side_table, nightstand, table} unless there are genuinely
  two distinct tables in the scene at different positions.

BAD "SURFACES" (do NOT flag):
- Roads, highways, pavement, outdoor ground (asphalt, dirt, grass)
- Ceilings, curtains
- Sky, trees, outdoor scenery without architectural features
- Building exteriors, bridges, vehicles
- Walls that are completely out of focus (background blur)
- Walls already covered with art, posters, or shelving (no usable empty area)
- Dark regions below a person's chest/torso
- Inferred/assumed surfaces not clearly visible
- A person's lap, thighs, or clothing
- Laptop screens, monitor faces, camera housings
- Microphone boom arms, monitor stands

CONFIDENCE GUIDANCE:
- Use >0.7 only if surface is clearly, unambiguously visible with usable area
- Use 0.4-0.6 for partially visible or partially obstructed
- Use <0.4 for uncertain (will be filtered out — better to omit)

PEOPLE BOXES (REQUIRED — powers person-overlap verification downstream):
Alongside the surfaces, return a bounding box for EVERY visible person,
covering their full visible extent INCLUDING the chair/couch section they
occupy. Be generous — slightly too large is better than too small. These
boxes are how the pipeline confirms no surface overlaps a person, which is
what allows real side tables next to a host and the wall between two
subjects to be kept. If no people are visible, return "people": [].

For each surface, provide:
- **location**: bounding box {x, y, width, height} in percentages (0-100)
- **orientation**: "horizontal" or "vertical"
- **surface_type**: desk, table, shelf, counter, nightstand, side_table, coffee_table, studio_desk, floor, rug, couch, wall, door, window
- **confidence**: 0.0 to 1.0 (see guidance above)
- **reasoning**: brief explanation
- **lighting_direction**: "left", "right", "top", "top-left", "top-right", "ambient"
- **lighting_intensity**: 0.0 to 1.0
- **camera_angle**: "eye-level", "slightly-above", "top-down", "low-angle"

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "surfaces_found": true,
  "frame_description": "Brief description of what's in the frame",
  "people": [
    {"location": {"x": 5, "y": 18, "width": 28, "height": 78}},
    {"location": {"x": 66, "y": 20, "width": 30, "height": 76}}
  ],
  "surfaces": [
    {
      "location": {"x": 20, "y": 55, "width": 30, "height": 20},
      "orientation": "horizontal",
      "surface_type": "studio_desk",
      "confidence": 0.85,
      "reasoning": "Clear studio desk surface, well-lit, main placement area",
      "lighting_direction": "top-left",
      "lighting_intensity": 0.7,
      "camera_angle": "slightly-above"
    },
    {
      "location": {"x": 5, "y": 5, "width": 35, "height": 45},
      "orientation": "vertical",
      "surface_type": "wall",
      "confidence": 0.75,
      "reasoning": "Empty unobstructed wall section behind subject, in focus",
      "lighting_direction": "top",
      "lighting_intensity": 0.6,
      "camera_angle": "eye-level"
    }
  ],
  "recommended_placement": {
    "location": {"x": 25, "y": 58, "width": 15, "height": 12},
    "reason": "Best spot — clear area on desk near subject"
  }
}

If NO suitable surfaces exist:
{
  "surfaces_found": false,
  "frame_description": "Description of frame",
  "people": [{"location": {"x": 30, "y": 10, "width": 42, "height": 88}}],
  "surfaces": [],
  "recommended_placement": null,
  "no_surface_reason": "Why no placement works here"
}

Analyze the frame now:`;

// ============================================================================
// LOCAL ASSET MAP
// ============================================================================

const LOCAL_ASSET_MAP: Record<string, string> = {
  // Production video - permanently deployed
  'upload-1769888669571-r3dd53': './public/videos/many_jobs.mov',
  // Test video 2 - Bar table test
  'test-video-2': './public/videos/test_video2.mov',
  'upload-test-video-2': './public/videos/test_video2.mov',
  // Test2.mov - Podcast sample (separate from test_video2.mov)
  'test-podcast-sample': './public/videos/Test2.mov',
  // Legacy mappings
  'yt_techguru_001': './public/videos/many_jobs.mov',
  'yt_beauty_02': './public/hero_video.mp4',
  'test-video-1': './public/hero_video.mp4',
  'hero-local-001': './public/hero_video.mp4',
  'many-jobs-test': './public/videos/many_jobs.mov',
  'local-many-jobs': './public/videos/many_jobs.mov',
  'prod-many-jobs': './public/videos/many_jobs.mov',
};

export function addToLocalAssetMap(videoId: string, filePath: string): void {
  LOCAL_ASSET_MAP[videoId] = filePath;
  console.log(`[Scanner V2] Added to LOCAL_ASSET_MAP: ${videoId} -> ${filePath}`);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/** Parse a stored duration to seconds. Returns null if unparseable.
 *  Accepts ISO 8601 ("PT1H46M2S", "PT30M", "PT45S" — YouTube Data API
 *  format, stored verbatim on video_index.duration), plain numeric seconds
 *  ("2760"), and colon clock formats ("46:03", "1:46:02" — the Facebook
 *  Graph importer stores durations this way, and rejecting them silently
 *  degraded every FB scan to the unknown-duration grid). Supports hours,
 *  minutes, seconds; ignores days/weeks since none of our sources use them. */
function parseIsoDuration(input: string | null | undefined): number | null {
  if (!input || typeof input !== "string") return null;
  // Plain seconds (already-numeric) — accept e.g. "2760"
  const numeric = Number(input);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  // Colon clock format: "M:SS" or "H:MM:SS"
  const clock = input.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const total = clock[3] !== undefined
      ? parseInt(clock[1], 10) * 3600 + parseInt(clock[2], 10) * 60 + parseInt(clock[3], 10)
      : parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
    return total > 0 ? total : null;
  }
  const m = input.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const hours = parseInt(m[1] || "0", 10);
  const minutes = parseInt(m[2] || "0", 10);
  const seconds = parseFloat(m[3] || "0");
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

async function getAvailableDiskSpaceMB(): Promise<number> {
  try {
    const tmpDir = os.tmpdir();
    return new Promise((resolve) => {
      const df = spawn("df", ["-m", tmpDir]);
      let output = "";
      
      df.stdout.on("data", (data) => {
        output += data.toString();
      });
      
      df.on("close", () => {
        const lines = output.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          if (parts.length >= 4) {
            const availableMB = parseInt(parts[3], 10);
            if (!isNaN(availableMB)) {
              resolve(availableMB);
              return;
            }
          }
        }
        // Fail open: an unparseable df must not block scans — the floor can
        // exceed 1GB for long videos, so a finite guess here could veto a
        // legitimate scan. Report Infinity, but say so: a scan that ENOSPCs
        // after this passed is otherwise baffling.
        console.warn(`[Scanner V2] df output unparseable — treating disk as sufficient (fail-open)`);
        resolve(Number.POSITIVE_INFINITY);
      });

      df.on("error", () => {
        console.warn(`[Scanner V2] df failed to spawn — treating disk as sufficient (fail-open)`);
        resolve(Number.POSITIVE_INFINITY);
      });
    });
  } catch {
    console.warn(`[Scanner V2] Disk space check threw — treating disk as sufficient (fail-open)`);
    return Number.POSITIVE_INFINITY;
  }
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Scanner V2] Deleted: ${filePath}`);
    }
  } catch (err) {
    console.error(`[Scanner V2] Failed to delete ${filePath}:`, err);
  }
}

function safeRmdir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`[Scanner V2] Removed directory: ${dirPath}`);
    }
  } catch (err) {
    console.error(`[Scanner V2] Failed to remove directory ${dirPath}:`, err);
  }
}

/**
 * Compare-and-set terminal status write. The cancel-scan route flips status
 * away from "Scanning" and returns success to the creator immediately, while
 * the scan's post-processing phases keep running for minutes — an
 * unconditional write at finalize would then stamp "Ready (N Spots)" over
 * the cancel, silently un-cancelling it. The single conditional UPDATE in
 * storage only writes while the row still says "Scanning", so a cancel (or
 * stuck-scan sweep) that lands at any point wins. Returns whether the write
 * happened.
 */
async function updateStatusIfStillScanning(videoId: number, status: string): Promise<boolean> {
  const updated = await storage.updateVideoStatusIfScanning(videoId, status);
  if (!updated) {
    console.log(`[Scanner V2] Skipping status "${status}" for video ${videoId} — row is no longer "Scanning" (cancelled or swept mid-scan); preserving the current status`);
  }
  return updated;
}

async function getFrameMetadata(framePath: string): Promise<{ width: number; height: number; isVertical: boolean }> {
  try {
    const metadata = await sharp(framePath).metadata();
    const width = metadata.width || 1920;
    const height = metadata.height || 1080;
    const isVertical = (width / height) < CONFIG.VERTICAL_ASPECT_THRESHOLD;
    return { width, height, isVertical };
  } catch {
    return { width: 1920, height: 1080, isVertical: false };
  }
}

// ============================================================================
// FRAME EXTRACTION (FFmpeg)
// ============================================================================

async function extractFrames(
  videoPath: string,
  outputDir: string,
  opts: { intervalSeconds?: number; maxFrames?: number } = {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const intervalSeconds = opts.intervalSeconds ?? CONFIG.FRAME_INTERVAL_SECONDS;
    const maxFrames = opts.maxFrames ?? CONFIG.MAX_FRAMES_PER_VIDEO;
    const absoluteVideoPath = path.resolve(videoPath);
    const absoluteOutputDir = path.resolve(outputDir);
    const outputPattern = path.join(absoluteOutputDir, "frame_%04d.jpg");

    console.log(`[Scanner V2] Extracting frames from: ${absoluteVideoPath}`);
    console.log(`[Scanner V2] Output directory: ${absoluteOutputDir}`);
    console.log(`[Scanner V2] Plan: every ${intervalSeconds}s, up to ${maxFrames} frames`);

    if (!fs.existsSync(absoluteVideoPath)) {
      reject(new Error(`Video file not found: ${absoluteVideoPath}`));
      return;
    }

    fs.mkdirSync(absoluteOutputDir, { recursive: true });

    const scaleFilter = `scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`;

    // SPARSE plans (long videos, one frame every 10s+) must NOT use the
    // single-pass fps filter: it decodes the ENTIRE file to emit a handful
    // of frames — ~20min of decode for an hour at Replit's ~3x realtime,
    // which no flat timeout survives (the 61-min uniform fallback died at
    // frame 2). Input-seeking per slot decodes ~one GOP per frame instead:
    // ~40 seeks finish in a couple of minutes with a per-frame timeout.
    // Slot numbers stay in the filename (frame_%04d, 1-based like the
    // fps-filter output) so the caller can recover honest timestamps even
    // when a mid-list slot fails.
    if (intervalSeconds >= 10) {
      (async () => {
        const extracted: string[] = [];
        let consecutiveFailures = 0;
        for (let i = 0; i < maxFrames; i++) {
          const t = i * intervalSeconds;
          const out = path.join(absoluteOutputDir, `frame_${String(i + 1).padStart(4, "0")}.jpg`);
          const ok = await new Promise<boolean>((res) => {
            const p = spawn("ffmpeg", [
              "-nostdin", "-y",
              "-ss", t.toString(),
              "-i", absoluteVideoPath,
              "-an",
              "-frames:v", "1",
              "-pix_fmt", "yuvj420p",
              "-vf", scaleFilter,
              "-q:v", "2",
              out,
            ]);
            const tm = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} res(false); }, 30_000);
            p.on("close", (c) => {
              clearTimeout(tm);
              try {
                res(c === 0 && fs.existsSync(out) && fs.statSync(out).size > 4096);
              } catch { res(false); }
            });
            p.on("error", () => { clearTimeout(tm); res(false); });
          });
          if (ok) {
            extracted.push(out);
            consecutiveFailures = 0;
          } else {
            try { fs.unlinkSync(out); } catch { /* never written */ }
            consecutiveFailures++;
            // Three misses in a row means we've seeked past the real end of
            // the file (plan duration can overshoot actual) or the file is
            // unreadable — either way, stop burning 30s per empty slot.
            if (consecutiveFailures >= 3) {
              console.log(`[Scanner V2] Seek extraction stopping at slot ${i + 1}/${maxFrames} (3 consecutive misses — likely past end of file)`);
              break;
            }
          }
        }
        console.log(`[Scanner V2] Extracted ${extracted.length} frames (per-seek sparse mode, every ${intervalSeconds}s)`);
        resolve(extracted);
      })().catch(reject);
      return;
    }

    const ffmpegArgs = [
      "-nostdin",               // Non-interactive mode
      "-y",                     // Overwrite output files
      "-i", absoluteVideoPath,
      "-an",                    // Skip audio (faster, avoids codec issues)
      "-vsync", "vfr",         // Variable frame rate (prevents duplicate frames)
      "-pix_fmt", "yuvj420p",  // Force JPEG-compatible pixel format (fixes HEVC/HDR)
      "-vf", `fps=1/${intervalSeconds},${scaleFilter}`,
      "-q:v", "2",
      "-frames:v", maxFrames.toString(),
      outputPattern,
    ];

    console.log(`[Scanner V2] FFmpeg command: ffmpeg ${ffmpegArgs.join(" ")}`);

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // The fps filter decodes up to spanSec of video to emit its frames —
    // budget ~700ms per source second (Replit decodes ~3x realtime), never
    // below the flat default, capped at 15 minutes.
    const spanSec = intervalSeconds * maxFrames;
    const timeoutMs = Math.min(15 * 60 * 1000, Math.max(CONFIG.FFMPEG_TIMEOUT_MS, spanSec * 700));
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    ffmpeg.on("close", (code) => {
      clearTimeout(timeout);
      
      if (code !== 0) {
        console.error(`[Scanner V2] FFmpeg failed with code ${code}`);
        console.error(`[Scanner V2] FFmpeg stderr: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg exited with code ${code}`));
        return;
      }
      
      try {
        const frames = fs.readdirSync(absoluteOutputDir)
          .filter(f => f.endsWith(".jpg"))
          .sort()
          .map(f => path.join(absoluteOutputDir, f));
        
        console.log(`[Scanner V2] Extracted ${frames.length} frames`);
        resolve(frames);
      } catch (err) {
        reject(err);
      }
    });
    
    ffmpeg.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Extract one frame at each requested timestamp. Used by the scene-first
 * scan path — instead of sampling the video uniformly every N seconds, we
 * sample at the midpoints of representative shots per unique scene.
 *
 * Returns parallel arrays so the caller can map frame[i] → its real
 * timestamp (vs. extractFrames where timestamp = i × interval).
 */
async function extractFramesAtTimestamps(
  videoPath: string,
  outputDir: string,
  timestamps: number[],
): Promise<{ frames: string[]; timestamps: number[] }> {
  const absoluteVideoPath = path.resolve(videoPath);
  const absoluteOutputDir = path.resolve(outputDir);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });

  const out: { frames: string[]; timestamps: number[] } = { frames: [], timestamps: [] };

  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const outPath = path.join(absoluteOutputDir, `scene_frame_${i.toString().padStart(4, "0")}.jpg`);

    const ok = await new Promise<boolean>((resolve) => {
      // -ss BEFORE -i = fast input seek (decoder skips most of the file).
      // 480 max dim is plenty for Gemini surface detection and saves bytes.
      const ff = spawn("ffmpeg", [
        "-nostdin",
        "-y",
        "-loglevel", "error",
        "-ss", String(Math.max(0, t)),
        "-i", absoluteVideoPath,
        "-an",
        "-frames:v", "1",
        "-pix_fmt", "yuvj420p",
        "-vf", `scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
        "-q:v", "2",
        outPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d) => { stderr += d.toString(); });
      const tm = setTimeout(() => {
        try { ff.kill("SIGKILL"); } catch {}
        console.warn(`[Scanner V2] Timestamp extract t=${t}s timed out`);
        resolve(false);
      }, 60_000);
      ff.on("close", (code) => {
        clearTimeout(tm);
        if (code === 0 && fs.existsSync(outPath)) {
          resolve(true);
        } else {
          if (stderr) {
            console.warn(`[Scanner V2] Timestamp extract t=${t}s failed: ${stderr.slice(-150)}`);
          }
          resolve(false);
        }
      });
      ff.on("error", (err) => {
        clearTimeout(tm);
        console.warn(`[Scanner V2] Timestamp extract spawn error t=${t}s: ${err.message}`);
        resolve(false);
      });
    });

    if (ok) {
      out.frames.push(outPath);
      out.timestamps.push(t);
    }
  }

  console.log(`[Scanner V2] Scene-first extraction: ${out.frames.length}/${timestamps.length} frames at requested timestamps`);
  return out;
}

/**
 * Extract frames directly from a remote CDN URL via ffmpeg HTTP-range seeking —
 * no full download, nothing written to disk except the sampled frame JPGs.
 *
 * This is the OAuth stream-and-scan path: for each timestamp, ffmpeg opens the
 * URL, issues an HTTP range request to seek near that timestamp (`-ss` before
 * `-i` = fast input seek), decodes one frame, and stops. For a well-indexed
 * progressive mp4 that pulls only the bytes around each frame, not the whole
 * video. `-reconnect*` flags make it resilient to the transient drops that CDN
 * range reads occasionally hit.
 */
async function extractFramesFromUrl(
  source: StreamSource,
  outputDir: string,
  timestamps: number[],
): Promise<{ frames: string[]; timestamps: number[] }> {
  const absoluteOutputDir = path.resolve(outputDir);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });

  const out: { frames: string[]; timestamps: number[] } = { frames: [], timestamps: [] };
  const headerArg = source.headers
    ? Object.entries(source.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n"
    : null;

  let consecutiveFailures = 0;
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const outPath = path.join(absoluteOutputDir, `stream_frame_${i.toString().padStart(4, "0")}.jpg`);

    const ok = await new Promise<boolean>((resolve) => {
      const args = [
        "-nostdin",
        "-y",
        "-loglevel", "error",
        // Resilience for CDN range reads.
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
      ];
      if (headerArg) args.push("-headers", headerArg);
      // A proxy-resolved CDN URL is IP-locked to the proxy's egress — ffmpeg
      // must fetch through the same proxy or googlevideo 403s every read.
      if (source.httpProxy) args.push("-http_proxy", source.httpProxy);
      args.push(
        "-ss", String(Math.max(0, t)),   // fast input seek — range-request to ~t
        "-i", source.url,
        "-an",
        "-frames:v", "1",
        "-pix_fmt", "yuvj420p",
        "-vf", `scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
        "-q:v", "2",
        outPath,
      );
      const ff = spawn("ffmpeg", args);
      let stderr = "";
      ff.stderr.on("data", (d) => { stderr += d.toString(); });
      const tm = setTimeout(() => {
        try { ff.kill("SIGKILL"); } catch {}
        console.warn(`[Scanner V2] Stream extract t=${t}s timed out`);
        resolve(false);
      }, 60_000);
      ff.on("close", (code) => {
        clearTimeout(tm);
        if (code === 0 && fs.existsSync(outPath)) {
          resolve(true);
        } else {
          if (stderr) console.warn(`[Scanner V2] Stream extract t=${t}s failed: ${stderr.slice(-160)}`);
          resolve(false);
        }
      });
      ff.on("error", (err) => {
        clearTimeout(tm);
        console.warn(`[Scanner V2] Stream extract spawn error t=${t}s: ${err.message}`);
        resolve(false);
      });
    });

    if (ok) {
      out.frames.push(outPath);
      out.timestamps.push(t);
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      // If the first several seeks all fail, the URL is unusable (expired,
      // DASH-only, geo-blocked). Bail early so we fall through to the download
      // fallback instead of grinding through 24 timeouts.
      if (consecutiveFailures >= 3 && out.frames.length === 0) {
        console.warn(`[Scanner V2] Stream extraction: ${consecutiveFailures} consecutive failures with 0 frames — aborting stream path`);
        break;
      }
    }
  }

  console.log(`[Scanner V2] Stream extraction: ${out.frames.length}/${timestamps.length} frames pulled from CDN URL`);
  return out;
}

/**
 * Dense uniform frame extraction from a remote CDN URL in a SINGLE ffmpeg pass
 * (fps filter). The stream flows through ffmpeg transiently — frames are kept,
 * the video bytes are never saved to disk. This is far more efficient than N
 * per-timestamp seeks when we want a dense grid (one process, sequential read),
 * and dense sampling is what maximizes surface-detection recall: we want to SEE
 * every distinct scene at least once so no placement surface is skipped.
 */
async function extractFramesUniformFromUrl(
  source: StreamSource,
  outputDir: string,
  intervalSeconds: number,
  maxFrames: number,
): Promise<{ frames: string[]; timestamps: number[]; complete: boolean }> {
  const absoluteOutputDir = path.resolve(outputDir);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });
  const outputPattern = path.join(absoluteOutputDir, "grid_%04d.jpg");
  const headerArg = source.headers
    ? Object.entries(source.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n"
    : null;

  return new Promise((resolve) => {
    const args = [
      "-nostdin",
      "-y",
      "-loglevel", "error",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      // The -reconnect family only fires on connection close/EOF. googlevideo
      // sometimes throttles an OPEN socket to zero bytes (stale n-parameter
      // descramble) — without an I/O timeout ffmpeg sits mute until the 8-min
      // SIGKILL below. 30s of no bytes = abort (and reconnect) instead.
      "-rw_timeout", "30000000",
      // Mid-read in-band 403/5xx (CDN URL invalidated by SABR rotation) is
      // fatal without this — it's an HTTP error, not a connection drop.
      "-reconnect_on_http_error", "4xx,5xx",
    ];
    if (headerArg) args.push("-headers", headerArg);
    // A proxy-resolved CDN URL is IP-locked to the proxy's egress — ffmpeg
    // must fetch through the same proxy or googlevideo 403s every read.
    if (source.httpProxy) args.push("-http_proxy", source.httpProxy);
    args.push(
      "-i", source.url,
      "-an",
      "-vsync", "vfr",
      "-pix_fmt", "yuvj420p",
      "-vf", `fps=1/${intervalSeconds},scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "2",
      "-frames:v", String(maxFrames),
      outputPattern,
    );

    const ff = spawn("ffmpeg", args);
    let stderr = "";
    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    const tm = setTimeout(() => {
      try { ff.kill("SIGKILL"); } catch {}
      console.warn(`[Scanner V2] Dense stream extraction timed out`);
      // Resolve with whatever landed so far — the caller's coverage gate
      // decides whether a partial grid is usable or the download path runs.
      resolve(collectGrid(true));
    }, 8 * 60 * 1000);

    // dirtyExit: ffmpeg was killed or died nonzero, so the highest-numbered
    // grid file may have been truncated mid-write. A truncated JPEG can
    // exceed the size floor below yet still crash sharp's decoder, and the
    // dHash-null fallback treats it as its own scene — GUARANTEEING its
    // selection for detection — so drop the tail file outright. A CLEAN
    // exit means ffmpeg read the entire input (or hit the -frames:v cap),
    // so the grid is complete no matter how few frames it holds — exposed
    // as `complete` for the caller's coverage gate.
    const collectGrid = (dirtyExit: boolean): { frames: string[]; timestamps: number[]; complete: boolean } => {
      let files: string[] = [];
      try {
        files = fs.readdirSync(absoluteOutputDir)
          .filter(f => f.startsWith("grid_") && f.endsWith(".jpg"))
          .filter(f => {
            // Size floor: a SIGKILL mid-write leaves stub JPEGs that pass
            // the filename glob; anything under 4KB isn't a decodable frame.
            try { return fs.statSync(path.join(absoluteOutputDir, f)).size >= 4096; }
            catch { return false; }
          })
          .sort();
      } catch { /* ignore */ }
      if (dirtyExit && files.length > 0) {
        const dropped = files.pop()!;
        console.warn(`[Scanner V2] Dense grid: dropping tail file ${dropped} (ffmpeg exited dirty — possible mid-write truncation)`);
      }
      const frames = files.map(f => path.join(absoluteOutputDir, f));
      // image2 numbers from grid_0001 up, so file NNNN is ~ (NNNN-1)*interval
      // seconds. Derive from the filename rather than the array index so a
      // file dropped by the size floor doesn't shift every later timestamp.
      const timestamps = files.map((f, i) => {
        const seq = parseInt(f.match(/grid_(\d+)\.jpg$/)?.[1] ?? "", 10);
        return (Number.isFinite(seq) && seq >= 1 ? seq - 1 : i) * intervalSeconds;
      });
      return { frames, timestamps, complete: !dirtyExit };
    };

    ff.on("close", (code) => {
      clearTimeout(tm);
      if (code !== 0 && stderr) {
        console.warn(`[Scanner V2] Dense stream extraction ffmpeg code ${code}: ${stderr.slice(-200)}`);
      }
      resolve(collectGrid(code !== 0));
    });
    ff.on("error", (err) => {
      clearTimeout(tm);
      console.warn(`[Scanner V2] Dense stream extraction spawn error: ${err.message}`);
      resolve(collectGrid(true));
    });
  });
}

/**
 * Select a scene-complete, evenly-distributed subset of frames for detection.
 *
 * Detection recall depends on SEEING every distinct scene at least once — a
 * surface only visible in one shot is missed if that shot is skipped. So we:
 *   1. dHash every dense-grid candidate.
 *   2. Cluster ALL candidate hashes into RECURRING scene classes (single-link,
 *      same clustering the download path's sceneIndex uses). A multicam
 *      podcast alternating host/guest/wide is 3 classes, not 60 segments —
 *      contiguous same-class runs are the "shots" of a grid-derived scene
 *      index that the caller persists exactly like the download path's.
 *   3. Allocate the detection budget ACROSS CLASSES proportionally to each
 *      class's total screen time (≥2 frames per class where possible), and
 *      spread each class's picks evenly across ALL of its occurrences. This
 *      covers the whole timeline — the previous chronological midpoint pass
 *      exhausted the budget on the first ~60 segments, leaving the back half
 *      of a fast-cutting episode unseen.
 * Non-selected frames are deleted immediately to bound temp usage.
 */
async function selectDiverseFrames(
  frames: string[],
  timestamps: number[],
  opts: { hashThreshold: number; budget: number },
): Promise<{ frames: string[]; timestamps: number[]; segmentIds: number[]; sceneIndex: SceneIndex | null }> {
  if (frames.length === 0) return { frames: [], timestamps: [], segmentIds: [], sceneIndex: null };

  // 1. Hash every candidate (parallel-ish; computeDHash is I/O light).
  const hashes: (string | null)[] = [];
  for (let i = 0; i < frames.length; i++) {
    try { hashes.push(await computeDHash(frames[i])); } catch { hashes.push(null); }
  }

  // 2. Cluster candidates into recurring scene classes. Failed hashes get the
  //    same 'fail'-prefixed sentinel shape the sceneIndex builder uses — the
  //    clusterer isolates those as singletons instead of chaining them.
  let classIds: number[];
  let gridSceneIndex: SceneIndex | null = null;
  let classesAreRecurring = true;
  const safeHashes = hashes.map((h, i) => h ?? `fail${i.toString(16).padStart(12, "0")}`);
  try {
    classIds = clusterHashes(safeHashes);
  } catch (clusterErr: any) {
    // Degraded fallback: hash-jump segmentation (each contiguous segment its
    // own class — no recurrence merging, but allocation still spans the
    // timeline). No scene index is synthesized in this mode.
    console.warn(`[Scanner V2] Grid hash clustering failed (segment fallback):`, clusterErr?.message || clusterErr);
    classesAreRecurring = false;
    classIds = new Array(frames.length).fill(0);
    let seg = 0;
    for (let i = 1; i < frames.length; i++) {
      const prev = hashes[i - 1];
      const cur = hashes[i];
      if (prev === null || cur === null || hammingDistance(cur, prev) >= opts.hashThreshold) seg++;
      classIds[i] = seg;
    }
  }

  // 3. Contiguous same-class runs = shots of the grid-derived scene index.
  //    tEnd of a run is the next run's tStart; the last run extends one grid
  //    interval past its final frame (the frame represents that interval).
  const runs: Array<{ start: number; end: number; classId: number }> = [];
  let runStart = 0;
  for (let i = 1; i < frames.length; i++) {
    if (classIds[i] !== classIds[i - 1]) {
      runs.push({ start: runStart, end: i - 1, classId: classIds[runStart] });
      runStart = i;
    }
  }
  runs.push({ start: runStart, end: frames.length - 1, classId: classIds[runStart] });

  const gridStep = frames.length > 1
    ? (timestamps[timestamps.length - 1] - timestamps[0]) / (frames.length - 1)
    : 1;
  if (classesAreRecurring && new Set(classIds).size > 0) {
    gridSceneIndex = {
      shots: runs.map((r, idx) => ({
        shotIdx: idx,
        sceneId: r.classId,
        tStart: timestamps[r.start],
        tEnd: idx + 1 < runs.length ? timestamps[runs[idx + 1].start] : timestamps[r.end] + gridStep,
        hash: safeHashes[Math.floor((r.start + r.end) / 2)],
      })),
      sceneCount: new Set(classIds).size,
      cuts: runs.slice(1).map(r => timestamps[r.start]),
    };
  }

  // 4. Budget allocation across classes, proportional to class screen time.
  //    The grid is uniform, so a class's candidate count IS its duration
  //    share. Every class gets 1 frame, then a 2nd where it has one (the
  //    consensus vote needs two independent samples), then extras flow to
  //    the classes with the most unsampled screen time.
  const classFrames = new Map<number, number[]>();
  for (let i = 0; i < frames.length; i++) {
    const arr = classFrames.get(classIds[i]) ?? [];
    arr.push(i);
    classFrames.set(classIds[i], arr);
  }
  const classesByDur = Array.from(classFrames.entries()).sort((a, b) => b[1].length - a[1].length);
  const alloc = new Map<number, number>();
  let remaining = opts.budget;
  for (const [cls] of classesByDur) {
    if (remaining <= 0) break;
    alloc.set(cls, 1);
    remaining--;
  }
  for (const [cls, idxs] of classesByDur) {
    if (remaining <= 0) break;
    if (alloc.get(cls) === 1 && idxs.length >= 2) {
      alloc.set(cls, 2);
      remaining--;
    }
  }
  while (remaining > 0) {
    // One frame at a time to the class with the most candidates per pick —
    // largest-remainder-style proportionality without float bookkeeping.
    let bestCls: number | null = null;
    let bestRatio = 0;
    for (const [cls, idxs] of classesByDur) {
      const cur = alloc.get(cls) ?? 0;
      if (cur >= idxs.length) continue; // class fully sampled
      const ratio = idxs.length / (cur + 1);
      if (ratio > bestRatio) { bestRatio = ratio; bestCls = cls; }
    }
    if (bestCls === null) break; // every candidate already picked
    alloc.set(bestCls, (alloc.get(bestCls) ?? 0) + 1);
    remaining--;
  }

  // 5. Within each class, spread picks evenly across its chronological
  //    candidate list — the list spans every occurrence of the class, so a
  //    class recurring at 2min and 55min gets sampled at both ends.
  const picks = new Set<number>();
  for (const [cls, idxs] of classesByDur) {
    const n = alloc.get(cls) ?? 0;
    for (let k = 0; k < n; k++) {
      picks.add(idxs[Math.min(idxs.length - 1, Math.floor(((k + 0.5) * idxs.length) / n))]);
    }
  }

  // 6. Materialize selection; unlink the rest.
  const selectedIdx = Array.from(picks).sort((a, b) => a - b);
  const selectedSet = new Set(selectedIdx);
  for (let i = 0; i < frames.length; i++) {
    if (!selectedSet.has(i)) safeUnlink(frames[i]);
  }

  console.log(`[Scanner V2] Scene-class selection: ${classFrames.size} recurring class(es) across ${runs.length} run(s) from ${frames.length} candidates → ${selectedIdx.length} detection frames (budget ${opts.budget})`);
  // Segment id per selected frame — the contiguous-run segmentation computed
  // above. The streamed path uses these as consensus groups only when no
  // scene index could be synthesized, so cross-scene detections never vote
  // for each other even in the degraded mode.
  const segmentOf = (idx: number): number => {
    for (let r = 0; r < runs.length; r++) {
      if (idx >= runs[r].start && idx <= runs[r].end) return r;
    }
    return 0;
  };
  return {
    frames: selectedIdx.map(i => frames[i]),
    timestamps: selectedIdx.map(i => timestamps[i]),
    segmentIds: selectedIdx.map(segmentOf),
    sceneIndex: gridSceneIndex,
  };
}

/**
 * Detect scene-cut timestamps in a video using ffmpeg's scene filter.
 *
 * Why: When the camera cuts to a different shot (e.g. wide podcast room →
 * solo close-up), surfaces from one shot shouldn't merge with surfaces
 * from the next, and product placements made in shot A shouldn't render
 * in shot B. This function returns the timestamps (seconds) of detected
 * cuts so downstream code can group surfaces by shot.
 *
 * Approach: ffmpeg's `select=gt(scene,N)` filter computes the per-frame
 * scene-change probability (0-1, based on histogram diff between frames);
 * when it crosses N (default 0.3), ffmpeg flags it as a cut. We pipe the
 * showinfo output to stderr and parse `pts_time:` lines.
 *
 * Returns: sorted array of seconds, e.g. [12.5, 28.0, 45.2]. Always
 * includes 0 implicitly as the start of the first shot — callers can
 * prepend if needed. Empty array means no cuts detected (single shot).
 *
 * Cost: one extra ffmpeg pass over the video. ~10-20% of extract time.
 * Acceptable since we already have the file local at this point.
 */
async function detectSceneCuts(
  videoPath: string,
  threshold: number = 0.3,
): Promise<number[]> {
  return new Promise((resolve) => {
    const absoluteVideoPath = path.resolve(videoPath);
    if (!fs.existsSync(absoluteVideoPath)) {
      console.warn(`[Scene Cuts] Video not found: ${absoluteVideoPath}`);
      resolve([]);
      return;
    }

    // -vf "scale=320:-2,select='gt(scene,T)',showinfo" prints info for each
    // detected cut. The 320px downscale runs BEFORE the scene filter — the
    // histogram diff is resolution-independent for cut detection, and scoring
    // full-res 1080p frames is what made hour-long files blow past the
    // timeout (empty cut list → sceneCount=1 → 6 frames for the whole hour).
    // -an drops audio (faster). -f null discards the output (we only want stderr).
    const args = [
      "-nostdin",
      "-i", absoluteVideoPath,
      "-an",
      "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ];

    console.log(`[Scene Cuts] Detecting cuts (threshold=${threshold}) in ${absoluteVideoPath}`);
    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => { stderr += data.toString(); });

    // Cap at 10 minutes. Even with the 320px downscale, the DECODE of an
    // hour-long file can outrun this on Replit CPU (~3x realtime ≈ 20min for
    // 61min of video) — but by then stderr already holds every cut found so
    // far. So the timeout only kills the process; the close handler that
    // follows parses the partial stderr and resolves with real cuts covering
    // the decoded prefix, which beats an empty list by miles (empty →
    // sceneCount=1 → degenerate sampling). A backstop resolves [] if the
    // close event somehow never arrives after the kill.
    let settled = false;
    let timedOut = false;
    const settle = (cuts: number[]) => {
      if (settled) return;
      settled = true;
      resolve(cuts);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try { ffmpeg.kill("SIGKILL"); } catch {}
      console.warn(`[Scene Cuts] Timed out after 10min — will parse partial cut list from decoded prefix`);
      setTimeout(() => {
        if (!settled) {
          console.warn(`[Scene Cuts] No close event after kill — returning empty cut list`);
          settle([]);
        }
      }, 15_000).unref();
    }, 10 * 60 * 1000);

    ffmpeg.on("close", () => {
      clearTimeout(timeout);
      // showinfo lines look like: "[Parsed_showinfo_1 @ 0x...] n: 0 pts: ... pts_time:12.5 ..."
      // We extract the pts_time values.
      const cuts: number[] = [];
      const re = /pts_time:(\d+(?:\.\d+)?)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (Number.isFinite(t) && t > 0) cuts.push(t);
      }
      // Dedup + sort (shouldn't have duplicates but be safe).
      const sorted = Array.from(new Set(cuts)).sort((a, b) => a - b);
      const partialNote = timedOut && sorted.length > 0
        ? ` (PARTIAL — decode killed at 10min; cuts cover first ~${sorted[sorted.length - 1].toFixed(0)}s, the remainder becomes one tail shot)`
        : "";
      console.log(`[Scene Cuts] Detected ${sorted.length} cut(s)${partialNote}: ${sorted.slice(0, 10).map(t => t.toFixed(1)).join(", ")}${sorted.length > 10 ? " ..." : ""}`);
      settle(sorted);
    });

    ffmpeg.on("error", (err) => {
      clearTimeout(timeout);
      console.warn(`[Scene Cuts] ffmpeg spawn failed (non-fatal):`, err?.message || err);
      settle([]);
    });
  });
}

/**
 * Given a sorted list of scene-cut timestamps and a target timestamp,
 * return the 0-indexed scene block ID. Block N covers [cuts[N-1], cuts[N]),
 * with block 0 starting at 0. Out-of-range timestamps clamp to the last
 * block. Used downstream to constrain clusterSurfaces so the same
 * "Coffee Table" detection in two different shots doesn't merge.
 */
function sceneBlockForTimestamp(cuts: number[], t: number): number {
  if (cuts.length === 0 || t < 0) return 0;
  // cuts are start-of-new-shot. If t < cuts[0], block 0.
  // If cuts[i-1] <= t < cuts[i], block i.
  for (let i = 0; i < cuts.length; i++) {
    if (t < cuts[i]) return i;
  }
  return cuts.length;
}

/**
 * Probe a LOCAL file's duration with ffprobe. Uploads carry no DB duration
 * (YouTube imports store ISO 8601, uploads store nothing), and scanning a
 * local file blind against the CONFIG default plan meant a 61-minute upload
 * scanned only its first 48 seconds. Returns 0 on any failure — callers
 * treat that as "duration unknown" and keep their existing plan.
 */
async function probeLocalDurationSec(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const ff = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    let out = "";
    ff.stdout.on("data", (d) => { out += d.toString(); });
    ff.on("close", () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    });
    ff.on("error", () => resolve(0));
  });
}

// ============================================================================
// EDGE-BASED SURFACE DETECTION (Sharp)
// ============================================================================

/**
 * FullScale Edge V2 — Smart surface detection using Sharp image analysis.
 *
 * Approach:
 * 1. Scan full frame for horizontal edge rows (gradient between above/below pixels)
 * 2. Cluster edge-dense rows into surface bands (groups of adjacent rows with edges)
 * 3. For each band, find horizontal extent by scanning columns for edge density
 * 4. Classify surface type based on vertical position in frame
 * 5. Score confidence based on edge continuity, band thickness, and position
 *
 * This produces tight, accurate bounding boxes around actual flat surfaces.
 */
async function analyzeFrameForSurfaces(
  framePath: string,
  timestamp: number,
  isVertical: boolean
): Promise<FrameAnalysisResult> {
  const defaultResult: FrameAnalysisResult = {
    hasSurface: false,
    confidence: 0,
    surfaces: [],
    isVertical,
  };

  try {
    const image = sharp(framePath);
    const metadata = await image.metadata();
    const width = metadata.width || 640;
    const height = metadata.height || 480;

    // Analyze full frame in greyscale
    const buffer = await image.greyscale().raw().toBuffer();

    if (buffer.length !== width * height) {
      console.log(`[Scanner V2] Buffer mismatch: expected ${width * height}, got ${buffer.length}`);
      return defaultResult;
    }

    // Step 1: For each row, compute horizontal edge score
    // A row with a strong horizontal edge has a long consecutive run of vertical gradients
    const rowScores: { edgeCount: number; maxRun: number; runStart: number; runEnd: number }[] = [];

    for (let y = 2; y < height - 2; y++) {
      let edgeCount = 0;
      let currentRun = 0;
      let maxRun = 0;
      let bestRunStart = 0;
      let bestRunEnd = 0;
      let runStart = 0;

      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        // Vertical gradient (Sobel-like: weighted above/below)
        const above = buffer[idx - width] * 0.5 + buffer[idx - 2 * width] * 0.5;
        const below = buffer[idx + width] * 0.5 + buffer[idx + 2 * width] * 0.5;
        const gradient = Math.abs(below - above);

        if (gradient > CONFIG.EDGE_THRESHOLD) {
          if (currentRun === 0) runStart = x;
          currentRun++;
          edgeCount++;
        } else {
          if (currentRun > maxRun) {
            maxRun = currentRun;
            bestRunStart = runStart;
            bestRunEnd = runStart + currentRun;
          }
          currentRun = 0;
        }
      }
      // Check final run
      if (currentRun > maxRun) {
        maxRun = currentRun;
        bestRunStart = runStart;
        bestRunEnd = runStart + currentRun;
      }

      rowScores[y] = { edgeCount, maxRun, runStart: bestRunStart, runEnd: bestRunEnd };
    }

    // Step 2: Find surface bands — clusters of adjacent rows with significant horizontal edges
    const minRunLength = Math.floor(width * CONFIG.HORIZONTAL_LINE_MIN_LENGTH);
    interface SurfaceBand {
      topRow: number;
      bottomRow: number;
      leftCol: number;
      rightCol: number;
      peakEdgeRow: number;
      peakEdgeScore: number;
      avgRunLength: number;
    }

    const bands: SurfaceBand[] = [];
    let currentBand: SurfaceBand | null = null;
    const GAP_TOLERANCE = Math.max(5, Math.floor(height * 0.02)); // Allow small gaps in bands

    for (let y = 2; y < height - 2; y++) {
      const row = rowScores[y];
      if (!row) continue;

      const hasSignificantEdge = row.maxRun >= minRunLength;

      if (hasSignificantEdge) {
        if (!currentBand) {
          currentBand = {
            topRow: y,
            bottomRow: y,
            leftCol: row.runStart,
            rightCol: row.runEnd,
            peakEdgeRow: y,
            peakEdgeScore: row.maxRun,
            avgRunLength: row.maxRun,
          };
        } else {
          currentBand.bottomRow = y;
          currentBand.leftCol = Math.min(currentBand.leftCol, row.runStart);
          currentBand.rightCol = Math.max(currentBand.rightCol, row.runEnd);
          if (row.maxRun > currentBand.peakEdgeScore) {
            currentBand.peakEdgeRow = y;
            currentBand.peakEdgeScore = row.maxRun;
          }
          const bandRows = currentBand.bottomRow - currentBand.topRow + 1;
          currentBand.avgRunLength = (currentBand.avgRunLength * (bandRows - 1) + row.maxRun) / bandRows;
        }
      } else {
        // Gap — close band if gap exceeds tolerance
        if (currentBand && (y - currentBand.bottomRow) > GAP_TOLERANCE) {
          const bandHeight = currentBand.bottomRow - currentBand.topRow;
          if (bandHeight >= 3) { // Min 3 rows to be a surface
            bands.push(currentBand);
          }
          currentBand = null;
        }
      }
    }
    // Close final band
    if (currentBand) {
      const bandHeight = currentBand.bottomRow - currentBand.topRow;
      if (bandHeight >= 3) {
        bands.push(currentBand);
      }
    }

    console.log(`[Scanner V2] Frame ${timestamp}s: found ${bands.length} edge band(s)`);

    // Step 3: Convert bands to surfaces with classification and confidence
    const surfaces: DetectedSurface[] = [];

    for (const band of bands) {
      const centerY = ((band.topRow + band.bottomRow) / 2) / height; // 0-1 normalized
      const bandHeightNorm = (band.bottomRow - band.topRow) / height;
      const bandWidthNorm = (band.rightCol - band.leftCol) / width;
      const runRatio = band.avgRunLength / width;

      // Skip very thin or very narrow bands
      if (bandWidthNorm < 0.15 || bandHeightNorm < 0.01) continue;

      // Skip bands that span almost the entire frame (likely scene boundaries, not surfaces)
      if (bandWidthNorm > 0.95 && bandHeightNorm > 0.5) continue;

      // Confidence scoring
      let confidence = 0;

      // Edge continuity: longer horizontal runs = more likely a flat surface
      confidence += Math.min(0.35, runRatio * 0.5);

      // Band thickness: real surfaces have some vertical depth (not just a single edge line)
      const thicknessScore = Math.min(0.25, bandHeightNorm * 2);
      confidence += thicknessScore;

      // Position bonus: surfaces in the middle 30-75% of frame are most likely tables/desks
      if (centerY >= 0.35 && centerY <= 0.75) {
        confidence += 0.25;
      } else if (centerY >= 0.25 && centerY <= 0.85) {
        confidence += 0.10;
      }

      // Width bonus: wider surfaces more likely real
      if (bandWidthNorm > 0.3) {
        confidence += 0.10;
      }

      confidence = Math.min(0.95, confidence);

      if (confidence < CONFIG.SURFACE_CONFIDENCE_THRESHOLD) continue;

      // Classify based on vertical position
      let surfaceType: string;
      if (centerY < 0.25) {
        surfaceType = "Shelf"; // Top quarter = shelf/high surface
      } else if (centerY < 0.45) {
        surfaceType = "Desk"; // Upper-middle = desk (person sitting behind it)
      } else if (centerY < 0.65) {
        surfaceType = "Table"; // Center = table
      } else if (centerY < 0.80) {
        surfaceType = "Desk"; // Lower-middle = desk (close-up or standing desk)
      } else {
        surfaceType = "Floor"; // Bottom = likely floor edge, skip
        continue; // Don't create surfaces for floor edges
      }

      // Build tight bounding box with some padding
      const padX = Math.min(0.03, bandWidthNorm * 0.1);
      const padY = Math.min(0.02, bandHeightNorm * 0.15);

      // The surface area extends from the edge band downward (the top of a table is the edge,
      // the placeable surface area is on/below it)
      const surfaceTopY = Math.max(0, (band.topRow / height) - padY);
      const surfaceBottomY = Math.min(1, (band.bottomRow / height) + bandHeightNorm * 0.5 + padY);

      const surface: DetectedSurface = {
        surfaceType,
        confidence,
        boundingBox: {
          x: Math.max(0, (band.leftCol / width) - padX),
          y: surfaceTopY,
          width: Math.min(1, bandWidthNorm + padX * 2),
          height: Math.min(1 - surfaceTopY, surfaceBottomY - surfaceTopY),
        },
        timestamp,
      };

      console.log(`[Scanner V2] Band → ${surfaceType} at y=${(centerY * 100).toFixed(0)}% (${(confidence * 100).toFixed(0)}% confidence, width=${(bandWidthNorm * 100).toFixed(0)}%, height=${(bandHeightNorm * 100).toFixed(0)}%)`);

      surfaces.push(surface);
    }

    // Deduplicate overlapping surfaces (keep higher confidence one)
    const dedupedSurfaces = deduplicateSurfaces(surfaces);

    if (dedupedSurfaces.length > 0) {
      const maxConfidence = Math.max(...dedupedSurfaces.map(s => s.confidence));
      return {
        hasSurface: true,
        confidence: maxConfidence,
        surfaces: dedupedSurfaces,
        isVertical,
      };
    }

    return defaultResult;

  } catch (err) {
    console.error(`[Scanner V2] Frame analysis error:`, err);
    return defaultResult;
  }
}

/**
 * IoU (intersection over union) between two normalized bounding boxes.
 * Both boxes use {x, y, width, height} in 0-1 space.
 */
function bboxIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);
  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  const union = aArea + bArea - interArea;
  if (union <= 0) return 0;
  return interArea / union;
}

/**
 * Remove overlapping surface detections, keeping the higher-confidence one.
 *
 * Per-frame NMS: when two boxes overlap heavily (IoU > 0.4) OR have very close
 * centers AND the same surface type, they describe the same physical surface
 * and we keep the higher-confidence one. The previous y-center-only check
 * missed the green+blue duplicate case where two coffee_table detections
 * landed on the same actual coffee table with slightly different bboxes.
 */
function deduplicateSurfaces(surfaces: DetectedSurface[]): DetectedSurface[] {
  if (surfaces.length <= 1) return surfaces;

  const sorted = [...surfaces].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedSurface[] = [];

  const IOU_THRESHOLD = 0.4;
  const CENTER_DIST_THRESHOLD = 0.12;

  const canonical = (t: string) => SURFACE_TYPE_SYNONYMS[t.toLowerCase()] || t;

  for (const surface of sorted) {
    const sType = canonical(surface.surfaceType);
    const sCenterX = surface.boundingBox.x + surface.boundingBox.width / 2;
    const sCenterY = surface.boundingBox.y + surface.boundingBox.height / 2;

    const overlaps = kept.some(k => {
      const kType = canonical(k.surfaceType);
      const kCenterX = k.boundingBox.x + k.boundingBox.width / 2;
      const kCenterY = k.boundingBox.y + k.boundingBox.height / 2;
      const centerDist = Math.hypot(sCenterX - kCenterX, sCenterY - kCenterY);
      const iou = bboxIoU(surface.boundingBox, k.boundingBox);
      // Drop if same canonical type AND (high IoU OR very close centers)
      const sameType = sType === kType;
      return (sameType && iou > IOU_THRESHOLD) || (sameType && centerDist < CENTER_DIST_THRESHOLD);
    });

    if (!overlaps) {
      kept.push(surface);
    }
  }

  return kept;
}

// ============================================================================
// GEMINI AI SURFACE DETECTION
// ============================================================================

function parseGeminiResponse(rawResponse: string): GeminiSurfaceDetectionResult | null {
  try {
    let jsonStr = rawResponse.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    
    const parsed = JSON.parse(jsonStr.trim());
    
    if (typeof parsed.surfaces_found !== 'boolean') {
      console.warn('[Gemini] Invalid response: missing surfaces_found');
      return null;
    }
    
    if (parsed.surfaces_found && Array.isArray(parsed.surfaces)) {
      parsed.surfaces = parsed.surfaces.filter((s: any) => {
        return s.location && 
               typeof s.location.x === 'number' &&
               typeof s.location.y === 'number' &&
               typeof s.confidence === 'number';
      });
    }
    
    return parsed;
  } catch (e) {
    console.error('[Gemini] Failed to parse response:', e);
    console.error('[Gemini] Raw response:', rawResponse.substring(0, 500));
    return null;
  }
}

async function analyzeFrameWithGemini(
  framePath: string,
  timestamp: number,
  isVertical: boolean,
  knownSurfaces?: KnownSurfaceSpec[]
): Promise<FrameAnalysisResult> {
  const defaultResult: FrameAnalysisResult = {
    hasSurface: false,
    confidence: 0,
    surfaces: [],
    isVertical,
  };

  try {
    console.log(`[Gemini] Analyzing frame at ${timestamp}s...`);

    const imageBuffer = fs.readFileSync(framePath);
    const base64Image = imageBuffer.toString('base64');
    const metadata = await sharp(framePath).metadata();
    const mimeType = metadata.format === 'png' ? 'image/png' : 'image/jpeg';

    // Room-model confirm mode: a matched scene class appends its known
    // surface inventory so the model re-locates them instead of
    // re-discovering the room from scratch every frame.
    const prompt = knownSurfaces && knownSurfaces.length > 0
      ? SURFACE_DETECTION_PROMPT + buildKnownSurfacesPromptSection(knownSurfaces)
      : SURFACE_DETECTION_PROMPT;

    const response = await geminiGenerate({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Image } }
        ]
      }],
    });
    
    if (!response) {
      console.error('[Gemini] Request timed out');
      return defaultResult;
    }
    
    const textContent = response.candidates?.[0]?.content?.parts?.[0];
    if (!textContent || !('text' in textContent) || !textContent.text) {
      console.error('[Gemini] No text in response');
      return defaultResult;
    }
    
    const parsed = parseGeminiResponse(textContent.text as string);
    
    if (!parsed) {
      console.error('[Gemini] Failed to parse response');
      return defaultResult;
    }
    
    console.log(`[Gemini] Frame ${timestamp}s: ${parsed.frame_description}`);
    console.log(`[Gemini] Surfaces found: ${parsed.surfaces_found}, count: ${parsed.surfaces?.length ?? 0}`);

    if (parsed.no_surface_reason) {
      console.log(`[Gemini] No surface reason: ${parsed.no_surface_reason}`);
    }

    // Person boxes from the same response. With real person positions the
    // ghost filter becomes an actual overlap test — only candidates that
    // genuinely sit on a person get rejected. The geometric zone heuristics
    // below remain solely as the fallback for responses without people data:
    // they guess where people probably are (center frame, side thirds) and
    // those guesses also killed real inventory — the side table next to a
    // host, the wall slice between two subjects. Parsed BEFORE the empty-
    // surfaces early return: a frame with zero surfaces still reports its
    // person coverage (that's the clean-frame re-sampler's trigger signal)
    // and may still confirm known set surfaces.
    const peopleBoxes = (Array.isArray(parsed.people) ? parsed.people : [])
      .filter((p) => p?.location && typeof p.location.x === "number" && typeof p.location.y === "number")
      .map((p) => ({
        x: p.location.x / 100,
        y: p.location.y / 100,
        w: (p.location.width ?? 0) / 100,
        h: (p.location.height ?? 0) / 100,
      }))
      .filter((p) => p.w > 0 && p.h > 0);
    // An explicit empty array is a real signal ("no people in frame") and
    // enables overlap mode just like populated boxes do; only a MISSING
    // field (older model output, malformed response) falls back to zones.
    const hasPeopleData = Array.isArray(parsed.people);
    // Total person-covered fraction of a box (sum of per-person
    // intersections, clamped — people rarely overlap each other in frame).
    // The REMAINDER (non-person area) is the actual placement real estate:
    // a backdrop wall extends BEHIND a seated host, so a generous person
    // box always overlaps it heavily even when plenty of empty wall shows
    // around them. Rejecting on overlap fraction alone killed real
    // backdrop walls at 60-80% overlap; the usable-remainder test keeps
    // them while still killing boxes that basically ARE the person.
    const personOverlapFraction = (bx: number, by: number, bw: number, bh: number): number => {
      let inter = 0;
      for (const p of peopleBoxes) {
        const ix = Math.max(0, Math.min(bx + bw, p.x + p.w) - Math.max(bx, p.x));
        const iy = Math.max(0, Math.min(by + bh, p.y + p.h) - Math.max(by, p.y));
        inter += ix * iy;
      }
      const area = bw * bh;
      return area > 0 ? Math.min(1, inter / area) : 0;
    };
    const personCoverage = hasPeopleData
      ? Math.min(1, peopleBoxes.reduce((sum, p) => sum + p.w * p.h, 0))
      : undefined;

    // Room-model confirmations (defensive parse). A confirmed known surface
    // becomes a candidate detection TAGGED with its model idx, carrying the
    // model's canonical surfaceType/orientation — Gemini's fresh label is
    // ignored for knowns, which is what stops label flip across episodes.
    // Confirmations still face the person-remainder ghost check (a person
    // now sitting where the desk was is still a person) but SKIP the
    // fallback zone heuristics — the model already vetted this surface.
    const knownConfirmed: DetectedSurface[] = [];
    const knownGhostVetoedIdx: number[] = [];
    if (knownSurfaces && knownSurfaces.length > 0 && Array.isArray(parsed.known_surfaces)) {
      for (const k of parsed.known_surfaces) {
        if (!k || typeof k.idx !== "number" || k.present !== true) continue;
        const model = knownSurfaces.find((ks) => ks.idx === k.idx);
        if (!model) continue;
        const loc = k.location;
        if (!loc || typeof loc.x !== "number" || typeof loc.y !== "number" ||
            typeof loc.width !== "number" || typeof loc.height !== "number") continue;
        const bbX = loc.x / 100;
        const bbY = loc.y / 100;
        const bbW = loc.width / 100;
        const bbH = loc.height / 100;
        if (bbW <= 0 || bbH <= 0) continue;
        // Taught surfaces are human ground truth — the creator drew the box
        // and vouched for it. A small side table beside a host lives
        // entirely inside the GENEROUS person envelope by construction, so
        // the overlap test would veto exactly the surfaces teaching exists
        // to rescue. Gemini saying present:false is the only way a taught
        // surface sits out a frame.
        if (hasPeopleData && !model.taught) {
          const frac = personOverlapFraction(bbX, bbY, bbW, bbH);
          const remainder = bbW * bbH * (1 - frac);
          const minRemainder = model.orientation === "vertical" ? 0.04 : 0.02;
          if (frac > 0.85 || remainder < minRemainder) {
            console.log(`[Gemini] GHOST FILTER: Rejected known #${k.idx} (${model.surfaceType}) — ${(frac * 100).toFixed(0)}% person overlap, ${(remainder * 100).toFixed(1)}% person-free`);
            knownGhostVetoedIdx.push(k.idx);
            continue;
          }
        }
        knownConfirmed.push({
          surfaceType: model.surfaceType,
          orientation: model.orientation,
          confidence: typeof k.confidence === "number" ? k.confidence : model.confidence,
          boundingBox: { x: bbX, y: bbY, width: bbW, height: bbH },
          timestamp,
          knownIdx: k.idx,
        });
      }
      console.log(`[Gemini] Known set surfaces: ${knownConfirmed.length}/${knownSurfaces.length} confirmed in this frame`);
    }

    if ((!parsed.surfaces_found || !parsed.surfaces || parsed.surfaces.length === 0) && knownConfirmed.length === 0) {
      // Gemini analyzed successfully but found no surfaces — don't fall back to edge
      return { ...defaultResult, aiAnalyzed: true, personCoverage, knownGhostVetoedIdx };
    }

    // Infer orientation from surface_type if Gemini didn't provide it explicitly.
    // Vertical types: walls, doors, windows. Everything else is horizontal.
    const inferOrientation = (surfaceType: string): "horizontal" | "vertical" => {
      const t = surfaceType.toLowerCase();
      if (t === "wall" || t === "door" || t === "window") return "vertical";
      return "horizontal";
    };

    // Sanity-correct Gemini's worst label mistakes BEFORE filtering. The
    // most common one we've seen: backdrops/walls behind subjects in
    // podcast scenes get labeled "studio_desk" or "table" because Gemini
    // sees brand-placement-shape but doesn't verify it's actually a
    // horizontal surface. Re-label these as "wall" so downstream code +
    // brand-side displays see the right surface type.
    const correctMislabel = (s: GeminiDetectedSurface): GeminiDetectedSurface => {
      const claimedType = s.surface_type.toLowerCase();
      const claimedOrientation = s.orientation || inferOrientation(s.surface_type);
      // Only inspect surfaces Gemini called horizontal (desks, tables, etc.)
      if (claimedOrientation !== "horizontal") return s;
      const bbY = s.location.y / 100;
      const bbH = s.location.height / 100;
      const centerY = bbY + bbH / 2;
      // Common mislabel: bbox center is in the top 40% of the frame AND
      // the bbox is reasonably tall (>25% frame height). Real horizontal
      // surfaces at eye level are thin strips in the lower half; anything
      // tall + high in the frame is almost certainly a wall/backdrop.
      const isUpperHalf = centerY < 0.40;
      const isTall = bbH > 0.25;
      // Shelves are exempt — they legitimately appear high in the frame
      const isShelf = claimedType.includes("shelf");
      if (!isShelf && isUpperHalf && isTall) {
        console.log(`[Gemini] LABEL CORRECTION: ${s.surface_type} → wall (bbox center y=${(centerY*100).toFixed(0)}%, h=${(bbH*100).toFixed(0)}% — likely a wall, not a horizontal surface)`);
        return { ...s, surface_type: "wall", orientation: "vertical" };
      }
      return s;
    };

    // Map Gemini surfaces, filter low-confidence, validate against ghost patterns.
    // Known-surface confirmations never pass through here — they were built
    // above with the model's canonical identity and their own safety check.
    const allSurfaces: DetectedSurface[] = (Array.isArray(parsed.surfaces) ? parsed.surfaces : [])
      .map(correctMislabel)
      // 0.60 (was 0.75): per-frame precision is now enforced by the
      // per-scene consensus vote + verification pass downstream — a lower
      // gate here feeds the vote more recall without shipping noise.
      .filter((s: GeminiDetectedSurface) => s.confidence >= 0.60)
      .filter((s: GeminiDetectedSurface) => {
        const orientation = s.orientation || inferOrientation(s.surface_type);
        const bbX = s.location.x / 100;
        const bbY = s.location.y / 100;
        const bbW = s.location.width / 100;
        const bbH = s.location.height / 100;
        const centerX = bbX + bbW / 2;
        const centerY = bbY + bbH / 2;
        const area = bbW * bbH;
        const surfTypeLower = s.surface_type.toLowerCase();
        const isFloor = surfTypeLower.includes('floor');
        const isShelf = surfTypeLower.includes('shelf');

        if (orientation === "vertical") {
          // A wall plane extends BEHIND the people in front of it, so heavy
          // person overlap is NORMAL for a real backdrop wall. Reject only
          // when the box is essentially the person (>85% covered) or when
          // the person-free remainder is too small to hang anything on
          // (<4% of frame — signage needs a substantial visible plane).
          if (hasPeopleData) {
            const frac = personOverlapFraction(bbX, bbY, bbW, bbH);
            const remainder = area * (1 - frac);
            if (frac > 0.85) {
              console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — vertical bbox ${(frac*100).toFixed(0)}% covered by person boxes (is the person)`);
              return false;
            }
            if (remainder < 0.04) {
              console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — only ${(remainder*100).toFixed(1)}% of frame is person-free wall (too small for signage)`);
              return false;
            }
          }
          return true;
        }

        // PERSON-OVERLAP MODE (people data present). A table top a host
        // leans over (or a side table inside a GENEROUS person box that
        // includes the chair) legitimately overlaps — the tests are: is the
        // box essentially the person (>85% covered → lap/torso/chair-seat
        // hallucination), and does enough person-free surface remain to set
        // a product on (>=2% of frame). Two absolute physics checks stay: a
        // "horizontal" surface spanning half the frame height isn't a table
        // top from any camera angle, and a non-shelf horizontal living
        // entirely in the upper frame is a mislabeled wall.
        if (hasPeopleData) {
          const frac = personOverlapFraction(bbX, bbY, bbW, bbH);
          const remainder = area * (1 - frac);
          // Small side furniture BESIDE a host is the one geometry boxes
          // cannot disambiguate: a real side table inside the generous
          // person+chair envelope and a chair-arm hallucination are the
          // same rectangle. When some remainder is visible (frac <= 0.95),
          // defer the judgment to the semantic layers — consensus still
          // needs multi-frame agreement and the verify pass looks at the
          // actual pixels. Fully-swallowed boxes (frac > 0.95) still die;
          // the teach flow is the human override for those.
          const isSmallSideFurniture =
            /side_table|coffee_table|nightstand/.test(surfTypeLower) && area <= 0.08;
          if (isSmallSideFurniture && frac > 0.40 && frac <= 0.95) {
            console.log(`[Gemini] GHOST FILTER: Deferring ${s.surface_type} to consensus+verify — ${(frac*100).toFixed(0)}% person overlap but small side furniture with visible remainder`);
          } else {
          if (frac > 0.85) {
            console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — ${(frac*100).toFixed(0)}% of bbox overlaps person boxes (is the person)`);
            return false;
          }
          if (remainder < 0.02) {
            console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — only ${(remainder*100).toFixed(1)}% of frame is person-free surface (too small for a product)`);
            return false;
          }
          }
          if (!isFloor && bbH > 0.45) {
            console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox too tall for a horizontal surface (h=${(bbH*100).toFixed(0)}%, max 45%)`);
            return false;
          }
          if (!isShelf && bbY + bbH < 0.40) {
            console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox entirely in upper frame (bottom at ${((bbY+bbH)*100).toFixed(0)}%)`);
            return false;
          }
          return true;
        }

        // FALLBACK ZONE HEURISTICS (no people data) — the original guesses.

        // Ghost pattern 1: small box centered on person's torso area
        const isInPersonZone = centerX > 0.20 && centerX < 0.80 && centerY > 0.15 && centerY < 0.55;
        const isSmallArea = area < 0.10;
        if (isInPersonZone && isSmallArea) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox center (${(centerX*100).toFixed(0)}%, ${(centerY*100).toFixed(0)}%) in person zone, small area ${(area*100).toFixed(1)}%`);
          return false;
        }

        // Ghost pattern 2: tall box overlapping person center (real eye-level tables are thin)
        // Center frame: 0.25-0.75. Real eye-level tables are < 25% tall horizontal strips.
        if (bbH > 0.25 && centerY < 0.55 && centerX > 0.25 && centerX < 0.75) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — tall bbox (h=${(bbH*100).toFixed(0)}%) centered on person area`);
          return false;
        }

        // Ghost pattern 2b: tall box on a SIDE-OF-FRAME person (the Shay Shay case).
        // In two-host podcast frames, hosts sit at the LEFT (x ~0-0.30) and RIGHT
        // (x ~0.70-1.0) of frame. Gemini sometimes calls a leather chair seat or
        // a person's torso/lap/legs a "coffee_table" because it sees a flat-ish
        // tone. Reject any horizontal-surface bbox whose center is in the outer
        // thirds AND is taller than a real eye-level table strip (>20% frame
        // height). Floor surfaces are exempt — floor space at someone's feet
        // legitimately sits at the side of frame.
        const isInSidePersonZone = !isFloor && (centerX < 0.30 || centerX > 0.70) && centerY > 0.10 && centerY < 0.85;
        if (isInSidePersonZone && bbH > 0.20) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — tall bbox (h=${(bbH*100).toFixed(0)}%) at side-of-frame person zone (cx=${(centerX*100).toFixed(0)}%)`);
          return false;
        }

        // Ghost pattern 2c: bbox spans most of frame height — that's a person/chair, not a table.
        if (!isFloor && bbH > 0.30) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox too tall for a horizontal surface (h=${(bbH*100).toFixed(0)}%, max 30%)`);
          return false;
        }

        // Ghost pattern 3: horizontal surface entirely in upper frame (shelves exempt)
        if (!isShelf && bbY + bbH < 0.40) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox entirely in upper frame (bottom at ${((bbY+bbH)*100).toFixed(0)}%)`);
          return false;
        }

        return true;
      })
      .map((s: GeminiDetectedSurface) => ({
        surfaceType: s.surface_type.charAt(0).toUpperCase() + s.surface_type.slice(1),
        orientation: s.orientation || inferOrientation(s.surface_type),
        confidence: s.confidence,
        boundingBox: {
          x: s.location.x / 100,
          y: s.location.y / 100,
          width: s.location.width / 100,
          height: s.location.height / 100,
        },
        timestamp,
        lightingDirection: s.lighting_direction || undefined,
        lightingIntensity: typeof s.lighting_intensity === 'number' ? s.lighting_intensity : undefined,
        cameraAngle: s.camera_angle || undefined,
      }))
      .sort((a: DetectedSurface, b: DetectedSurface) => b.confidence - a.confidence)
      .slice(0, 8); // Max 8 surfaces per frame — full room inventory; consensus prunes
                    // (shelves + tables + floor + wall) without dropping real
                    // surfaces. Per-frame dedup + cluster IoU still merge
                    // duplicates of the same physical surface downstream.

    // Belt-and-braces against the "do NOT re-list knowns" instruction being
    // ignored: a fresh detection sitting on a confirmed known surface is the
    // same physical surface wearing a second identity — dropping it here
    // keeps the model from later appending its own desk as a "new" surface.
    const freshSurfaces = knownConfirmed.length === 0
      ? allSurfaces
      : allSurfaces.filter((s) => {
          const twin = knownConfirmed.find((k) => bboxIoU(s.boundingBox, k.boundingBox) > 0.5);
          if (twin) {
            console.log(`[Gemini] Dropped fresh ${s.surfaceType} — duplicates known #${twin.knownIdx} (${twin.surfaceType})`);
          }
          return !twin;
        });

    const combinedSurfaces = [...freshSurfaces, ...knownConfirmed];
    if (combinedSurfaces.length === 0) {
      return { ...defaultResult, aiAnalyzed: true, personCoverage, knownGhostVetoedIdx };
    }

    const maxConfidence = Math.max(...combinedSurfaces.map(s => s.confidence));

    return {
      hasSurface: true,
      confidence: maxConfidence,
      surfaces: combinedSurfaces,
      isVertical,
      aiAnalyzed: true,
      personCoverage,
      knownGhostVetoedIdx,
    };

  } catch (err: any) {
    // Log detailed error info to diagnose production issues (API key, base URL, connectivity)
    const errMsg = err?.message || String(err);
    const errStatus = err?.status || err?.statusCode || 'unknown';
    const errBody = err?.body || err?.response?.data || '';
    console.error(`[Gemini] Frame analysis error at ${timestamp}s: ${errMsg}`);
    console.error(`[Gemini] Error details — status: ${errStatus}, body: ${typeof errBody === 'string' ? errBody.substring(0, 300) : JSON.stringify(errBody).substring(0, 300)}`);
    console.error(`[Gemini] Base URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(not set)'}, API key set: ${!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY}`);

    // Re-throw rate limit errors so the retry wrapper can catch and backoff
    const bodyStr = typeof errBody === 'string' ? errBody : JSON.stringify(errBody);
    const is429 = errStatus === 429 || errStatus === '429' ||
                  errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') ||
                  errMsg.toLowerCase().includes('resource_exhausted') ||
                  bodyStr.includes('RESOURCE_EXHAUSTED') || bodyStr.includes('429');
    if (is429) {
      const rateLimitErr: any = new Error(`Gemini rate limited at ${timestamp}s`);
      rateLimitErr.status = 429;
      rateLimitErr.isRateLimit = true;
      throw rateLimitErr;
    }

    return defaultResult;
  }
}

/**
 * Call analyzeFrameWithGemini with exponential backoff on 429 rate limit errors.
 * Returns the default empty result after all retries are exhausted.
 */
async function analyzeFrameWithGeminiRetry(
  framePath: string,
  timestamp: number,
  isDense: boolean = false,
  knownSurfaces?: KnownSurfaceSpec[],
  maxRetries: number = 5
): Promise<any> {
  const defaultResult = {
    surfaces: [],
    isVertical: false,
    aiAnalyzed: true,
  };
  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await analyzeFrameWithGemini(framePath, timestamp, isDense, knownSurfaces);
    } catch (err: any) {
      lastErr = err;
      if (!err.isRateLimit) {
        // Non-rate-limit errors already return defaultResult inside analyzeFrameWithGemini
        return defaultResult;
      }
      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s (capped)
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 32000);
        console.log(`[Gemini] Rate limited at ${timestamp}s — retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  // Exhausted 429s are an ABSTENTION, not a verdict — the model never saw
  // the frame. Without the marker this empty result counted as a real
  // "no surfaces" vote in the scene consensus denominator, so ONE
  // rate-limited frame in a 2-frame scene vetoed every surface the other
  // frame found. The scan loop drops marked frames from framesAnalyzed.
  console.error(`[Gemini] Rate limit retries exhausted at ${timestamp}s — abstaining from consensus`);
  return { ...defaultResult, rateLimited: true };
}

// ============================================================================
// SCENE CONTEXT ANALYSIS — FullScale Edge (Sharp-based, no external AI)
// ============================================================================

interface SceneContextResult {
  sceneSetting: string;
  refinedSurfaceType: string;
  surroundings: string[];
  mood: string;
  culturalContext: string;
  brandCategories: string[];
}

/**
 * Analyzes a video frame using Sharp image statistics to infer scene context.
 * Uses brightness zones, color channel distribution, edge density patterns,
 * and aspect ratio to classify the scene — no external AI API required.
 */
async function analyzeSceneContext(
  framePath: string,
  currentSurfaceType: string,
  isVertical: boolean,
): Promise<SceneContextResult | null> {
  try {
    const image = sharp(framePath);
    const metadata = await image.metadata();
    const width = metadata.width || 1280;
    const height = metadata.height || 720;

    // Get image statistics (channel means, dominant colors)
    const stats = await image.stats();
    const rMean = stats.channels[0]?.mean || 0;
    const gMean = stats.channels[1]?.mean || 0;
    const bMean = stats.channels[2]?.mean || 0;
    const overallBrightness = (rMean + gMean + bMean) / 3;

    // Analyze top third vs bottom third brightness (helps detect studio lighting)
    const topThird = await sharp(framePath)
      .extract({ left: 0, top: 0, width, height: Math.floor(height / 3) })
      .stats();
    const bottomThird = await sharp(framePath)
      .extract({ left: 0, top: Math.floor(height * 2 / 3), width, height: Math.floor(height / 3) })
      .stats();

    const topBrightness = ((topThird.channels[0]?.mean || 0) + (topThird.channels[1]?.mean || 0) + (topThird.channels[2]?.mean || 0)) / 3;
    const bottomBrightness = ((bottomThird.channels[0]?.mean || 0) + (bottomThird.channels[1]?.mean || 0) + (bottomThird.channels[2]?.mean || 0)) / 3;

    // Analyze edge density in the surface region (bottom half)
    const bottomHalf = await sharp(framePath)
      .extract({ left: 0, top: Math.floor(height / 2), width, height: Math.floor(height / 2) })
      .greyscale()
      .raw()
      .toBuffer();

    let edgeCount = 0;
    const bw = width;
    const bh = Math.floor(height / 2);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const idx = y * bw + x;
        const gradient = Math.abs(bottomHalf[idx + bw] - bottomHalf[idx - bw]);
        if (gradient > 15) edgeCount++;
      }
    }
    const edgeDensity = edgeCount / ((bw - 2) * (bh - 2));

    // Color warmth analysis (warm = reddish/orange, cool = bluish)
    const warmth = rMean - bMean; // positive = warm, negative = cool

    // Classify scene based on heuristics
    const sceneSetting = classifyScene(overallBrightness, topBrightness, bottomBrightness, edgeDensity, warmth, isVertical);
    const refinedSurfaceType = refineSurfaceType(currentSurfaceType, sceneSetting, edgeDensity, overallBrightness);
    const surroundings = inferSurroundings(sceneSetting, edgeDensity, overallBrightness, warmth);
    const mood = inferMood(overallBrightness, warmth, edgeDensity);
    const brandCategories = suggestBrands(sceneSetting, mood);

    console.log(`[FullScale Edge Context] Setting: ${sceneSetting}`);
    console.log(`[FullScale Edge Context] Refined type: ${refinedSurfaceType} (was: ${currentSurfaceType})`);
    console.log(`[FullScale Edge Context] Brightness: ${overallBrightness.toFixed(0)}, Warmth: ${warmth.toFixed(0)}, Edge density: ${(edgeDensity * 100).toFixed(1)}%`);

    return {
      sceneSetting,
      refinedSurfaceType,
      surroundings,
      mood,
      culturalContext: "General", // Sharp can't determine cultural markers — needs future training data
      brandCategories,
    };
  } catch (err) {
    console.error("[FullScale Edge Context] Analysis failed:", err);
    return null;
  }
}

function classifyScene(
  brightness: number, topBright: number, bottomBright: number,
  edgeDensity: number, warmth: number, isVertical: boolean,
): string {
  const lightingContrast = Math.abs(topBright - bottomBright);

  // Studio/podcast: controlled lighting (low contrast), darker background, bright subject area
  if (lightingContrast > 30 && topBright < bottomBright && brightness > 80) {
    return "Podcast/Recording Studio";
  }
  if (lightingContrast > 30 && topBright < 100 && bottomBright > 120) {
    return "Studio Setup";
  }

  // Office/workspace: moderate brightness, high edge density (lots of objects/edges)
  if (edgeDensity > 0.15 && brightness > 100 && brightness < 200) {
    return warmth > 10 ? "Warm Office/Workspace" : "Modern Office/Workspace";
  }

  // Kitchen: typically warm, moderate brightness, high edge density
  if (warmth > 20 && edgeDensity > 0.12 && brightness > 120) {
    return "Kitchen/Dining Area";
  }

  // Outdoor: very bright, high brightness variance
  if (brightness > 170) {
    return "Outdoor/Bright Setting";
  }

  // Dark/moody setting: low overall brightness
  if (brightness < 60) {
    return "Dark/Moody Setting";
  }

  // Living space: moderate everything
  if (brightness > 90 && brightness < 160 && warmth > 0) {
    return "Living Space";
  }

  // Vertical video often = mobile/casual content
  if (isVertical) {
    return "Mobile/Casual Setting";
  }

  return "Indoor Setting";
}

function refineSurfaceType(
  currentType: string, sceneSetting: string,
  edgeDensity: number, brightness: number,
): string {
  // Keep specific types from edge detection (Table, Shelf, etc.)
  // Only refine generic types
  if (currentType !== "Desk" && currentType !== "Table" && currentType !== "Potential Surface") {
    return currentType;
  }

  const setting = sceneSetting.toLowerCase();

  if (currentType === "Desk" || currentType === "Table") {
    // Add scene context to the type
    if (setting.includes("podcast") || setting.includes("studio") || setting.includes("recording")) {
      return "Studio Desk";
    }
    if (setting.includes("kitchen") || setting.includes("dining")) {
      return "Counter";
    }
    if (setting.includes("office") || setting.includes("workspace")) {
      return edgeDensity > 0.2 ? "Work Desk" : "Clean Desk";
    }
    if (setting.includes("outdoor")) {
      return currentType === "Table" ? "Outdoor Table" : "Outdoor Desk";
    }
    if (setting.includes("living")) {
      return currentType === "Table" ? "Coffee Table" : "Side Table";
    }
    return currentType; // Keep as-is if no scene match
  }

  // Potential Surface — make more specific
  if (currentType === "Potential Surface") {
    if (setting.includes("podcast") || setting.includes("studio")) return "Studio Surface";
    if (setting.includes("office")) return "Desk Area";
    return "Surface";
  }

  return currentType;
}

function inferSurroundings(
  sceneSetting: string, edgeDensity: number,
  brightness: number, warmth: number,
): string[] {
  const items: string[] = [];
  const setting = sceneSetting.toLowerCase();

  if (setting.includes("podcast") || setting.includes("studio")) {
    items.push("Microphone", "Monitor", "Camera");
    if (edgeDensity > 0.15) items.push("Cables", "Audio equipment");
  }
  if (setting.includes("office") || setting.includes("workspace")) {
    items.push("Computer", "Chair");
    if (edgeDensity > 0.2) items.push("Books", "Papers", "Stationery");
    if (brightness > 140) items.push("Desk lamp", "Window");
  }
  if (setting.includes("kitchen") || setting.includes("dining")) {
    items.push("Countertop", "Appliances");
    if (warmth > 20) items.push("Warm lighting", "Food items");
  }
  if (setting.includes("outdoor")) {
    items.push("Natural light", "Plants");
  }
  if (setting.includes("living")) {
    items.push("Sofa", "Decor");
    if (warmth > 15) items.push("Warm lighting", "Textiles");
  }

  // Generic items based on edge density
  if (edgeDensity > 0.18 && items.length < 3) items.push("Multiple objects");
  if (brightness > 150 && !items.includes("Window")) items.push("Well-lit");
  if (warmth > 25 && !items.includes("Warm lighting")) items.push("Warm ambiance");

  return items.slice(0, 8);
}

function inferMood(brightness: number, warmth: number, edgeDensity: number): string {
  if (brightness > 160 && warmth > 15) return "Energetic";
  if (brightness > 130 && edgeDensity < 0.1) return "Calm";
  if (brightness > 100 && warmth < -5) return "Professional";
  if (brightness < 80) return "Intimate";
  if (edgeDensity > 0.2) return "Creative";
  if (warmth > 10) return "Casual";
  return "Neutral";
}

function suggestBrands(sceneSetting: string, mood: string): string[] {
  const setting = sceneSetting.toLowerCase();
  const brands: string[] = [];

  if (setting.includes("podcast") || setting.includes("studio")) {
    brands.push("Audio equipment", "Tech accessories", "Beverages", "Software");
  } else if (setting.includes("kitchen") || setting.includes("dining")) {
    brands.push("Food & beverage", "Kitchen appliances", "Health & wellness");
  } else if (setting.includes("office") || setting.includes("workspace")) {
    brands.push("Tech products", "Office supplies", "Productivity software", "Coffee/beverages");
  } else if (setting.includes("outdoor")) {
    brands.push("Outdoor gear", "Fitness", "Suncare", "Beverages");
  } else if (setting.includes("living")) {
    brands.push("Home decor", "Lifestyle", "Streaming services", "Beverages");
  } else {
    brands.push("Lifestyle", "Consumer electronics", "Beverages");
  }

  // Mood-based additions
  if (mood === "Professional") brands.push("Business services");
  if (mood === "Creative") brands.push("Creative tools", "Art supplies");
  if (mood === "Energetic") brands.push("Energy drinks", "Sports brands");

  return [...new Set(brands)].slice(0, 5);
}

/**
 * Runs FullScale Edge scene context analysis on detected surfaces after the main scan.
 * Picks unique frames (one per timestamp) to minimize processing.
 * Updates surface records with refined types, scene context, and surroundings.
 * Uses Sharp image statistics only — no external AI API.
 */
async function enrichSurfacesWithContext(
  videoId: number,
  permanentFramesDir: string,
  excludeIds?: Set<number>,
): Promise<void> {
  console.log(`[FullScale Edge Context] Starting post-scan enrichment for video ${videoId}`);

  // Skip Filtered rows (machine- or creator-rejected — enrichment used to
  // overwrite their surfaceType with a live refined type, silently
  // resurrecting them) and prior-scan rows awaiting end-of-scan retirement.
  const allRows = await storage.getDetectedSurfaces(videoId);
  const surfaces = allRows.filter(s =>
    s.surfaceType !== "Filtered" && !excludeIds?.has(s.id));
  if (surfaces.length === 0) {
    console.log("[FullScale Edge Context] No surfaces to enrich");
    return;
  }

  // Group surfaces by rounded timestamp — matches the scanner's filename
  // convention (Math.round(t) under scene-first sampling). Math.floor was
  // here previously and lost every scene-first surface whose timestamp
  // landed >= x.5s (e.g. 64.5s → looked for "frame_64s.jpg" but scanner
  // saved "frame_65s.jpg"). Math.round is uniform-scan-compatible too —
  // integer timestamps round to themselves.
  const timestampMap = new Map<number, typeof surfaces>();
  for (const surface of surfaces) {
    const ts = Math.round(Number(surface.timestamp));
    if (!timestampMap.has(ts)) {
      timestampMap.set(ts, []);
    }
    timestampMap.get(ts)!.push(surface);
  }

  console.log(`[FullScale Edge Context] ${surfaces.length} surfaces across ${timestampMap.size} unique timestamps`);

  let enrichedCount = 0;

  // Refined-type votes per canonical surface group. Surface identity is
  // established at consensus time (one surfaceGroupId per physical surface);
  // writing a per-timestamp refined type onto individual rows fractured that
  // identity — the same physical table ended up half "Table" half "Desk"
  // depending on which frames this pass got to look at. Votes are collected
  // here and the group-majority type is applied to ALL rows of each group
  // after the loop. Rows without a groupId (legacy scans) keep the old
  // per-timestamp refinement.
  const groupTypeVotes = new Map<string, string[]>();

  for (const [timestamp, surfacesAtTime] of Array.from(timestampMap.entries())) {
    // Try the canonical filename first (Math.round of timestamp), then
    // fall back to Math.floor for legacy surfaces from older scans whose
    // frames were saved with the floor convention.
    const candidates = [
      `frame_${timestamp}s.jpg`,
      `frame_${Math.floor(Number(surfacesAtTime[0].timestamp))}s.jpg`,
    ];
    let framePath = "";
    for (const fn of candidates) {
      const p = path.join(permanentFramesDir, fn);
      if (fs.existsSync(p)) { framePath = p; break; }
    }

    if (!framePath) {
      console.log(`[FullScale Edge Context] Frame not found in ${permanentFramesDir} (tried ${candidates.join(", ")}), skipping`);
      continue;
    }

    // Detect if frame is vertical
    const frameMeta = await sharp(framePath).metadata();
    const isVertical = (frameMeta.height || 720) > (frameMeta.width || 1280);

    // Use the highest-confidence surface type as input
    const bestSurface = surfacesAtTime.reduce((a, b) =>
      parseFloat(String(a.confidence)) > parseFloat(String(b.confidence)) ? a : b
    );

    const result = await analyzeSceneContext(framePath, bestSurface.surfaceType, isVertical);
    if (!result) continue;

    // Update ALL surfaces at this timestamp with the context. The refined
    // TYPE is only written directly for group-less legacy rows — grouped
    // rows vote, and the group majority is applied below so every row of a
    // physical surface carries one consistent type.
    for (const surface of surfacesAtTime) {
      const groupId = (surface as any).surfaceGroupId as string | null | undefined;
      try {
        const patch: Record<string, any> = {
          sceneContext: `${result.sceneSetting} | ${result.mood} | Brands: ${result.brandCategories.slice(0, 3).join(", ")}`,
          surroundings: result.surroundings.slice(0, 10),
        };
        if (groupId) {
          const votes = groupTypeVotes.get(groupId) ?? [];
          votes.push(result.refinedSurfaceType);
          groupTypeVotes.set(groupId, votes);
        } else {
          patch.surfaceType = result.refinedSurfaceType;
        }
        await storage.updateDetectedSurface(surface.id, patch);
        enrichedCount++;
      } catch (err) {
        console.error(`[FullScale Edge Context] Failed to update surface ${surface.id}:`, err);
      }
    }
  }

  // Apply the majority refined type per group to EVERY row of the group —
  // including rows at timestamps whose frames weren't found above. First
  // vote wins ties (frames are processed in timestamp order, and the
  // earliest refinement saw the same evidence as the rest).
  for (const [groupId, votes] of Array.from(groupTypeVotes.entries())) {
    const tally = new Map<string, number>();
    let majority = votes[0];
    for (const v of votes) {
      const n = (tally.get(v) ?? 0) + 1;
      tally.set(v, n);
      if (n > (tally.get(majority) ?? 0)) majority = v;
    }
    const groupRows = surfaces.filter(s => (s as any).surfaceGroupId === groupId);
    for (const row of groupRows) {
      if (row.surfaceType === majority) continue;
      try {
        await storage.updateDetectedSurface(row.id, { surfaceType: majority });
      } catch (err) {
        console.error(`[FullScale Edge Context] Failed to apply group type to surface ${row.id}:`, err);
      }
    }
  }

  console.log(`[FullScale Edge Context] Enriched ${enrichedCount}/${surfaces.length} surfaces (${groupTypeVotes.size} group-consistent type refinements)`);
}

// ============================================================================
// PHASE 2A: SURFACE KEYFRAME CAPTURE — Preserve Raw Per-Frame Bounding Boxes
// ============================================================================
//
// Before normalization overwrites all bboxes with the median, we capture each
// surface's raw per-frame position as a "keyframe". During remix clip generation,
// these keyframes are used for smooth spline interpolation so placed products
// follow natural camera movement instead of sitting static.
//
// Keyframes are linked to the canonical surface ID from each cluster, enabling
// N-point motion tracking per surface across the clip's time range.

async function captureSurfaceKeyframes(videoId: number): Promise<void> {
  console.log(`[Keyframes] Capturing raw per-frame bounding boxes for video ${videoId}`);

  const surfaces = await storage.getDetectedSurfaces(videoId);
  const validSurfaces = surfaces.filter(
    (s) => s.surfaceType !== "Filtered" && s.surfaceType !== "Potential Surface"
  );

  if (validSurfaces.length === 0) {
    console.log(`[Keyframes] No valid surfaces to capture`);
    return;
  }

  // Load this video's scene-cut timestamps so cross-shot surfaces don't
  // cluster together. A coffee table in shot A and a coffee table in shot B
  // are different objects even if their bboxes look similar.
  let sceneCuts: number[] = [];
  try {
    const video = await storage.getVideoById(videoId);
    const raw = (video as any)?.sceneBoundaries;
    if (Array.isArray(raw)) sceneCuts = raw.filter(t => typeof t === "number" && Number.isFinite(t));
  } catch { /* ignore */ }

  // Cluster surfaces to identify which ones represent the same physical surface
  // Use the same clustering logic as normalization
  const clusters = clusterSurfaces(validSurfaces as any, sceneCuts);
  console.log(`[Keyframes] Found ${clusters.length} cluster(s) across ${validSurfaces.length} surfaces (scene cuts: ${sceneCuts.length})`);

  const keyframeBatch: Array<{
    surfaceId: number;
    videoId: number;
    timestamp: string;
    boundingBoxX: string;
    boundingBoxY: string;
    boundingBoxWidth: string;
    boundingBoxHeight: string;
    confidence: string;
  }> = [];

  for (const cluster of clusters) {
    if (cluster.surfaces.length === 0) continue;

    // The canonical surface is the highest-confidence one in the cluster
    const canonical = cluster.surfaces.reduce((best, s) =>
      s.confidence > best.confidence ? s : best
    );
    const canonicalId = canonical.id;

    // Create a keyframe for EVERY surface in the cluster, linked to the canonical ID
    // Each surface entry represents a different timestamp (frame)
    for (const member of cluster.surfaces) {
      // Find the original surface record to get the timestamp
      const original = validSurfaces.find((s) => s.id === member.id);
      if (!original) continue;

      keyframeBatch.push({
        surfaceId: canonicalId,
        videoId,
        timestamp: String(original.timestamp),
        boundingBoxX: member.bbX.toFixed(6),
        boundingBoxY: member.bbY.toFixed(6),
        boundingBoxWidth: member.bbW.toFixed(6),
        boundingBoxHeight: member.bbH.toFixed(6),
        confidence: member.confidence.toFixed(4),
      });
    }

    console.log(
      `[Keyframes] Cluster "${cluster.surfaceType}" → ${cluster.surfaces.length} keyframe(s) linked to surface #${canonicalId}`
    );
  }

  // Bulk insert all keyframes
  if (keyframeBatch.length > 0) {
    await storage.bulkInsertSurfaceKeyframes(keyframeBatch);
    console.log(`[Keyframes] Saved ${keyframeBatch.length} keyframes for video ${videoId}`);
  }
}

// ============================================================================
// POST-SCAN NORMALIZATION — Cluster & Normalize Bounding Boxes
// ============================================================================
//
// Problem: Gemini analyzes each frame independently, so the "same" table gets
// wildly different bounding boxes at different timestamps. This causes:
// 1. Products to appear at different positions per frame
// 2. Scene group matching to fail (different bbX/bbY = different group)
//
// Solution: After scanning all frames, cluster surfaces that represent the same
// physical surface (same type + approximate position), then force all surfaces
// in a cluster to share the MEDIAN bounding box. This ensures consistent
// product placement across frames of the same camera angle.

interface SurfaceCluster {
  surfaces: { id: number; bbX: number; bbY: number; bbW: number; bbH: number; confidence: number; groupId?: string | null }[];
  surfaceType: string;
  // Scene the cluster lives in (sceneId or per-shot block) — post-processing
  // must never merge or dedupe across scenes.
  sceneKey?: number;
  // Canonical-surface identity stamped at consensus insert. Optional because
  // legacy rows pre-date the column; identity-aware passes fall back to
  // spatial behavior when it's absent.
  groupId?: string | null;
}

// Normalize surface type synonyms to a canonical name
// e.g., "Studio_desk", "studio_desk", "desk", "table" all → "Table"
// ── AUTH 2b: per-scene model verification ─────────────────────────
// Second opinion on consensus survivors: show Gemini the scene's
// best-supported frame plus the candidate boxes and ask it to confirm each
// one is really the named surface, at that location, and not covering a
// person. Fail-open: any API/parse failure keeps the consensus result
// (consensus already filtered — verification only ever REMOVES).
async function verifySceneSurfaces(
  framePath: string,
  candidates: Array<{ surfaceType: string; bbox: { x: number; y: number; width: number; height: number } }>,
): Promise<Set<number> | null> {
  try {
    if (!fs.existsSync(framePath) || candidates.length === 0) return null;
    const base64Image = fs.readFileSync(framePath).toString("base64");
    const list = candidates
      .map((c, i) => `${i}: ${c.surfaceType} at x=${(c.bbox.x * 100).toFixed(0)}% y=${(c.bbox.y * 100).toFixed(0)}% w=${(c.bbox.width * 100).toFixed(0)}% h=${(c.bbox.height * 100).toFixed(0)}%`)
      .join("\n");
    const prompt = `You are auditing candidate surface detections for product placement. The attached image is one frame of the scene. Candidates (bbox as percent of frame, origin top-left):\n${list}\n\nFor EACH candidate index, answer keep=true ONLY if ALL of these hold:\n- the named surface type is genuinely visible at that box location\n- the label is correct (a floor region is not a "wall"; a couch back is not a "table")\n- the box does NOT primarily cover a person, their clothing, or the chair they sit in\nReturn STRICT JSON only, no markdown fences: {"verdicts":[{"index":0,"keep":true,"reason":"short"}]} with exactly one verdict per candidate.`;

    // The verify call lands right after the detection burst — the most
    // rate-limited moment of the scan. Small backoff loop for 429s.
    let response: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await geminiGenerate({
          model: "gemini-2.5-flash",
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "image/jpeg", data: base64Image } },
            ],
          }],
        });
        break;
      } catch (callErr: any) {
        const msg = String(callErr?.message || callErr);
        if (/429|rate.?limit|quota|resource.?exhausted/i.test(msg) && attempt < 2) {
          const backoff = 2000 * Math.pow(2, attempt);
          console.warn(`[Scanner V2] Verify pass rate-limited — retrying in ${backoff / 1000}s`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        // geminiGenerate REJECTS on timeout (the old race resolved null);
        // preserve the fail-open timeout semantics this pass was built with.
        if (/timeout/i.test(msg)) { response = null; break; }
        throw callErr;
      }
    }
    if (!response) {
      console.warn(`[Scanner V2] Verify pass timed out (fail-open)`);
      return null;
    }

    const textContent = (response as any).candidates?.[0]?.content?.parts?.[0];
    if (!textContent || !("text" in textContent) || !textContent.text) return null;

    let jsonStr = String(textContent.text).trim();
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
    const parsed = JSON.parse(jsonStr.trim());
    if (!Array.isArray(parsed?.verdicts)) return null;

    const keep = new Set<number>();
    let wellFormedVerdicts = 0;
    for (const v of parsed.verdicts) {
      if (typeof v?.index === "number" && typeof v?.keep === "boolean") {
        wellFormedVerdicts++;
        if (v.keep === true) keep.add(v.index);
      }
    }
    // An all-reject is trusted only when the model explicitly returned a
    // well-formed verdict for EVERY candidate (a deliberate judgment);
    // partial/malformed responses fail open — consensus already filtered.
    if (keep.size === 0 && wellFormedVerdicts < candidates.length) {
      console.warn(`[Scanner V2] Verify pass returned ${wellFormedVerdicts}/${candidates.length} verdicts with none kept — fail-open`);
      return null;
    }
    if (keep.size === 0) {
      console.log(`[Scanner V2] Verify pass deliberately rejected all ${candidates.length} candidate(s)`);
    }
    return keep;
  } catch (err: any) {
    console.warn(`[Scanner V2] Scene verification failed (fail-open):`, err?.message || err);
    return null;
  }
}

// ── Full-res bbox refinement (brand-commit re-scan) ────────────────
// Scan-time detection ran on frames capped at FRAME_MAX_DIMENSION (1280).
// When a brand commits and the placement renders, this refines the surface
// bbox against a FULL-RESOLUTION frame for pixel-accurate compositing.
// Fail-open: any error/implausible answer keeps the scan-time bbox.
export async function refineSurfaceBBoxOnFrame(
  framePath: string,
  surfaceType: string,
  bbox: { x: number; y: number; width: number; height: number },
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    if (!fs.existsSync(framePath)) return null;
    const proxyKeyOk = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY && process.env.AI_INTEGRATIONS_GEMINI_API_KEY !== "dummy-key";
    if (!proxyKeyOk && !aiDirect) return null;
    const base64Image = fs.readFileSync(framePath).toString("base64");
    const prompt = `This is a full-resolution video frame. A "${surfaceType}" surface was previously detected at approximately x=${(bbox.x * 100).toFixed(1)}%, y=${(bbox.y * 100).toFixed(1)}%, width=${(bbox.width * 100).toFixed(1)}%, height=${(bbox.height * 100).toFixed(1)}% (percent of frame, origin top-left). Return the PRECISE bounding box of the EMPTY placeable area of that exact surface — tightened to this higher-resolution frame. Respond with STRICT JSON only: {"x": number, "y": number, "width": number, "height": number} in percent 0-100, or {"not_visible": true} if that surface is not visible in this frame.`;

    // geminiGenerate rejects on timeout — the enclosing try's fail-open
    // catch preserves the old resolve-null semantics.
    const response = await geminiGenerate({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64Image } }] }],
    });
    if (!response) return null;
    const part = (response as any).candidates?.[0]?.content?.parts?.[0];
    if (!part || !("text" in part) || !part.text) return null;
    let jsonStr = String(part.text).trim();
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
    const parsed = JSON.parse(jsonStr.trim());
    if (parsed?.not_visible) return null;
    const refined = {
      x: Number(parsed.x) / 100,
      y: Number(parsed.y) / 100,
      width: Number(parsed.width) / 100,
      height: Number(parsed.height) / 100,
    };
    if ([refined.x, refined.y, refined.width, refined.height].some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return null;
    if (refined.width <= 0.01 || refined.height <= 0.01) return null;
    // Plausibility: the refinement must still be the SAME surface — reject
    // answers that wandered elsewhere in the frame.
    const iou = bboxIoU(refined, bbox);
    if (iou < 0.2) {
      console.warn(`[Scanner V2] BBox refinement wandered (IoU ${iou.toFixed(2)}) — keeping scan-time bbox`);
      return null;
    }
    return refined;
  } catch (err: any) {
    console.warn(`[Scanner V2] BBox refinement failed (fail-open):`, err?.message || err);
    return null;
  }
}

const SURFACE_TYPE_SYNONYMS: Record<string, string> = {
  desk: "Table",
  table: "Table",
  studio_desk: "Table",
  "studio desk": "Table",
  counter: "Counter",
  countertop: "Counter",
  kitchen_counter: "Counter",
  shelf: "Shelf",
  bookshelf: "Shelf",
  nightstand: "Nightstand",
  side_table: "Nightstand",
  coffee_table: "Coffee Table",
  couch: "Couch",
  sofa: "Couch",
  rug: "Rug",
  carpet: "Rug",
};

export function canonicalSurfaceType(type: string): string {
  const lower = type.toLowerCase().trim();
  return SURFACE_TYPE_SYNONYMS[lower] || type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Cluster surfaces by CANONICAL type and spatial proximity.
 * Two surfaces join the same cluster if:
 * - Same canonical type (Table/Desk/Studio_desk all merge)
 * - IoU > 0.30 against ANY existing surface in the cluster, OR
 * - Bounding box centers are within CLUSTER_TOLERANCE of each other (fallback for thin strips)
 *
 * IoU-against-all-members fixes the green+blue duplicate case: when bboxes
 * drift across frames, the rolling cluster member chain merges them into
 * one cluster instead of breaking off a new one.
 */
function clusterSurfaces(
  surfaces: Array<{ id: number; surfaceType: string; timestamp?: string | number; boundingBoxX: string; boundingBoxY: string; boundingBoxWidth: string; boundingBoxHeight: string; confidence: string; sceneId?: number | null; surfaceGroupId?: string | null }>,
  sceneCuts: number[] = [],
): SurfaceCluster[] {
  const CLUSTER_TOLERANCE = 0.18; // L∞ center distance (fallback)
  const IOU_MERGE = 0.30;

  const clusters: SurfaceCluster[] = [];

  for (const s of surfaces) {
    const bbX = parseFloat(s.boundingBoxX);
    const bbY = parseFloat(s.boundingBoxY);
    const bbW = parseFloat(s.boundingBoxWidth);
    const bbH = parseFloat(s.boundingBoxHeight);
    const centerX = bbX + bbW / 2;
    const centerY = bbY + bbH / 2;
    const canonical = canonicalSurfaceType(s.surfaceType);
    const candidateBox = { x: bbX, y: bbY, width: bbW, height: bbH };
    // Scene key — prefer the persisted sceneId (from sceneIndex's perceptual
    // clustering), fall back to per-shot sceneBlock for surfaces that were
    // detected before scene-first indexing shipped. Two surfaces with the
    // same sceneId are in the same physical scene (host shot returns), so
    // cross-shot clustering IS allowed there. Different sceneId = different
    // room = never cluster.
    const ts = typeof s.timestamp === "number" ? s.timestamp : parseFloat(String(s.timestamp ?? 0));
    const sceneKey = (typeof s.sceneId === "number")
      ? s.sceneId
      : sceneBlockForTimestamp(sceneCuts, Number.isFinite(ts) ? ts : 0);

    let matched = false;
    for (const cluster of clusters) {
      if (canonicalSurfaceType(cluster.surfaceType) !== canonical) continue;
      // HARD GATE: different scenes never cluster.
      if (cluster.sceneKey !== undefined && cluster.sceneKey !== sceneKey) continue;

      // Match against ANY member — bboxes drift across frames so the rolling
      // chain (frame N matches N+1, N+1 matches N+2, ...) keeps the cluster
      // intact even when the first and last bboxes wouldn't match each other.
      const isMatch = cluster.surfaces.some(member => {
        const memberBox = { x: member.bbX, y: member.bbY, width: member.bbW, height: member.bbH };
        if (bboxIoU(candidateBox, memberBox) > IOU_MERGE) return true;
        const mCX = member.bbX + member.bbW / 2;
        const mCY = member.bbY + member.bbH / 2;
        return Math.abs(centerX - mCX) < CLUSTER_TOLERANCE && Math.abs(centerY - mCY) < CLUSTER_TOLERANCE;
      });

      if (isMatch) {
        cluster.surfaces.push({ id: s.id, bbX, bbY, bbW, bbH, confidence: parseFloat(s.confidence), groupId: s.surfaceGroupId ?? null });
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({
        surfaceType: canonical,
        sceneKey,
        groupId: s.surfaceGroupId ?? null,
        surfaces: [{ id: s.id, bbX, bbY, bbW, bbH, confidence: parseFloat(s.confidence), groupId: s.surfaceGroupId ?? null }],
      });
    }
  }

  // Cluster-level identity: the dominant member group (most rows; ties break
  // toward higher cumulative confidence). Members from a different group got
  // spatially merged into this cluster — post-processing stamps them with
  // the dominant id so a physical surface keeps exactly one identity.
  // Room-model ids (rm{modelId}-s{idx}) ALWAYS beat fresh g-ids regardless
  // of row count: the model id is the persistent identity, and letting a
  // fresh sighting outvote it would re-mint the same physical surface as a
  // new g-group — which the finalize upsert would then append to the model
  // as a duplicate that gets confirmed on every future scan.
  for (const cluster of clusters) {
    const byGroup = new Map<string, { rows: number; conf: number }>();
    for (const m of cluster.surfaces) {
      if (!m.groupId) continue;
      const agg = byGroup.get(m.groupId) ?? { rows: 0, conf: 0 };
      agg.rows++;
      agg.conf += m.confidence;
      byGroup.set(m.groupId, agg);
    }
    let dominant: string | null = null;
    let dominantAgg = { rows: -1, conf: -1, isModel: false };
    for (const [gid, agg] of Array.from(byGroup.entries())) {
      const isModel = gid.startsWith("rm");
      const wins = isModel !== dominantAgg.isModel
        ? isModel
        : agg.rows > dominantAgg.rows || (agg.rows === dominantAgg.rows && agg.conf > dominantAgg.conf);
      if (wins) {
        dominant = gid;
        dominantAgg = { rows: agg.rows, conf: agg.conf, isModel };
      }
    }
    cluster.groupId = dominant;
  }

  return clusters;
}

/**
 * After clustering produces the median bboxes, two SEPARATE clusters of the
 * same canonical type can still end up overlapping (e.g. Gemini split the
 * same coffee table into two semantic groups due to confidence drift).
 * Merge clusters whose median bboxes have IoU > 0.4 — drop the
 * lower-cumulative-confidence one, mark its surfaces Filtered.
 *
 * Operates GROUP-WISE: clusters carrying the same surfaceGroupId are one
 * canonical surface that spatial clustering happened to split, so they're
 * coalesced into a single unit first — a group either survives whole or is
 * dropped whole, never partially. And a HARD scene gate: two units in
 * different scenes are different physical objects no matter how perfectly
 * their bboxes overlap (same wall position in the host shot and the guest
 * shot), so cross-scene dedupe never happens.
 */
async function dedupeOverlappingClusters(
  clusters: SurfaceCluster[],
  computeMedianFn: (c: SurfaceCluster['surfaces']) => { x: number; y: number; w: number; h: number },
): Promise<{ keep: SurfaceCluster[]; drop: SurfaceCluster[] }> {
  const IOU_MERGE = 0.40;

  // Coalesce same-group clusters into one unit. Group-less clusters (legacy
  // rows) stay one-unit-per-cluster, preserving the old behavior for them.
  const byGroup = new Map<string, SurfaceCluster>();
  const units: SurfaceCluster[] = [];
  for (const c of clusters) {
    if (!c.groupId) {
      units.push(c);
      continue;
    }
    const existing = byGroup.get(c.groupId);
    if (existing) {
      existing.surfaces = existing.surfaces.concat(c.surfaces);
    } else {
      const unit: SurfaceCluster = { surfaceType: c.surfaceType, sceneKey: c.sceneKey, groupId: c.groupId, surfaces: [...c.surfaces] };
      byGroup.set(c.groupId, unit);
      units.push(unit);
    }
  }

  const enriched = units.map(c => ({
    cluster: c,
    median: computeMedianFn(c.surfaces),
    score: c.surfaces.reduce((sum, s) => sum + s.confidence, 0),
  })).sort((a, b) => b.score - a.score);

  const keep: SurfaceCluster[] = [];
  const drop: SurfaceCluster[] = [];
  for (const e of enriched) {
    const eBox = { x: e.median.x, y: e.median.y, width: e.median.w, height: e.median.h };
    const conflict = keep.find(k => {
      if (canonicalSurfaceType(k.surfaceType) !== canonicalSurfaceType(e.cluster.surfaceType)) return false;
      // HARD scene gate: different scenes never dedupe.
      if (k.sceneKey !== undefined && e.cluster.sceneKey !== undefined && k.sceneKey !== e.cluster.sceneKey) return false;
      const kEnriched = enriched.find(x => x.cluster === k);
      if (!kEnriched) return false;
      const kBox = { x: kEnriched.median.x, y: kEnriched.median.y, width: kEnriched.median.w, height: kEnriched.median.h };
      return bboxIoU(eBox, kBox) > IOU_MERGE;
    });
    if (conflict) {
      drop.push(e.cluster);
    } else {
      keep.push(e.cluster);
    }
  }
  return { keep, drop };
}

/**
 * Compute the median bounding box for a cluster.
 * Uses the median of each dimension independently for robustness against outliers.
 */
function computeMedianBBox(surfaces: SurfaceCluster['surfaces']): { x: number; y: number; w: number; h: number } {
  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return {
    x: median(surfaces.map(s => s.bbX)),
    y: median(surfaces.map(s => s.bbY)),
    w: median(surfaces.map(s => s.bbW)),
    h: median(surfaces.map(s => s.bbH)),
  };
}

/**
 * Post-scan normalization pipeline.
 * Groups all detected surfaces by spatial similarity, computes a single
 * consistent bounding box per group, and updates all surfaces to use it.
 * Also filters out phantom surfaces that are too small (<5% frame area).
 */
async function normalizeSurfaceBoundingBoxes(videoId: number, excludeIds?: Set<number>, taughtGroupIds?: Set<string>): Promise<void> {
  console.log(`[Normalize] Starting bounding box normalization for video ${videoId}`);

  // excludeIds = the previous scan's rows (still active until end-of-scan
  // retirement). Keep them out of clustering/dedupe so they can't compete
  // with — or overwrite the bboxes of — this run's detections.
  const allRows = await storage.getDetectedSurfaces(videoId);
  const surfaces = excludeIds ? allRows.filter(s => !excludeIds.has(s.id)) : allRows;
  if (surfaces.length < 2) {
    console.log(`[Normalize] Only ${surfaces.length} surface(s), nothing to normalize`);
    return;
  }

  // Step 1: Filter out phantom and invalid surfaces
  // Height limits differ by orientation: horizontal surfaces (tables/desks)
  // seen at eye level are inherently thin strips (max ~40%), but vertical
  // surfaces (walls/doors/windows) legitimately span most of the frame.
  // Without per-orientation limits, every detected wall got removed as
  // "oversized" — exactly what the user just hit.
  const MIN_SURFACE_AREA = 0.03; // 3% of frame area minimum (applies to both orientations)
  const MAX_HORIZONTAL_HEIGHT = 0.40; // tables/desks at eye level
  const MAX_VERTICAL_HEIGHT = 0.95; // walls can fill almost the entire frame
  const phantomIds: number[] = [];
  for (const s of surfaces) {
    // Taught surfaces are creator ground truth — the creator drew the box.
    // The area/height heuristics exist to kill hallucinated detections, and
    // they were deterministically erasing small taught furniture every scan
    // (teach accepted boxes below the 3% floor). Never phantom-filter them.
    const rowGid = (s as any).surfaceGroupId as string | null | undefined;
    if (rowGid && taughtGroupIds?.has(rowGid)) continue;
    const width = parseFloat(String(s.boundingBoxWidth));
    const height = parseFloat(String(s.boundingBoxHeight));
    const area = width * height;
    const orientation = (s as any).orientation as string | null | undefined;
    // Backstop for legacy rows that pre-date the orientation field —
    // infer from surfaceType so the filter still does the right thing.
    const isVertical = orientation === "vertical"
      || ["wall", "door", "window"].includes((s.surfaceType || "").toLowerCase());
    const heightLimit = isVertical ? MAX_VERTICAL_HEIGHT : MAX_HORIZONTAL_HEIGHT;

    if (area < MIN_SURFACE_AREA) {
      phantomIds.push(s.id);
      console.log(`[Normalize] Removing phantom surface ${s.id} (${s.surfaceType}, area=${(area * 100).toFixed(1)}% < ${(MIN_SURFACE_AREA * 100)}%)`);
    } else if (height > heightLimit && s.surfaceType !== "Filtered") {
      // Bounding box exceeds the per-orientation max — likely overlaps people/floor
      phantomIds.push(s.id);
      console.log(`[Normalize] Removing oversized ${isVertical ? "vertical" : "horizontal"} surface ${s.id} (${s.surfaceType}, height=${(height * 100).toFixed(1)}% > ${(heightLimit * 100)}%)`);
    }
  }

  // Delete phantom surfaces
  for (const id of phantomIds) {
    try {
      await storage.updateDetectedSurface(id, { surfaceType: "Filtered", sceneContext: "Removed: surface too small" });
    } catch (err) {
      console.warn(`[Normalize] Failed to filter surface ${id}:`, err);
    }
  }

  // Step 2: Cluster remaining valid surfaces. Pass scene cuts so cross-shot
  // surfaces don't merge — same rationale as captureSurfaceKeyframes.
  const validSurfaces = surfaces.filter(s => !phantomIds.includes(s.id));
  let sceneCuts: number[] = [];
  try {
    const video = await storage.getVideoById(videoId);
    const raw = (video as any)?.sceneBoundaries;
    if (Array.isArray(raw)) sceneCuts = raw.filter(t => typeof t === "number" && Number.isFinite(t));
  } catch { /* ignore */ }
  const clusters = clusterSurfaces(validSurfaces as any, sceneCuts);

  console.log(`[Normalize] Found ${clusters.length} cluster(s) from ${validSurfaces.length} surfaces (scene cuts: ${sceneCuts.length})`);

  // Step 2a: identity adoption. When spatial clustering merges rows from
  // more than one consensus group into a single cluster, post-processing has
  // decided they're the same physical surface — every merged row adopts the
  // cluster's dominant surfaceGroupId so identity stays one-per-surface all
  // the way to the inventory. Rows with no groupId (legacy scans) adopt too
  // when the cluster has one; clusters with no grouped rows are left alone.
  for (const cluster of clusters) {
    if (!cluster.groupId) continue;
    for (const member of cluster.surfaces) {
      if (member.groupId === cluster.groupId) continue;
      try {
        await storage.updateDetectedSurface(member.id, { surfaceGroupId: cluster.groupId });
        member.groupId = cluster.groupId;
      } catch (err) {
        console.warn(`[Normalize] Failed to adopt group id on surface ${member.id}:`, err);
      }
    }
  }

  // Step 2b: Drop overlapping clusters of the same canonical type. clusterSurfaces
  // groups by IoU/center-distance against members, but two clusters of the same
  // type can still drift far enough apart that no individual member matches —
  // their MEDIANS, however, can still overlap heavily. This pass catches the
  // green+blue duplicate case where Gemini split one real coffee table into two
  // semantic groups across many frames.
  const { keep: keptClusters, drop: dropCandidates } = await dedupeOverlappingClusters(clusters, computeMedianBBox);
  // Taught clusters never lose the dedupe: a 1-row taught cluster (~0.9
  // cumulative confidence) loses to any multi-row cluster on score, which
  // deterministically erased the creator's own box every scan. Spared
  // clusters rejoin the kept set so step 3 still normalizes their rows.
  const droppedClusters: typeof dropCandidates = [];
  for (const cluster of dropCandidates) {
    if (cluster.groupId && taughtGroupIds?.has(cluster.groupId)) {
      console.log(`[Normalize] Sparing taught cluster ${cluster.groupId} (${cluster.surfaceType}) from dedupe drop`);
      keptClusters.push(cluster);
    } else {
      droppedClusters.push(cluster);
    }
  }
  if (droppedClusters.length > 0) {
    console.log(`[Normalize] Dropping ${droppedClusters.length} overlapping cluster(s) of duplicate type`);
    for (const cluster of droppedClusters) {
      for (const surface of cluster.surfaces) {
        try {
          await storage.updateDetectedSurface(surface.id, {
            surfaceType: "Filtered",
            sceneContext: `Removed: duplicate ${cluster.surfaceType} cluster overlapping a stronger one`,
          });
        } catch (err) {
          console.warn(`[Normalize] Failed to filter duplicate cluster surface ${surface.id}:`, err);
        }
      }
    }
  }

  // Step 3: For each kept cluster with 2+ surfaces, compute median bbox and update all
  let normalizedCount = 0;
  for (const cluster of keptClusters) {
    if (cluster.surfaces.length < 2) continue;

    const medianBox = computeMedianBBox(cluster.surfaces);
    console.log(`[Normalize] Cluster "${cluster.surfaceType}" (${cluster.surfaces.length} surfaces) → median bbox: x=${(medianBox.x * 100).toFixed(1)}%, y=${(medianBox.y * 100).toFixed(1)}%, w=${(medianBox.w * 100).toFixed(1)}%, h=${(medianBox.h * 100).toFixed(1)}%`);

    for (const surface of cluster.surfaces) {
      try {
        await storage.updateDetectedSurface(surface.id, {
          surfaceType: cluster.surfaceType, // Normalize name (e.g., "Studio_desk" → "Table")
          boundingBoxX: medianBox.x.toFixed(6),
          boundingBoxY: medianBox.y.toFixed(6),
          boundingBoxWidth: medianBox.w.toFixed(6),
          boundingBoxHeight: medianBox.h.toFixed(6),
        });
        normalizedCount++;
      } catch (err) {
        console.warn(`[Normalize] Failed to update surface ${surface.id}:`, err);
      }
    }
  }

  console.log(`[Normalize] Normalized ${normalizedCount} surfaces across ${keptClusters.length} cluster(s)`);
}

// ============================================================================
// TEMPORAL SURFACE GROUPING
// ============================================================================

/**
 * Groups surfaces across frames into temporal tracks by canonical surface
 * identity. This identifies when a surface "starts" and "ends" in the video.
 * Keeps the best track (longest duration, highest confidence) PER canonical
 * surface and marks that surface's weaker fragmented sightings as Filtered —
 * distinct surfaces always keep their own best track.
 *
 * This prevents ghost/duplicate tracks of one surface without ever deleting
 * a different physical surface that happens to share its type or position.
 */
async function groupSurfacesTemporally(
  videoId: number,
  intervalHint: number = CONFIG.FRAME_INTERVAL_SECONDS,
  excludeIds?: Set<number>,
): Promise<void> {
  console.log(`[Temporal] Starting temporal grouping for video ${videoId} (interval hint: ${intervalHint}s)`);

  const surfaces = await storage.getDetectedSurfaces(videoId);
  // excludeIds = the previous scan's rows. They're retired at end-of-scan, but
  // until then they're still active in the DB — letting them into the track
  // competition means old detections can outscore and delete the new scan's.
  const validSurfaces = surfaces.filter(s =>
    s.surfaceType !== "Filtered" &&
    s.surfaceType !== "Potential Surface" &&
    !excludeIds?.has(s.id));

  if (validSurfaces.length < 2) {
    console.log(`[Temporal] Only ${validSurfaces.length} valid surface(s), skipping temporal grouping`);
    return;
  }

  // Sort by timestamp
  const sorted = [...validSurfaces].sort((a, b) => parseFloat(String(a.timestamp)) - parseFloat(String(b.timestamp)));

  // Track identity — the canonical surface group when the row has one.
  // Chaining used to accept `same type OR similar center-Y`, which fused
  // DIFFERENT physical surfaces (a desk and the shelf behind it sit at
  // similar heights) into one track labeled after whichever came first.
  // A track is now one identity, full stop. Rows without a groupId (legacy
  // scans) fall back to a type+scene composite — same-type-same-scene
  // chaining without the cross-identity position shortcut.
  const trackKeyOf = (s: (typeof sorted)[number]): string =>
    ((s as any).surfaceGroupId as string | null | undefined)
      ?? `${s.surfaceType.toLowerCase()}:scene${(s as any).sceneId ?? 0}`;

  // Build tracks: consecutive frames of the SAME canonical surface
  interface SurfaceTrack {
    surfaceType: string;
    key: string;
    surfaces: typeof sorted;
    startTime: number;
    endTime: number;
    avgConfidence: number;
  }

  // Partition rows by identity FIRST, then chain each partition by time gap
  // independently. Chaining the global timestamp order broke multicam scenes:
  // when frames yield 2+ consensus surfaces each, rows of different groups
  // alternate at every timestamp (desk@100s, wall@100s, desk@109s, ...), so
  // every key change closed the track, nearly every track was a singleton,
  // and best-per-group kept ONE row per surface — silently filtering the
  // supporting-frame rows that give videoExporter fades and remix
  // densification their keyframe density. Distinct groups never interact.
  const rowsByKey = new Map<string, typeof sorted>();
  for (const s of sorted) {
    const key = trackKeyOf(s);
    const arr = rowsByKey.get(key) ?? [];
    arr.push(s);
    rowsByKey.set(key, arr);
  }

  const tracks: SurfaceTrack[] = [];
  const closeTrack = (key: string, trackRows: typeof sorted) => {
    const timestamps = trackRows.map(s => parseFloat(String(s.timestamp)));
    tracks.push({
      surfaceType: trackRows[0].surfaceType,
      key,
      surfaces: [...trackRows],
      startTime: Math.min(...timestamps),
      endTime: Math.max(...timestamps),
      avgConfidence: trackRows.reduce((sum, s) => sum + parseFloat(String(s.confidence)), 0) / trackRows.length,
    });
  };

  for (const [key, rows] of Array.from(rowsByKey.entries())) {
    // "Consecutive" means within 1.5× the actual scan interval. The hint is
    // the caller-measured median gap between analyzed frames — scene-first
    // and grid-diverse sampling space frames irregularly (shot midpoints,
    // 9s+ grids), so a config-constant interval here marked every real gap
    // as non-consecutive, fragmenting tracks into one-frame slivers and
    // filtering 95%+ of detections.
    let currentTrack: typeof sorted = [rows[0]];
    for (let i = 1; i < rows.length; i++) {
      const timeDiff = parseFloat(String(rows[i].timestamp)) - parseFloat(String(rows[i - 1].timestamp));
      if (timeDiff <= intervalHint * 1.5) {
        currentTrack.push(rows[i]);
      } else {
        closeTrack(key, currentTrack);
        currentTrack = [rows[i]];
      }
    }
    closeTrack(key, currentTrack);
  }

  console.log(`[Temporal] Found ${tracks.length} surface track(s):`);
  for (const track of tracks) {
    const duration = track.endTime - track.startTime + intervalHint;
    console.log(`[Temporal]   ${track.surfaceType}: ${track.startTime}s - ${track.endTime}s (${duration}s, ${track.surfaces.length} frames, ${(track.avgConfidence * 100).toFixed(0)}% avg confidence)`);
  }

  if (tracks.length <= 1) {
    console.log(`[Temporal] Only 1 track, no filtering needed`);
    // Store temporal range in scene_context for the surfaces in this track
    if (tracks.length === 1) {
      const track = tracks[0];
      const duration = track.endTime - track.startTime + intervalHint;
      const contextNote = `Visible: ${track.startTime}s - ${track.endTime + intervalHint}s (${duration}s)`;
      for (const s of track.surfaces) {
        try {
          await storage.updateDetectedSurface(s.id, { sceneContext: contextNote });
        } catch (err) { /* non-fatal */ }
      }
    }
    return;
  }

  // Score tracks: prefer longer duration and higher confidence
  const scoredTracks = tracks.map(track => {
    const duration = track.endTime - track.startTime + intervalHint;
    // Score = duration (in seconds) * average confidence
    const score = duration * track.avgConfidence;
    return { ...track, score, duration };
  }).sort((a, b) => b.score - a.score);

  // Keep the best track PER CANONICAL SURFACE. Keying by (type, scene) kept
  // ONE track per type per scene — two REAL walls in the same wide shot
  // meant one of them lost. A distinct group is a distinct physical surface
  // and always survives; only weaker RE-DETECTIONS of the same surface
  // (fragmented sightings of one group) lose to that group's best track.
  const bestPerGroup = new Map<string, typeof scoredTracks[0]>();
  for (const t of scoredTracks) {
    const existing = bestPerGroup.get(t.key);
    if (!existing || t.score > existing.score) {
      bestPerGroup.set(t.key, t);
    }
  }
  const keepIds = new Set<number>();
  const winningTracks = Array.from(bestPerGroup.values());
  for (const t of winningTracks) {
    console.log(`[Temporal] Keeping ${t.surfaceType} [${t.key}]: ${t.startTime}s - ${t.endTime}s (${t.duration}s, score=${t.score.toFixed(2)})`);
    const contextNote = `Visible: ${t.startTime}s - ${t.endTime + intervalHint}s (${t.duration}s)`;
    for (const s of t.surfaces) {
      keepIds.add(s.id);
      try {
        await storage.updateDetectedSurface(s.id, { sceneContext: contextNote });
      } catch (err) { /* non-fatal */ }
    }
  }

  // Filter out surfaces NOT in their group's winning track. These are weaker
  // fragments of the SAME canonical surface (e.g. a brief 2-frame sighting
  // when the group's primary track has 5 frames). Other groups — including
  // same-type groups in the same scene — keep their own winners.
  for (const track of scoredTracks) {
    if (track.surfaces.every(s => keepIds.has(s.id))) continue; // entirely a winner
    for (const s of track.surfaces) {
      if (keepIds.has(s.id)) continue;
      const winner = bestPerGroup.get(track.key);
      const winnerLabel = winner ? `${winner.surfaceType} (${winner.duration}s)` : "best track";
      console.log(`[Temporal] Filtering surface ${s.id} (${track.surfaceType}, ${track.duration}s) — winning track for this surface is ${winnerLabel}`);
      try {
        await storage.updateDetectedSurface(s.id, {
          surfaceType: "Filtered",
          sceneContext: `Removed: weaker ${track.surfaceType} sighting (${track.duration}s) — best track for this surface is ${winnerLabel}`,
        });
      } catch (err) {
        console.warn(`[Temporal] Failed to filter surface ${s.id}:`, err);
      }
    }
  }

  console.log(`[Temporal] Kept ${keepIds.size} surfaces across ${bestPerGroup.size} canonical surface track(s), filtered ${validSurfaces.length - keepIds.size}`);
}

// ============================================================================
// MAIN SCAN FUNCTIONS
// ============================================================================

// Single-flight lock per videoId. Prevents stacked scans when the user clicks
// the Scan button repeatedly while a scan is already running. Subsequent calls
// for the same videoId join the in-flight promise rather than starting a new
// scan, so the user gets one scan and one consistent result regardless of how
// many times they click. The map clears once each scan settles.
const SCAN_IN_FLIGHT = new Map<number, Promise<ScanResult>>();

export function isVideoScanInFlight(videoId: number): boolean {
  return SCAN_IN_FLIGHT.has(videoId);
}

export async function processVideoScan(
  videoId: number,
  forceRescan: boolean = false,
  scanMode: keyof typeof scanModes = "standard"
): Promise<ScanResult> {
  // If a scan is already running for this video, return the existing promise.
  // The caller's "click again" results in the same response as the original
  // run — no wipe, no parallel work, no race.
  const existing = SCAN_IN_FLIGHT.get(videoId);
  if (existing) {
    console.log(`[Scanner V2] Video ${videoId}: scan already in progress, joining existing run (forceRescan=${forceRescan} ignored)`);
    return existing;
  }

  const promise = (async () => {
    try {
      return await processVideoScanInner(videoId, forceRescan, scanMode);
    } finally {
      SCAN_IN_FLIGHT.delete(videoId);
    }
  })();

  SCAN_IN_FLIGHT.set(videoId, promise);
  return promise;
}

async function processVideoScanInner(
  videoId: number,
  forceRescan: boolean = false,
  scanMode: keyof typeof scanModes = "standard"
): Promise<ScanResult> {
  console.log(`[Scanner V2] ========== STARTING SCAN ==========`);
  console.log(`[Scanner V2] Video ID: ${videoId}, Force Rescan: ${forceRescan}`);

  const tempDir = path.join(os.tmpdir(), `scan-v2-${videoId}-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");

  // Snapshot existing surface IDs BEFORE any wipe. If this scan succeeds with
  // new surfaces we'll delete the snapshotted ones at the end. If the scan
  // fails or finds nothing, we leave the prior data alone — preserves the
  // creator's previous results across an error or a click-twice rescan.
  // priorActiveCount tracks only the rows a brand can actually see: the raw
  // snapshot includes every soft-deleted Filtered/"Potential Surface" row
  // from all prior rescans (rescans never hard-delete), so using its length
  // in a status string inflates monotonically — 4 active surfaces atop 130
  // retired rows must revert to "Ready (4 Spots)", not "Ready (134 Spots)".
  let priorSurfaceIds: number[] = [];
  let priorActiveCount = 0;
  // groupId per ACTIVE prior row — the retirement sweep spares taught rows
  // only when they were still live at scan start. A row the creator rejected
  // is already Filtered and stays that way; sparing must never resurrect it.
  const priorGroupById = new Map<number, string>();
  try {
    const prior = await storage.getDetectedSurfaces(videoId);
    priorSurfaceIds = prior.map(s => s.id);
    for (const s of prior) {
      const gid = (s as any).surfaceGroupId as string | null | undefined;
      if (gid && s.surfaceType !== "Filtered") priorGroupById.set(s.id, gid);
    }
    // Count CANONICAL surfaces, not rows — each surface owns many
    // supporting-frame rows, and a failed rescan reverting to
    // "Ready (23 Spots)" over 4 physical surfaces is the row-count fiction
    // this pipeline exists to kill. Rows from before groupIds existed fall
    // back to type+scene identity (same coalesce storage counts by).
    priorActiveCount = new Set(
      prior
        .filter(s => s.surfaceType !== "Filtered" && s.surfaceType !== "Potential Surface")
        .map(s => ((s as any).surfaceGroupId as string | null | undefined) ?? `${s.surfaceType}:${(s as any).sceneId ?? 0}`)
    ).size;
    if (priorSurfaceIds.length > 0) {
      console.log(`[Scanner V2] Snapshotted ${priorSurfaceIds.length} existing surface rows (${priorActiveCount} active canonical surfaces) — will replace only on successful scan`);
    }
  } catch (err: any) {
    console.warn(`[Scanner V2] Could not snapshot existing surfaces:`, err?.message || err);
  }

  try {
    const video = await storage.getVideoById(videoId);
    if (!video) {
      return { success: false, videoId, surfacesDetected: 0, error: "Video not found" };
    }

    console.log(`[Scanner V2] Video: ${video.title} (${video.youtubeId})`);

    if (!forceRescan && video.status !== "Pending Scan") {
      return {
        success: false,
        videoId,
        surfacesDetected: 0,
        error: `Video status is "${video.status}", not "Pending Scan"`,
      };
    }

    // PRE-FLIGHT CHECKS — flat floor only. The stream path writes just a
    // few hundred small JPEGs, so scaling this gate with duration would
    // veto stream-only scans of long videos that never touch
    // download-sized space. The duration-scaled requirement lives in the
    // re-check right before the download fallback commits to its pull —
    // the only phase that actually needs that much room.
    const availableMB = await getAvailableDiskSpaceMB();
    console.log(`[Scanner V2] Available disk space: ${availableMB}MB (required: ${CONFIG.MIN_DISK_SPACE_MB}MB)`);

    if (availableMB < CONFIG.MIN_DISK_SPACE_MB) {
      console.error(`[Scanner V2] Insufficient disk space: ${availableMB}MB < ${CONFIG.MIN_DISK_SPACE_MB}MB required`);
      return {
        success: false,
        videoId,
        surfacesDetected: 0,
        error: `Insufficient disk space: ${availableMB}MB available, ${CONFIG.MIN_DISK_SPACE_MB}MB required`,
      };
    }

    // Mark "Scanning" up front — BEFORE any download/stream resolution — so the
    // library poll sees the transition immediately instead of clearing the
    // spinner while a slow source resolution is still in flight. (A later
    // updateVideoStatus("Scanning") is a harmless no-op re-write.)
    await storage.updateVideoStatus(videoId, "Scanning");

    // LOCATE VIDEO FILE
    let videoPath: string | undefined;

    // OAuth stream-and-scan: frames pulled directly from a CDN URL without ever
    // downloading the full video (see streamResolver.ts + extractFramesFromUrl).
    // When this succeeds, we skip the local-file requirement entirely and feed
    // these frames straight into detection.
    let streamedFrames: { frames: string[]; timestamps: number[]; segmentIds: number[]; sceneIndex: SceneIndex | null } | null = null;

    if ((video as any).filePath?.startsWith('/storage/')) {
      try {
        const objectKey = (video as any).filePath.replace(/^\/storage\//, 'public/');
        videoPath = await downloadToTempFile(objectKey, tempDir);
        console.log(`[Scanner V2] Downloaded from Object Storage to: ${videoPath}`);
      } catch (e: any) {
        console.error(`[Scanner V2] Object Storage download failed:`, e.message);
      }
    } else if ((video as any).filePath) {
      videoPath = path.resolve(process.cwd(), (video as any).filePath);
      console.log(`[Scanner V2] Using DB filePath: ${videoPath}`);
    }
    
    if (!videoPath && LOCAL_ASSET_MAP[video.youtubeId]) {
      videoPath = path.resolve(process.cwd(), LOCAL_ASSET_MAP[video.youtubeId]);
      console.log(`[Scanner V2] Using LOCAL_ASSET_MAP: ${videoPath}`);
    }
    
    if (!videoPath && video.youtubeId.startsWith("upload-")) {
      const fileMatch = video.description?.match(/File: (\/uploads\/[^\s|]+)/);
      if (fileMatch) {
        videoPath = path.resolve(process.cwd(), `./public${fileMatch[1]}`);
        console.log(`[Scanner V2] Using description fallback: ${videoPath}`);
      }
    }

    // YOUTUBE FALLBACK: imported videos (via /api/youtube/sync or
    // import-selected) have no filePath — only a youtubeId. Pull the source
    // to tempDir so the rest of the scan pipeline has bytes to work with.
    // tempDir is cleaned up in the finally block, so the source video is
    // discarded automatically once frames are extracted (light-cloud model:
    // we never persist creator source files).
    const looksLikeRealYouTubeId = (id: string) =>
      !!id && !id.startsWith("upload-") && !id.startsWith("ig-")
        && !id.startsWith("fb-") && !id.startsWith("demo-")
        && !id.startsWith("hero-");

    let scanPlan: { intervalSeconds: number; maxFrames: number } = {
      intervalSeconds: CONFIG.FRAME_INTERVAL_SECONDS,
      maxFrames: CONFIG.MAX_FRAMES_PER_VIDEO,
    };
    // True until a duration-derived plan replaces the CONFIG defaults. Local
    // files (uploads) used to skip planning entirely and scan 48s of an
    // hour-long file — the local path below probes ffprobe when this is
    // still set.
    let scanPlanIsDefault = true;

    // Hard cap at 1 hour — anything longer scans only the first hour of
    // content (creator-confirmed: nothing >1hr in scope). Shared by the
    // stream grid sizing, the download plan, and the local-file plan.
    const MAX_DURATION_SEC = 60 * 60;

    // Plan adaptive sampling — duration-banded, NOT a fixed frame target.
    // Fixed-target was wrong: 75 frames on a 30-min video = every 24s,
    // way too sparse for podcasts where surfaces shift between cuts.
    // Sliding scale gets denser sampling on shorter content where
    // action density is higher, and reasonable spacing on longer content.
    const planFromDuration = (durSec: number): { intervalSeconds: number; maxFrames: number } => {
      // Cap effective duration at 1hr — long videos still scan, just
      // limited to first hour of content.
      const eff = Math.min(durSec, MAX_DURATION_SEC);
      let interval: number;
      if (eff <= 5 * 60) interval = 2;          // ≤5min: every 2s
      else if (eff <= 15 * 60) interval = 3;    // 5–15min: every 3s
      else if (eff <= 30 * 60) interval = 4;    // 15–30min: every 4s
      else interval = 5;                         // 30–60min: every 5s
      const maxFrames = Math.ceil(eff / interval);
      return { intervalSeconds: interval, maxFrames };
    };

    // Resolve video duration. Primary source: the DB (YouTube import stores
    // ISO 8601 like "PT1H46M2S" in video.duration). Fast + reliable since
    // we already have it. Fallback: yt-dlp metadata probe — but that's
    // slow and frequently times out on long videos, so we only try it if
    // the DB doesn't have a duration.
    const durationSec = (() => {
      const fromDb = parseIsoDuration((video as any).duration);
      if (fromDb && fromDb > 0) {
        console.log(`[Scanner V2] Duration from DB: ${fromDb}s (${(fromDb/60).toFixed(1)} min)`);
        return fromDb;
      }
      return null;
    })();

    // yt-dlp probe result, shared between the stream path and the download
    // fallback — each probe spawns yt-dlp and can take tens of seconds, so
    // a stream attempt that probes and then fails coverage must not force
    // the fallback to probe the same video again.
    let ytProbedDurationSec: number | null = null;

    // ─── OAuth STREAM-AND-SCAN (primary path for imported videos) ───────────
    // For YouTube/IG/FB imports (no local filePath), resolve a direct CDN URL
    // via the creator's OAuth credentials and pull sample frames straight from
    // it — no full download, no upload. This is the intended model: the source
    // is never persisted. Falls through to the download fallbacks below only if
    // URL resolution or streaming extraction fails.
    const platform = (video as any).platform as string | undefined;
    const isStreamableImport =
      !videoPath &&
      ((platform === "youtube" && looksLikeRealYouTubeId(video.youtubeId)) ||
       ((platform === "instagram" || platform === "facebook") &&
        (video.youtubeId.startsWith("instagram:") || video.youtubeId.startsWith("facebook:"))));

    // Creator's YouTube OAuth token — shared by the stream-URL resolve, the
    // duration probe, and the download fallback below (Path B: authenticated
    // requests bypass anonymous bot detection). Fetched once per scan; null
    // for non-YouTube sources and local files.
    const oauthToken = !videoPath && platform === "youtube" && looksLikeRealYouTubeId(video.youtubeId)
      ? await getFreshYoutubeTokenForUser(video.userId).catch(() => null)
      : null;

    if (isStreamableImport) {
      let source: StreamSource | null = null;
      try {
        if (platform === "youtube") {
          source = await resolveYoutubeStreamUrl(video.youtubeId, oauthToken || undefined);
        } else {
          const user = await storage.getUserById((video as any).userId);
          const token = safeDecrypt(user?.facebookAccessToken);
          if (!token) {
            console.warn(`[Scanner V2] No Facebook token for user ${(video as any).userId} — cannot stream ${platform}`);
          } else {
            source = await resolveGraphStreamUrl(video.youtubeId, platform as "instagram" | "facebook", token);
          }
        }
      } catch (e: any) {
        console.warn(`[Scanner V2] Stream URL resolution threw: ${e?.message || e}`);
      }

      if (source) {
        // DENSE-then-DIVERSE detection: pull a dense uniform grid in one
        // streaming pass (interval GRID_INTERVAL), then perceptually dedup to a
        // scene-diverse subset for Gemini. Dense grid = every scene is SEEN so
        // no surface is skipped; dedup = Gemini budget spent on distinct
        // scenes/angles, not near-identical frames. This is the OAuth
        // detection model: the stream flows through ffmpeg transiently, nothing
        // is persisted.
        const GRID_CAP = 400;                     // hard ceiling on candidate frames
        // The DB duration is often absent for imports (and unparseable
        // formats parse to null) — mirror the download fallback and probe
        // yt-dlp before sizing the grid blind. Sizing blind against a
        // too-small grid silently caps coverage at the first few minutes
        // of a video of unknown length.
        let streamDurationSec = durationSec;
        if (!streamDurationSec && platform === "youtube") {
          ytProbedDurationSec = await getYoutubeVideoDuration(video.youtubeId, oauthToken || undefined);
          streamDurationSec = ytProbedDurationSec;
          if (streamDurationSec) {
            console.log(`[Scanner V2] Duration from yt-dlp probe: ${streamDurationSec}s`);
          }
        }
        const eff = streamDurationSec ? Math.min(streamDurationSec, MAX_DURATION_SEC) : null;
        // Interval adapts to duration so the candidate grid spans the WHOLE
        // (capped) video without exceeding GRID_CAP: short clips get dense 2s
        // sampling; a 1hr podcast gets ~9s sampling across all 60 min. dHash
        // dedup below then trims to the scene-diverse detection set. Unknown
        // duration sizes for the full 1-hour cap (9s × 400 = 3600s) — the
        // extractor stops at end-of-stream anyway, so short videos just
        // finish early, while a tighter blind grid would quietly scan only
        // the head of a long one.
        const gridInterval = eff ? Math.max(2, Math.ceil(eff / GRID_CAP)) : 9;
        const gridMax = eff ? Math.min(GRID_CAP, Math.ceil(eff / gridInterval)) : GRID_CAP;

        console.log(`[Scanner V2] Stream-and-scan: dense grid every ${gridInterval}s (up to ${gridMax} candidates spanning ${eff ? (eff/60).toFixed(1)+'min' : 'unknown dur'}) from ${platform} CDN URL (no download)`);
        fs.mkdirSync(framesDir, { recursive: true });
        const grid = await extractFramesUniformFromUrl(source, framesDir, gridInterval, gridMax);

        // COVERAGE GATE: a truncated dense pass (CDN throttle, mid-stream
        // 403, the extractor's 8-min SIGKILL cap) returns a partial grid of
        // head-of-video frames. Accepting it marks the video scanned with
        // the whole back half unseen AND suppresses the download fallback
        // below (gated on !streamedFrames) — the worst kind of failure, an
        // invisible one. A clean ffmpeg exit means the entire input was
        // read (or the frame cap was hit), so the grid is complete no
        // matter how few frames it holds — a fully-streamed short Reel
        // with no stored duration is accepted here, not bounced to the
        // download path. Truncated (dirty-exit) grids must span ≥70% of
        // the (capped) duration; with unknown duration, a sane frame floor.
        const coveredSec = grid.frames.length > 0
          ? grid.timestamps[grid.timestamps.length - 1] + gridInterval
          : 0;
        const acceptReason = grid.frames.length === 0
          ? null
          : grid.complete
          ? "clean ffmpeg exit (entire input read)"
          : eff !== null && coveredSec >= 0.7 * eff
          ? `covered ${coveredSec}s of ${eff}s (≥70%)`
          : eff === null && grid.frames.length >= 10
          ? `${grid.frames.length} frames meet the 10-frame floor (unknown duration)`
          : null;

        if (acceptReason) {
          console.log(`[Scanner V2] Stream-and-scan: grid accepted — ${acceptReason}; ${grid.frames.length} frames spanning ~${coveredSec}s`);
          // Detection budget: how many frames actually go to Gemini. Larger
          // than the old fixed 24 — recall matters more than cost per the
          // creator's directive that detection quality is paramount.
          const detectionBudget = Math.max(CONFIG.MAX_FRAMES_PER_VIDEO, Math.min(60, grid.frames.length));
          const selected = await selectDiverseFrames(grid.frames, grid.timestamps, {
            hashThreshold: 10,       // dHash hamming ≥10/64 ≈ meaningfully different scene/angle
            budget: detectionBudget,
          });
          if (selected.frames.length > 0) {
            streamedFrames = selected;
            console.log(`[Scanner V2] Stream-and-scan: ${grid.frames.length} candidates → ${selected.frames.length} diverse frames for detection — skipping download`);
          }
        } else if (grid.frames.length > 0) {
          console.warn(
            `[Scanner V2] Stream-and-scan: truncated dense grid covered only ${coveredSec}s of ` +
            (eff !== null
              ? `${eff}s (${grid.frames.length} frames, <70%)`
              : `unknown duration (${grid.frames.length} frames, below 10-frame floor)`) +
            ` — treating stream attempt as FAILED`
          );
        }
        if (!streamedFrames) {
          console.warn(`[Scanner V2] Stream-and-scan produced no usable frame set — falling back to download`);
          // Purge the whole grid (including size-floor stubs the collector
          // excluded from its return but left on disk): the download
          // fallback's uniform extractor globs this same dir for *.jpg,
          // and stale grid frames would mix into its results with wrong
          // timestamps. Must run on EVERY unaccepted stream attempt — a
          // stub-only grid has frames.length === 0 and would otherwise
          // skip the purge entirely.
          try {
            for (const f of fs.readdirSync(framesDir)) {
              if (f.startsWith("grid_") && f.endsWith(".jpg")) safeUnlink(path.join(framesDir, f));
            }
          } catch { /* best-effort cleanup */ }
        }
      }
    }

    // Heartbeat: the stuck-scan sweep ages rows by updated_at, and the
    // resolve/probe/stream phases above plus the download fallbacks below
    // can legitimately run for tens of minutes with zero row writes.
    // Refresh updated_at at each long-phase boundary via the CAS — status
    // stays "Scanning", so a cancel that already flipped it is never
    // clobbered and the write is a no-op.
    await storage.updateVideoStatusIfScanning(videoId, "Scanning").catch(() => {});

    if (!videoPath && !streamedFrames && (video as any).platform === "youtube" && looksLikeRealYouTubeId(video.youtubeId)) {
      console.log(`[Scanner V2] No filePath; attempting YouTube download for ${video.youtubeId}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const downloadPath = path.join(tempDir, `${video.youtubeId}.mp4`);

      // Path B (OAuth): the hoisted oauthToken above rides along on every
      // request here so anonymous bot detection doesn't block long
      // downloads. Falls back to anonymous if no token is available.

      // Resolve duration for the duration-banded plan (planFromDuration
      // above). Probe results feed back into ytProbedDurationSec so the
      // degenerate-index fallback later in the local path can reuse them.
      let probedDuration = durationSec ?? ytProbedDurationSec;
      if (!probedDuration) {
        probedDuration = await getYoutubeVideoDuration(video.youtubeId, oauthToken || undefined);
        if (probedDuration) {
          console.log(`[Scanner V2] Duration from yt-dlp probe: ${probedDuration}s`);
          ytProbedDurationSec = probedDuration;
        }
      }

      if (probedDuration && probedDuration > 0) {
        scanPlan = planFromDuration(probedDuration);
        scanPlanIsDefault = false;
        const coveredMin = (scanPlan.intervalSeconds * scanPlan.maxFrames / 60).toFixed(1);
        const fullMin = (probedDuration / 60).toFixed(1);
        const cappedNote = probedDuration > MAX_DURATION_SEC ? ` (CAPPED at 1hr — full video is ${fullMin}min)` : "";
        console.log(`[Scanner V2] Plan: every ${scanPlan.intervalSeconds}s × ${scanPlan.maxFrames} frames = ${coveredMin}min coverage${cappedNote}`);
      } else {
        // Duration unknown — default to "5 min, every 2s" plan = 150 frames.
        scanPlan = { intervalSeconds: 2, maxFrames: 150 };
        scanPlanIsDefault = false;
        console.log(`[Scanner V2] Duration unknown — using fallback plan: every 2s × 150 frames (5min coverage)`);
      }

      // Download budget: enough seconds to cover the planned frames + a buffer.
      const plannedRange = scanPlan.intervalSeconds * scanPlan.maxFrames + 30;
      const cappedDuration = probedDuration ? Math.min(probedDuration, MAX_DURATION_SEC) : null;
      const trimSec = cappedDuration ? Math.min(cappedDuration, plannedRange) : plannedRange;

      // Re-check disk right before committing to the pull — the scan
      // preflight ran before the trim size was known, the stream attempt
      // above may have written hundreds of frames since, and /tmp is shared
      // with sourceCache, uploads, and the yt-dlp binary. Throwing (instead
      // of letting yt-dlp ENOSPC mid-file) skips the whole retry ladder,
      // whose later rungs drop the trim and pull strictly MORE bytes at
      // the same full disk. ~0.4 MB/s covers ≤720p plus merge headroom.
      const dlRequiredMB = Math.max(CONFIG.MIN_DISK_SPACE_MB, Math.ceil(trimSec * 0.4));
      const dlAvailableMB = await getAvailableDiskSpaceMB();
      if (dlAvailableMB < dlRequiredMB) {
        throw new Error(`Insufficient disk space for source download: ${dlAvailableMB}MB available, ~${dlRequiredMB}MB needed for a ${trimSec}s pull`);
      }

      const ok = await downloadYouTubeVideo(video.youtubeId, downloadPath, {
        trimToSeconds: trimSec,
        timeoutMs: 10 * 60 * 1000, // 10min cap — long videos with full-duration scans take longer
        oauthToken: oauthToken || undefined,
      });
      if (ok && fs.existsSync(downloadPath)) {
        videoPath = downloadPath;
        console.log(`[Scanner V2] YouTube download succeeded: ${videoPath}`);
        // Tee the pull into the playback/editorial cache so review playback
        // and the editorial pipeline become cache hits instead of separate
        // YouTube downloads from the same IP. Only when the trim window
        // covers the whole video — a >1hr capped pull or an
        // unknown-duration bounded pull is a truncated source and must
        // never be served to the player.
        if (probedDuration && probedDuration > 0 && probedDuration <= trimSec) {
          seedSourceCache(videoId, downloadPath);
        }
      } else {
        console.error(`[Scanner V2] YouTube download failed for ${video.youtubeId}`);
      }
    }

    // FACEBOOK / INSTAGRAM FALLBACK: imported videos (via /api/social/sync)
    // have no filePath — the importer only stored Graph API metadata. Resolve
    // the CDN-hosted source URL on-demand using the user's stored Page access
    // token (also valid for the linked IG Business account), download to
    // tempDir, and let the existing finally{} cleanup discard the bytes.
    // Same light-cloud model as the YouTube path above.
    const isFbOrIg =
      !videoPath && !streamedFrames &&
      ((video as any).platform === "facebook" || (video as any).platform === "instagram") &&
      (video.youtubeId.startsWith("facebook:") || video.youtubeId.startsWith("instagram:"));

    if (isFbOrIg) {
      const platform = (video as any).platform as "facebook" | "instagram";
      const user = await storage.getUserById((video as any).userId);
      const token = safeDecrypt(user?.facebookAccessToken);
      if (!token) {
        console.error(`[Scanner V2] No Facebook access token for user ${(video as any).userId} — cannot download ${platform} source`);
      } else {
        console.log(`[Scanner V2] No filePath; attempting ${platform} download for ${video.youtubeId}`);
        fs.mkdirSync(tempDir, { recursive: true });
        const safeId = video.youtubeId.replace(/[^a-zA-Z0-9]/g, "_");
        const downloadPath = path.join(tempDir, `${safeId}.mp4`);
        const ok = platform === "facebook"
          ? await downloadFacebookVideo(video.youtubeId, token, downloadPath)
          : await downloadInstagramVideo(video.youtubeId, token, downloadPath);
        if (ok && fs.existsSync(downloadPath)) {
          videoPath = downloadPath;
          console.log(`[Scanner V2] ${platform} download succeeded: ${videoPath}`);
          // Graph CDN downloads are always the full video — safe to tee
          // into the playback/editorial cache unconditionally.
          seedSourceCache(videoId, downloadPath);
        } else {
          console.error(`[Scanner V2] ${platform} download failed for ${video.youtubeId}`);
        }
      }
    }

    // DEBUG LOGGING
    console.log('[Scanner V2] DEBUG - youtubeId:', video.youtubeId);
    console.log('[Scanner V2] DEBUG - LOCAL_ASSET_MAP keys:', Object.keys(LOCAL_ASSET_MAP));
    console.log('[Scanner V2] DEBUG - Resolved videoPath:', videoPath);

    // No frames from streaming AND no local/downloaded file → genuine failure.
    // Give a descriptive, actionable status instead of the ambiguous
    // "Pending Upload" (which the UI rendered identically to "Pending Scan",
    // making a failed scan look like nothing happened).
    if (!streamedFrames && (!videoPath || !fs.existsSync(videoPath))) {
      console.error(`[Scanner V2] No frames from stream and no video file: ${videoPath}`);
      const platform = (video as any).platform as string | undefined;
      const failStatus =
        platform === "instagram" || platform === "facebook"
          ? "Scan Failed — Reconnect Instagram/Facebook"
          : platform === "youtube"
          ? "Scan Failed — Source Unavailable"
          : "Pending Upload";
      await updateStatusIfStillScanning(videoId, failStatus);
      return {
        success: false,
        videoId,
        surfacesDetected: 0,
        error: streamedFrames === null && (platform === "youtube" || platform === "instagram" || platform === "facebook")
          ? `Could not access ${platform} source. The connection may need to be re-authorized, or the video may be private/unavailable.`
          : "Video file not found. Upload required.",
      };
    }

    if (videoPath) {
      const fileSizeMB = fs.statSync(videoPath).size / 1024 / 1024;
      console.log(`[Scanner V2] Video file size: ${fileSizeMB.toFixed(2)}MB`);
    }

    fs.mkdirSync(framesDir, { recursive: true });

    let frames: string[] = [];
    let frameTimestamps: number[] = [];
    // Streamed path: dHash segment id per frame (consensus grouping when no sceneIndex exists)
    let streamSegmentIds: number[] | null = null;
    let usedSceneFirst = false;
    let sceneIndex: SceneIndex | null = null;
    // Provenance for the persisted index/inventory: ffmpeg cut detection on a
    // local file, or classes clustered from the streamed dense grid.
    let sceneIndexSource: "sceneIndex" | "grid" = "sceneIndex";
    // A degenerate index (zero cuts on a long video) still gets persisted,
    // but its single all-covering scene must not become the consensus
    // bucket — the local dHash segmentation below takes over for grouping.
    let indexDegenerate = false;

    if (streamedFrames) {
      // OAuth stream path: frames were already pulled from the CDN URL. No
      // ffmpeg cut detection here (that reads the whole file, which we
      // deliberately never downloaded) — but the dense grid's dHash classes
      // give us a real scene index of their own: recurring camera setups
      // with per-run tStart/tEnd. Adopt it (and persist it, unless that
      // would downgrade a refined index — see below), so streamed scans get
      // real sceneIds instead of stamping 0 on every row.
      frames = streamedFrames.frames;
      frameTimestamps = streamedFrames.timestamps;
      streamSegmentIds = streamedFrames.segmentIds;
      if (streamedFrames.sceneIndex && streamedFrames.sceneIndex.sceneCount > 0) {
        sceneIndex = streamedFrames.sceneIndex;
        sceneIndexSource = "grid";
        // Grid cuts are quantized to the sampling interval (~9s on an hour
        // file). A prior download-path scan may have persisted frame-accurate
        // refined cuts — overwriting those silently degrades sceneBlockId
        // enrichment and the client's shot-constrained placement. Persist
        // only when the stored index is absent/empty or itself grid-derived:
        // the source stamp below marks new grid rows, and all-integer cuts
        // identify legacy grid rows (refined cuts carry 1/60s fractions).
        // The grid index still drives THIS scan in-memory either way.
        const existingIdx = (video as any).sceneIndex as (SceneIndex & { source?: string }) | null | undefined;
        const existingIsRefined = !!existingIdx &&
          Array.isArray(existingIdx.cuts) && existingIdx.cuts.length > 0 &&
          existingIdx.source !== "grid" &&
          existingIdx.cuts.some(c => !Number.isInteger(c));
        if (existingIsRefined) {
          console.log(`[Scanner V2] Keeping existing frame-accurate scene index (${existingIdx!.cuts.length} refined cuts) — adopting it for grouping and stamping`);
          // Rows must be stamped in the SAME sceneId space as the index the
          // API serves — the placement preview compares surface.sceneId
          // against sceneIds computed from the served index, and the grid
          // clustering numbers its classes independently. The grid index
          // already did its job (frame selection); everything downstream
          // (consensus keys, row stamping, inventory) uses the kept index.
          sceneIndex = existingIdx!;
          sceneIndexSource = "sceneIndex";
        } else {
          try {
            await storage.updateVideoIndex(videoId, {
              sceneIndex: { ...sceneIndex, source: "grid" } as any,
              sceneBoundaries: sceneIndex.cuts as any,
            });
            console.log(`[Scanner V2] Persisted grid-derived scene index: ${sceneIndex.sceneCount} unique scene(s) across ${sceneIndex.shots.length} run(s)`);
          } catch (gidxErr: any) {
            console.warn(`[Scanner V2] Failed to persist grid scene index (non-fatal):`, gidxErr?.message || gidxErr);
          }
        }
      }
      console.log(`[Scanner V2] Using ${frames.length} streamed frames (${sceneIndex ? "grid scene classes" : "dHash segments"}; ffmpeg cut detection skipped — no local file)`);
    } else if (videoPath) {
      // LOCAL/DOWNLOADED path — scene-first detection for denser, cheaper sampling.
      // Resolve duration first. Uploads reach here with the CONFIG default
      // plan (no DB duration, no yt-dlp probe) — scanning blind against it
      // meant a 61-minute upload scanned only its first 48 seconds. One
      // ffprobe on the local file fixes the plan; the duration also sizes
      // the uniform fallback below when scene-first sampling doesn't happen.
      let localDurationSec = durationSec ?? ytProbedDurationSec;
      if (scanPlanIsDefault || !localDurationSec) {
        const probed = await probeLocalDurationSec(videoPath);
        if (probed > 0) {
          localDurationSec = probed;
          if (scanPlanIsDefault) {
            scanPlan = planFromDuration(probed);
            scanPlanIsDefault = false;
            console.log(`[Scanner V2] Local file duration ${probed.toFixed(0)}s (ffprobe) — plan: every ${scanPlan.intervalSeconds}s × ${scanPlan.maxFrames} frames`);
          }
        }
      }

      // SCENE-FIRST: detect cuts and cluster shots into unique scenes BEFORE
      // extracting frames. Sample 1-2 frames per UNIQUE SCENE rather than
      // uniformly — a podcast with 60 cuts but 2 unique scenes goes from 50
      // frames to ~4. Failure is non-fatal — falls back to uniform.
      let sceneCuts: number[] = [];
      try {
        sceneCuts = await detectSceneCuts(videoPath);
        await storage.updateVideoIndex(videoId, { sceneBoundaries: sceneCuts as any });
        console.log(`[Scanner V2] Persisted ${sceneCuts.length} scene cut(s) to videoIndex.sceneBoundaries`);
      } catch (sceneErr: any) {
        console.warn(`[Scanner V2] Scene-cut detection failed (non-fatal):`, sceneErr?.message || sceneErr);
      }

      try {
        sceneIndex = await buildSceneIndex(videoPath, sceneCuts);
        if (sceneIndex) {
          await storage.updateVideoIndex(videoId, {
            sceneIndex: sceneIndex as any,
            sceneBoundaries: sceneIndex.cuts as any,
          });
          console.log(`[Scanner V2] Persisted scene index: ${sceneIndex.sceneCount} unique scene(s) across ${sceneIndex.shots.length} shot(s); refined ${sceneIndex.cuts.length} cuts`);
        }
      } catch (sidxErr: any) {
        console.warn(`[Scanner V2] Scene index build failed (non-fatal):`, sidxErr?.message || sidxErr);
      }

      // A degenerate index (zero cuts on a long video — usually cut
      // detection timing out, not a genuinely single-shot hour) means
      // "one scene" is an artifact. Scene-first sampling would trust it
      // and extract ~6 frames for the whole file; take the uniform
      // fallback below instead, sized by duration.
      indexDegenerate = !!sceneIndex && (sceneIndex as any).degenerate === true;

      if (sceneIndex && sceneIndex.sceneCount > 0 && !indexDegenerate) {
        // ≥2 frames per scene ALWAYS — the consensus vote needs at least two
        // independent samples of a scene to confirm a surface ("double
        // authentication"). Budget grows to 36 frames to keep 2/scene
        // feasible for multi-scene episodes.
        const SCENE_FIRST_BUDGET = 36;
        const desiredPerScene = Math.max(
          2,
          Math.min(6, Math.floor(SCENE_FIRST_BUDGET / sceneIndex.sceneCount)),
        );
        const samples = sampleMultiTimestampsPerScene(sceneIndex, desiredPerScene);
        const trimmed = samples.slice(0, SCENE_FIRST_BUDGET);
        console.log(`[Scanner V2] Scene-first extraction: ${trimmed.length} frames across ${sceneIndex.sceneCount} unique scene(s) (${desiredPerScene}/scene target)`);

        const result = await extractFramesAtTimestamps(videoPath, framesDir, trimmed.map(s => s.t));
        if (result.frames.length > 0) {
          frames = result.frames;
          frameTimestamps = result.timestamps;
          usedSceneFirst = true;
        } else {
          console.warn(`[Scanner V2] Scene-first extraction returned 0 frames — falling back to uniform`);
        }
      }

      if (!usedSceneFirst) {
        // Long-video uniform fallback: the banded plan's maxFrames assumes
        // cut-dense content (an hour file = 720 frames = 720 sequential
        // Gemini calls). Whenever scene-first sampling didn't happen on a
        // >10-min video — degenerate index, zero cuts, or an extraction
        // that failed or returned nothing — spread a fixed budget (one
        // frame per ~90s, clamped 24-60) uniformly across the WHOLE
        // duration so an hour-long file gets real coverage at bounded cost.
        if (localDurationSec && localDurationSec > 10 * 60) {
          const uniformBudget = Math.max(24, Math.min(60, Math.round(localDurationSec / 90)));
          const eff = Math.min(localDurationSec, MAX_DURATION_SEC);
          scanPlan = {
            intervalSeconds: Math.max(1, Math.floor(eff / uniformBudget)),
            maxFrames: uniformBudget,
          };
          console.log(`[Scanner V2] Scene-first unavailable for ${(localDurationSec / 60).toFixed(1)}min video — uniform fallback: every ${scanPlan.intervalSeconds}s × ${uniformBudget} frames`);
        }
        console.log(`[Scanner V2] Extracting frames with plan: every ${scanPlan.intervalSeconds}s × ${scanPlan.maxFrames} frames`);
        frames = await extractFrames(videoPath, framesDir, scanPlan);
        // Timestamps come from the slot number baked into the filename
        // (frame_0001 = t=0), not the array index — sparse per-seek
        // extraction can skip a failed mid-list slot, and an index-based
        // mapping would shift every later timestamp by one interval.
        frameTimestamps = frames.map((f, i) => {
          const m = /frame_(\d+)\.jpg$/.exec(f);
          const slot = m ? parseInt(m[1], 10) - 1 : i;
          return slot * scanPlan.intervalSeconds;
        });
      }
    }

    if (frames.length === 0) {
      await updateStatusIfStillScanning(videoId, "Scan Failed");
      return { success: false, videoId, surfacesDetected: 0, error: "No frames extracted" };
    }

    console.log(`[Scanner V2] Using ${frames.length} frames (${usedSceneFirst ? "scene-first" : "uniform"})`);

    // Heartbeat: frame extraction (stream or download+extract) may have
    // eaten most of the sweep threshold — mark the row fresh before the
    // per-frame detection loop starts.
    await storage.updateVideoStatusIfScanning(videoId, "Scanning").catch(() => {});

    const { isVertical } = await getFrameMetadata(frames[0]);
    console.log(`[Scanner V2] Video orientation: ${isVertical ? "VERTICAL (9:16)" : "HORIZONTAL (16:9)"}`);

    // ── Room-model match: is this a set we already know? ──────────
    // Each scene class's exemplar hashes (shot-midpoint dHashes) are compared
    // against the creator's stored room models. A class within hamming range
    // of a model IS that studio/camera setup coming back — detection switches
    // to confirm mode for its frames (known surfaces re-located, not
    // re-discovered), and its surfaces inherit the model's stable groupIds so
    // placements survive rescans and recur across episodes. Failure is
    // non-fatal: a modelless scan is just today's behavior.
    interface SceneModelMatch {
      model: RoomModel;
      surfaces: RoomModelSurface[];
      distance: number;
    }
    const modelBySceneKey = new Map<number, SceneModelMatch>();
    if (sceneIndex && !indexDegenerate && sceneIndex.sceneCount > 0) {
      try {
        // Same alias set the teach route matches under — videoIndex.userId
        // is a mixed users.id/email column, and a model created under one
        // key must stay loadable from a video keyed by the other, or a
        // taught surface lands in a model this video's scans never read
        // (and the scan mints a duplicate model for the same room).
        const ownerAliases = new Set<string>([video.userId]);
        try {
          const owner = String(video.userId).includes("@")
            ? await storage.getUserByEmail(video.userId)
            : await storage.getUserById(video.userId);
          if (owner) {
            ownerAliases.add(owner.id);
            if (owner.email) {
              ownerAliases.add(owner.email);
              ownerAliases.add(owner.email.toLowerCase());
            }
          }
        } catch { /* alias widening is best-effort */ }
        const roomModels = await storage.getRoomModelsForUsers(Array.from(ownerAliases));
        if (roomModels.length > 0) {
          const classExemplars = collectClassExemplarHashes(sceneIndex, 5);
          for (const [classId, classHashes] of Array.from(classExemplars.entries())) {
            let best: SceneModelMatch | null = null;
            for (const model of roomModels) {
              // Min hamming across the exemplar cross product — sentinel
              // hashes were already excluded on the class side, and are
              // skipped on the model side too.
              let minDist = Number.MAX_SAFE_INTEGER;
              for (const mh of model.sceneExemplarHashes ?? []) {
                if (!mh || mh.startsWith("fail")) continue;
                for (const ch of classHashes) {
                  const d = hammingDistance(ch, mh);
                  if (d < minDist) minDist = d;
                }
              }
              // Same threshold the scene clusterer uses — "same scene" and
              // "same set" should agree on what visually close means. When
              // several models qualify, the closest one wins.
              if (minDist < 12 && (!best || minDist < best.distance)) {
                const modelSurfaces = parseRoomModelSurfaces(model.surfaces);
                if (modelSurfaces.length > 0) {
                  best = { model, surfaces: modelSurfaces, distance: minDist };
                }
              }
            }
            if (best) {
              modelBySceneKey.set(classId, best);
              console.log(`[RoomModel] Scene class ${classId} matched model #${best.model.id} (${best.surfaces.length} surfaces, seen in ${best.model.episodeCount ?? 1} episode(s))`);
            }
          }
          // Drift visibility: when the creator HAS taught surfaces but a scene
          // class matched no model, the taught set may be sitting right there
          // unrecognized (exemplar drift, stale model hashes after a
          // gate-skipped upsert) — and every taught confirmation silently
          // skipped for that class.
          const taughtModelCount = roomModels.filter(m => parseRoomModelSurfaces(m.surfaces).some(s => s.taught)).length;
          if (taughtModelCount > 0) {
            for (const classId of Array.from(classExemplars.keys())) {
              if (!modelBySceneKey.has(classId)) {
                console.warn(`[RoomModel] Scene class ${classId} matched NO model while ${taughtModelCount} of this creator's model(s) carry taught surfaces — if this class is the taught set, exemplar drift is hiding it and its taught surfaces cannot be confirmed this scan`);
              }
            }
          }
        }
      } catch (rmErr: any) {
        console.warn(`[RoomModel] Model lookup failed (non-fatal — scanning without set memory):`, rmErr?.message || rmErr);
      }
    }

    // Every taught surface's cross-scan identity across the matched models —
    // the exemption set the post-processing passes (phantom filter, dedupe)
    // and the end-of-scan retirement sweep honor. Creator ground truth is
    // never silently filtered, deduped away, or retired without replacement.
    const taughtGroupIds = new Set<string>();
    for (const match of Array.from(modelBySceneKey.values())) {
      for (const s of match.surfaces) {
        if (s.taught) taughtGroupIds.add(`rm${match.model.id}-s${s.idx}`);
      }
    }

    // Frames uploaded to Object Storage instead of local disk

    // PROCESS FRAMES ONE BY ONE (with immediate cleanup)
    let totalSurfaces = 0;
    const geminiKeyPresent = (!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY
      && process.env.AI_INTEGRATIONS_GEMINI_API_KEY !== 'dummy-key') || !!aiDirect;
    console.log(`[Scanner V2] Detection method: ${CONFIG.DETECTION_METHOD.toUpperCase()}`);
    console.log(`[Scanner V2] Gemini: proxy=${!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY} direct-fallback=${!!aiDirect}${geminiKeyPresent ? '' : ' — NO key at all, edge-detection fallback (inaccurate)'}`);
    if (!geminiKeyPresent) {
      console.warn(`[Scanner V2] ⚠️  No Gemini key (AI_INTEGRATIONS_GEMINI_API_KEY or GEMINI_API_KEY). Surface detection will be limited.`);
    }

    // ── Phase A: analyze every frame; buffer results per scene ────
    // Detections are NOT inserted per-frame anymore. They buffer here and
    // must survive the per-scene consensus vote (AUTH 1: >=2 frames agree)
    // + position priors (AUTH 2) + a model verification pass (AUTH 2b)
    // before any row is written. This is what makes detections consistent
    // across a scene instead of one frame's hallucination becoming truth.
    interface BufferedFrameAnalysis {
      framePath: string;
      timestamp: number;
      frameUrl: string;
      sceneKey: number;
      surfaces: DetectedSurface[];
      viaGemini: boolean;
      // Frame was never actually analyzed (429 retries exhausted) — it
      // abstains from the consensus vote instead of counting as an empty
      // verdict in the denominator.
      rateLimited: boolean;
      // Person-box coverage of the frame (0-1), when the response carried
      // people data — drives the clean-frame re-sampling pass below.
      personCoverage?: number;
      // Known-surface idx values the parse-time ghost filter vetoed in this
      // frame. Taught surfaces are exempt there, so this should stay empty
      // for taught idx values — the [Taught] fate line counts it as proof.
      knownGhostVetoes?: number[];
    }
    const bufferedAnalyses: BufferedFrameAnalysis[] = [];

    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      // Real timestamp at this frame — scene-first sets this to the
      // representative shot midpoint per scene; uniform fallback uses
      // i × intervalSeconds. sceneId lookup downstream needs the real t.
      const timestamp = frameTimestamps[i] ?? i * scanPlan.intervalSeconds;
      const tsKey = Math.round(timestamp);

      // Cooperative cancellation: the cancel-scan route flips status away
      // from "Scanning"; honor it within a few frames instead of grinding
      // through the whole Gemini budget. Checked every 3rd frame to keep
      // the DB chatter negligible.
      if (i % 3 === 0) {
        try {
          const fresh = await storage.getVideoById(videoId);
          if (fresh && fresh.status !== "Scanning") {
            console.log(`[Scanner V2] Scan cancelled for video ${videoId} (status now "${fresh.status}") — aborting at frame ${i + 1}/${frames.length}`);
            // temp dirs are cleaned by this function's finally block
            return { success: false, videoId, surfacesDetected: 0, error: "Scan cancelled" };
          }
        } catch { /* status check is best-effort */ }
      }

      console.log(`[Scanner V2] Processing frame ${i + 1}/${frames.length} (${timestamp.toFixed(2)}s)...`);

      // Save ALL valid frames to permanent directory for thumbnail strip
      const frameFilename = `frame_${tsKey}s.jpg`;
      try {
        const frameSize = fs.statSync(framePath).size;
        if (frameSize > 5000) {
          const objectKey = `public/uploads/frames/${videoId}/${frameFilename}`;
          await uploadFileToStorage(framePath, objectKey);
        } else {
          console.warn(`[Scanner V2] Skipping tiny frame ${frameFilename} (${frameSize} bytes)`);
        }
      } catch (copyErr) {
        console.error(`[Scanner V2] Failed to upload frame to storage:`, copyErr);
      }

      // Use Gemini AI or edge detection based on config
      // Falls back to edge detection if Gemini API key is missing
      const useGemini = CONFIG.DETECTION_METHOD === 'gemini'
        && ((process.env.AI_INTEGRATIONS_GEMINI_API_KEY
              && process.env.AI_INTEGRATIONS_GEMINI_API_KEY !== 'dummy-key')
            || !!aiDirect);

      // Consensus group: real scene cluster when a usable sceneIndex
      // exists; dHash segment ids otherwise (streamed grid, local
      // fallback, or a degenerate one-scene index whose single bucket
      // would let cross-scene detections vote for each other). Resolved
      // BEFORE detection so a matched room model can ride along.
      const sceneKey = sceneIndex && !indexDegenerate
        ? sceneIdForTimestamp(sceneIndex, timestamp)
        : (streamSegmentIds?.[i] ?? 0);
      const knownForFrame = modelBySceneKey.get(sceneKey)?.surfaces;

      let analysis: FrameAnalysisResult;
      if (useGemini) {
        analysis = await analyzeFrameWithGeminiRetry(framePath, timestamp, isVertical, knownForFrame);
        // Only fall back to edge if Gemini API actually failed (not if it just found no surfaces)
        // If aiAnalyzed=true, Gemini worked fine — it just said "no surfaces here"
        if (!analysis.aiAnalyzed && !analysis.hasSurface) {
          console.warn(`[Scanner V2] ⚠️  Gemini API FAILED for frame ${timestamp}s (aiAnalyzed=false). This likely means the API request failed (wrong base URL, auth error, or timeout). Falling back to edge detection...`);
          analysis = await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
        }
      } else {
        if (i === 0) console.log(`[Scanner V2] Gemini API key not configured, using edge detection fallback`);
        analysis = await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
      }

      // Buffer EVERY analyzed frame — including zero-detection ones. The
      // consensus vote divides by framesAnalyzed; counting only detection-
      // bearing frames let a lone hallucination in an otherwise-empty scene
      // pass as 1/1 "full support".
      bufferedAnalyses.push({
        framePath,
        timestamp,
        frameUrl: `/storage/uploads/frames/${videoId}/${frameFilename}`,
        sceneKey,
        surfaces: analysis.hasSurface ? analysis.surfaces : [],
        viaGemini: Boolean(useGemini) && analysis.aiAnalyzed === true,
        rateLimited: analysis.rateLimited === true,
        personCoverage: analysis.personCoverage,
        knownGhostVetoes: analysis.knownGhostVetoedIdx,
      });
      // NOTE: temp frames are intentionally KEPT here — the verification
      // pass re-reads the best frame per scene. The outer finally removes
      // the whole tempDir. (~36 frames ≈ a few MB.)
    }

    // Cooperative cancellation, part 2: the in-loop check above only fires
    // every 3rd frame and only while frames remain, but Phases B-D below
    // (consensus, model verification with 429 backoff, insertion,
    // enrichment) can grind for minutes on their own. Honor a cancel that
    // landed near the loop's end before committing to that work.
    try {
      const fresh = await storage.getVideoById(videoId);
      if (fresh && fresh.status !== "Scanning") {
        console.log(`[Scanner V2] Scan cancelled for video ${videoId} (status now "${fresh.status}") — aborting before consensus/verification`);
        return { success: false, videoId, surfacesDetected: 0, error: "Scan cancelled" };
      }
    } catch { /* status check is best-effort */ }

    // Heartbeat: consensus + model verification (with 429 backoff) can
    // grind for minutes more — refresh updated_at so the sweep doesn't
    // mistake a live verification phase for a stuck scan.
    await storage.updateVideoStatusIfScanning(videoId, "Scanning").catch(() => {});

    // Local fallback without a usable sceneIndex: segment frames by dHash
    // jumps so consensus groups approximate scenes instead of collapsing the
    // whole video into one bucket (which made cross-scene detections vote
    // for each other and killed scene-unique surfaces as 'single_frame').
    // Also covers the degenerate one-scene index — same single-bucket risk.
    if ((!sceneIndex || indexDegenerate) && !streamSegmentIds && bufferedAnalyses.length > 1) {
      try {
        let seg = 0;
        let prevHash: string | null = null;
        for (const bf of bufferedAnalyses) {
          const h = await computeDHash(bf.framePath).catch(() => null);
          if (prevHash && h && hammingDistance(prevHash, h) >= 10) seg++;
          if (prevHash && !h) seg++;
          bf.sceneKey = seg;
          prevHash = h;
        }
        console.log(`[Scanner V2] Local dHash segmentation: ${seg + 1} consensus group(s) across ${bufferedAnalyses.length} frames`);
      } catch (segErr: any) {
        console.warn(`[Scanner V2] Local segmentation failed (single bucket):`, segErr?.message);
      }
    }

    // ── Clean-frame re-sampling: people-saturated scene classes ───
    // A talking-head class whose EVERY sampled frame is majority-covered by
    // people gives detection almost nothing to work with — the sampling
    // happened to land on shots where the hosts fill the frame. When the
    // class has unsampled shots left, pull up to 2 extra frames from their
    // midpoints and let them join the consensus vote. LOCAL path only:
    // seek-based extraction needs the file on disk — the streamed grid
    // already spread its budget across every occurrence and re-seeking the
    // CDN for a couple of frames costs more than it recovers.
    if (videoPath && !streamedFrames && sceneIndex && !indexDegenerate && geminiKeyPresent) {
      const MAX_RESAMPLE_FRAMES = 8;
      let resampleBudget = MAX_RESAMPLE_FRAMES;
      try {
        const byClass = new Map<number, BufferedFrameAnalysis[]>();
        for (const bf of bufferedAnalyses) {
          const arr = byClass.get(bf.sceneKey) ?? [];
          arr.push(bf);
          byClass.set(bf.sceneKey, arr);
        }
        for (const [classKey, classFrames] of Array.from(byClass.entries())) {
          if (resampleBudget <= 0) break;
          const effective = classFrames.filter((bf) => !bf.rateLimited);
          if (effective.length === 0) continue;
          // EVERY analyzed frame must be >50% person-covered. Frames without
          // people data can't be measured and disqualify the class — the
          // trigger fails closed rather than spending budget on a guess.
          const allCrowded = effective.every((bf) => (bf.personCoverage ?? 0) > 0.5);
          if (!allCrowded) continue;
          const classShots = sceneIndex.shots.filter((s) => s.sceneId === classKey);
          const unsampled = classShots.filter(
            (shot) => !classFrames.some((bf) => bf.timestamp >= shot.tStart && bf.timestamp < shot.tEnd),
          );
          if (unsampled.length === 0) continue; // no shots left beyond the sampled ones
          const meanCoverage = effective.reduce((s, bf) => s + (bf.personCoverage ?? 0), 0) / effective.length;
          const picks = unsampled
            .sort((a, b) => (b.tEnd - b.tStart) - (a.tEnd - a.tStart))
            .slice(0, Math.min(2, resampleBudget));
          console.log(`[Scanner V2] Clean-frame re-sampling: scene ${classKey} averages ${(meanCoverage * 100).toFixed(0)}% person coverage across all ${effective.length} analyzed frame(s) — extracting ${picks.length} unsampled shot midpoint(s)`);
          // Per-class subdir: extractFramesAtTimestamps numbers its outputs
          // from 0000, and earlier frames must survive for the verify pass.
          const resampleDir = path.join(framesDir, `resample_${classKey}`);
          const extra = await extractFramesAtTimestamps(videoPath, resampleDir, picks.map((shot) => shot.tStart + (shot.tEnd - shot.tStart) / 2));
          resampleBudget -= extra.frames.length;
          const knownForClass = modelBySceneKey.get(classKey)?.surfaces;
          for (let e = 0; e < extra.frames.length; e++) {
            const extraPath = extra.frames[e];
            const extraT = extra.timestamps[e];
            // _r suffix keeps re-sampled uploads out of the main loop's
            // frame_{t}s.jpg namespace — a resample midpoint rounding to the
            // same integer second as a sampled frame would otherwise
            // overwrite that frame's stored image for every row citing it.
            const extraFilename = `frame_${Math.round(extraT)}s_r.jpg`;
            try {
              await uploadFileToStorage(extraPath, `public/uploads/frames/${videoId}/${extraFilename}`);
            } catch (upErr) {
              console.error(`[Scanner V2] Failed to upload re-sampled frame to storage:`, upErr);
            }
            const extraAnalysis: FrameAnalysisResult = await analyzeFrameWithGeminiRetry(extraPath, extraT, isVertical, knownForClass);
            bufferedAnalyses.push({
              framePath: extraPath,
              timestamp: extraT,
              frameUrl: `/storage/uploads/frames/${videoId}/${extraFilename}`,
              sceneKey: classKey,
              surfaces: extraAnalysis.hasSurface ? extraAnalysis.surfaces : [],
              viaGemini: extraAnalysis.aiAnalyzed === true,
              rateLimited: extraAnalysis.rateLimited === true,
              personCoverage: extraAnalysis.personCoverage,
              knownGhostVetoes: extraAnalysis.knownGhostVetoedIdx,
            });
          }
        }
      } catch (resampleErr: any) {
        console.warn(`[Scanner V2] Clean-frame re-sampling failed (non-fatal):`, resampleErr?.message || resampleErr);
      }
    }

    // Surface the abstention rate before consensus runs — a heavily
    // rate-limited scan silently loses vote coverage, and that should be
    // visible in the log next to the scenes it affected.
    const abstainedCount = bufferedAnalyses.filter((bf) => bf.rateLimited).length;
    if (abstainedCount > 0) {
      const pct = ((abstainedCount / bufferedAnalyses.length) * 100).toFixed(0);
      console.warn(`[Scanner V2] ${abstainedCount}/${bufferedAnalyses.length} frames (${pct}%) rate-limited (abstained from consensus)`);
    }

    // ── Phase B: per-scene consensus vote (AUTH 1 + AUTH 2) ───────
    // ── Phase C: model verification per scene (AUTH 2b) ───────────
    // ── Phase D: insert survivors only ────────────────────────────
    const framesByScene = new Map<number, BufferedFrameAnalysis[]>();
    for (const bf of bufferedAnalyses) {
      const arr = framesByScene.get(bf.sceneKey) ?? [];
      arr.push(bf);
      framesByScene.set(bf.sceneKey, arr);
    }

    // groupId → its room-model identity, recorded as ids are minted. The
    // finalize upsert uses this to tell a refreshed known surface from a
    // fresh discovery without ever parsing the (opaque) groupId format.
    const modelGroupInfo = new Map<string, { modelId: number; idx: number }>();

    for (const [sceneKey, sceneFrames] of Array.from(framesByScene.entries())) {
      // Rate-limited frames abstain: they leave both the vote pool AND the
      // denominator. An abstention counted as an empty verdict meant one
      // 429-exhausted frame in a 2-frame scene vetoed everything the other
      // frame found. With one effective frame left, consensus clamps its
      // vote floor to 1 internally.
      const effectiveFrames = sceneFrames.filter((bf) => !bf.rateLimited);
      const matchedModel = modelBySceneKey.get(sceneKey) ?? null;

      // Known-surface confirmations bypass the IoU-chaining consensus
      // entirely: identity is exact (the model's surface idx), so grouping
      // is a lookup, not a spatial match. Only fresh detections vote below.
      const knownConfirmations = new Map<number, Array<{ frameT: number; det: DetectedSurface }>>();
      if (matchedModel) {
        for (const bf of effectiveFrames) {
          for (const s of bf.surfaces) {
            if (s.knownIdx == null) continue;
            const arr = knownConfirmations.get(s.knownIdx) ?? [];
            arr.push({ frameT: bf.timestamp, det: s });
            knownConfirmations.set(s.knownIdx, arr);
          }
        }
      }

      const consensusInput: FrameDetection[] = effectiveFrames.map((bf) => ({
        frameT: bf.timestamp,
        surfaces: bf.surfaces.filter((s) => s.knownIdx == null).map((s) => ({
          surfaceType: s.surfaceType,
          confidence: s.confidence,
          bbox: s.boundingBox,
          ref: s,
        })),
      }));

      const { surfaces: consensusSurfaces, rejected } = buildSceneConsensus(consensusInput, {
        normalizeType: canonicalSurfaceType,
        framesAnalyzed: effectiveFrames.length,
      });
      if (rejected.length > 0) {
        console.log(
          `[Scanner V2] Scene ${sceneKey}: consensus rejected ${rejected.length} detection(s) — ` +
          rejected.map((r) => `${r.surfaceType}@${r.frameT.toFixed(0)}s:${r.reason}`).join(", ")
        );
      }

      // A known surface survives on >=1 confirming frame — the cross-frame
      // vote already happened in the episodes that built the model; today's
      // question is only "is it still there". bbox = per-dimension median of
      // the adjusted boxes; surfaceType/orientation stay the model's
      // canonical values; confidence blends this scan's mean 50/50 with the
      // model's stored score.
      const modelSurfaces: ConsensusSurface[] = [];
      const modelKeyBySurface = new Map<ConsensusSurface, { modelId: number; idx: number }>();
      if (matchedModel) {
        const med = (vals: number[]) => {
          const s = [...vals].sort((a, b) => a - b);
          const m = Math.floor(s.length / 2);
          return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        };
        for (const [knownIdx, confs] of Array.from(knownConfirmations.entries())) {
          const ms = matchedModel.surfaces.find((s) => s.idx === knownIdx);
          if (!ms || confs.length === 0) continue;
          const distinct = Array.from(new Set(confs.map((c) => c.frameT))).sort((a, b) => a - b);
          const freshMean = confs.reduce((s, c) => s + c.det.confidence, 0) / confs.length;
          const cs: ConsensusSurface = {
            surfaceType: ms.surfaceType,
            bbox: {
              x: med(confs.map((c) => c.det.boundingBox.x)),
              y: med(confs.map((c) => c.det.boundingBox.y)),
              width: med(confs.map((c) => c.det.boundingBox.width)),
              height: med(confs.map((c) => c.det.boundingBox.height)),
            },
            confidence: Math.round(((freshMean + ms.confidence) / 2) * 100) / 100,
            votes: distinct.length,
            framesAnalyzed: effectiveFrames.length,
            supportTimestamps: distinct,
            members: confs.map((c) => ({ frameT: c.frameT, confidence: c.det.confidence, bbox: c.det.boundingBox, ref: c.det })),
          };
          modelSurfaces.push(cs);
          modelKeyBySurface.set(cs, { modelId: matchedModel.model.id, idx: knownIdx });
        }
        if (matchedModel.surfaces.length > 0) {
          console.log(`[RoomModel] Scene ${sceneKey}: ${modelSurfaces.length}/${matchedModel.surfaces.length} known surface(s) confirmed this scan`);
        }
      }

      const allSceneSurfaces = [...modelSurfaces, ...consensusSurfaces];

      // Taught-fate line: one per taught surface of the matched model, every
      // scan. Each link of the confirm chain fails silently on its own
      // (degraded frames can't confirm a known, present:false is a no-op,
      // an omitted known_surfaces array logs nothing) — this line is the
      // single place a vanished taught surface names the link that ate it.
      const logTaughtFates = (verifyKeepSet: Set<number> | null, rowsByGroup?: Map<string, number>) => {
        if (!matchedModel) return;
        const promptedFrames = effectiveFrames.filter((f) => f.viaGemini).length;
        for (const ms of matchedModel.surfaces) {
          if (!ms.taught) continue;
          const gid = `rm${matchedModel.model.id}-s${ms.idx}`;
          const confirmed = knownConfirmations.get(ms.idx)?.length ?? 0;
          const ghostVetoed = effectiveFrames.reduce(
            (sum, f) => sum + (f.knownGhostVetoes?.filter((vIdx) => vIdx === ms.idx).length ?? 0), 0);
          const taughtCs = modelSurfaces.find((m) => modelKeyBySurface.get(m)?.idx === ms.idx);
          let verifyFate = "skipped";
          if (taughtCs && verifyKeepSet) {
            verifyFate = verifyKeepSet.has(allSceneSurfaces.indexOf(taughtCs)) ? "kept" : "rejected";
          }
          const rows = rowsByGroup?.get(gid) ?? 0;
          console.log(`[Taught] ${gid}: prompted in ${promptedFrames} frames / confirmed ${confirmed} / ghost-vetoed ${ghostVetoed} / verify=${verifyFate} / rows=${rows}`);
        }
      };

      if (allSceneSurfaces.length === 0) {
        logTaughtFates(null);
        continue;
      }

      // AUTH 2b: second model opinion on the scene's best-supported frame.
      // Audits BOTH kinds — a known surface the verifier rejects is dropped
      // for THIS scan but stays in the room model (removal-only, fail-open).
      // EXCEPT taught surfaces: the verifier's "genuinely visible" / "does
      // not primarily cover a person" criteria are the exact judgments
      // teaching exists to override (mirrors the confirm-mode ghost-filter
      // exemption), and it audits the scene's max-support frame — usually
      // not the frame that confirmed the taught surface.
      let approved = allSceneSurfaces;
      let verifyKeep: Set<number> | null = null;
      if (sceneFrames.some((f) => f.viaGemini)) {
        const frameSupport = new Map<number, number>();
        for (const cs of allSceneSurfaces) {
          for (const t of cs.supportTimestamps) frameSupport.set(t, (frameSupport.get(t) ?? 0) + 1);
        }
        const bestT = Array.from(frameSupport.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
        const bestFrame = effectiveFrames.find((f) => f.timestamp === bestT) ?? effectiveFrames[0];
        verifyKeep = await verifySceneSurfaces(
          bestFrame.framePath,
          allSceneSurfaces.map((cs) => ({ surfaceType: cs.surfaceType, bbox: cs.bbox })),
        );
        if (verifyKeep) {
          const keep = verifyKeep;
          const taughtIdx = new Set<number>();
          allSceneSurfaces.forEach((cs, idx) => {
            const mk = modelKeyBySurface.get(cs);
            if (mk && matchedModel?.surfaces.find((s) => s.idx === mk.idx)?.taught) taughtIdx.add(idx);
          });
          const dropped = allSceneSurfaces.filter((_, idx) => !keep.has(idx) && !taughtIdx.has(idx));
          if (dropped.length > 0) {
            console.log(`[Scanner V2] Scene ${sceneKey}: verification rejected ${dropped.map((d) => d.surfaceType).join(", ")}`);
          }
          approved = allSceneSurfaces.filter((_, idx) => keep.has(idx) || taughtIdx.has(idx));
        }
      }

      // Insert one row PER SUPPORTING FRAME with that frame's own bbox —
      // keyframe density is a rendering contract downstream (videoExporter
      // fades products across keyframe gaps; remix densifies sparse tracks).
      // Every row of a consensus surface carries the same surfaceGroupId:
      // ONE id per canonical physical surface, minted here where identity is
      // established. Post-processing (normalize/dedupe/temporal/enrichment)
      // operates on groups from this point on, so a surface never fragments
      // back into per-frame "spots". Model-backed surfaces reuse the model's
      // stable id — IDENTICAL across rescans and episodes by design, which
      // is what lets group-keyed placements survive both.
      let groupSeq = 0;
      const insertedRowsByGroup = new Map<string, number>();
      for (const cs of approved) {
        const modelKey = modelKeyBySurface.get(cs);
        const surfaceGroupId = modelKey
          ? `rm${modelKey.modelId}-s${modelKey.idx}`
          : `g${videoId}-${sceneKey}-${++groupSeq}`;
        if (modelKey) modelGroupInfo.set(surfaceGroupId, modelKey);
        for (const member of cs.members) {
          const surface = member.ref as DetectedSurface;
          const bf = sceneFrames.find((f) => f.timestamp === member.frameT);
          if (!surface || !bf) continue;
          const sceneIdForFrame = sceneIndex ? sceneIdForTimestamp(sceneIndex, member.frameT) : 0;
          const dbSurface: InsertDetectedSurface = {
            videoId,
            timestamp: member.frameT.toString(),
            surfaceType: surface.surfaceType,
            orientation: surface.orientation || null,
            // Vote-weighted consensus confidence — full-agreement surfaces
            // keep their score, bare-majority ones are discounted.
            confidence: cs.confidence.toString(),
            boundingBoxX: member.bbox.x.toString(),
            boundingBoxY: member.bbox.y.toString(),
            boundingBoxWidth: member.bbox.width.toString(),
            boundingBoxHeight: member.bbox.height.toString(),
            frameUrl: bf.frameUrl,
            // Lighting & camera data from Gemini AI
            lightingDirection: surface.lightingDirection || null,
            lightingIntensity: surface.lightingIntensity != null ? surface.lightingIntensity.toString() : null,
            cameraAngle: surface.cameraAngle || null,
            // Scene cluster — same physical set across cuts gets same ID,
            // unlocks placement continuity in the frontend.
            sceneId: sceneIdForFrame,
            // Canonical-surface identity — shared by every supporting-frame
            // row of this consensus surface.
            surfaceGroupId,
            // creatorApproved defaults to false in schema — surfaces hidden from
            // brands until creator explicitly approves via UI toggle
          };

          const inserted = await storage.insertDetectedSurface(dbSurface);
          console.log(`[Scanner V2] *** SURFACE CONFIRMED: ${surface.surfaceType} at ${member.frameT.toFixed(1)}s scene=${sceneKey} (votes ${cs.votes}/${cs.framesAnalyzed}, conf ${(cs.confidence * 100).toFixed(1)}%, id: ${inserted.id}) ***`);
          insertedRowsByGroup.set(surfaceGroupId, (insertedRowsByGroup.get(surfaceGroupId) ?? 0) + 1);
          totalSurfaces++;
        }
      }

      logTaughtFates(verifyKeep, insertedRowsByGroup);
    }
    
    // NOTE: The "Potential Surface" fallback that used to pad low-detection
    // scans with synthetic bottom-of-frame boxes (confidence 0.15) was REMOVED.
    // It produced fake placement targets brands could browse and bid on — a
    // scan that genuinely found nothing (or where Gemini was unavailable) would
    // still show "Ready (N Spots)" of junk. Surfaces must be REAL detections
    // now. A zero-detection scan honestly reports zero. If detection quality is
    // the concern, the fix is denser real detection (see keyframe densification),
    // not synthetic surfaces.

    // PHASE 2A: CAPTURE SURFACE KEYFRAMES — Save raw per-frame bboxes for motion tracking
    // Must happen BEFORE normalization overwrites bboxes with the median
    try {
      await captureSurfaceKeyframes(videoId);
    } catch (kfErr) {
      console.error(`[Scanner V2] Keyframe capture failed (non-fatal):`, kfErr);
    }

    // POST-SCAN NORMALIZATION — Cluster similar surfaces and normalize bounding boxes
    // This ensures consistent product placement across frames of the same camera angle.
    // Prior-scan rows are excluded — they're retired at end-of-scan and must not
    // compete with (or overwrite) this run's detections.
    const priorIdExclusions = new Set(priorSurfaceIds);
    try {
      await normalizeSurfaceBoundingBoxes(videoId, priorIdExclusions, taughtGroupIds);
    } catch (normErr) {
      console.error(`[Scanner V2] Bounding box normalization failed (non-fatal):`, normErr);
    }

    // TEMPORAL SURFACE GROUPING — Group consecutive surfaces into tracks.
    // Keep the best track per canonical surface and mark weaker sightings of
    // the same surface as Filtered.
    // The "consecutive" test needs the spacing frames were ACTUALLY sampled
    // at, not the plan's nominal interval: scene-first uses shot midpoints
    // and the streamed grid runs at 9s+, while scanPlan.intervalSeconds
    // stays at its 2-5s default on those paths — every real gap failed the
    // 1.5× test and all tracks collapsed to singletons. The median gap of
    // the analyzed frames is the truth regardless of sampling mode.
    const analyzedTs = bufferedAnalyses.map((bf) => bf.timestamp).sort((a, b) => a - b);
    const frameGaps = analyzedTs.slice(1).map((t, i) => t - analyzedTs[i]).filter((g) => g > 0).sort((a, b) => a - b);
    const medianFrameGap = frameGaps.length > 0
      ? frameGaps[Math.floor(frameGaps.length / 2)]
      : scanPlan.intervalSeconds;
    try {
      await groupSurfacesTemporally(videoId, medianFrameGap, priorIdExclusions);
    } catch (temporalErr) {
      console.error(`[Scanner V2] Temporal grouping failed (non-fatal):`, temporalErr);
    }

    // Recount as CANONICAL SURFACES, not rows. Every insert above is one
    // supporting frame of a consensus surface, so row math ("Ready (153
    // Spots)") counted keyframes, not physical surfaces. The number a
    // creator or brand should see is the count of distinct surviving
    // surfaceGroupIds from THIS run — prior runs' rows (including their old
    // Filtered ones) stay out of it entirely.
    const insertedRowCount = totalSurfaces;
    const postNormSurfaces = await storage.getDetectedSurfaces(videoId);
    const priorIdSet = new Set(priorSurfaceIds);
    const survivingRows = postNormSurfaces.filter(s => !priorIdSet.has(s.id) && s.surfaceType !== "Filtered");
    const survivingGroupIds = new Set<string>();
    let ungroupedSurvivors = 0;
    for (const s of survivingRows) {
      const gid = (s as any).surfaceGroupId as string | null | undefined;
      if (gid) survivingGroupIds.add(gid);
      else ungroupedSurvivors++; // defensive: every row this run inserts carries a groupId
    }
    totalSurfaces = survivingGroupIds.size + ungroupedSurvivors;
    console.log(`[Scanner V2] Net new surfaces this run: ${totalSurfaces} canonical surface(s) across ${survivingRows.length} surviving rows (${insertedRowCount} rows inserted)`);

    // Scan-end taught audit: a taught surface with ZERO surviving rows means
    // some link of the confirm chain ate it — the [Taught] fate lines above
    // name which one. The retirement sweep below spares its prior row(s).
    for (const gid of Array.from(taughtGroupIds)) {
      if (!survivingGroupIds.has(gid)) {
        console.warn(`[Taught] ⚠️ ${gid}: taught surface produced ZERO surviving rows this scan — see the [Taught] fate lines above for the failing link`);
      }
    }

    // SCENE CONTEXT ENRICHMENT — FullScale Edge image analysis
    // Uses Sharp to analyze brightness, edges, and color to infer scene context
    try {
      const enrichmentDir = path.join(tempDir, "enrichment_frames");
      fs.mkdirSync(enrichmentDir, { recursive: true });
      const enrichmentSurfaces = await storage.getDetectedSurfaces(videoId);

      // Pre-download each surface's frame from GCS. Prefer surface.frameUrl
      // (the EXACT path scanner saved — most reliable), with Math.round
      // (current scanner) and Math.floor (legacy) fallbacks. Was Math.floor-
      // only previously; that path lost all scene-first surfaces with
      // non-integer timestamps because scanner uses Math.round naming.
      const downloadedKeys = new Set<string>();
      for (const s of enrichmentSurfaces) {
        const tsFloat = Number(s.timestamp);
        const candidateKeys: string[] = [];
        if (s.frameUrl) {
          candidateKeys.push(
            s.frameUrl
              .replace(/^\/storage\//, "public/")
              .replace(/^\/uploads\//, "public/uploads/"),
          );
        }
        candidateKeys.push(`public/uploads/frames/${videoId}/frame_${Math.round(tsFloat)}s.jpg`);
        candidateKeys.push(`public/uploads/frames/${videoId}/frame_${Math.floor(tsFloat)}s.jpg`);

        for (const objKey of candidateKeys) {
          if (downloadedKeys.has(objKey)) break;
          try {
            const tempPath = await downloadToTempFile(objKey, enrichmentDir);
            downloadedKeys.add(objKey);
            console.log(`[Scanner V2] Downloaded frame for enrichment: ${tempPath}`);
            break; // first key that resolves wins
          } catch { /* try next candidate */ }
        }
      }
      await enrichSurfacesWithContext(videoId, enrichmentDir, priorIdExclusions);
    } catch (enrichErr) {
      console.error(`[Scanner V2] Scene context enrichment failed (non-fatal):`, enrichErr);
    }

    // CLAUDE DENSE + GENERATION DECISION BRANCH
    // If in autoRemix mode and ANTHROPIC_API_KEY is set, run narrative analysis
    // and decide whether to generate assets for surfaces without natural product moments
    if (scanMode === "autoRemix" && process.env.ANTHROPIC_API_KEY) {
      try {
        console.log(`[Scanner V2] Running Claude Dense narrative analysis (autoRemix mode)...`);
        const enrichedSurfaces = await storage.getDetectedSurfaces(videoId);
        const activeSurfaces = enrichedSurfaces.filter(s => s.surfaceType !== "Filtered");

        if (activeSurfaces.length > 0) {
          const { analyzeNarrative } = await import("./lib/ai/claude-dense/narrativeAnalyzer");
          const { decidePlacement } = await import("./lib/ai/cdense/connector");

          let analysisCount = 0;
          let generateCount = 0;

          for (const surface of activeSurfaces.slice(0, 10)) {
            try {
              // Build frame path for this surface's timestamp
              const frameTimestamp = Math.round(surface.timestampStart || 0);
              const claudeFrameDir = path.join(tempDir, "claude_frames");
              if (!fs.existsSync(claudeFrameDir)) fs.mkdirSync(claudeFrameDir, { recursive: true });
              let framePath: string;
              try {
                const claudeObjKey = `public/uploads/frames/${videoId}/frame_${frameTimestamp}s.jpg`;
                framePath = await downloadToTempFile(claudeObjKey, claudeFrameDir);
              } catch {
                continue;
              }

              if (!fs.existsSync(framePath)) continue;

              const frameBase64 = fs.readFileSync(framePath).toString("base64");

              const narrativeResult = await analyzeNarrative({
                videoId,
                frameIndex: frameTimestamp,
                frameBase64,
                detectedSurfaces: [{
                  id: surface.id,
                  surfaceType: surface.surfaceType || "table",
                  confidence: surface.confidence || 0.5,
                  boundingBox: {
                    x: surface.bboxX || 0,
                    y: surface.bboxY || 0,
                    width: surface.bboxWidth || 0.2,
                    height: surface.bboxHeight || 0.2,
                  },
                  lightingDirection: surface.lightingDirection || undefined,
                }],
                sceneContext: {
                  sceneType: surface.sceneType || "unknown",
                  brightness: { overall: surface.brightness || 128, top: 128, bottom: 128 },
                  edgeDensity: surface.edgeDensity || 0,
                  colorWarmth: surface.colorWarmth || 0,
                  surroundings: [],
                  brandCategorySuggestions: [],
                },
              });

              // Save analysis to DB
              await storage.createSceneAnalysis({
                videoId,
                surfaceId: surface.id,
                frameStart: frameTimestamp,
                narrativeContext: narrativeResult.narrativeContext,
                emotionalTone: narrativeResult.emotionalTone,
                culturalTags: narrativeResult.culturalTags,
                placementViability: narrativeResult.placementViability,
                suggestedCategories: narrativeResult.suggestedProductCategories,
                reasoning: narrativeResult.reasoning,
              });
              analysisCount++;

              // Check placement decision
              const existingPlacements = await storage.getPlacementsForVideo(videoId);
              const hasExisting = existingPlacements.some(p => p.detectedSurfaceId === surface.id);

              const decision = decidePlacement({
                videoId,
                surfaceId: surface.id,
                narrativeAnalysis: narrativeResult,
                brandMatches: { matches: [] }, // No brand matching during scan — done later via UI
                surfaceDetails: {
                  surfaceType: surface.surfaceType || "table",
                  boundingBox: {
                    x: surface.bboxX || 0,
                    y: surface.bboxY || 0,
                    width: surface.bboxWidth || 0.2,
                    height: surface.bboxHeight || 0.2,
                  },
                  confidence: surface.confidence || 0.5,
                  lightingDirection: surface.lightingDirection || "ambient",
                },
                sceneAesthetic: {
                  colorWarmth: surface.colorWarmth || 0,
                  brightness: { overall: surface.brightness || 128, top: 128, bottom: 128 },
                  dominantColors: [],
                },
                hasExistingPlacement: hasExisting,
                scanMode: "autoRemix",
              });

              if (decision.type === "generate_asset") generateCount++;
              console.log(`[Scanner V2] Surface ${surface.id}: ${decision.type} — ${decision.reason}`);

            } catch (surfaceErr) {
              console.warn(`[Scanner V2] Claude Dense failed for surface ${surface.id} (non-fatal):`, surfaceErr);
            }
          }

          console.log(`[Scanner V2] Claude Dense: analyzed ${analysisCount} surfaces, ${generateCount} flagged for generation`);
        }
      } catch (claudeErr) {
        console.error(`[Scanner V2] Claude Dense pipeline failed (non-fatal):`, claudeErr);
      }
    }

    // FINALIZE
    let finalStatus: string;
    if (totalSurfaces > 0) {
      finalStatus = `Ready (${totalSurfaces} Spots)`;
    } else if (!geminiKeyPresent) {
      finalStatus = "Ready (0 Spots)";
      console.warn(`[Scanner V2] ⚠️  0 surfaces found — Gemini API key is NOT configured. Set AI_INTEGRATIONS_GEMINI_API_KEY for AI-powered surface detection.`);
    } else {
      finalStatus = "Ready (0 Spots)";
      console.warn(`[Scanner V2] 0 surfaces found despite Gemini being available. The video may not contain clear flat surfaces, or ghost filters may be too aggressive.`);
    }

    // Cancel compare-and-set: the cancel-scan route flips status away from
    // "Scanning" and returns success immediately, while this function may
    // still be minutes deep in post-processing. If the status changed under
    // us, the creator cancelled — leave their prior surfaces untouched and
    // do NOT stamp a terminal status over the cancel.
    let cancelledMidScan = false;
    try {
      const freshAtFinalize = await storage.getVideoById(videoId);
      cancelledMidScan = !!freshAtFinalize && freshAtFinalize.status !== "Scanning";
    } catch { /* best-effort — the guarded write below re-checks */ }

    if (cancelledMidScan) {
      console.log(`[Scanner V2] Video ${videoId}: status changed during post-processing (cancelled) — keeping prior surfaces, skipping terminal status write`);
    } else {
      // Replace prior surfaces ONLY now — scan succeeded. If totalSurfaces > 0,
      // delete the snapshotted prior IDs so the new surfaces stand alone. If
      // totalSurfaces == 0, KEEP the prior data — a re-scan that finds nothing
      // shouldn't wipe creator's earlier good results.
      const sparedTaughtIds = new Set<number>();
      if (totalSurfaces > 0 && priorSurfaceIds.length > 0) {
        try {
          for (const id of priorSurfaceIds) {
            // Taught prior rows survive a scan that produced NO replacement
            // rows for their group — the creator vouched for the surface,
            // and a degraded scan failing to re-confirm it must not erase
            // it. A CONFIRMED taught surface (surviving replacement rows
            // exist) retires its prior rows normally, so old and new rows
            // are never active together. Only rows still live at scan start
            // qualify (priorGroupById skips Filtered) — a creator-rejected
            // row stays retired.
            const gid = priorGroupById.get(id);
            if (gid && taughtGroupIds.has(gid) && !survivingGroupIds.has(gid)) {
              sparedTaughtIds.add(id);
              continue;
            }
            await storage.updateDetectedSurface(id, { surfaceType: "Filtered", sceneContext: "Replaced by re-scan" });
          }
          if (sparedTaughtIds.size > 0) {
            console.log(`[Taught] Spared ${sparedTaughtIds.size} prior taught row(s) from retirement — no replacement rows this scan`);
          }
          console.log(`[Scanner V2] Marked ${priorSurfaceIds.length - sparedTaughtIds.size} prior surfaces as Filtered (replaced by ${totalSurfaces} new surfaces)`);
        } catch (err: any) {
          console.warn(`[Scanner V2] Failed to filter prior surfaces:`, err?.message || err);
        }
      } else if (totalSurfaces === 0 && priorSurfaceIds.length > 0) {
        console.log(`[Scanner V2] Re-scan found 0 surfaces — keeping ${priorSurfaceIds.length} prior surfaces intact (re-scan didn't find replacements)`);
      }

      // SCENE INVENTORY — the creator-facing model of the episode: a small
      // set of recurring camera setups ("Scene A recurs 41 times, 23 min on
      // screen, holds 3 surfaces"), each carrying its canonical physical
      // surfaces with occurrence counts and screen time. Built from the
      // scene index (cut detection or grid classes) plus this run's
      // surviving groups. A re-scan that found nothing keeps the prior
      // inventory, mirroring the keep-prior-surfaces rule above. A
      // degenerate index is skipped outright: its single all-covering shot
      // would report every surface as "Scene A · 1 shot · full-video
      // screen time" — exactly the untrustworthy data the flag rejects —
      // so the column stays null and the UIs fall back gracefully.
      let inventoryPersisted = false;
      if (totalSurfaces > 0 && sceneIndex && !indexDegenerate && sceneIndex.shots.length > 0) {
        try {
          const invRows = await storage.getDetectedSurfaces(videoId);
          // Spared taught prior rows count as survivors here: their row
          // outlived the retirement sweep, and an inventory that omits them
          // would hide the taught surface from the scene modal anyway —
          // exactly the disappearance the sparing exists to prevent. They
          // stay OUT of the room-model upsert below (not fresh evidence).
          const invSurvivors = invRows.filter(s =>
            (!priorIdSet.has(s.id) || sparedTaughtIds.has(s.id)) && s.surfaceType !== "Filtered" && (s as any).surfaceGroupId);

          const rowsByGroup = new Map<string, typeof invSurvivors>();
          for (const row of invSurvivors) {
            const gid = (row as any).surfaceGroupId as string;
            const arr = rowsByGroup.get(gid) ?? [];
            arr.push(row);
            rowsByGroup.set(gid, arr);
          }

          // Occurrence count + total screen time per scene class, straight
          // from the index shots (grid source: shots are contiguous runs,
          // so "occurrences" is the run count).
          const sceneStats = new Map<number, { occurrences: number; totalSec: number }>();
          for (const shot of sceneIndex.shots) {
            const st = sceneStats.get(shot.sceneId) ?? { occurrences: 0, totalSec: 0 };
            st.occurrences++;
            st.totalSec += Math.max(0, shot.tEnd - shot.tStart);
            sceneStats.set(shot.sceneId, st);
          }

          const medianOf = (vals: number[]) => {
            const s = [...vals].sort((a, b) => a - b);
            const m = Math.floor(s.length / 2);
            return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
          };
          const surfacesByScene = new Map<number, any[]>();
          for (const [gid, rows] of Array.from(rowsByGroup.entries())) {
            // Dominant sceneId across the group's rows — groups never
            // straddle scenes by construction, but degenerate-index
            // fallbacks can leave disagreeing stamps.
            const sceneVotes = new Map<number, number>();
            for (const r of rows) {
              const sid = (r as any).sceneId ?? 0;
              sceneVotes.set(sid, (sceneVotes.get(sid) ?? 0) + 1);
            }
            let groupSceneId = 0;
            let bestVotes = -1;
            sceneVotes.forEach((n, sid) => { if (n > bestVotes) { bestVotes = n; groupSceneId = sid; } });

            const rep = rows.reduce((a, b) =>
              parseFloat(String(a.confidence)) >= parseFloat(String(b.confidence)) ? a : b);
            const stats = sceneStats.get(groupSceneId);
            const arr = surfacesByScene.get(groupSceneId) ?? [];
            arr.push({
              groupId: gid,
              surfaceType: rep.surfaceType,
              bbox: {
                x: medianOf(rows.map(r => parseFloat(String(r.boundingBoxX)))),
                y: medianOf(rows.map(r => parseFloat(String(r.boundingBoxY)))),
                w: medianOf(rows.map(r => parseFloat(String(r.boundingBoxWidth)))),
                h: medianOf(rows.map(r => parseFloat(String(r.boundingBoxHeight)))),
              },
              confidence: parseFloat(String(rep.confidence)),
              // Set-dressing model: the surface belongs to its camera setup,
              // so it's on screen whenever the setup is.
              screenTimeSec: Math.round((stats?.totalSec ?? 0) * 10) / 10,
              rowCount: rows.length,
              representativeRowId: rep.id,
              frameUrl: rep.frameUrl ?? null,
            });
            surfacesByScene.set(groupSceneId, arr);
          }

          // NUMBERED FIXTURES — displayLabel gives every canonical surface a
          // stable human name: per scene, per canonical type — "Wall 1",
          // "Wall 2", "Nightstand 1". Ordinals derive from room-model idx
          // (model-backed surfaces first, ordered by idx; fresh surfaces
          // after, in insertion order), so a modeled surface keeps its number
          // across rescans and episodes of the same set. Assigned BEFORE the
          // per-scene confidence sort so "insertion order" means row order,
          // not display order. jsonb-only — no schema change; clients fall
          // back to surfaceType when the field is absent (legacy videos).
          const modelIdxByGroup = new Map<string, number>();
          for (const match of Array.from(modelBySceneKey.values())) {
            for (const s of match.surfaces) modelIdxByGroup.set(`rm${match.model.id}-s${s.idx}`, s.idx);
          }
          for (const [gid, info] of Array.from(modelGroupInfo.entries())) modelIdxByGroup.set(gid, info.idx);
          const humanTypeName = (canonical: string): string =>
            canonical.replace(/_/g, " ").split(/\s+/).filter(Boolean)
              .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          for (const sceneSurfaceList of Array.from(surfacesByScene.values())) {
            const byType = new Map<string, any[]>();
            for (const surf of sceneSurfaceList) {
              const typeKey = canonicalSurfaceType(String(surf.surfaceType));
              const arr = byType.get(typeKey) ?? [];
              arr.push(surf);
              byType.set(typeKey, arr);
            }
            for (const [typeKey, surfs] of Array.from(byType.entries())) {
              // Model-backed ordinals come from the MODEL'S full same-type
              // roster (all idx values of this type across the matched
              // models), not from which surfaces happened to survive THIS
              // scan — a dense per-scan rank would renumber "Wall 2" to
              // "Wall 1" the first scan its sibling goes unconfirmed, and
              // a fixture's number is a name the creator remembers.
              const typeIdxRoster: number[] = [];
              for (const match of Array.from(modelBySceneKey.values())) {
                for (const ms of match.surfaces) {
                  if (canonicalSurfaceType(String(ms.surfaceType)) === typeKey) typeIdxRoster.push(ms.idx);
                }
              }
              const rosterSorted = Array.from(new Set(typeIdxRoster)).sort((a, b) => a - b);
              const modelBacked = surfs.filter(s => modelIdxByGroup.has(s.groupId));
              const fresh = surfs.filter(s => !modelIdxByGroup.has(s.groupId));
              for (const surf of modelBacked) {
                const idx = modelIdxByGroup.get(surf.groupId)!;
                const pos = rosterSorted.indexOf(idx);
                surf.displayLabel = `${humanTypeName(typeKey)} ${(pos >= 0 ? pos : rosterSorted.length) + 1}`;
              }
              let freshOrdinal = rosterSorted.length;
              for (const surf of fresh) {
                surf.displayLabel = `${humanTypeName(typeKey)} ${++freshOrdinal}`;
              }
            }
          }

          // "Scene A" is the class with the most screen time, and so on down.
          const sceneLabel = (i: number): string =>
            i < 26 ? `Scene ${String.fromCharCode(65 + i)}` : `Scene ${i + 1}`;
          const scenes = Array.from(sceneStats.entries())
            .sort((a, b) => b[1].totalSec - a[1].totalSec)
            .map(([classSceneId, st], i) => ({
              sceneId: classSceneId,
              label: sceneLabel(i),
              occurrences: st.occurrences,
              totalSec: Math.round(st.totalSec * 10) / 10,
              surfaces: (surfacesByScene.get(classSceneId) ?? []).sort((a, b) => b.confidence - a.confidence),
            }));
          // Defensive: a group stamped with a sceneId the index doesn't know
          // still shows up — an inventory must never drop a real surface.
          for (const [orphanSceneId, arr] of Array.from(surfacesByScene.entries())) {
            if (!sceneStats.has(orphanSceneId)) {
              scenes.push({ sceneId: orphanSceneId, label: sceneLabel(scenes.length), occurrences: 0, totalSec: 0, surfaces: arr });
            }
          }

          const sceneInventory = {
            version: 1,
            source: sceneIndexSource,
            scenes,
            generatedAt: new Date().toISOString(),
          };
          await storage.updateVideoIndex(videoId, { sceneInventory: sceneInventory as any });
          console.log(`[Scanner V2] Persisted scene inventory: ${scenes.length} scene class(es), ${rowsByGroup.size} canonical surface(s) (source=${sceneIndexSource})`);
          inventoryPersisted = true;
        } catch (invErr: any) {
          console.warn(`[Scanner V2] Scene inventory build failed (non-fatal):`, invErr?.message || invErr);
        }
      } else if (totalSurfaces > 0 && indexDegenerate) {
        console.log(`[Scanner V2] Degenerate scene index — skipping scene inventory build`);
      }
      // A successful rescan retires every prior-generation row, so a stale
      // inventory would reference only Filtered rows — scene blocks with no
      // nested detections, badge counts that match nothing. When this run
      // produced surfaces but could not build a fresh inventory (degenerate
      // index, missing index, build failure), clear the column so the UIs
      // fall back to the flat view instead of rendering ghosts. A 0-surface
      // run keeps prior data, mirroring the keep-prior-surfaces rule.
      if (totalSurfaces > 0 && !inventoryPersisted) {
        try {
          await storage.updateVideoIndex(videoId, { sceneInventory: null as any });
        } catch {}
      }

      // ── Room-model upsert: persist the set memory ─────────────────
      // Success path only — the cancel branch above never reaches here, and
      // a 0-surface scan has nothing to teach the model. Matched classes
      // refresh their confirmed surfaces (bbox/confidence/frameUrl, idx
      // kept) and APPEND genuine discoveries with never-reused indices;
      // unmatched classes with surviving surfaces become new models. Known
      // surfaces absent from this scan stay in the model untouched — sets
      // evolve, pruning is a future concern. Non-fatal throughout: the scan
      // result stands even if set memory can't be written.
      //
      // AI-QUALITY GATE: set memory is persistent and feeds every future
      // scan of this creator's sets, so a scan that mostly ran on the edge-
      // detection fallback (dead Gemini proxy, missing key, rate limits)
      // must not teach it. Garbage written here would be confirmed forever
      // after. Require Gemini to have actually analyzed most frames.
      const geminiFrames = bufferedAnalyses.filter(b => b.viaGemini).length;
      const geminiShare = bufferedAnalyses.length > 0 ? geminiFrames / bufferedAnalyses.length : 0;
      const aiQualityOk = geminiShare >= 0.7;
      if (!aiQualityOk && totalSurfaces > 0) {
        console.warn(
          `[RoomModel] SKIPPING set-memory write — only ${geminiFrames}/${bufferedAnalyses.length} frames (${Math.round(geminiShare * 100)}%) were AI-analyzed; ` +
          `the rest fell back to edge detection. Set memory must not learn from a degraded scan (check GEMINI_API_KEY / proxy health).`,
        );
      }
      if (aiQualityOk && totalSurfaces > 0 && sceneIndex && !indexDegenerate && sceneIndex.shots.length > 0) {
        try {
          const rmRows = await storage.getDetectedSurfaces(videoId);
          const rmSurvivors = rmRows.filter(s =>
            !priorIdSet.has(s.id) && s.surfaceType !== "Filtered" && (s as any).surfaceGroupId);

          const rmByGroup = new Map<string, typeof rmSurvivors>();
          for (const row of rmSurvivors) {
            const gid = (row as any).surfaceGroupId as string;
            const arr = rmByGroup.get(gid) ?? [];
            arr.push(row);
            rmByGroup.set(gid, arr);
          }

          const rmMedian = (vals: number[]) => {
            const s = [...vals].sort((a, b) => a - b);
            const m = Math.floor(s.length / 2);
            return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
          };
          // Distill a surviving group to the fields a model surface stores.
          const summarizeGroup = (rows: typeof rmSurvivors) => {
            const rep = rows.reduce((a, b) =>
              parseFloat(String(a.confidence)) >= parseFloat(String(b.confidence)) ? a : b);
            return {
              surfaceType: rep.surfaceType,
              orientation: (rep.orientation === "vertical" ? "vertical" : "horizontal") as "horizontal" | "vertical",
              bbox: {
                x: rmMedian(rows.map(r => parseFloat(String(r.boundingBoxX)))),
                y: rmMedian(rows.map(r => parseFloat(String(r.boundingBoxY)))),
                w: rmMedian(rows.map(r => parseFloat(String(r.boundingBoxWidth)))),
                h: rmMedian(rows.map(r => parseFloat(String(r.boundingBoxHeight)))),
              },
              confidence: parseFloat(String(rep.confidence)),
              frameUrl: rep.frameUrl ?? null,
            };
          };

          // Group → scene class via the dominant sceneId of its rows (same
          // vote the inventory uses — degenerate fallbacks can disagree).
          const groupsByClass = new Map<number, Array<{ gid: string; rows: typeof rmSurvivors }>>();
          for (const [gid, rows] of Array.from(rmByGroup.entries())) {
            const sceneVotes = new Map<number, number>();
            for (const r of rows) {
              const sid = (r as any).sceneId ?? 0;
              sceneVotes.set(sid, (sceneVotes.get(sid) ?? 0) + 1);
            }
            let classId = 0;
            let bestVotes = -1;
            sceneVotes.forEach((n, sid) => { if (n > bestVotes) { bestVotes = n; classId = sid; } });
            const arr = groupsByClass.get(classId) ?? [];
            arr.push({ gid, rows });
            groupsByClass.set(classId, arr);
          }

          const upsertExemplars = collectClassExemplarHashes(sceneIndex, 8);

          // Classes that matched the same model update it ONCE, merged — a
          // close-up class and a wide class both within range of one model
          // must not overwrite each other's refresh.
          const updatesByModel = new Map<number, { match: SceneModelMatch; classIds: number[]; groups: Array<{ gid: string; rows: typeof rmSurvivors }> }>();
          const newModelClasses: Array<{ classId: number; groups: Array<{ gid: string; rows: typeof rmSurvivors }> }> = [];
          for (const [classId, groups] of Array.from(groupsByClass.entries())) {
            const match = modelBySceneKey.get(classId);
            if (match) {
              const agg = updatesByModel.get(match.model.id) ?? { match, classIds: [], groups: [] };
              agg.classIds.push(classId);
              agg.groups.push(...groups);
              updatesByModel.set(match.model.id, agg);
            } else {
              newModelClasses.push({ classId, groups });
            }
          }

          let modelsUpdated = 0;
          let modelsCreated = 0;

          for (const [modelId, upd] of Array.from(updatesByModel.entries())) {
            // Base the merge on a FRESH read, not the scan-start snapshot.
            // Scans run for many minutes, and a surface taught mid-scan
            // would otherwise be clobbered by a whole-jsonb replace — worse,
            // nextIdx computed from the stale snapshot would re-issue the
            // taught surface's idx to a different physical surface, aliasing
            // its already-written rm{model}-s{idx} rows. Refresh targets are
            // found by idx, so fresh-only entries simply persist untouched.
            let surfaces = upd.match.surfaces.map(s => ({ ...s, bbox: { ...s.bbox } }));
            try {
              const freshModel = await storage.getRoomModelById(modelId);
              if (freshModel) {
                const freshSurfaces = parseRoomModelSurfaces(freshModel.surfaces);
                if (freshSurfaces.length >= surfaces.length) {
                  surfaces = freshSurfaces.map(s => ({ ...s, bbox: { ...s.bbox } }));
                }
              }
            } catch { /* fall back to the scan-start snapshot */ }
            let nextIdx = surfaces.reduce((mx, s) => Math.max(mx, s.idx), -1) + 1;
            let refreshed = 0;
            let appended = 0;
            for (const { gid, rows } of upd.groups) {
              const info = modelGroupInfo.get(gid);
              // A model-backed group drifting into another model's class
              // (post-processing merges can move a group's dominant scene)
              // belongs to ITS model, not this one — appending it here would
              // clone one physical surface into two models.
              if (info && info.modelId !== modelId) continue;
              const summary = summarizeGroup(rows);
              if (info) {
                const target = surfaces.find(s => s.idx === info.idx);
                if (target) {
                  target.bbox = summary.bbox;
                  target.confidence = summary.confidence;
                  target.frameUrl = summary.frameUrl;
                  refreshed++;
                  continue;
                }
              }
              // Fresh discovery inside a known set — but first check it
              // isn't the SAME physical surface re-minted under a fresh
              // g-id (a drifted-bbox sighting that escaped the confirm-mode
              // dedupe and outlived the rm-group in post-processing).
              // Appending that would put one desk in the model twice, and
              // both entries would get confirmed on every future scan with
              // no pruning to self-correct. Same canonical type + IoU>0.5
              // against an existing model surface ⇒ refresh that entry
              // instead of appending.
              const asWH = (b: { x: number; y: number; w: number; h: number }) =>
                ({ x: b.x, y: b.y, width: b.w, height: b.h });
              const dupOf = surfaces.find(s =>
                canonicalSurfaceType(s.surfaceType) === canonicalSurfaceType(summary.surfaceType) &&
                bboxIoU(asWH(s.bbox), asWH(summary.bbox)) > 0.5);
              if (dupOf) {
                dupOf.bbox = summary.bbox;
                dupOf.confidence = summary.confidence;
                dupOf.frameUrl = summary.frameUrl;
                refreshed++;
                continue;
              }
              // Append-only, idx never reused even if surfaces were deleted
              // from the model.
              surfaces.push({
                idx: nextIdx++,
                surfaceType: summary.surfaceType,
                orientation: summary.orientation,
                bbox: summary.bbox,
                confidence: summary.confidence,
                frameUrl: summary.frameUrl,
              });
              appended++;
            }

            // Exemplar merge: this scan's hashes lead (collected longest
            // shot first), then the model's existing ones, deduped, cap 8 —
            // the model tracks the set's newest look without forgetting the
            // older episodes that still fit under the cap.
            const scanHashes: string[] = [];
            for (const cid of upd.classIds) {
              for (const h of upsertExemplars.get(cid) ?? []) {
                if (!scanHashes.includes(h)) scanHashes.push(h);
              }
            }
            const mergedHashes: string[] = [];
            for (const h of [...scanHashes, ...(upd.match.model.sceneExemplarHashes ?? [])]) {
              if (mergedHashes.length >= 8) break;
              if (h && !h.startsWith("fail") && !mergedHashes.includes(h)) mergedHashes.push(h);
            }

            const isNewEpisode = upd.match.model.lastVideoId !== videoId;
            await storage.updateRoomModel(modelId, {
              surfaces,
              lastVideoId: videoId,
              ...(mergedHashes.length > 0 ? { sceneExemplarHashes: mergedHashes } : {}),
              ...(isNewEpisode ? { episodeCount: (upd.match.model.episodeCount ?? 1) + 1 } : {}),
            });
            modelsUpdated++;
            console.log(`[RoomModel] Model #${modelId}: refreshed ${refreshed}, appended ${appended} surface(s)${isNewEpisode ? " (new episode)" : ""}`);
          }

          for (const { classId, groups } of newModelClasses) {
            const exemplars = upsertExemplars.get(classId) ?? [];
            // An unhashable class can never be matched again — storing it
            // would only accumulate dead models.
            if (exemplars.length === 0) continue;
            // Model-backed groups already live in their model; a new model
            // must only be born from genuinely fresh surfaces.
            const freshGroups = groups.filter(({ gid }) => !modelGroupInfo.has(gid));
            if (freshGroups.length === 0) continue;
            const surfaces: RoomModelSurface[] = freshGroups.map(({ rows }, i) => {
              const summary = summarizeGroup(rows);
              return {
                idx: i,
                surfaceType: summary.surfaceType,
                orientation: summary.orientation,
                bbox: summary.bbox,
                confidence: summary.confidence,
                frameUrl: summary.frameUrl,
              };
            });
            await storage.insertRoomModel({
              userId: video.userId,
              sceneExemplarHashes: exemplars,
              surfaces,
              sourceVideoId: videoId,
              lastVideoId: videoId,
            });
            modelsCreated++;
            console.log(`[RoomModel] New model for scene class ${classId}: ${surfaces.length} surface(s), ${exemplars.length} exemplar hash(es)`);
          }

          if (modelsUpdated > 0 || modelsCreated > 0) {
            console.log(`[RoomModel] Set memory persisted: ${modelsUpdated} model(s) refreshed, ${modelsCreated} created`);
          }
        } catch (rmUpsertErr: any) {
          console.warn(`[RoomModel] Set-memory upsert failed (non-fatal):`, rmUpsertErr?.message || rmUpsertErr);
        }
      }

      await updateStatusIfStillScanning(videoId, finalStatus);
    }

    console.log(`[Scanner V2] ========== SCAN COMPLETE ==========`);
    console.log(`[Scanner V2] Video ID: ${videoId}, Surfaces: ${totalSurfaces}, Gemini: ${geminiKeyPresent ? 'YES' : 'NO'}`);

    // AUTO-TRIGGER EDITORIAL PIPELINE — after every successful scan, run the
    // full editorial auto-pipeline in the background. It ensures the
    // transcript itself (ensureTranscript is idempotent and race-aware),
    // then analyzes, ranks, and renders clips. Single choke point: manual
    // scans, batch scans, sync scans, and uploads all get clips without a
    // user click. Skips cleanly when clips are already rendered.
    try {
      const editorialState = (video as any).editorialStatus;
      const editorialFresh = !editorialState || editorialState === "pending";
      // Gate mirrors runEditorialAutoPipeline's own precondition (filePath
      // OR youtubeId): light-cloud imports have no filePath and the
      // pipeline resolves their source via the shared cache itself, so
      // requiring a local file here would silently exclude exactly the
      // platform-import videos the light-cloud model is built around.
      if (cancelledMidScan) {
        console.log(`[Scanner V2] Video ${videoId}: scan cancelled — skipping editorial auto-trigger`);
      } else if ((video.filePath || video.youtubeId) && editorialFresh) {
        console.log(`[Scanner V2] Auto-triggering editorial pipeline for video ${videoId}...`);
        // Dynamic imports to avoid circular dependency with the remix module
        const { runEditorialAutoPipeline } = await import("./lib/remix/editorialAutoPipeline");
        const { stableUserIntId } = await import("./lib/stableUserId");

        runEditorialAutoPipeline(videoId, stableUserIntId(video.userId))
          .then((r) => {
            if (r.success) {
              console.log(`[Scanner V2] Editorial auto-pipeline for ${videoId}: ${r.clipsRendered}/${r.clipsGenerated} rendered (${r.status})`);
            } else {
              console.warn(`[Scanner V2] Editorial auto-pipeline for ${videoId} failed (non-fatal): ${r.error}`);
            }
          })
          .catch((err) => console.warn(`[Scanner V2] Editorial auto-pipeline error for ${videoId} (non-fatal):`, err?.message || err));
      } else if (!video.filePath && !video.youtubeId) {
        console.log(`[Scanner V2] No source for video ${videoId} (no file path and no platform id), skipping editorial auto-pipeline`);
      } else {
        // ready/failed/analyzing states never auto-rerun on rescans — a
        // failed pipeline would otherwise burn a full Claude+Whisper+render
        // cycle on EVERY scan. Retries go through the explicit
        // editorial-auto force/resume endpoints.
        console.log(`[Scanner V2] Editorial status '${editorialState}' for video ${videoId} — not auto-rerunning`);
      }
    } catch (editorialErr) {
      console.warn(`[Scanner V2] Editorial auto-trigger setup failed (non-fatal):`, editorialErr);
    }

    return {
      success: true,
      videoId,
      surfacesDetected: totalSurfaces,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Scanner V2] SCAN FAILED: ${errorMessage}`);

    // Roll back any partial new surfaces inserted during this failed run, so
    // the creator's prior data (snapshotted above) remains the source of truth.
    // Anything currently in the DB whose ID is NOT in priorSurfaceIds was
    // inserted by THIS scan attempt — mark Filtered so it doesn't render.
    try {
      const priorIdSet = new Set(priorSurfaceIds);
      const current = await storage.getDetectedSurfaces(videoId);
      const partialNew = current.filter(s => !priorIdSet.has(s.id) && s.surfaceType !== "Filtered");
      if (partialNew.length > 0) {
        for (const s of partialNew) {
          try {
            await storage.updateDetectedSurface(s.id, { surfaceType: "Filtered", sceneContext: "Removed: scan failed mid-way" });
          } catch { /* ignore */ }
        }
        console.log(`[Scanner V2] Rolled back ${partialNew.length} partial new surfaces; ${priorSurfaceIds.length} prior surfaces restored as the active set`);
      }
    } catch (rollbackErr: any) {
      console.warn(`[Scanner V2] Rollback of partial surfaces failed (non-fatal):`, rollbackErr?.message || rollbackErr);
    }

    try {
      // If we had prior ACTIVE surfaces, status reverts to whatever Ready
      // tier matches their count — otherwise mark Scan Failed. Must be the
      // active count, not the raw snapshot length: the snapshot includes
      // every soft-deleted Filtered/"Potential Surface" row from prior
      // rescans, and a failed rescan advertising "Ready (134 Spots)" over
      // 4 real surfaces is fiction the library count would contradict.
      // Guarded write: a cancel followed by a late throw must not be
      // un-cancelled by this revert — only write while still "Scanning".
      if (priorActiveCount > 0) {
        await updateStatusIfStillScanning(videoId, `Ready (${priorActiveCount} Spots)`);
      } else {
        await updateStatusIfStillScanning(videoId, "Scan Failed");
      }
    } catch {
      // Ignore DB errors during error handling
    }

    return {
      success: false,
      videoId,
      surfacesDetected: 0,
      error: errorMessage,
    };
    
  } finally {
    // CLEANUP - Always runs, even on error
    safeRmdir(tempDir);
  }
}

/**
 * Phase 2A: Dense re-scan for a specific time range at higher frame density.
 * Used before remix clip generation to get smoother motion tracking keyframes.
 *
 * Extracts frames at 0.5s intervals (4x denser than standard 2s scan),
 * runs Gemini surface detection on each, and creates keyframe entries
 * linked to existing surface IDs.
 *
 * @param videoId - The video to re-scan
 * @param startTime - Clip start time in seconds
 * @param endTime - Clip end time in seconds
 * @param surfaceIds - Which surfaces to track (only create keyframes for matching surfaces)
 * @param intervalSeconds - Frame interval (default 0.5s)
 * @param sourcePath - Optional local source file to use directly. The remix
 *   pipeline already holds a resolved+pinned copy of the source when it calls
 *   this — passing it skips a redundant cache resolve.
 */
export async function denseScanRange(
  videoId: number,
  startTime: number,
  endTime: number,
  surfaceIds: number[],
  intervalSeconds: number = 0.5,
  sourcePath?: string
): Promise<{ keyframesCreated: number }> {
  console.log(`[DenseScan] Starting dense scan for video ${videoId}: ${startTime.toFixed(1)}s-${endTime.toFixed(1)}s @ ${intervalSeconds}s intervals`);

  const video = await storage.getVideoById(videoId);
  if (!video || (!sourcePath && !(video as any).filePath && !video.youtubeId)) {
    console.error(`[DenseScan] Video not found or no source (no file path or platform id)`);
    return { keyframesCreated: 0 };
  }

  const tempDir = path.join(os.tmpdir(), `dense-scan-${videoId}-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  let videoPath: string | undefined;
  try {
    // Resolve video path: caller-supplied local file, Object Storage, local
    // filePath, or — for light-cloud imports (YouTube/IG/FB) with no
    // filePath at all — the shared source cache. Hard-requiring filePath
    // here starved every light-cloud clip of dense motion-tracking
    // keyframes: placements rendered static/jittery across camera motion
    // while the identical flow on an uploaded video looked polished. The
    // cache resolve is a hard-link cache hit when the remix pipeline
    // already pulled this source; pinning into tempDir keeps the cache
    // sweeper from unlinking it mid-scan, and the finally below releases
    // the pin with the rest of tempDir.
    const filePath = (video as any).filePath;
    if (sourcePath) {
      videoPath = sourcePath;
    } else if (filePath?.startsWith("/storage/")) {
      const objectKey = filePath.replace(/^\/storage\//, "public/");
      videoPath = await downloadToTempFile(objectKey, tempDir);
    } else if (filePath) {
      videoPath = path.resolve(process.cwd(), filePath);
    } else {
      // Dynamic import mirrors the remix pipeline's own usage and avoids a
      // module cycle (sourceCache → lib/scanner ← this file).
      const { getPinnedSourcePath } = await import("./lib/sourceCache");
      videoPath = await getPinnedSourcePath(video as any, path.join(tempDir, "source-pin"));
    }

    if (!videoPath || !fs.existsSync(videoPath)) {
      console.error(`[DenseScan] Video file not found: ${videoPath}`);
      return { keyframesCreated: 0 };
    }

    // Load reference surfaces to match against
    const refSurfaces = await storage.getDetectedSurfaces(videoId);
    const targetSurfaces = refSurfaces.filter((s) => surfaceIds.includes(s.id));
    if (targetSurfaces.length === 0) {
      console.warn(`[DenseScan] No matching surfaces found for IDs: ${surfaceIds.join(", ")}`);
      return { keyframesCreated: 0 };
    }

    // Extract frames at dense interval for the specified range
    const duration = endTime - startTime;
    const fpsFilter = `fps=1/${intervalSeconds}`;
    const framePattern = path.join(framesDir, "frame_%05d.jpg");

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-nostdin", "-y",
        "-ss", startTime.toString(),
        "-i", videoPath!,
        "-t", duration.toString(),
        "-vf", `${fpsFilter},scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease`,
        "-q:v", "3",
        framePattern,
      ]);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))));
      proc.on("error", reject);
    });

    const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
    console.log(`[DenseScan] Extracted ${frames.length} frames`);

    // For dense tracking, we need a wider spatial tolerance because the camera can move
    // the surface significantly across the frame. When there's only one target surface of
    // a given type, we rely on type matching alone (the surface is unique).
    const CLUSTER_TOLERANCE = 0.40; // 40% tolerance for camera movement
    const keyframeBatch: Array<{
      surfaceId: number;
      videoId: number;
      timestamp: string;
      boundingBoxX: string;
      boundingBoxY: string;
      boundingBoxWidth: string;
      boundingBoxHeight: string;
      confidence: string;
    }> = [];

    // Count how many target surfaces share each type (for matching strategy)
    const typeCounts = new Map<string, number>();
    for (const t of targetSurfaces) {
      const key = t.surfaceType.toLowerCase();
      typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
    }

    for (let i = 0; i < frames.length; i++) {
      const framePath = path.join(framesDir, frames[i]);
      const timestamp = startTime + i * intervalSeconds;

      try {
        const analysis = await analyzeFrameWithGeminiRetry(framePath, timestamp, false);

        if (analysis.hasSurface && analysis.surfaces.length > 0) {
          // Match detected surfaces to our target surfaces
          for (const detected of analysis.surfaces) {
            const centerX = detected.boundingBox.x + detected.boundingBox.width / 2;
            const centerY = detected.boundingBox.y + detected.boundingBox.height / 2;

            for (const target of targetSurfaces) {
              const typeMatch = detected.surfaceType.toLowerCase() === target.surfaceType.toLowerCase();
              if (!typeMatch) continue;

              // If this is the only surface of its type, match by type alone —
              // the surface is unique so spatial proximity is unnecessary
              // (and would reject valid matches when camera moves significantly)
              const typeCount = typeCounts.get(target.surfaceType.toLowerCase()) || 1;
              let shouldMatch = false;

              if (typeCount === 1) {
                // Unique surface type → type match is sufficient
                shouldMatch = true;
              } else {
                // Multiple surfaces of same type → also require spatial proximity
                const targetCX = parseFloat(String(target.boundingBoxX)) + parseFloat(String(target.boundingBoxWidth)) / 2;
                const targetCY = parseFloat(String(target.boundingBoxY)) + parseFloat(String(target.boundingBoxHeight)) / 2;
                const posMatch = Math.abs(centerX - targetCX) < CLUSTER_TOLERANCE && Math.abs(centerY - targetCY) < CLUSTER_TOLERANCE;
                shouldMatch = posMatch;
              }

              if (shouldMatch) {
                keyframeBatch.push({
                  surfaceId: target.id,
                  videoId,
                  timestamp: timestamp.toFixed(2),
                  boundingBoxX: detected.boundingBox.x.toFixed(6),
                  boundingBoxY: detected.boundingBox.y.toFixed(6),
                  boundingBoxWidth: detected.boundingBox.width.toFixed(6),
                  boundingBoxHeight: detected.boundingBox.height.toFixed(6),
                  confidence: detected.confidence.toFixed(4),
                });
                break; // matched, move to next detected surface
              }
            }
          }
        }
      } finally {
        safeUnlink(framePath);
      }
    }

    // Remove existing keyframes in this time range to prevent duplicates
    // (if dense scan runs twice for the same range, old keyframes are replaced)
    if (keyframeBatch.length > 0) {
      for (const surfaceId of surfaceIds) {
        try {
          await storage.deleteSurfaceKeyframesInRange(surfaceId, startTime, endTime);
        } catch (delErr: any) {
          console.warn(`[DenseScan] Failed to clear old keyframes for surface ${surfaceId}: ${delErr.message}`);
        }
      }
      await storage.bulkInsertSurfaceKeyframes(keyframeBatch);
    }

    console.log(`[DenseScan] Created ${keyframeBatch.length} keyframes for ${targetSurfaces.length} surface(s)`);
    return { keyframesCreated: keyframeBatch.length };
  } catch (err: any) {
    console.error(`[DenseScan] Failed: ${err.message}`);
    return { keyframesCreated: 0 };
  } finally {
    safeRmdir(tempDir);
  }
}

export async function scanPendingVideos(
  userId: string,
  limit: number = 5
): Promise<ScanResult[]> {
  console.log(`[Scanner V2] Scanning pending videos for user ${userId} (limit: ${limit})`);
  
  try {
    const pendingVideos = await storage.getPendingVideos(userId, limit);
    console.log(`[Scanner V2] Found ${pendingVideos.length} pending videos`);
    
    const results: ScanResult[] = [];
    
    for (const video of pendingVideos) {
      const result = await processVideoScan(video.id);
      results.push(result);
    }
    
    return results;
    
  } catch (error) {
    console.error(`[Scanner V2] scanPendingVideos error:`, error);
    return [];
  }
}

export async function detectSurface(
  videoPath: string
): Promise<{ hasSurface: boolean; confidence: number }> {
  const tempDir = path.join(os.tmpdir(), `detect-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");
  
  try {
    let resolvedPath = videoPath;
    if (videoPath.startsWith('/storage/')) {
      try {
        const objectKey = videoPath.replace(/^\/storage\//, 'public/');
        resolvedPath = await downloadToTempFile(objectKey, tempDir);
        console.log(`[Scanner V2] detectSurface: Downloaded from Object Storage: ${resolvedPath}`);
      } catch (e: any) {
        console.error(`[Scanner V2] detectSurface: Object Storage download failed:`, e.message);
        return { hasSurface: false, confidence: 0 };
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return { hasSurface: false, confidence: 0 };
    }
    
    fs.mkdirSync(framesDir, { recursive: true });
    
    const frames = await extractFrames(resolvedPath, framesDir);
    
    if (frames.length === 0) {
      return { hasSurface: false, confidence: 0 };
    }
    
    const middleFrame = frames[Math.floor(frames.length / 2)];
    const { isVertical } = await getFrameMetadata(middleFrame);
    const analysis = await analyzeFrameForSurfaces(middleFrame, 0, isVertical);
    
    return {
      hasSurface: analysis.hasSurface,
      confidence: analysis.confidence,
    };
    
  } catch {
    return { hasSurface: false, confidence: 0 };
    
  } finally {
    safeRmdir(tempDir);
  }
}

// ============================================================================
// YOUTUBE THUMBNAIL HELPERS
// ============================================================================

export function getYouTubeThumbnailUrl(
  youtubeId: string,
  quality: "default" | "hq" | "mq" | "sd" | "maxres" = "hq"
): string {
  const qualityMap: Record<string, string> = {
    default: "default.jpg",
    mq: "mqdefault.jpg",
    hq: "hqdefault.jpg",
    sd: "sddefault.jpg",
    maxres: "maxresdefault.jpg",
  };
  return `https://i.ytimg.com/vi/${youtubeId}/${qualityMap[quality]}`;
}

export function getYouTubeThumbnailWithFallback(youtubeId: string): string {
  return getYouTubeThumbnailUrl(youtubeId, "hq");
}

// ============================================================================
// MODULE INITIALIZATION
// ============================================================================

console.log(`[Scanner V2] ========== MODULE LOADED ==========`);
console.log(`[Scanner V2] Frame interval: ${CONFIG.FRAME_INTERVAL_SECONDS}s`);
console.log(`[Scanner V2] Max frames: ${CONFIG.MAX_FRAMES_PER_VIDEO}`);
console.log(`[Scanner V2] Min disk space: ${CONFIG.MIN_DISK_SPACE_MB}MB`);
console.log(`[Scanner V2] Confidence threshold: ${CONFIG.SURFACE_CONFIDENCE_THRESHOLD}`);
console.log(`[Scanner V2] LOCAL_ASSET_MAP entries: ${Object.keys(LOCAL_ASSET_MAP).length}`);
console.log(`[Scanner V2] ==========================================`);
