# FullScale — Master Build Plan
## From Remix Engine to Agentic Content Studio

**Last updated**: 2026-02-19
**Status**: Phase 1 P0 complete, Phase 2 partially wired, everything else ahead

---

## Current State (What's Done)

| Component | Status | Key Files |
|-----------|--------|-----------|
| Scanner V2 (Gemini surface detection) | Done | `server/scanner_v2.ts` |
| Claude Dense narrative analysis | Done | `server/lib/ai/claude-dense/editorialAnalyzer.ts` |
| Editorial clip ranking (7-dimension) | Done | `server/lib/remix/clipRanker.ts`, `clipScoringRubric.ts` |
| Transcript pipeline (Deepgram) | Done | `server/lib/remix/transcriptPipeline.ts` |
| Brand matching + scoring | Done | `server/lib/ai/claude-dense/sceneEnhancer.ts` |
| Remix orchestrator (9-step pipeline) | Done | `server/lib/remix/remixOrchestrator.ts` |
| FFmpeg clip generation + placements | Done | `server/lib/remix/clipGenerator.ts` |
| Caption engine (transcript + AI) | Done | `server/lib/remix/captionEngine.ts` |
| Quality scorer | Done | `server/lib/remix/qualityScorer.ts` |
| Object Storage persistence for clips | Done | `remixOrchestrator.ts` Step 8 |
| Video player + download UI | Done | `client/src/components/RemixStudio.tsx` |
| Remix Studio (Editorial + Auto tabs) | Done | `RemixStudio.tsx`, `EditorialClips.tsx` |
| Seeddance 2.0 API client | Scaffolded | `server/lib/ai/image-gen/assetGenerator.ts` |
| Chat infrastructure (Gemini SSE) | Done | `server/replit_integrations/chat/routes.ts` |
| Generated assets DB schema | Done | `shared/schema.ts` (`generatedAssets` table) |

---

## The Build: 5 Phases

### Phase 2A: Product Placement Motion Tracking Fix
**Priority**: P0 — Core product quality
**Effort**: Medium (3 files)
**Goal**: Products follow camera movement naturally instead of sitting static

**The Problem**:
- Scanner V2 captures frames at 2s intervals (max 24 frames)
- Each `detectedSurface` stores ONE static bounding box per timestamp
- `clipGenerator.ts` interpolates `bboxStart → bboxEnd`, but `bboxEnd` is rarely set
- Result: Products are pinned to initial position while camera moves

**The Fix**:

1. **Multi-keyframe surface tracking**
   - New table: `surfaceKeyframes` — stores bbox per surface per timestamp
   - During scan, when same surface is detected across multiple frames, create keyframe entries
   - Schema: `{ surfaceId, timestamp, x, y, width, height, confidence }`

2. **Surface identity matching across frames**
   - In Scanner V2, after detecting surfaces per frame, run a cross-frame matcher:
     - Same surface type + overlapping bbox region + similar confidence = same surface
     - Create linked keyframe entries
   - Use Gemini to confirm: "Is the white t-shirt at 4.2s the same as the white t-shirt at 6.2s?"

3. **Spline interpolation in clipGenerator**
   - Replace linear `bboxStart → bboxEnd` with multi-keyframe spline
   - For each frame in the clip, find the two nearest keyframes and interpolate
   - Catmull-Rom or simple cubic for smooth curves
   - `ClipPlacement.keyframes: Array<{ time, x, y, width, height }>` replaces `bboxStart/bboxEnd`

4. **Increase frame density for remix-targeted videos**
   - When a video enters the remix pipeline, optionally re-scan at 0.5s intervals (just the clip range)
   - Only for surfaces that have approved brand matches (don't waste compute)

**Files to modify**:
- `shared/schema.ts` — new `surfaceKeyframes` table
- `server/scanner_v2.ts` — cross-frame surface matching
- `server/lib/remix/clipGenerator.ts` — multi-keyframe interpolation
- `server/storage.ts` — CRUD for surfaceKeyframes

---

### Phase 2B: Multi-Segment Stitching (OpusClip-Style)
**Priority**: P1 — Major feature unlock
**Effort**: Large (5+ files)
**Goal**: Stitch non-contiguous moments into highlight reels with transitions

**Architecture**:

1. **Claude Narrative Threading prompt**
   - New analysis mode in `editorialAnalyzer.ts`:
     ```
     "Identify 3-5 moments from this transcript that form a coherent story
     when stitched together. Each moment should advance the narrative:
     - Setup (context/hook)
     - Development (tension/information)
     - Payoff (resolution/punchline)
     Provide exact timestamps and explain how they connect."
     ```
   - Returns: `{ segments: Array<{ start, end, role, connectionToNext }> }`

2. **New data model: `StitchPlan`**
   ```typescript
   interface StitchPlan {
     segments: Array<{
       start: number;
       end: number;
       role: "hook" | "development" | "payoff" | "bridge";
       transitionIn: "cut" | "crossfade" | "branded_wipe";
       transitionDuration: number; // seconds
     }>;
     totalDuration: number;
     narrativeArc: string;
   }
   ```

3. **FFmpeg concat pipeline** (new file: `clipStitcher.ts`)
   - Extract each segment as individual MP4
   - Apply transitions between segments:
     - `crossfade`: FFmpeg `xfade` filter (0.5-1s overlap)
     - `branded_wipe`: Seeddance-generated transition card (see Phase 3)
     - `cut`: Hard cut (default, fastest)
   - Concat via filter_complex:
     ```bash
     ffmpeg -i seg1.mp4 -i seg2.mp4 -i seg3.mp4 \
       -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=X[v01]; \
       [v01][2:v]xfade=transition=fade:duration=0.5:offset=Y[vout]; \
       [0:a][1:a]acrossfade=d=0.5[a01]; \
       [a01][2:a]acrossfade=d=0.5[aout]" \
       -map "[vout]" -map "[aout]" output.mp4
     ```
   - Platform-specific formatting applied to final concat output

4. **UI: Stitch Builder in RemixStudio**
   - New tab: "Highlight Reel" alongside Editorial Clips and Auto-Remix
   - Shows Claude's suggested narrative thread with segments on a timeline
   - Drag to reorder, toggle segments on/off, adjust transition type
   - "Generate Highlight Reel" button kicks off the stitch pipeline

5. **Route**: `POST /api/remix/:videoId/stitch`
   - Accepts: `{ segments: Array<{start, end}>, transitions, platformTargets }`
   - Returns: jobId (same polling/status flow as regular remix)

**Files to create**:
- `server/lib/remix/clipStitcher.ts` — FFmpeg concat logic
- `client/src/components/StitchBuilder.tsx` — Timeline UI

**Files to modify**:
- `server/lib/ai/claude-dense/editorialAnalyzer.ts` — narrative threading prompt
- `server/lib/remix/remixOrchestrator.ts` — new stitch code path
- `server/routes.ts` — stitch endpoint
- `client/src/components/RemixStudio.tsx` — third tab
- `shared/schema.ts` — stitch plan storage (optional, could use remixJobs config)

---

### Phase 2C: Post-Generation Clip Editor
**Priority**: P1 — Creator workflow essential
**Effort**: Medium (3 files)
**Goal**: Trim, adjust, and re-render generated clips without re-running full pipeline

**Architecture**:

1. **Re-render endpoint**: `POST /api/remix/clips/:clipId/re-render`
   ```json
   {
     "newStart": 45.2,
     "newEnd": 72.8,
     "captionsEnabled": true,
     "captionStyle": "highlight",
     "platformTarget": "tiktok"
   }
   ```
   - Fetches original video from Object Storage
   - Runs Steps 5-8 only (FORMAT → CAPTION → SCORE → EXPORT)
   - Skips detection/ranking (creator already chose the moment)
   - Creates new `generatedClip` record linked to same `remixJobId`
   - Old clip kept for comparison (not deleted)

2. **Trim Editor UI** (new component: `ClipTrimEditor.tsx`)
   - Opens from ClipCard "Edit" button
   - Video player with draggable trim handles (start/end markers on progress bar)
   - Preview plays only the trimmed region
   - Caption on/off toggle, style selector
   - "Re-render" button submits to re-render endpoint
   - Shows both original and trimmed versions for comparison

3. **Caption editor** (stretch)
   - Display burned-in captions as editable text fields with timestamps
   - User can retype, adjust timing, remove individual captions
   - Submitted as `captionOverrides` array to re-render endpoint

**Files to create**:
- `client/src/components/ClipTrimEditor.tsx` — trim UI

**Files to modify**:
- `server/routes.ts` — re-render endpoint
- `server/lib/remix/remixOrchestrator.ts` — re-render function (subset of pipeline)
- `client/src/components/RemixStudio.tsx` — "Edit" button on ClipCard

---

### Phase 3: Seeddance 2.0 Text-to-Image Integration
**Priority**: P1 — Unlocks AI-generated product placements
**Effort**: Medium (API client exists, needs pipeline integration)
**Goal**: When no brand asset exists, generate one contextually using Seeddance 2.0

**What's Already Built**:
- `server/lib/ai/image-gen/assetGenerator.ts` — full Seeddance 2.0 API client
- `server/lib/ai/image-gen/promptBuilder.ts` — prompt engineering
- `shared/schema.ts` — `generatedAssets` table with all fields
- Async job model: submit → poll → download → save

**What Needs Wiring**:

1. **Trigger: "No brand asset available"**
   - In `remixOrchestrator.ts` Step 4 (INSERT), when a brand match exists but `product.imageUrl` is missing or `product.isTransparent === false`:
     - Call `generateProductAsset()` with scene context
     - Prompt: "Generate a [product category] product image that fits naturally on [surface type] in [scene description]"
     - Save to Object Storage + update brandProduct.imageUrl
     - Continue pipeline with generated image

2. **Bridge/transition card generation**
   - For multi-segment stitching (Phase 2B), generate branded transition cards:
     - "Generate a branded card with [brand name] logo on [brand color] background"
     - Used between stitch segments instead of crossfade

3. **Outro card generation**
   - After clip ends, generate a branded end card:
     - Product hero shot + CTA text + brand colors
     - 2-3 second hold frame appended to clip via FFmpeg

4. **B-roll image generation** (for AI co-pilot, Phase 4)
   - When co-pilot detects dead air or awkward cut:
     - Generate contextual b-roll image
     - Convert to 2-3 second video (Ken Burns pan/zoom effect via FFmpeg)
     - Insert into stitch plan

**Files to modify**:
- `server/lib/remix/remixOrchestrator.ts` — call assetGenerator in Step 4
- `server/lib/ai/image-gen/assetGenerator.ts` — new generation modes (transition, outro, b-roll)
- `server/lib/remix/clipStitcher.ts` — use generated cards as transition frames

**Dependency**: Seeddance 2.0 API key must be available. Scaffold with mock/placeholder until then.

---

### Phase 4: AI Co-Pilot in Remix Studio
**Priority**: P2 — Differentiator feature
**Effort**: Large (new system)
**Goal**: Claude-powered assistant that watches the remix in real-time and suggests improvements

**Architecture**:

1. **Remix Context Engine** (new file: `server/lib/ai/remixCopilot.ts`)
   - Maintains context of current remix session:
     - Video metadata, transcript, editorial analysis
     - Current clip boundaries, quality scores, placements
     - Creator's edit history (what they changed and why)
   - Claude receives full context + creator action → returns suggestion

2. **Suggestion Types**:
   ```typescript
   type CopilotSuggestion =
     | { type: "trim"; reason: string; newStart?: number; newEnd?: number }
     | { type: "hook_improvement"; reason: string; alternativeStart: number }
     | { type: "add_placement"; reason: string; surfaceId: number; productId: number }
     | { type: "generate_asset"; reason: string; prompt: string } // triggers Seeddance
     | { type: "stitch"; reason: string; additionalSegments: Array<{start, end}> }
     | { type: "caption_edit"; reason: string; newCaptions: CaptionSegment[] }
     | { type: "platform_switch"; reason: string; betterPlatform: string }
     | { type: "reject"; reason: string } // "this clip won't perform well because..."
   ```

3. **Trigger Points** (when co-pilot activates):
   - After clip generation → "Here's what I'd improve"
   - After creator trims → "Good call, but you might also want to..."
   - After quality score < 0.7 → "This scored low because... here's how to fix it"
   - On demand → creator types question in chat panel

4. **UI: Chat Panel in RemixStudio**
   - Slide-out panel on right side of Remix Studio modal
   - Shows Claude suggestions as cards with "Apply" / "Dismiss" buttons
   - "Apply" sends the adjustment directly to the re-render endpoint
   - Creator can also type freeform questions:
     - "Why did you choose this moment?"
     - "Can you find a moment where they talk about X?"
     - "Make this more brand-friendly"

5. **SSE streaming** (reuse existing chat infrastructure)
   - Extend `server/replit_integrations/chat/routes.ts` with remix-aware context
   - New endpoint: `POST /api/remix/:videoId/copilot/ask`
   - Streams Claude response with structured suggestion JSON

**Files to create**:
- `server/lib/ai/remixCopilot.ts` — co-pilot logic + Claude prompts
- `client/src/components/RemixCopilot.tsx` — chat panel UI

**Files to modify**:
- `server/routes.ts` — co-pilot endpoints
- `client/src/components/RemixStudio.tsx` — co-pilot panel integration
- `client/src/components/ClipTrimEditor.tsx` — "Apply suggestion" actions

---

## Execution Order

```
Phase 2A: Product Placement Motion Tracking
├── surfaceKeyframes schema + CRUD
├── Scanner V2 cross-frame matching
├── Multi-keyframe spline interpolation in clipGenerator
└── Optional: dense re-scan for remix-targeted clips

Phase 2B: Multi-Segment Stitching
├── Claude narrative threading prompt
├── StitchPlan data model
├── clipStitcher.ts (FFmpeg concat)
├── Stitch route endpoint
└── StitchBuilder UI (timeline + drag-reorder)

Phase 2C: Post-Generation Clip Editor
├── Re-render endpoint
├── ClipTrimEditor component (trim handles + preview)
└── Caption editor (stretch)

Phase 3: Seeddance 2.0 Integration
├── Wire assetGenerator into remixOrchestrator Step 4
├── Transition card generation (for stitching)
├── Outro card generation
└── B-roll generation (for co-pilot)

Phase 4: AI Co-Pilot
├── remixCopilot.ts (context engine + suggestion types)
├── Co-pilot SSE endpoint
├── RemixCopilot.tsx chat panel
└── "Apply suggestion" actions wired to trim/re-render/stitch
```

**Dependencies**:
- Phase 2B depends on 2A (placements need motion tracking for stitched clips)
- Phase 3 depends on 2B (transition cards used in stitching)
- Phase 4 depends on 2C + 3 (co-pilot suggests trims + generates assets)
- Phases 2A, 2B, 2C can be built in parallel with some coordination

---

## Files Touched Per Phase

| Phase | New Files | Modified Files |
|-------|-----------|---------------|
| 2A | — | `schema.ts`, `storage.ts`, `scanner_v2.ts`, `clipGenerator.ts` |
| 2B | `clipStitcher.ts`, `StitchBuilder.tsx` | `editorialAnalyzer.ts`, `remixOrchestrator.ts`, `routes.ts`, `RemixStudio.tsx`, `schema.ts` |
| 2C | `ClipTrimEditor.tsx` | `routes.ts`, `remixOrchestrator.ts`, `RemixStudio.tsx` |
| 3 | — | `remixOrchestrator.ts`, `assetGenerator.ts`, `clipStitcher.ts` |
| 4 | `remixCopilot.ts`, `RemixCopilot.tsx` | `routes.ts`, `RemixStudio.tsx`, `ClipTrimEditor.tsx` |
