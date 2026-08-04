# FullScale Data Dictionary

**Version 1.2 · 2026-08-04 · prepared for the FullScale × Deloitte data workstream**

*Changelog — v1.1/1.2 (2026-08-04): added the Phase 1 measurement spine (§4b), retention curves
and per-video demographics, the creator behavior event log, audience response (comments +
per-day metrics), the delivery repository, and per-platform outcome coverage. Gap statuses in
§6 updated in place — five of the original eight are now closed.*

> Scope: every table in the production PostgreSQL schema (`shared/schema.ts`, `shared/models/*`),
> classified by provenance, plus the audience-metric inventory (what is collected today, at what
> cadence) and the instrumentation gaps between today's data and the research goal. Everything in
> this document is generated from the live codebase — it describes what **is**, not what is planned,
> except where a section is explicitly labeled as a gap.

---

## 1. The research frame: measuring CV impact on the audience

The research question is **what effect does CV-driven product placement have on the audience** —
and the platform's structural advantage is that the same physical location in a creator's set can
carry *different products across episodes and versions*. That maps cleanly onto an experimental
design:

| Research concept | FullScale data object | Why it works |
|---|---|---|
| **Experimental unit** | Fixture: `detected_surfaces.surface_group_id` / `room_models` surface (`rm{modelId}-s{idx}`) | Fixture identity is deliberately **stable across rescans AND across episodes** of the same set — the same physical desk is one unit over time. This is the capability most datasets cannot offer. |
| **Treatment** | Product applied to a fixture: `saved_placements.product_id`, `brand_placement_assignments.brand_product_id` | One-active-assignment-per-surface exclusivity gives clean treatment assignment per fixture per period. |
| **Exposure dose** | `video_index.scene_inventory` → per-scene `occurrences` and `totalScreenTimeSec`; per-fixture screen time | CV-computed: how often and how long the audience actually sees the fixture. |
| **Exposure event** | `editorial_clips` / `generated_clips` (`productPlacements` jsonb) and `published_posts` | Which rendered artifact carried which treatment, and where it went. |
| **Outcomes** | `clip_analytics`, `social_insight_snapshots`, `clip_feedback`, `shared_links.view_count` | Views, engagement, demographics — today mostly at clip/post granularity (see §6 gaps). |
| **Covariates / confounders** | `brand_match_scores`, `scene_analysis.placement_viability`, channel audience data | ⚠️ **Treatment assignment is NOT random.** Match scores and viability ratings are explicit selection mechanisms — any impact analysis must treat them as confounders (or use them for propensity adjustment). |

**The same-scene / different-products design in practice:** Scene B's `Wall 4` (`rm12-s3`) carries
Product A in episodes 1–4 and Product B in episodes 5–8. Fixture identity, screen-time dose, and
placement lifecycle are all first-party CV data; the outcome deltas come from the audience tables.
Section 6 lists exactly what still needs to be instrumented to close that loop at placement (rather
than clip) granularity.

---

## 2. How to read this dictionary

**Provenance** (the licensing boundary — this is the "ours vs theirs" split):

| Label | Meaning |
|---|---|
| First-party (CV/pipeline-generated) | Produced by FullScale's computer vision / pipelines. FullScale IP; licensable. |
| First-party (user input) | Entered by creators/brands in-product. FullScale-held; subject to user agreements. |
| Platform-derived | Mirrors YouTube / Meta API data. Subject to platform ToS, retention limits (Meta ≈ 90 days — hence the snapshot tables), and generally **not licensable onward**. |
| Mixed | Table contains both kinds of columns — the per-column notes call out which. |

**A structural note the analysts should internalize early** (from the schema audit):
> 42 pgTables total: 39 in shared/schema.ts, 2 in shared/models/auth.ts (sessions, users), 2 in shared/models/chat.ts (conversations, messages) — one overlap note: auth/chat are re-exported through schema.ts. The CV-research spine for "fixture = experimental unit, product = treatment" is: room_models + detected_surfaces.surface_group_id give the STABLE FIXTURE IDENTITY (the "rm{modelId}-s{idx}" group id is deliberately identical across rescans and episodes, so the same physical desk is one unit over time); video_index.scene_inventory gives per-fixture EXPOSURE DOSE (occurrences + totalScreenTimeSec per scene); saved_placements + brand_placement_assignments record the TREATMENT (which brand_products product was applied to which fixture, with app-layer one-active-assignment-per-surface exclusivity — clean treatment assignment); editorial_clips/generated_clips (productPlacements jsonb carries surfaceId+brandProductId+placementId) and published_posts are the EXPOSURE EVENTS; and clip_analytics, clip_feedback (performance rows), shared_links.view_count, and social_insight_snapshots are the OUTCOME/covariate side. Honest gaps for the data dictionary: (1) outcome tables are keyed at clip/post level, not per-fixture — the fixture→outcome join must go through generated_clips.productPlacements or editorial_clips.surfaces jsonb; (2) clip_feedback's performance columns reference an "analyticsCollector" in comments but only storage.ts touches the table today; (3) several outcome-adjacent tables (clip_analytics, published_posts, distribution_profiles, publishing_schedules) use integer user_id while the rest of the app uses varchar users.id — a known dual-ID wrinkle handled by server/lib/stableUserId.ts; (4) studio_jobs is defined but unused by any server/client code; (5) treatment assignment is NOT random — brand_match_scores and scene_analysis.placement_viability are explicit selection mechanisms and must be treated as confounders/covariates in any audience-impact analysis. Platform-derived metric tables (clip_analytics, social_insight_snapshots, social_accounts.audience_data, youtube_connections stats) mirror YouTube/Meta data and are subject to their retention/ToS constraints — social_insight_snapshots exists precisely because Meta only retains ~90 days.
---

## 3. Entity map
**CV & Scene Intelligence (the first-party core)**: `video_index`, `detected_surfaces`, `room_models`, `scene_analysis`
**Placement & Treatment**: `monetization_items`, `brand_products`, `brand_placement_assignments`, `saved_placements`, `shared_links`, `brand_match_scores`
**Content & Derivatives**: `video_exports`, `video_transcripts`, `remix_jobs`, `generated_clips`, `editorial_clips`, `distribution_profiles`, `published_posts`, `publishing_schedules`
**Audience & Outcomes**: `youtube_connections`, `social_accounts`, `social_insight_snapshots`, `clip_feedback`, `clip_analytics`
**Identity, Access & Consent**: `sessions`, `users`, `allowed_users`
**Operational & Supporting**: `conversations`, `messages`, `oauth_states`, `surface_keyframes`, `notifications`, `data_deletion_requests`, `stitch_plans`, `remix_templates`, `generated_assets`, `studio_subscriptions`, `studio_usage`, `studio_voices`, `studio_videos`, `studio_jobs`, `studio_waitlist`, `brand_briefs`

---

## 4. Table dictionaries

### CV & Scene Intelligence (the first-party core)

#### `video_index`

The video catalog: indexed high-value videos from YouTube/Instagram/uploads, scan status, editorial auto-clip pipeline state, and — crucially — the CV scene understanding (scene boundaries, recurring-scene index, and the rolled-up scene inventory of sellable surfaces).

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** CORE: scene_inventory is the per-fixture exposure ledger — occurrences and total screen time per canonical surface per recurring scene. scene_index defines the recurring-scene classes; scene_boundaries prevents placements crossing cuts. Platform view_count is a legacy popularity covariate.

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Video ID |
| `user_id` | varchar notNull | Owning creator |
| `youtube_id` | varchar notNull | YouTube video ID (or platform-specific id) |
| `title` | text notNull | Video title |
| `description` | text | Description |
| `view_count` | integer notNull default 0 | Platform view count at index time |
| `thumbnail_url` | text | Thumbnail |
| `status` | varchar notNull default 'Pending Scan' | Scan status |
| `priority_score` | integer notNull default 0 | Indexing priority |
| `published_at` | timestamp | Platform publish date |
| `category` | varchar | Content category |
| `is_evergreen` | boolean default false | Evergreen flag |
| `duration` | varchar | Duration string |
| `platform` | varchar notNull default 'youtube' | 'youtube', 'instagram', 'facebook' (plus twitch/tiktok/x via URL-paste ingest) |
| `sentiment` | varchar default 'Neutral' | 'Uplifting', 'Serious', 'Chaotic', 'Educational', etc. |
| `cultural_context` | varchar default 'General' | 'American Tech Office', 'Japanese Tea Room', etc. |
| `file_path` | text | Persistent file path for uploaded videos (survives restart) |
| `source_url` | text | Canonical URL to the original content (FB/IG permalink etc.) |
| `subcategory` | varchar | Finer classification than category (e.g. 'Sports') |
| `tags` | jsonb | Flexible tag array for future filtering, e.g. ["sports","basketball"] |
| `deleted_at` | timestamp | Soft delete (trash bin): null = active, set = trashed |
| `editorial_status` | varchar(20) | Editorial auto-clip pipeline: null \| 'pending' \| 'transcribing' \| 'analyzing' \| 'rendering' \| 'ready' \| 'failed' |
| `editorial_error` | text | Editorial pipeline error |
| `editorial_clip_count` | integer default 0 | Rendered editorial clip count |
| `editorial_completed_at` | timestamp | Editorial pipeline completion |
| `scene_boundaries` | jsonb: number[] | Seconds marking the START of each shot (ffmpeg scene-detect), e.g. [0, 12.5, 28]; a surface at t belongs to the block whose start <= t < next-start; null until first scan |
| `scene_index` | jsonb | Clusters shots by perceptual similarity into recurring scenes (podcast host↔guest = 2 scenes, not 10 shots); computed by sceneIndex.ts after sceneBoundaries |
| `scene_index.shots[]` | jsonb: {shotIdx, sceneId, tStart, tEnd, hash}[] | Per-shot scene assignment with dHash |
| `scene_index.sceneCount` | jsonb: number | Number of recurring scene classes |
| `scene_index.cuts` | jsonb | Cut list |
| `scene_inventory` | jsonb | Scene-block inventory built at scan finalize — the sellable 'what's in this episode' model: each recurring scene lists canonical surfaces ONCE with occurrence counts and screen time, instead of per-frame rows; null until a scan with surface grouping runs — consumers must handle null |
| `scene_inventory.version` | jsonb: number | Format version (1) |
| `scene_inventory.source` | jsonb: 'sceneIndex' | 'grid' | 'grid' marks streamed scans where scene index was synthesized from dense-grid frame hashes rather than shot-midpoint keyframes |
| `scene_inventory.scenes[].sceneId` | jsonb: number | Recurring scene class id |
| `scene_inventory.scenes[].label` | jsonb: string | 'Scene A' etc., by descending totalSec |
| `scene_inventory.scenes[].occurrences` | jsonb: number | Shot count for this scene |
| `scene_inventory.scenes[].totalSec` | jsonb: number | Sum of shot durations — the scene's total screen time |
| `scene_inventory.scenes[].surfaces[].groupId` | jsonb: string | Canonical surface identity (detected_surfaces.surface_group_id) |
| `scene_inventory.scenes[].surfaces[].surfaceType` | jsonb: string | Surface type |
| `scene_inventory.scenes[].surfaces[].bbox` | jsonb: {x,y,w,h} | Median bounding box, 0-1 normalized |
| `scene_inventory.scenes[].surfaces[].confidence` | jsonb: number | Detection confidence |
| `scene_inventory.scenes[].surfaces[].screenTimeSec` | jsonb: number | Surface screen time (= scene totalSec) |
| `scene_inventory.scenes[].surfaces[].rowCount` | jsonb: number | Supporting detected_surfaces rows |
| `scene_inventory.scenes[].surfaces[].representativeRowId` | jsonb: number | Representative detected_surfaces.id |
| `scene_inventory.scenes[].surfaces[].frameUrl` | jsonb: string | Representative frame image |
| `scene_inventory.generatedAt` | jsonb: timestamp | When inventory was built |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `detected_surfaces`

AI-detected ad placement surfaces in videos — one row per supporting frame of a consensus surface; surface_group_id collapses rows into the canonical physical surface. Creator approval gates brand visibility.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** CORE: this IS the fixture table. surface_group_id is the experimental-unit key ('rm{modelId}-s{idx}' ids are identical across rescans/episodes by design); scene_id propagates placements across recurring shots; lighting/camera fields are realism covariates; creator_approved gates which fixtures enter the market.

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Detection row ID |
| `video_id` | integer notNull | Reference to video_index.id |
| `timestamp` | numeric notNull | Seconds into video where surface was detected |
| `surface_type` | varchar notNull | Table, Desk, Wall, Monitor, Bottle |
| `confidence` | numeric notNull | AI confidence score (0-1) |
| `bounding_box_x` | numeric notNull | X coordinate (0-1 normalized) |
| `bounding_box_y` | numeric notNull | Y coordinate (0-1 normalized) |
| `bounding_box_width` | numeric notNull | Width (0-1 normalized) |
| `bounding_box_height` | numeric notNull | Height (0-1 normalized) |
| `frame_url` | text | Optional stored frame image URL |
| `surroundings` | text[] | Array of surrounding objects detected |
| `scene_context` | text | Scene description from AI |
| `lighting_direction` | varchar | left, right, top, top-left, top-right, ambient (Gemini) |
| `lighting_intensity` | numeric | 0.0-1.0 (dim to bright) |
| `camera_angle` | varchar | eye-level, slightly-above, top-down, low-angle |
| `orientation` | varchar | 'horizontal' \| 'vertical' — drives placement type (horizontal=product, vertical=signage/poster) |
| `creator_approved` | boolean notNull default false | Surfaces hidden from brands until creator explicitly approves (creator-controlled exposure model) |
| `scene_id` | integer | Scene cluster ID from sceneIndex — same sceneId = same physical scene; used to propagate placements across visually-similar shots; null pre-clustering |
| `surface_group_id` | text | Canonical physical-surface identity; formats 'g{videoId}-{sceneKey}-{seq}' (fresh) or 'rm{modelId}-s{idx}' (room-model-confirmed, IDENTICAL across rescans and episodes so group-keyed placements survive both); opaque string — never parse; null pre-grouping — fall back to (surfaceType, sceneId) composite, never treat raw rows as distinct surfaces |
| `created_at` | timestamp defaultNow | Created |

#### `room_models`

Persistent per-creator 'set memory': one row per recurring set/camera setup, identified perceptually by exemplar dHashes (match = hamming distance <= 12). `surfaces` is the ONE authoritative surface list for that set, confirmed (not re-discovered) on later scans — buys consistent labels/boxes, placements that survive rescans via stable 'rm{modelId}-s{idx}' ids, and instant inventory for new episodes in the same room.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** CORE: the cross-episode experimental-unit registry. A room-model surface index (idx) is the durable fixture identity that lets different products (treatments) be compared on the SAME physical fixture across episodes; episode_count = number of episodes the fixture appeared in.

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Room model ID |
| `user_id` | varchar notNull | Canonical creator (users.id); legacy email-keyed rows fold in via alias handling at read time |
| `scene_exemplar_hashes` | text[] notNull | Up to 8 dHashes of shot-midpoint keyframes for this set/camera setup |
| `surfaces` | jsonb notNull: RoomModelSurface[] | Authoritative surface list for the set |
| `surfaces[].idx` | jsonb: number | Stable per-model index — append-only, never reused after a deletion; forms 'rm{id}-s{idx}' group ids |
| `surfaces[].surfaceType` | jsonb: string | Canonical type; later scans keep this even when Gemini relabels |
| `surfaces[].orientation` | jsonb: string | Canonical orientation (kept across rescans) |
| `surfaces[].bbox` | jsonb: {x,y,w,h} | 0-1 normalized floats |
| `surfaces[].confidence` | jsonb: number | Confidence |
| `surfaces[].frameUrl` | jsonb: string|null | Cleanest keyframe seen so far, or null |
| `source_video_id` | integer | First video that built this model |
| `last_video_id` | integer | Most recent video that confirmed it |
| `episode_count` | integer default 1 | Distinct videos that have matched this set |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `scene_analysis`

Claude Dense narrative analysis per surface/frame range: narrative context, emotional tone, cultural tags, and placement viability scoring. Used by routes + storage and the remix orchestrator side.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** Context covariates for the fixture at exposure time (tone, cultural tags) AND a selection mechanism: placement_viability influences which fixtures get treated — a confounder to model

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Analysis ID |
| `video_id` | integer notNull FK video_index.id | Video |
| `surface_id` | integer FK detected_surfaces.id | Surface analyzed (nullable) |
| `frame_start` | real notNull | Analysis window start |
| `frame_end` | real | Analysis window end |
| `narrative_context` | text | What's happening narratively |
| `emotional_tone` | varchar(50) | Emotional tone label |
| `cultural_tags` | jsonb: string[] | Cultural tags |
| `placement_viability` | real | Viability score for placement |
| `suggested_categories` | jsonb: string[] | Suggested product categories |
| `reasoning` | text | Model reasoning |
| `claude_response_raw` | jsonb | Raw model response |
| `created_at` | timestamp defaultNow | Created |

### Placement & Treatment

#### `monetization_items`

Brand bids on creator video surfaces, plus the placement-review lifecycle that fulfills a bid (creator places product → brand reviews via shared link → accept/revise/reject).

- **Provenance:** **First-party (user input)** — FullScale IP, user-contributed
- **CV-research relevance:** Treatment DEMAND signal: bid_amount by scene_type/genre is the market price of a fixture; placement_id links bid to the treatment applied

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Bid ID |
| `title` | text notNull | Bid/item title |
| `thumbnail_url` | text | Thumbnail |
| `date` | timestamp defaultNow | Bid date |
| `status` | text notNull | 'pending' \| 'placed' \| 'accepted' \| 'revision_requested' \| 'rejected' \| 'expired' |
| `video_id` | integer | Reference to video_index.id |
| `creator_user_id` | varchar | Creator who owns the video |
| `brand_email` | varchar | Brand who placed the bid |
| `brand_name` | varchar | Brand company name |
| `bid_amount` | numeric | Bid amount in dollars |
| `scene_type` | varchar | e.g. 'Desk', 'Wall', 'Product' |
| `genre` | varchar | e.g. 'Tech', 'Lifestyle', 'Gaming' |
| `placement_id` | integer | Reference to saved_placements.id — placement that fulfills this bid |
| `review_slug` | varchar | Shared link slug for brand to review the placement |
| `review_note` | text | Brand's note when requesting revision |

#### `brand_products`

Product images uploaded by brands for placement previews, with auto-populated ingest analysis (subject bounds, dominant color, background type) used by the compositor.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** The TREATMENT catalog: product identity + attributes (category, dominant_color, subject size, transparency) are treatment covariates for same-fixture-different-product comparisons

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Product ID |
| `user_id` | varchar notNull | Brand user ID (references users.id) |
| `name` | varchar notNull | Product name |
| `image_url` | text notNull | Path to stored product image |
| `thumbnail_url` | text | Auto-generated smaller thumbnail |
| `category` | varchar | e.g. 'beverage', 'electronics', 'fashion' |
| `width` | integer | Image pixel width |
| `height` | integer | Image pixel height |
| `is_transparent` | boolean default false | Whether image has alpha channel |
| `subject_bounds_x` | numeric | Normalized 0-1: X offset of non-transparent subject (auto on upload) |
| `subject_bounds_y` | numeric | Normalized 0-1: Y offset of subject |
| `subject_bounds_w` | numeric | Normalized 0-1: subject width |
| `subject_bounds_h` | numeric | Normalized 0-1: subject height |
| `dominant_color` | varchar | Hex color e.g. '#FF6B2B' |
| `background_type` | varchar | 'transparent' \| 'solid' \| 'complex' |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `brand_placement_assignments`

Brand-initiated placement requests awaiting creator approval: brand picks product + surface on a creator's video/editorial clip → pending_creator_review → approve/reject; on approval auto-remix renders include the product. App-layer constraint: only ONE active (pending or approved) assignment per surface_id (409 on conflict). Carries the full CPM pricing record (server/lib/placementPricing.ts) charged on approval.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** CORE: the treatment-assignment record — (brand_product_id treatment) x (surface_id fixture) with exclusivity, duration term (exposure window), and priced value; pricing_breakdown preserves the assignment mechanism's inputs (a selection-bias audit trail)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Assignment ID |
| `brand_user_id` | varchar notNull | Brand who requested placement |
| `creator_user_id` | varchar notNull | Creator who owns the video |
| `video_id` | integer notNull | FK to video_index.id |
| `editorial_clip_id` | integer | FK to editorial_clips.id — the editorial clip this placement targets (nullable for legacy source-video assignments; new requests should always set it) |
| `brand_product_id` | integer | FK to brand_products.id; NULL = brand delegated the choice — creator picks from the brand's catalog at approval time |
| `surface_id` | integer notNull | FK to detected_surfaces.id |
| `status` | varchar(30) notNull default 'pending_creator_review' | pending_creator_review → creator_approved \| creator_rejected \| brand_withdrawn \| expired |
| `brand_message` | text | Optional message brand → creator |
| `rejection_reason` | text | Optional reason from creator |
| `reviewed_at` | timestamp | When creator approved/rejected |
| `placement_fee_cents` | integer default 0 | Total fee brand pays (cents; integer to avoid float math on money); charged on approval, refunded on revoke |
| `platform_take_cents` | integer default 0 | Platform's 30% cut |
| `creator_payout_cents` | integer default 0 | Creator's 70% |
| `is_test_placement` | boolean default false | Admin override: zero charge |
| `custom_fee_cents` | integer | Admin override: bespoke fee |
| `negotiated_note` | text | Audit note for custom deals |
| `pricing_breakdown` | jsonb | Pricing audit — full inputs and multipliers used by the CPM rubric (untyped in schema) |
| `duration_term` | varchar(20) default 'single' | single \| 1-month \| 3-month \| 6-month \| 12-month |
| `duration_days` | integer default 0 | Duration in days |
| `expires_at` | timestamp | null = no expiry (single placement) |
| `charge_status` | varchar(20) default 'pending' | pending → charged \| failed (Stripe integration is a follow-up) |
| `charged_at` | timestamp | When charged |
| `stripe_charge_id` | varchar | Stripe charge id |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `saved_placements`

Persistent product placements on video surfaces — the creator's authored composition (transform/blend), scene-continuity propagation, explicit scoping to canonical surfaces, the human review lifecycle (FullScale reviews before final render), optional AI harmonization, and per-frame keyframe pinning.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** CORE: the applied-treatment record — which product image landed on which fixture, with explicit scope (applies_to_group_ids of canonical surface group ids) defining exactly where the treatment propagates; review_status marks the human quality gate before publication

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Placement ID |
| `video_id` | integer notNull | Reference to video_index.id |
| `surface_id` | integer notNull | Reference to detected_surfaces.id (anchor surface) |
| `product_id` | integer | Reference to brand_products.id (null if custom upload) |
| `product_image_url` | text notNull | URL of product image used |
| `created_by` | varchar notNull | Email of user who created placement |
| `role` | varchar notNull default 'creator' | 'creator' or 'brand' |
| `bid_id` | integer | Reference to monetization_items.id (null for organic placements) |
| `scene_group_id` | varchar | Legacy continuity group, e.g. 'video-5-Desk-0.3-0.5' — surfaces with matching group share placements |
| `applies_to_group_ids` | jsonb: string[] | Explicit placement scope in detected_surfaces.surfaceGroupId values: null = legacy heuristic matching; [] = anchor surface only; ['rm3-s1',...] = exactly those canonical surfaces |
| `transform` | jsonb notNull | Transform settings blob |
| `transform.offsetX` | jsonb: number | X offset within surface |
| `transform.offsetY` | jsonb: number | Y offset |
| `transform.scale` | jsonb: number | Scale factor |
| `transform.rotation` | jsonb: number | Rotation |
| `transform.flipH` | jsonb: boolean | Horizontal flip |
| `blend` | jsonb notNull | Blend/compositing settings blob |
| `blend.opacity` | jsonb: number | Opacity |
| `blend.blendMode` | jsonb: string | Blend mode |
| `blend.shadowEnabled` | jsonb: boolean | Shadow on/off |
| `blend.shadowBlur` | jsonb: number | Shadow blur |
| `blend.shadowOffsetX` | jsonb: number | Shadow X offset |
| `blend.shadowOffsetY` | jsonb: number | Shadow Y offset |
| `blend.shadowColor` | jsonb: string | Shadow color |
| `blend.featherRadius` | jsonb: number | Edge feathering |
| `blend.brightness` | jsonb: number | Brightness adjust |
| `blend.contrast` | jsonb: number | Contrast adjust |
| `status` | varchar notNull default 'active' | 'active' \| 'archived' — row liveness |
| `review_status` | varchar(20) notNull default 'submitted' | Human-review lifecycle: 'submitted' → 'in_review' → 'render_ready' \| 'needs_changes' (distinct from status) |
| `review_note` | text | Ops note back to the creator (esp. needs_changes) |
| `reviewed_at` | timestamp | When reviewed |
| `harmonized_image_url` | text | AI-harmonized product image (fal.ai CDN or future GCS); null when creator opted out via Harmonized/Flat toggle |
| `is_harmonized` | boolean notNull default false | When true, previews + render pipeline use harmonizedImageUrl instead of flat overlay |
| `keyframes` | jsonb: {t, transform{offsetX,offsetY,scale,rotation,flipH}}[] | Frame-pinned transform snapshots at timestamps (seconds); render lerps between adjacent keyframes; empty/null = base transform constant |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `shared_links`

Shareable public links for placements/exports, plus A1 release pages linking a brand placement's FINAL approved render (minted at brand_approved; unique partial index makes the lazy mint race-safe). Tracks view counts.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** view_count is a FIRST-PARTY outcome metric: audience views of release pages carrying a specific placement — one of the few audience signals FullScale owns outright

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Link ID |
| `slug` | varchar notNull unique | 8-char unique slug (/s/abc12345) |
| `placement_id` | integer | Reference to saved_placements.id (optional) |
| `export_id` | integer | Reference to video_exports.id (optional) |
| `brand_placement_id` | integer | Reference to brand_placement_assignments.id (optional); A1 release page plays the baked clip with credits + download; unique partial index (one release link per placement) |
| `video_id` | integer notNull | Reference to video_index.id |
| `created_by` | varchar notNull | Email of creating user |
| `title` | text | Optional custom title |
| `view_count` | integer notNull default 0 | Public page view count |
| `is_active` | boolean notNull default true | Can be deactivated |
| `expires_at` | timestamp | Optional expiration |
| `created_at` | timestamp defaultNow | Created |

#### `brand_match_scores`

Brand-product ↔ scene compatibility scores (AI-generated, human-approvable) used by the remix orchestrator to pick placements.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** The assignment mechanism's score: compatibility drives which product gets matched to which scene — must be recorded as a covariate since treatment is not randomized

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Score ID |
| `scene_analysis_id` | integer notNull FK scene_analysis.id | Scene analyzed |
| `brand_product_id` | integer notNull FK brand_products.id | Product scored |
| `compatibility_score` | real | Brand↔scene compatibility |
| `reasoning` | text | Model reasoning |
| `suggested_placement_style` | varchar(100) | Suggested style |
| `approved` | boolean default false | Human approval flag |
| `approved_by` | varchar(20) | Who approved |
| `created_at` | timestamp defaultNow | Created |

### Content & Derivatives

#### `video_exports`

Async video export jobs — composited videos with product placements baked in.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** Rendered deliverable containing the treatment; placement_data snapshots which placements/keyframes were baked into the exposed asset

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Export job ID |
| `video_id` | integer notNull | Reference to video_index.id |
| `requested_by` | varchar notNull | Email of requesting user |
| `status` | varchar notNull default 'queued' | 'queued' \| 'processing' \| 'complete' \| 'failed' |
| `progress` | integer default 0 | 0-100 percentage |
| `placement_data` | jsonb notNull | Array of placement configs with keyframes (snapshot of what was rendered) |
| `output_path` | text | Path to exported MP4 |
| `output_url` | text | Relative download URL |
| `error` | text | Error message if failed |
| `created_at` | timestamp defaultNow | Created |
| `completed_at` | timestamp | Completed |

#### `video_transcripts`

Speech-to-text transcription with speaker diarization (whisper/deepgram) — feeds editorial clip selection.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** Content covariate: what was being said during the fixture's screen time (spoken context of exposure)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Transcript ID |
| `video_id` | integer notNull FK video_index.id | Video |
| `provider` | varchar(30) notNull | 'whisper', 'deepgram' |
| `language` | varchar(10) default 'en' | Language |
| `full_text` | text | Full transcript text (plain) |
| `segments` | jsonb | Timestamped segments with speaker diarization |
| `segments[].start` | jsonb: number | Segment start (seconds) |
| `segments[].end` | jsonb: number | Segment end (seconds) |
| `segments[].text` | jsonb: string | Segment text |
| `segments[].speaker` | jsonb: string? | Speaker ID from diarization |
| `segments[].confidence` | jsonb: number | 0-1 |
| `segments[].words[]` | jsonb: {word, start, end, confidence}[] | Word-level timings |
| `speaker_map` | jsonb: Record<string,string> | Diarization labels → display names |
| `audio_duration` | real | Total audio length in seconds |
| `word_count` | integer | Word count |
| `segment_count` | integer | Segment count |
| `status` | varchar(20) default 'pending' | pending, processing, completed, failed |
| `error_message` | text | Error |
| `processing_time_ms` | integer | Processing time |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp | Updated |

#### `remix_jobs`

Auto-remix job tracking: user-configured clip generation runs over a video.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** minor — production lineage linking clips to the run that made them (config records editorial mode, platform targets)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Job ID |
| `video_id` | integer notNull FK video_index.id | Source video |
| `user_id` | integer notNull | Requesting user (NOTE: integer, unlike varchar users.id) |
| `status` | varchar(30) default 'queued' | Job status |
| `config` | jsonb | Run configuration |
| `config.minClipDuration` | jsonb: number | Min clip length |
| `config.maxClipDuration` | jsonb: number | Max clip length |
| `config.maxClips` | jsonb: number | Clip cap |
| `config.platformTargets` | jsonb: string[] | Target platforms |
| `config.captionsEnabled` | jsonb: boolean | Captions on/off |
| `config.captionStyle` | jsonb: string? | Caption style |
| `config.clipRange` | jsonb: {start,end}? | Optional source range |
| `config.editorialMode` | jsonb: boolean? | Editorial mode flag |
| `clip_count` | integer default 0 | Clips produced |
| `platform_targets` | jsonb: string[] | Targets (denormalized) |
| `brand_match_ids` | jsonb: number[] | brand_match_scores ids applied in this run |
| `error_message` | text | Error |
| `created_at` | timestamp defaultNow | Created |
| `completed_at` | timestamp | Completed |

#### `generated_clips`

Clips produced by the auto-remix pipeline, including which product placements were baked in and where the clip was published.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** CORE JOIN: product_placements[] ties the published creative to (surfaceId, brandProductId, placementId) — the bridge from fixture+treatment to exposure and outcomes (clip_feedback, clip_analytics via published_posts)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Clip ID |
| `remix_job_id` | integer notNull FK remix_jobs.id | Producing job |
| `video_id` | integer notNull FK video_index.id | Source video |
| `clip_start` | real notNull | Start (source seconds) |
| `clip_end` | real notNull | End (source seconds) |
| `duration` | real notNull | Duration |
| `format` | varchar(10) | Output format |
| `platform_target` | varchar(30) | Intended platform |
| `product_placements` | jsonb: {surfaceId, brandProductId, placementId}[] | Placements baked into this clip |
| `captions_enabled` | boolean default true | Captions |
| `quality_score` | real | Quality score |
| `export_path` | varchar(500) | Rendered file path |
| `thumbnail_path` | varchar(500) | Thumbnail path |
| `status` | varchar(30) default 'generated' | Clip status |
| `published_at` | timestamp | When published |
| `published_platform` | varchar(30) | Where published |
| `published_url` | varchar(500) | Published URL |
| `created_at` | timestamp defaultNow | Created |

#### `editorial_clips`

Persisted AI-identified viral moments per video with multi-dimensional scoring, monetization tiering, assembled-narrative segments, and auto-render state — the unit brands browse to request placements (brand_placement_assignments.editorial_clip_id).

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** HIGH: the exposure unit brands buy against; surface_score/brand_match_score/monetization_tier encode expected placement value (selection covariates); surfaces jsonb carries the fixtures visible in the clip

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Clip ID |
| `video_id` | integer notNull FK video_index.id | Source video |
| `user_id` | integer notNull | User (integer) |
| `clip_start` | real notNull | Start (source seconds) |
| `clip_end` | real notNull | End |
| `duration` | real notNull | Duration (= sum of beats when segments set) |
| `editorial_score` | real | Editorial quality score |
| `surface_score` | real | Surface/monetizability score |
| `brand_match_score` | real | Brand-match score |
| `final_score` | real | Combined score |
| `monetization_tier` | varchar(20) | premium, standard, organic |
| `scores` | jsonb | Score rubric |
| `scores.hookStrength` | jsonb: number | Hook strength |
| `scores.narrativeCompleteness` | jsonb: number | Narrative completeness |
| `scores.emotionalArc` | jsonb: number | Emotional arc |
| `scores.speakerClarity` | jsonb: number | Speaker clarity |
| `scores.surfaceCompatibility` | jsonb: number | Surface compatibility |
| `scores.culturalRelevance` | jsonb: number | Cultural relevance |
| `scores.replayability` | jsonb: number | Replayability |
| `surfaces` | jsonb (untyped) | Surfaces visible in the clip |
| `brand_matches` | jsonb (untyped) | Brand match candidates |
| `edit_points` | jsonb: {start, end, adjustments[]} | Edit adjustments |
| `segments` | jsonb: {start, end, role?}[] | Assembled-narrative beats (hook→body→payoff) in NARRATIVE order; null for single-range clips; times are source-video seconds |
| `suggested_title` | varchar(300) | Suggested title |
| `topic_tags` | jsonb: string[] | Topic tags |
| `reasoning` | text | Model reasoning |
| `raw_clip_start` | real | Pre-adjustment start |
| `raw_clip_end` | real | Pre-adjustment end |
| `export_path` | varchar(500) | Object Storage URL for rendered MP4 |
| `thumbnail_path` | varchar(500) | Object Storage URL for thumbnail JPG |
| `aspect_ratio` | varchar(10) | e.g. '9:16', '16:9', '1:1' |
| `render_status` | varchar(20) default 'pending' | pending, rendering, rendered, failed |
| `render_error` | text | Render error |
| `rendered_at` | timestamp | Rendered at |
| `quality_score` | real | Post-render quality rubric score 0-1 (comment notes a prior commit wrote this key before the column existed; drizzle silently dropped it) |
| `created_at` | timestamp defaultNow | Created |

#### `distribution_profiles`

Phase 3 distribution: connected social accounts (with OAuth tokens) used for publishing clips.

- **Provenance:** **Platform-derived** — mirrors YouTube/Meta data; subject to platform ToS & retention
- **CV-research relevance:** Identifies WHICH channel delivered the exposure (channel-level covariate)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Profile ID |
| `user_id` | integer notNull | User (integer; dual-ID handled via stableUserId.ts) |
| `platform` | varchar(30) notNull | tiktok, instagram, youtube, twitter, linkedin |
| `account_name` | varchar(200) | Account name |
| `account_id` | varchar(200) | Platform account id |
| `access_token` | text | OAuth access token |
| `refresh_token` | text | OAuth refresh token |
| `token_expires_at` | timestamp | Token expiry |
| `is_active` | boolean default true | Active flag |
| `metadata` | jsonb: Record<string,any> | Platform extras |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `published_posts`

Record of clips published (or scheduled) to platforms — the exposure event linking a generated clip to a platform post id/URL.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** HIGH: the exposure-event table — joins clip (and its productPlacements) to the platform post that audiences actually saw; timestamps define the exposure window

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Post ID |
| `clip_id` | integer notNull FK generated_clips.id | Published clip |
| `video_id` | integer notNull FK video_index.id | Source video |
| `profile_id` | integer FK distribution_profiles.id | Publishing profile |
| `platform` | varchar(30) notNull | Platform |
| `platform_post_id` | varchar(200) | Platform's post id |
| `post_url` | varchar(500) | Post URL |
| `caption` | text | Caption |
| `hashtags` | jsonb: string[] | Hashtags |
| `scheduled_for` | timestamp | Scheduled time |
| `published_at` | timestamp | Actual publish time |
| `status` | varchar(30) default 'draft' | draft, scheduled, publishing, published, failed |
| `error_message` | text | Error |
| `created_at` | timestamp defaultNow | Created |

#### `publishing_schedules`

User-scheduled publishing of clips to a profile/platform at a set time.

- **Provenance:** **First-party (user input)** — FullScale IP, user-contributed
- **CV-research relevance:** Exposure-timing covariate (when the placement-bearing clip went live)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Schedule ID |
| `user_id` | integer notNull | User (integer; stableUserId.ts) |
| `clip_id` | integer notNull FK generated_clips.id | Clip to publish |
| `profile_id` | integer notNull FK distribution_profiles.id | Target profile |
| `platform` | varchar(30) notNull | Platform |
| `scheduled_for` | timestamp notNull | Scheduled time |
| `caption` | text | Caption |
| `hashtags` | jsonb: string[] | Hashtags |
| `status` | varchar(30) default 'pending' | pending, processing, completed, failed, cancelled |
| `post_id` | integer | Resulting published_posts.id |
| `error_message` | text | Error |
| `created_at` | timestamp defaultNow | Created |

### Audience & Outcomes

#### `youtube_connections`

Stores OAuth tokens for YouTube API access plus channel identity and headline stats; one row per user (user_id unique).

- **Provenance:** **Platform-derived** — mirrors YouTube/Meta data; subject to platform ToS & retention
- **CV-research relevance:** subscriber_count/total_view_count are channel-level audience-size covariates

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `user_id` | varchar notNull unique | Links to the Replit Auth user |
| `access_token` | text notNull | YouTube OAuth access token |
| `refresh_token` | text | OAuth refresh token |
| `expires_at` | timestamp | Token expiry |
| `channel_id` | text | YouTube channel ID |
| `channel_title` | text | Channel title |
| `subscriber_count` | integer | YouTube channel subscriber count |
| `total_view_count` | integer | YouTube channel total view count |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `social_accounts`

Multi-account creator identity — replaces single-account-per-platform fields on users. One user can hold multiple (platform, accountType, platformAccountId) accounts; audience_data caches latest platform demographics/engagement. See docs/adr/001-multi-account-creator-profile.md.

- **Provenance:** **Platform-derived** — mirrors YouTube/Meta data; subject to platform ToS & retention
- **CV-research relevance:** audience_data demographics are the audience-composition covariates for any impact analysis; followers/totalViews are reach denominators

| Column | Type | Definition |
|---|---|---|
| `id` | uuid PK defaultRandom | Account row ID |
| `user_id` | varchar notNull | Owning user; indexed |
| `platform` | varchar notNull | 'instagram' \| 'facebook' \| 'youtube' \| 'twitch' |
| `account_type` | varchar notNull | 'business' \| 'personal' |
| `platform_account_id` | varchar notNull | FB page id / IG biz id / YT channel id; unique with (userId, platform, accountType) |
| `handle` | varchar | @username, page name, channel name |
| `display_name` | varchar | Display name |
| `avatar_url` | text | Avatar URL |
| `bio` | text | Platform-provided bio (input for AI synthesis) |
| `followers` | integer | Follower count |
| `total_views` | bigint (number mode) | YT channel total views; null elsewhere |
| `access_token` | text | OAuth access token (encrypted) |
| `refresh_token` | text | OAuth refresh token (encrypted, nullable — FB doesn't refresh) |
| `token_expires_at` | timestamp | Token expiry |
| `scopes` | text[] | Granted OAuth scopes |
| `audience_data` | jsonb | Latest demographics + engagement pulled from the platform |
| `audience_data.age_distribution` | jsonb: Record<ageBucket,fraction> | e.g. {"18-24": 0.32} |
| `audience_data.gender_distribution` | jsonb: Record<gender,fraction> | male/female/other fractions |
| `audience_data.top_countries[]` | jsonb: {code, percent}[] | Top audience countries |
| `audience_data.top_cities[]` | jsonb: {name, percent}[] | Top audience cities |
| `audience_data.engagement` | jsonb: {reach, total_interactions, follower_count} | Engagement rollup |
| `audience_data.raw` | jsonb | Raw platform payload |
| `audience_synced_at` | timestamp | When audience_data was last pulled |
| `metadata` | jsonb | Platform-specific extras |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `social_insight_snapshots`

FullScale's own longitudinal record of IG/FB account insights, appended by a snapshot job — exists because Meta retains account-level IG insights only ~90 days (stories 24h).

- **Provenance:** **Platform-derived** — mirrors YouTube/Meta data; subject to platform ToS & retention
- **CV-research relevance:** The audience PANEL over time: follower counts + demographics + story insights per account per capture — baseline/denominator series for before/after placement analysis

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Snapshot ID |
| `social_account_id` | uuid | FK to social_accounts.id (nullable: account may be deleted later); indexed with captured_at |
| `user_id` | varchar notNull | Owning user |
| `platform` | varchar(20) notNull | 'instagram' \| 'facebook' |
| `platform_account_id` | varchar notNull | Platform account id; indexed with captured_at |
| `followers` | integer | Follower count at capture |
| `metrics` | jsonb | Account-level insight values for the window (untyped) |
| `demographics` | jsonb | Follower/engaged-audience breakdowns (untyped) |
| `stories` | jsonb | Live-story insights captured this cycle (24h window) |
| `captured_at` | timestamp defaultNow | Snapshot time |

#### `clip_feedback`

Creator/brand approval + post-publish performance tracking per generated clip (feedback_type distinguishes human ratings from performance rows; comment says performance is 'collected by analyticsCollector' but only storage.ts references the table today).

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** OUTCOME table at clip level: views, engagement_rate, completion_rate, click_through_rate on clips that carry placements; also the human approval record (selection into publication)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Feedback ID |
| `generated_clip_id` | integer notNull FK generated_clips.id | Clip |
| `feedback_type` | varchar(20) notNull | 'creator', 'brand', 'performance' |
| `approved` | boolean | Approval verdict (human rows) |
| `rating` | integer | 1-5 |
| `rejection_reason` | varchar(200) | Why rejected |
| `views` | integer | Post-publish views |
| `engagement_rate` | real | Engagement rate |
| `share_count` | integer | Shares |
| `completion_rate` | real | % of viewers who watched to end |
| `click_through_rate` | real | % who clicked product link |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp | Updated |

#### `clip_analytics`

Per-post platform performance metrics fetched after publish (written from routes.ts) — views, engagement, watch time, demographics.

- **Provenance:** **Platform-derived** — mirrors YouTube/Meta data; subject to platform ToS & retention
- **CV-research relevance:** THE primary OUTCOME table: audience response metrics per published post; joined back to fixture+product via post → clip → productPlacements. fetched_at supports time-series pulls; demographics_data gives audience composition of the response.

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `post_id` | integer notNull FK published_posts.id | Post measured |
| `clip_id` | integer notNull FK generated_clips.id | Clip measured |
| `platform` | varchar(30) notNull | Platform |
| `views` | integer default 0 | Views |
| `likes` | integer default 0 | Likes |
| `comments` | integer default 0 | Comments |
| `shares` | integer default 0 | Shares |
| `saves` | integer default 0 | Saves |
| `reach` | integer default 0 | Reach |
| `impressions` | integer default 0 | Impressions |
| `engagement_rate` | real default 0 | Engagement rate |
| `watch_time_seconds` | real default 0 | Watch time |
| `completion_rate` | real default 0 | Completion rate |
| `click_through_rate` | real default 0 | CTR |
| `demographics_data` | jsonb: Record<string,any> | Viewer demographics of the response |
| `fetched_at` | timestamp defaultNow | When fetched from platform |
| `created_at` | timestamp defaultNow | Created |

### Identity, Access & Consent

#### `sessions`

Express/Replit Auth session store (connect-pg-simple style). Comment: mandatory for Replit Auth, don't drop. Pure ops.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP

| Column | Type | Definition |
|---|---|---|
| `sid` | varchar PK | Session ID |
| `sess` | jsonb | Serialized session blob (express-session) |
| `expire` | timestamp | Session expiry; indexed (IDX_session_expire) |

#### `users`

Core account table (Replit Auth mandated). Holds email/password or Google auth, approval gate, and legacy single-account Meta/Twitch OAuth identity + Facebook Page / IG Business data now being superseded by social_accounts.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns
- **CV-research relevance:** Identity anchor joining creators to videos/placements; FB/IG follower counts are audience-size covariates (legacy — prefer social_accounts)

| Column | Type | Definition |
|---|---|---|
| `id` | varchar PK default gen_random_uuid() | User ID (UUID; legacy rows may be email-keyed elsewhere — the dual-ID reality) |
| `email` | varchar unique | Email |
| `password` | varchar | Hashed password for email/password auth |
| `first_name` | varchar | First name |
| `last_name` | varchar | Last name |
| `profile_image_url` | varchar | Avatar (e.g. from Google) |
| `is_approved` | boolean default false | Waitlist by default, admin approves |
| `auth_provider` | varchar default 'email' | 'email' or 'google' |
| `twitch_id` | varchar | Twitch OAuth ID |
| `facebook_id` | varchar | Facebook OAuth ID |
| `instagram_id` | varchar | Instagram OAuth ID |
| `facebook_page_id` | varchar | FB Page id (Graph API) |
| `facebook_page_name` | varchar | FB Page name |
| `facebook_followers` | integer | FB Page follower count (platform-derived) |
| `facebook_access_token` | text | Page access token for future API calls |
| `instagram_business_id` | varchar | IG Business account id (linked via Facebook) |
| `instagram_handle` | varchar | IG handle |
| `instagram_followers` | integer | IG follower count (platform-derived) |
| `onboarding_dismissed_at` | timestamp | First-login onboarding checklist: null = still shown, set = dismissed (server-side so it survives devices/logouts) |
| `profile_submitted_at` | timestamp | Waitlist: creator confirmed Airtable profile form submitted; drives 'application received' state |
| `created_at` | timestamp defaultNow | Row created |
| `updated_at` | timestamp defaultNow | Row updated |

#### `allowed_users`

Email allowlist for the founding cohort (admin-managed approval gate) doubling as the creator marketplace profile record (slug, bio, featured card).

- **Provenance:** **First-party (user input)** — FullScale IP, user-contributed
- **CV-research relevance:** none (cohort/marketplace metadata)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `email` | varchar notNull unique | Allowlisted email |
| `name` | varchar | Name |
| `user_type` | varchar notNull default 'creator' | 'creator' or 'brand' |
| `company_name` | varchar | For brand users |
| `added_at` | timestamp defaultNow | When added |
| `slug` | varchar | Unique URL slug for creator profiles (e.g. 'martin') |
| `is_featured` | boolean default false | Show in marketplace featured section |
| `bio` | text | Creator bio/blurb |
| `headline` | varchar | One-liner (e.g. 'Sports Podcast Host') |
| `podcast_name` | varchar | Podcast title if applicable |
| `podcast_url` | varchar | Podcast link |
| `website_url` | varchar | Personal/company website |
| `card_image_url` | text | Creator-picked image for the Featured Creator card on the brand marketplace; falls back to first video thumbnail then gradient+initials |

### Operational & Supporting

#### `conversations`

Chat conversation headers for the Gemini chat integration (shared/models/chat.ts).

- **Provenance:** **First-party (user input)** — FullScale IP, user-contributed

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Conversation ID |
| `title` | text notNull | Conversation title |
| `created_at` | timestamp default CURRENT_TIMESTAMP | Created |

#### `messages`

Chat messages within a conversation (Gemini integration); cascade-deletes with conversation.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Message ID |
| `conversation_id` | integer notNull FK conversations.id (onDelete cascade) | Parent conversation |
| `role` | text notNull | Message role (user/assistant) |
| `content` | text notNull | Message text |
| `created_at` | timestamp default CURRENT_TIMESTAMP | Created |

#### `oauth_states`

State tokens for OAuth CSRF protection; persisted so they survive server restarts. Pure ops.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP

| Column | Type | Definition |
|---|---|---|
| `state` | varchar PK | CSRF state token |
| `expires_at` | timestamp notNull | Expiry |
| `created_at` | timestamp defaultNow | Created |

#### `surface_keyframes`

Per-frame bounding box positions for motion tracking; preserves the raw bbox before normalization overwrites it, enabling smooth interpolation of placements.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** Supports exposure geometry: fixture position/size over time within a shot (how big/central the fixture was on screen)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Keyframe ID |
| `surface_id` | integer notNull | References detected_surfaces.id (canonical surface) |
| `video_id` | integer notNull | References video_index.id |
| `timestamp` | numeric notNull | Seconds into video |
| `bounding_box_x` | numeric notNull | 0-1 normalized X |
| `bounding_box_y` | numeric notNull | 0-1 normalized Y |
| `bounding_box_width` | numeric notNull | 0-1 normalized width |
| `bounding_box_height` | numeric notNull | 0-1 normalized height |
| `confidence` | numeric notNull | Detection confidence at this frame |
| `created_at` | timestamp defaultNow | Created |

#### `notifications`

In-app notification rows. userId stores the recipient's identity key AS KNOWN AT EMIT TIME (users.id UUID or legacy email — the dual-ID reality); reads expand aliases like the placement inbox does.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** none (ops; types do trace the placement lifecycle events)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Notification ID |
| `user_id` | varchar notNull | Recipient identity key (UUID or legacy email) |
| `type` | varchar(40) notNull | placement_request \| placement_approved \| placement_rejected \| placement_withdrawn \| editorial_ready |
| `title` | varchar(200) notNull | Title |
| `body` | text | Body |
| `link_path` | varchar(300) | In-app route the notification opens |
| `metadata` | jsonb: Record<string,any> | Arbitrary payload |
| `read_at` | timestamp | When read |
| `created_at` | timestamp defaultNow | Created |

#### `data_deletion_requests`

Meta App Review compliance: records Meta's signed Data Deletion Request callbacks (user removed the app on FB/IG); we must delete their data and expose a status page keyed by confirmation code.

- **Provenance:** **Platform-derived** — mirrors YouTube/Meta data; subject to platform ToS & retention
- **CV-research relevance:** Governance-relevant only: deletions truncate longitudinal audience panels; details records what was deleted (tables + row counts)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Request ID |
| `platform` | varchar(20) notNull | 'meta' |
| `platform_user_id` | varchar notNull | App-scoped FB user id from the signed request |
| `confirmation_code` | varchar notNull unique | Code shown on the human-readable status page |
| `status` | varchar(20) notNull default 'completed' | completed \| partial \| failed |
| `details` | jsonb | What was deleted (tables + row counts) |
| `created_at` | timestamp defaultNow | Created |

#### `stitch_plans`

Multi-segment highlight reel plans (OpusClip-style): AI-planned narrative arcs assembled from hook/development/climax/payoff segments, rendered into a generated clip.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** minor — narrative structure of the creative the placement rides in

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Plan ID |
| `video_id` | integer notNull FK video_index.id | Source video |
| `user_id` | integer notNull | User (integer) |
| `status` | varchar(30) default 'draft' | draft, generating, completed, failed |
| `narrative_arc` | text | Planned arc description |
| `suggested_title` | varchar(200) | Suggested title |
| `segments` | jsonb | Planned segments |
| `segments[].start` | jsonb: number | Segment start |
| `segments[].end` | jsonb: number | Segment end |
| `segments[].role` | jsonb: 'hook'|'development'|'climax'|'payoff'|'bridge' | Narrative role |
| `segments[].narrativePurpose` | jsonb: string | Why this segment |
| `segments[].connectionToNext` | jsonb: string? | Bridge to next |
| `segments[].suggestedTransition` | jsonb: 'cut'|'crossfade'|'branded_wipe' | Transition |
| `segments[].enabled` | jsonb: boolean | Included in render |
| `total_duration` | real | Total duration |
| `transition_style` | varchar(30) default 'crossfade' | Default transition |
| `platform_target` | varchar(30) default 'tiktok' | Target platform |
| `output_path` | varchar(500) | Rendered output |
| `thumbnail_path` | varchar(500) | Thumbnail |
| `quality_score` | real | Quality |
| `generated_clip_id` | integer FK generated_clips.id | Resulting clip |
| `error_message` | text | Error |
| `created_at` | timestamp defaultNow | Created |
| `completed_at` | timestamp | Completed |

#### `remix_templates`

Brand-specific formatting templates for remixes (format rules, transitions, caption style). Referenced only from storage.ts.

- **Provenance:** **First-party (user input)** — FullScale IP, user-contributed
- **CV-research relevance:** minor — creative-format covariate if templates vary across placements

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Template ID |
| `user_id` | integer | Owning user (integer) |
| `brand_id` | integer | Owning brand |
| `name` | varchar(200) notNull | Template name |
| `description` | text | Description |
| `format_rules` | jsonb (untyped) | Formatting rules |
| `transition_style` | varchar(50) | Transition style |
| `caption_style` | jsonb (untyped) | Caption styling |
| `created_at` | timestamp defaultNow | Created |

#### `generated_assets`

AI-generated product assets — video clips via Seeddance 2.0 or images — composited against surfaces, with quality gating and manual review flags.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** minor — AI-generated treatment creative variants (surface x product x asset), with quality/approval gates

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Asset ID |
| `video_id` | integer notNull FK video_index.id | Video context |
| `surface_id` | integer FK detected_surfaces.id | Target surface |
| `brand_product_id` | integer FK brand_products.id | Product |
| `asset_type` | varchar(30) | 'video', 'image', 'placeholder' |
| `generation_prompt` | text | Prompt used |
| `asset_path` | varchar(500) | Generated asset path |
| `composite_path` | varchar(500) | Composited output path |
| `seeddance_job_id` | varchar(200) | Seeddance 2.0 job id |
| `video_duration` | real | Seconds |
| `video_aspect_ratio` | varchar(10) | e.g. '16:9', '9:16' |
| `video_resolution` | varchar(10) | e.g. '1080p', '720p' |
| `target_platform` | varchar(30) | e.g. 'tiktok', 'youtube' |
| `quality_score` | real | Quality evaluation |
| `needs_manual_review` | boolean default true | Manual review flag |
| `approved` | boolean default false | Approved flag |
| `created_at` | timestamp defaultNow | Created |

#### `studio_subscriptions`

FullScale Studio (document-to-video product): user's active plan tier + Stripe billing state. One row per user.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP
- **CV-research relevance:** none (separate Studio product)

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `user_id` | varchar notNull unique | References users.id |
| `tier` | varchar notNull default 'free' | 'free' \| 'starter' \| 'pro' \| 'business' |
| `stripe_customer_id` | varchar | Stripe customer |
| `stripe_subscription_id` | varchar | Stripe subscription |
| `current_period_start` | timestamp | Billing period start |
| `current_period_end` | timestamp | Billing period end |
| `status` | varchar notNull default 'active' | 'active' \| 'canceled' \| 'past_due' \| 'trialing' |
| `cancel_at_period_end` | boolean default false | Pending cancellation |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |

#### `studio_usage`

Monthly video-generation metering per Studio user (quota enforcement).

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `user_id` | varchar notNull | References users.id |
| `month` | varchar notNull | YYYY-MM format (e.g. '2026-03') |
| `videos_generated` | integer notNull default 0 | Count this month |
| `videos_limit` | integer notNull default 1 | Derived from tier at time of creation |
| `created_at` | timestamp defaultNow | Created |

#### `studio_voices`

Catalog of available ElevenLabs voices gated by subscription tier.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `voice_id` | varchar notNull unique | ElevenLabs voice ID |
| `name` | varchar notNull | Display name (e.g. 'Rachel') |
| `preview_url` | text | Audio preview sample URL |
| `tier` | varchar notNull default 'free' | Minimum tier required |
| `category` | varchar notNull default 'professional' | 'professional' \| 'casual' \| 'narrator' \| 'character' |
| `gender` | varchar | 'male' \| 'female' \| 'neutral' |
| `accent` | varchar | 'american' \| 'british' \| 'australian' etc. |
| `description` | text | Voice description |
| `is_default` | boolean default false | Default voice for free tier |
| `is_active` | boolean default true | Can be temporarily disabled |
| `created_at` | timestamp defaultNow | Created |

#### `studio_videos`

Generated Studio videos (document-to-video outputs) with the two-stage extract→generate pipeline state.

- **Provenance:** **Mixed** — first-party columns alongside platform-derived columns

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `user_id` | varchar notNull | References users.id |
| `title` | varchar | Auto-derived from document |
| `source_file_name` | varchar | Original uploaded file name |
| `source_file_url` | text | Stored document path |
| `voice_id` | varchar | ElevenLabs voice used |
| `tier` | varchar notNull default 'free' | Tier at time of generation |
| `visual_quality` | varchar default '720p' | '720p' \| '1080p' |
| `visual_mode` | varchar default 'static' | 'static' \| 'ai_generated' |
| `is_watermarked` | boolean default true | Watermark flag |
| `status` | varchar notNull default 'queued' | 'queued' \| 'extracting' \| 'script_ready' \| 'processing' \| 'completed' \| 'failed' \| 'cancelled' |
| `progress` | integer default 0 | 0-100 |
| `output_url` | text | Path to final MP4 |
| `thumbnail_url` | text | Thumbnail |
| `duration_seconds` | real | Duration |
| `scene_count` | integer | Scene count |
| `error_message` | text | Error |
| `script_data` | jsonb | StoryScript JSON from extract stage |
| `work_dir` | text | workDir where slides live (between extract + generate) |
| `deck_intent` | varchar | investor-pitch / sales-deck / team-update / marketing |
| `slide_image_paths` | jsonb: string[] | Paths to rendered slide JPEGs |
| `created_at` | timestamp defaultNow | Created |
| `completed_at` | timestamp | Completed |

#### `studio_jobs`

Studio pipeline job progress tracker. NOTE: defined in schema but no server or client code references it — dormant/unused today.

- **Provenance:** **First-party (CV/pipeline-generated)** — FullScale IP

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Job ID |
| `video_id` | integer | Studio video id |
| `status` | text default 'queued' | queued \| parsing \| extracting \| generating \| adding-voice \| assembling \| complete \| failed |
| `current_stage` | text | Current stage label |
| `progress` | integer default 0 | 0-100 |
| `error_message` | text | Error |
| `started_at` | timestamp | Started |
| `completed_at` | timestamp | Completed |
| `created_at` | timestamp defaultNow | Created |

#### `studio_waitlist`

Studio access waitlist submissions with admin review state.

- **Provenance:** **First-party (user input)** — FullScale IP, user-contributed

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Row ID |
| `user_id` | varchar | User if signed in |
| `name` | varchar notNull | Name |
| `email` | varchar notNull | Email |
| `use_case` | text | Stated use case |
| `status` | varchar notNull default 'pending' | 'pending' \| 'approved' \| 'rejected' |
| `submitted_at` | timestamp defaultNow | Submitted |
| `reviewed_at` | timestamp | Reviewed |
| `reviewed_by` | varchar | Reviewer |

#### `brand_briefs`

Multi-step brand onboarding wizard — one brief per user (userId unique); status flips draft→submitted on final step. Array fields use jsonb to store multi-select chips without a join table; fields nullable to support draft state.

- **Provenance:** **First-party (user input)** — FullScale IP, user-contributed
- **CV-research relevance:** Brand intent priors: target demographics/geographies/interests define the INTENDED audience — comparable against actual response demographics (clip_analytics.demographics_data, social_insight_snapshots) to measure targeting fit

| Column | Type | Definition |
|---|---|---|
| `id` | serial PK | Brief ID |
| `user_id` | varchar notNull unique | Brand user |
| `status` | varchar notNull default 'draft' | 'draft' \| 'submitted' |
| `brand_name` | varchar | Step 1: brand name |
| `website` | varchar | Website |
| `industry` | varchar | Industry |
| `brand_voice` | jsonb: string[] default [] | Brand voice chips |
| `logo_url` | varchar | Logo |
| `placement_types` | jsonb: string[] default [] | Step 2: desired placement types |
| `product_description` | text | Product description |
| `reference_image_urls` | jsonb: string[] default [] | Reference images |
| `flexibility` | varchar | 'exact' \| 'substitutes' \| 'flexible' |
| `target_geographies` | jsonb: string[] default [] | Step 3: target geographies |
| `audience_age_min` | integer default 18 | Target age min |
| `audience_age_max` | integer default 45 | Target age max |
| `audience_interests` | jsonb: string[] default [] | Target interests |
| `languages` | jsonb: string[] default [] | Languages |
| `primary_objective` | varchar | Step 4: 'awareness' \| 'launch' \| 'pmf_test' \| 'conversions' \| 'partnerships' \| 'other' |
| `success_measurement` | text | How success is measured |
| `budget_range` | varchar | 'under_5k' \| '5k_25k' \| '25k_100k' \| '100k_500k' \| '500k_plus' \| 'discuss' |
| `timeline` | varchar | 'one_time' \| '3mo' \| '6mo' \| 'ongoing' \| 'exploring' |
| `content_categories` | jsonb: string[] default [] | Step 5: content categories |
| `specific_creators` | text | Named creators |
| `things_to_avoid` | text | Exclusions |
| `hands_on_level` | varchar | 'hands_off' \| 'selective' \| 'hands_on' |
| `created_at` | timestamp defaultNow | Created |
| `updated_at` | timestamp defaultNow | Updated |
| `submitted_at` | timestamp | When submitted |

---

## 4b. Phase 1 measurement spine (SHIPPED — added after v1.0)

Three tables were added to make the research design queryable in SQL rather than
reconstructable from jsonb. All three are **first-party (CV/pipeline-generated)**.

### `fixture_exposure` — exposure supply (the denominator)

Materialized at scan finalize from the same numbers that feed `scene_inventory`.

| Column | Type | Definition |
|---|---|---|
| `user_id` | varchar | Creator who owns the content |
| `video_id` | integer | `video_index.id` |
| `surface_group_id` | varchar(64) | **FIXTURE identity** — the experimental unit |
| `scene_id` / `scene_label` | integer / varchar | Scene class within the video ("Scene A") |
| `display_label` | varchar(64) | Human fixture name ("Wall 2", "Nightstand 1") |
| `surface_type` | varchar(64) | Canonical surface type |
| `is_model_backed` | boolean | `rm{modelId}-s{idx}` id — **eligible** to persist across episodes (not proof it did) |
| `scene_screen_time_sec` | numeric | ⚠️ **SCENE-grain, replicated onto every fixture in that scene.** See grain warning below |
| `occurrences` | integer | Distinct runs of the scene class |
| `row_count` / `confidence` | integer / numeric | Detection rows backing the fixture; data-quality signals |
| `video_duration_sec` | numeric | Duration at scan time, for screen-time share |
| `scan_at` | timestamp | When this row was written |

> **⚠️ GRAIN WARNING — read before any aggregation.** `scene_screen_time_sec` is a
> *scene-level* quantity attributed to every fixture in that scene (the set-dressing
> model: a surface is on screen whenever its camera setup is). **Summing it across
> fixtures within a video double-counts** — a 10-minute single-scene video with 5
> fixtures sums to 50 minutes. For wall-clock exposure supply, sum over **DISTINCT
> (video_id, scene_id)**. Per-fixture comparison and dose-weighting are valid as-is.

**Other semantics that affect analysis:**
- **Append-only / scan-versioned.** A rescan SUPERSEDES prior rows rather than deleting
  them (`superseded_at` set on the outgoing row, `scan_version` increments). **Dose as of
  a past treatment window IS reconstructible**: the row valid at time *T* is the one where
  `scan_at <= T AND (superseded_at IS NULL OR superseded_at > T)`. Current-state queries
  filter `superseded_at IS NULL`.
- **Quality-gated.** Scans that ran mostly on edge-detection fallback (<70% AI-analyzed
  frames) are skipped rather than overwriting good rows with fallback geometry.
- **Missingness is non-random.** Videos with a degenerate scene index produce no rows,
  and pre-instrumentation scans were never backfilled.

### `fixture_assignments` — treatment windows (and candidate control periods)

Opened when a brand placement is approved; closed on withdrawal, rejection, render
failure, archive, or supersession.

| Column | Type | Definition |
|---|---|---|
| `surface_group_id` | varchar(64) | FIXTURE (experimental unit) |
| `video_id` | integer | Episode — exclusivity is enforced per (fixture × video) |
| `brand_product_id` / `product_name` | integer / varchar | **TREATMENT** |
| `brand_user_id` | varchar | Brand counterparty |
| `placement_id` / `assignment_id` | integer | Traceback to `saved_placements` / `brand_placement_assignments` |
| `started_at` / `ended_at` | timestamp | **DEAL-TIME window**, not audience time (see caveat) |
| `end_reason` | varchar(32) | archived · expired · replaced · withdrawn · render_failed |

**Caveats:**
- **Deal-time ≠ audience-time.** A window opens at approval, but the audience only sees
  the product once the creator posts. For audience-time, join `placement_exposures` on
  `assignment_id` and use its `live_at`.
- **Control periods are EXPLICIT ROWS** (`is_control = true`, `brand_product_id IS NULL`),
  not inferred gaps — opened when a fixture is first observed by instrumentation and
  reopened whenever a treatment window closes. This makes "observed but untreated"
  distinguishable from "not observed at all". Time before instrumentation remains
  **unobserved, not control** (no rows exist for it).
- **Outcomes over control periods are now measurable** via `video_stat_snapshots` (below):
  view velocity during a control window is the counterfactual slope for the treatment
  windows on either side.
- **No expiry sweep yet:** windows do not auto-close at `expiresAt`.

### `placement_exposures` — the exposure event (was the blocking gap)

One row per placement that reached an audience. Written when a creator marks a render
live — suggested from their connected channel's recent uploads, or pasted manually.

| Column | Type | Definition |
|---|---|---|
| `placement_id` | integer | `saved_placements.id` — **unique**, one exposure per placement |
| `assignment_id` | integer | Treatment window that authorized it; **null = organic/untreated** |
| `surface_group_id` / `brand_product_id` | varchar / integer | Fixture and treatment |
| `source_video_id` | integer | The source upload the placement lives on |
| `platform` / `post_url` / `platform_post_id` | varchar / text / varchar | Where it ran; the post id analytics fetchers poll |
| `live_at` | timestamp | Post publish time when resolvable, else record time |
| `source_start_sec` / `source_end_sec` | numeric | ⚠️ **SOURCE-video coordinates**, not post-relative |
| `editorial_clip_id` / `clip_start_sec` | integer / numeric | Set when the post was a clip — Phase 2 must map source→post coordinates through this |
| `link_source` | varchar(24) | creator_confirmed · admin |
| `confirmed_at` | timestamp | When a human vouched for the link |

> **⚠️ COORDINATE WARNING.** `source_start_sec` is measured from the start of the
> original upload. Published assets are frequently **trimmed clips**, so Phase 2
> retention joins must subtract the clip's start offset before aligning to a retention
> curve — otherwise curves point at the wrong seconds. The columns are named for what
> they are so this cannot happen silently.

### `video_stat_snapshots` — per-video audience time series (the outcome side)

Appends, never overwrites. Polled every 6h for videos under measurement (any video
carrying a fixture with a treatment window or a recorded exposure); YouTube today via
the batch-50 `videos.list` call, other platforms when their per-post fetchers are wired.
Kill switch `VIDEO_STAT_SERIES_ENABLED=false`.

| Column | Type | Definition |
|---|---|---|
| `video_id` / `user_id` | integer / varchar | `video_index.id`, owning creator |
| `platform` / `platform_post_id` | varchar | Where it was polled |
| `view_count` / `like_count` / `comment_count` | bigint / integer | Cumulative counts at capture time |
| `raw` | jsonb | Full payload — metrics we don't model yet |
| `captured_at` | timestamp | Sample time (the series axis) |

**Why it exists:** `video_index.view_count` is overwritten on every refresh, so a single
counter cannot distinguish a placement-driven lift from baseline growth. Differencing
consecutive snapshots gives **views/day**, which is comparable across treatment and
control windows on the same fixture.

### `video_retention_curves` — the measurement the study turns on

Daily capture per video under measurement, via YouTube Analytics
(`dimensions=elapsedVideoTimeRatio&metrics=audienceWatchRatio,relativeRetentionPerformance`).
Kill switch `RETENTION_CAPTURE_ENABLED=false`.

| Column | Type | Definition |
|---|---|---|
| `video_id` / `user_id` | integer / varchar | `video_index.id`, owning creator |
| `platform_post_id` | varchar | The post the curve describes |
| `video_duration_sec` | numeric | Duration the ratios normalize against — needed to convert ratio ↔ seconds |
| `curve` | jsonb | `[{ ratio, watchRatio, relativePerformance }]` ordered by ratio (~100 buckets) |
| `start_date` / `end_date` | varchar(10) | Reporting window |
| `captured_at` | timestamp | Capture time |

**Availability caveat:** YouTube only surfaces retention above a reporting threshold, so
new or low-traffic videos return nothing. Absence is "not yet reported", not zero
retention — never impute it.

### `video_demographics` — per-content covariates

Per-video `ageGroup × gender` (channel-level demographics can't tell you whether product
A and product B reached the same people). Same capture cycle, same threshold caveat.
Instagram exposes demographics only at account level — a platform limit, not a gap.

### `placement_renders` — the delivery repository

The creator chooses WHERE a product lives; the FullScale team produces the final
photorealistic render out-of-band. This is where that finished work comes back to them.
One placement can ship several renders — different aspect ratios for different
destinations, and revisions of each.

| Column | Type | Definition |
|---|---|---|
| `placement_id` / `video_id` | integer | What was rendered |
| `creator_user_id` | varchar | Who it's FOR — the content owner, not the uploader |
| `aspect_ratio` | varchar(16) | Cut variant: 16:9 (YouTube), 9:16 (Shorts/TikTok/Reels), 1:1 |
| `version` / `superseded_at` | integer / timestamp | Re-renders supersede rather than overwrite, so delivery history survives |
| `storage_path` | text | Object key — **outside the public prefix**; served only through the ownership-gated download route |
| `delivery_note` | text | Note from the team to the creator ("moved the product to 0:42") |
| `delivered_by_user_id` / `delivered_at` | varchar / timestamp | Which operator delivered it, when |
| `downloaded_at` | timestamp | Creator-side receipt — null means finished work is sitting unclaimed |

**Why it matters to the study:** delivery is the step between "placement chosen" and
"audience exposed." `delivered_at → downloaded_at → placement_exposures.live_at` gives the
fulfilment funnel, and a render delivered but never downloaded is a distinct failure mode
from one downloaded but never posted.

### `creator_events` — the behavior log (append-only)

Everything else in the app records creator decisions as **state**: an approval is a
boolean, a rejection overwrites a type column, a teach is a flag inside a jsonb array.
State answers "what is true now" and cannot answer "what did this creator do, when."
This table is the only place a decision's **time and actor** are kept.

| Column | Type | Definition |
|---|---|---|
| `creator_user_id` | varchar | The CONTENT owner — whose behavior this describes |
| `actor_user_id` / `actor_role` | varchar | Who performed it. Diverges when an admin acts on a creator's behalf; `actor_role='admin'` rows are excluded from creator aggregates |
| `event_type` | varchar(48) | surface_approved · surface_rejected · surface_unapproved · surface_taught · placement_created · placement_archived · placement_went_live · brand_request_approved · brand_request_rejected · video_imported · video_trashed · scan_started |
| `video_id` / `surface_id` / `surface_group_id` / `placement_id` / `assignment_id` / `brand_product_id` | integer / varchar | Sparse — only the relevant ids are set |
| `metadata` | jsonb | Rejection reasons, surface types, `bulk: true` (an "approve all" click is ONE decision, not N), `requestedAt` for response-time math |
| `occurred_at` | timestamp | The decision time |

> **⚠️ COVERAGE STARTS AT SHIP DATE.** The timestamps this replaces were never written,
> so nothing before the log exists is recoverable. A low count for a long-tenured creator
> means "not yet observed", never "not engaged". **Exception:** brand responsiveness is
> fully recoverable from `brand_placement_assignments.createdAt → reviewedAt` and covers
> all history.

**What it answers:** curation selectivity (approve vs reject — a creator who rejects
nothing is rubber-stamping, not curating), teaching intensity (the highest-intent action
in the product), self-directed placement, and whether creators finish the loop by marking
renders live.

### `video_daily_metrics` — per-day audience series

YouTube Analytics `dimensions=day`. **Retroactive to publish date**, so a before/after
comparison around a placement's go-live is computable immediately rather than after weeks
of counter accumulation. Unique on (video_id, day); re-runs update in place.

### `content_comments` — what viewers actually said

Comment text on videos carrying a live placement, classified for `sentiment` and
`mentions_brand`. **`mentions_brand` is the important one** — it separates "the audience
reacted to the integration" from "the audience reacted to the video."
`after_placement_live` is stamped at capture so the pre/post split survives
re-classification.

**Platform reality:** YouTube only. Its comment read needs no scope beyond the granted
`youtube.readonly`. Instagram/Facebook require an App Review permission
(`instagram_manage_comments`), TikTok exposes no comment list to this integration, X
needs a paid tier, and Twitch has no comment concept. Sentiment is classified in batches
of ~40 comments per model call, so cost is negligible.

> **Naming trap:** `video_index.sentiment` is a **CV scene-mood** field from the scanner —
> it is NOT audience sentiment. Audience sentiment lives only in `content_comments`.

### Platform coverage of the outcome side (what each platform can actually tell us)

The measurement spine is platform-agnostic; the *platforms* are not. Live status is at
`GET /api/admin/measurement/platforms` and in the readout.

| Platform | Views | Likes/comments | Retention | Demographics | Requires |
|---|---|---|---|---|---|
| **YouTube** | ✅ | ✅ | ✅ per-second curve | ✅ per-video | Creator's connected channel (already granted) |
| **Twitch** | ✅ VODs + clips | ❌ not exposed | ❌ none | ❌ none | App token only (`TWITCH_CLIENT_ID`/`SECRET`) — **no creator OAuth** |
| **TikTok** | ✅ | ✅ + shares | ❌ none | ❌ account-level only | `video.list` scope + creator reconnect + creator owns the video |
| **X** | ✅ impressions | ✅ + reposts | ❌ none | ❌ none | Creator connected via X OAuth + **paid API tier** |

**Notes that affect analysis:**
- **Retention is YouTube-only and will stay that way** — no other platform exposes a
  per-second curve. Cross-platform comparisons must fall back to view trajectories.
- **Twitch VOD view counts expire with the VOD** (14/60 days by account tier). Clips are
  the durable series; a VOD series that stops is retention policy, not audience decay.
- **TikTok share-link imports (`vm.`/`t.`) can never yield metrics** — those URLs carry no
  numeric video id and we don't persist the resolved redirect. Re-import from the full
  `@user/video/…` URL. The fetcher reports this explicitly rather than skipping silently.
- **Every failure carries a reason.** A platform that can't be read logs *why*
  (missing credentials / no creator OAuth / paid tier / unresolvable id) and writes no
  row. There are no zero-filled rows: absence means unmeasured, never "no audience".

### Joining retention to a placement (the easy thing to get wrong)

`placement_exposures.source_start_sec` is in **source-video** coordinates. Published
assets are often trimmed clips, so:

```
post_relative_sec = source_start_sec - clip_start_sec      -- 0 when the post is the full upload
position_ratio    = post_relative_sec / video_duration_sec  -- from the curve row
watch_at_placement = curve[ bucket where ratio <= position_ratio ]  -- last matching bucket
lift = watch_at_placement.watchRatio - mean(curve.watchRatio)
```

`GET /api/admin/measurement/retention` implements exactly this and returns
`liftVsVideoMean` per exposure — **positive means more viewers than that video's own
average were present at the moment the product was on screen.** That single number is
the closest thing the platform has to a direct answer to the research question.

### Putting it together: the crossover query

`GET /api/admin/measurement/fixture/:groupId` returns exactly this, and is the reference
implementation for the SQL:

1. Read the fixture's periods from `fixture_assignments` (treatment and control, ordered).
2. For each period, resolve the **dose that applied during it** from `fixture_exposure`
   using the as-of predicate above — not today's measurement.
3. For each period, slice `video_stat_snapshots` to the window and compute **views/day**
   between the first and last sample.
4. Compare treated vs control slopes within the same fixture, dose-weighted.

Periods with fewer than two samples are returned with `measurable: false` — a window
shorter than the sampling interval has no slope, and should be excluded rather than
imputed.

**Gap status after Phase 1:** gaps 1, 2 and 6 below are now *partially addressed* —
exposure events, treatment windows and go-live capture exist. **Gap 7 (time-series
collection) and gap 8 (fixture rollup + control baseline) are now CLOSED** for YouTube —
`video_stat_snapshots` appends per-video trajectories and control periods are explicit
rows with measurable outcomes. **Gaps 3 (retention curves) and 4 (per-video demographics) are now CLOSED for
YouTube** — both captured daily through the already-granted `yt-analytics.readonly`
scope. **Gap 5 (click/conversion attribution) is the only fully open gap**, and it is
the one that needs brand-side cooperation (a pixel or postback) for conversions;
first-party click tracking via the `/s/` redirect is buildable without them.

Also now written: the expiry sweep that closes treatment windows whose deal term has
passed (`end_reason = 'expired'`) and returns the fixture to an explicit control period —
previously `expired` was a documented status nothing ever wrote.

---

## 5. Audience metrics collected today

| Metric | Source | Cadence | Lands in | Code evidence |
|---|---|---|---|---|
| IG account insights: views, reach, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, profile_links_taps, follows_and_unfollows (period=day) | Meta Graph API /{ig-id}/insights (instagram_manage_insights) | every 12h background job (first run 3min after boot); per-metric retry on combined-call failure | `social_insight_snapshots.metrics (jsonb)` | `server/lib/socialAnalytics.ts:165-205; server/lib/socialSnapshots.ts:22,41-50; shared/schema.ts:641` |
| IG follower_demographics + engaged_audience_demographics, broken down by age, gender, country, city | Meta Graph API /{ig-id}/insights?metric=follower_demographics|engaged_audience_demographics&breakdown=... (fails soft under 100 followers) | every 12h (snapshot job); also mirrored to the account's live demographics each cycle | `social_insight_snapshots.demographics + social_accounts.audience_data` | `server/lib/socialAnalytics.ts:207-227; server/lib/socialSnapshots.ts:52-54` |
| IG story insights per live story: views, reach, replies, shares, total_interactions, profile_visits | Meta Graph API /{story-id}/insights (stories expire 24h — 12h cadence gives two capture chances) | every 12h | `social_insight_snapshots.stories (jsonb array)` | `server/lib/socialAnalytics.ts:246-271; shared/schema.ts:643` |
| IG per-media insights: views (unified metric replacing impressions/plays), reach, saved, shares, total_interactions, ig_reels_avg_watch_time (ms), ig_reels_video_view_total_time (ms), like_count, comments_count | Meta Graph API /{media-id}/insights + media list | on-demand only — analytics page load (8s-timeout live fetch, 6-12 media) and /api/analytics/refresh; NOT persisted (served in JSON; only follower count written to users.instagramFollowers) | `none (response-only); users.instagram_followers` | `server/lib/socialAnalytics.ts:81-140; server/routes.ts:14128-14138,14735-14762` |
| IG/FB followers, following, media_count; FB fan_count/followers_count | Meta Graph API account/Page node fields | 12h snapshot + on-demand refresh | `social_insight_snapshots.followers; social_accounts.followers; users.instagram_followers / users.facebook_followers` | `server/lib/socialAnalytics.ts:71-78,303-341; server/routes.ts:14740,14779` |
| FB Page insights (post-deprecation survivors): page_media_view, page_total_media_view_unique, page_follows, page_daily_follows_unique, page_daily_unfollows_unique, page_post_engagements, page_total_actions, page_views_total, page_video_views | Meta Graph API /{page-id}/insights (read_insights + ANALYZE-task Page token; fails soft to {}) | every 12h | `social_insight_snapshots.metrics` | `server/lib/socialAnalytics.ts:284-343; server/lib/socialSnapshots.ts:56-69` |
| Audience demographics normalized to standard shape: age_distribution, gender_distribution, top_countries, top_cities (+ engagement: follower_count, reach, total_interactions) | IG follower_demographics (4 single-breakdown calls); FB follower count only (Meta deprecated Page demographics late 2024) | on-demand (/api/social-accounts/:id/refresh-analytics, refresh-all) + daily external cron /api/admin/cron/refresh-audiences (CRON_SECRET-gated, Replit Scheduled Deployment) | `social_accounts.audience_data + audience_synced_at` | `server/lib/audienceFetcher.ts:101-219,327-355; server/routes.ts:2599-2703,2715` |
| YouTube channel audience (90-day window): views, subscribersGained, estimatedMinutesWatched, averageViewDuration, ageGroup×gender viewerPercentage, top-10 countries by views | YouTube Analytics API v2 reports (yt-analytics.readonly) | same on-demand + daily-cron paths as above | `social_accounts.audience_data` | `server/lib/audienceFetcher.ts:229-318` |
| YouTube channel subscriberCount + totalViewCount | YouTube Data API channels.list statistics | at OAuth callback + on-demand GET /api/youtube/refresh-stats | `youtube_connections.subscriber_count / total_view_count; social_accounts.followers / total_views` | `server/routes.ts:2895-2900,3078-3117; shared/schema.ts:22-23,75-76` |
| Per-video YouTube viewCount (likeCount/commentCount fetched too but returned only, never persisted) | YouTube Data API videos.list?part=statistics (batch of 50) | at import; on-demand POST /api/analytics/refresh (updates top-50); on-demand backfill /api/video-index/backfill-viewcounts — value OVERWRITES, no history | `video_index.view_count` | `server/lib/socialAnalytics.ts:364-391; server/routes.ts:14790-14818,3474-3610,4457; server/lib/indexer.ts:274-300` |
| Per-video IG views (canonical `views` metric, legacy plays/video_views fallback) and FB video `views` field | Meta Graph API per-media insights / Page videos edge | at import + on-demand backfill (only rows with viewCount 0) | `video_index.view_count` | `server/lib/platformAuth.ts:94,120,165-201,242,313; server/routes.ts:4536-4572` |
| Derived priorityScore from viewCount + age + evergreen | derived (internal) | at import | `video_index.priority_score` | `server/lib/indexer.ts:169-180,317` |
| Published-clip metrics: views, likes, comments, shares, saves, reach, impressions, watchTimeSeconds (IG reels only), derived engagementRate — per platform: TikTok video/query, YouTube videos.list, IG media insights, Twitter public_metrics | TikTok Open API / YouTube Data API / Meta Graph / Twitter v2 | ON-DEMAND ONLY via POST /api/distribution/analytics/video/:videoId/refresh — the periodic startAnalyticsCollection tick is a stub that only logs and is not started at boot (index.ts starts only the publish scheduler and Meta snapshot job) | `clip_analytics (one row per fetch, keyed post_id/clip_id; completion_rate, click_through_rate always 0; demographics_data never populated)` | `server/lib/distribution/analyticsCollector.ts:49-259,406-419; server/routes.ts:14847-14858; shared/schema.ts:1050-1069; server/index.ts:540-563` |
| Derived aggregate metrics per video: totalViews/Likes/Comments/Shares/Reach, avgEngagementRate, avgCompletionRate, brandExposureMinutes = Σ(clip duration × views)/60, top-5 clips | derived from latest clip_analytics row per post | computed at request time (GET /api/distribution/analytics/video/:videoId), never stored | `none (response-only)` | `server/lib/distribution/analyticsCollector.ts:280-397; server/routes.ts:14835-14844` |
| Publish events: platform, platformPostId, postUrl, publishedAt, status (published/failed/dry_run) — remix-clip path only; generated_clips.productPlacements jsonb carries surfaceId/brandProductId/placementId into the published clip | internal event (POST /api/distribution/publish; scheduler tick every minute) | at-event | `published_posts; generated_clips.published_at/published_platform/published_url (manual URL via storage.publishClip)` | `server/routes.ts:13746-13865,12727; server/lib/distribution/scheduler.ts:261-270,293-318; server/lib/remix/remixOrchestrator.ts:780,1232; server/storage.ts:2069-2080` |
| Share-link page views (includes A1 brand-release pages) — the platform's ONLY first-party audience event | internal event: every public GET /api/share/:slug increments | at-event | `shared_links.view_count` | `server/routes.ts:11149; server/storage.ts:1785-1790; shared/schema.ts:602` |
| Self-reported clip performance: views, engagement_rate, share_count, completion_rate, click_through_rate + creator/brand approval and 1-5 rating | manual POST /api/remix/clips/:clipId/feedback with client-supplied numbers — no automated writer exists despite the schema comment claiming analyticsCollector populates it | on-demand (manual) | `clip_feedback; read back by /api/remix/analytics/rubric-performance` | `shared/schema.ts:712-727; server/routes.ts:12473-12527; server/storage.ts:2663-2678` |
| CV exposure-supply: per scene class occurrences (shot count) + totalSec (Σ shot durations); per canonical fixture screenTimeSec (= its scene's totalSec under the set-dressing model), rowCount, median bbox, confidence, numbered displayLabel | derived at scan finalize from sceneIndex shots × surfaceGroupId-grouped detected_surfaces | at-scan (rebuilt each successful scan; cleared on degenerate index) | `video_index.scene_inventory (jsonb)` | `server/scanner_v2.ts:5707-5891; shared/schema.ts:219-236` |
| Creator-intelligence rollups: videosScanned, sceneClasses, sellableSec (Σ totalSec of scenes with ≥1 surface), canonicalSurfaces, surfacesApproved, placement funnel (brandRequests → placementsApproved → released A1 pages), engagementRatePct = total_interactions/reach from latest Meta snapshot, plus full per-creator drill-down (snapshots series, media tables, placements) | derived (SQL GROUP BY over video_index.scene_inventory, detected_surfaces, brand_placement_assignments, shared_links, social_insight_snapshots) | computed at request time (admin endpoints), never stored | `none (response-only)` | `server/storage.ts:3218-3416; server/routes.ts:14228-14414,14178-14218` |
| Placement pricing signal: placement_fee/platform_take/creator_payout cents + pricing_breakdown audit blob (inputs: follower-count creator tier, monetizationTier, recency, bbox prominence, duration term — ExpectedImpressions × CPM rubric) | derived at placement-request time | at-event | `brand_placement_assignments.placement_fee_cents et al. + pricing_breakdown jsonb` | `server/lib/placementPricing.ts:1-80; shared/schema.ts:443-458` |

### Collectors added since v1.0

| Metric | Source | Cadence | Lands in | Notes |
|---|---|---|---|---|
| Audience retention curve (per-second) | YouTube Analytics `elapsedVideoTimeRatio` | daily | `video_retention_curves.curve` | Only above YouTube's reporting threshold — absence ≠ zero |
| Per-video demographics (age × gender) | YouTube Analytics, video-filtered | daily | `video_demographics` | Same threshold caveat |
| Per-day views/likes/comments/shares | YouTube Analytics `dimensions=day` | daily | `video_daily_metrics` | **Retroactive to publish date** — before/after works immediately |
| Rolling counters (views/likes/comments) | YouTube Data API + platform fetchers | every 6h | `video_stat_snapshots` | Appends, never overwrites |
| Twitch VOD/clip views | Twitch Helix (app token) | every 6h | `video_stat_snapshots` | Views only; VOD counts expire with the VOD |
| TikTok post metrics | TikTok Display API `video/query` | every 6h | `video_stat_snapshots` | Needs `video.list` + creator owns the video |
| X post metrics | X API v2 `public_metrics` | every 6h | `video_stat_snapshots` | Needs creator OAuth + paid API tier |
| Comment text + sentiment + brand mention | YouTube `commentThreads` + LLM classification | daily | `content_comments` | Only for videos carrying a live placement |
| Creator behavior events | First-party (in-app actions) | at-event | `creator_events` | Coverage starts 2026-08-04; not retroactive |
| Brand response latency | Derived from existing timestamps | on read | computed | Covers **all** history, no log needed |


---

## 6. Gaps: what impact measurement needs that does not exist yet

These are the eight gaps identified in the original v1.0 audit, kept here with their original
analysis for traceability. **Each now carries a current status line** — five are closed, one is
mostly closed, one is open, and the statuses reflect what shipped between v1.0 and v1.2.

### Gap 1: Per-placement exposure record in published content: nothing links a brand_placement_assignment (or saved_placement) to a live post with metrics. The brand-approval path ends at an A1 shared_links release page (view counter only); brand placements ride editorial_clips, which have NO analytics fields and never enter published_posts/clip_analytics. The placement→post linkage that does exist (generated_clips.productPlacements jsonb) covers only the legacy remix path.

> ✅ **CLOSED** — `placement_exposures` records every placement that reached an audience, joined to its treatment window via `assignment_id`.

**Why it matters:** Without an exposure record, no audience metric can be attributed to a treatment — the study cannot even enumerate which audience saw which product. This is the single blocking gap.

**What building it takes:** Add a placement_exposures table (placement_id, surface_group_id, published_post_id or post_url, platform, live_from/live_to, in-content timestamp span from detected_surfaces). Hook it where the A1 link is minted at brand_approved (routes.ts release-mint path) and where published_posts rows are created; brand_placement_assignments already carries durationTerm/expiresAt as the intended-window scaffold.

### Gap 2: Treatment on-air windows / variant assignment: the fixture (surfaceGroupId — stable across rescans and episodes for room-model surfaces, exactly the experimental-unit id the study needs) and the treatment (productId on saved_placements, brandProductId on assignments, appliesToGroupIds scoping) are both recorded, but nothing records WHICH product occupied the fixture during which real-world period, and there is no versioned render registry or control (no-placement) condition.

> ✅ **CLOSED** — `fixture_assignments` records which product occupied which fixture over which period, with explicit control rows for untreated periods.

**Why it matters:** Same-scene/different-products is a within-fixture crossover design; without assignment periods you cannot align outcomes to treatments or define baseline periods.

**What building it takes:** Small delta on existing identity work: an assignment-period table keyed on surfaceGroupId (fixture) × brandProductId (treatment) × date range, written at brand approval and at placement archive/expiry. rm{modelId}-s{idx} ids are already documented as identical across rescans/episodes (shared/schema.ts:283-292), so cross-episode fixtures work unchanged.

### Gap 3: Time-coded engagement / audience-retention curves: no integration requests retention. The YouTube Analytics calls fetch only channel totals, demographics and countries — grep confirms zero occurrences of audienceWatchRatio / elapsedVideoTimeRatio / relativeRetentionPerformance anywhere in server code. IG yields only scalar avg/total watch time per media.

> ✅ **CLOSED** (YouTube) — `video_retention_curves` captures per-second retention daily; `/api/admin/measurement/retention` positions each placement on its curve. No other platform exposes retention — a permanent limit, not a backlog item.

**Why it matters:** The core CV-impact question — do viewers drop, linger, or rewind at the seconds where the placed product is on screen — is unanswerable without a per-video retention curve to join against placement timestamps.

**What building it takes:** The yt-analytics.readonly scope already requested (audienceFetcher.ts uses it) is sufficient. Add a fetcher for reports?dimensions=elapsedVideoTimeRatio&metrics=audienceWatchRatio,relativeRetentionPerformance&filters=video==ID, store curves per videoId (new table or jsonb), and join against detected_surfaces.timestamp / scene_inventory shot spans, which are already time-coded to the second.

### Gap 4: Per-content viewer demographics: demographics exist only at account level (IG follower_demographics; YouTube channel ageGroup×gender). clip_analytics.demographics_data exists as a column but no code ever writes it; no fetcher requests video-filtered demographics.

> ✅ **CLOSED** (YouTube) — `video_demographics` captures per-video ageGroup × gender. Instagram exposes demographics only at account level (platform limit).

**Why it matters:** Comparing product A vs product B in the same fixture across different videos/periods is confounded if the audiences differed; per-exposure demographics are the covariates the Deloitte design needs.

**What building it takes:** YouTube Analytics supports filters=video==ID on the ageGroup×gender report — extend fetchYoutubeAudience with a per-video variant and write into the already-existing clip_analytics.demographics_data. IG offers engaged_audience_demographics only at account level (platform limit — document as a design constraint, not a build item).

### Gap 5: Click/conversion attribution: click_through_rate columns (clip_analytics, clip_feedback) are hard-coded 0 or manually self-reported. No UTM generation, no tracked outbound product links, no pixel/postback. The /s/ release page counts page views but has no click-out tracking on anything.

> 🔴 **OPEN — the only fully open gap** — First-party click tracking via the `/s/` redirect is buildable without external dependencies; *conversions* need brand-side pixels or postbacks, which is a partnership decision rather than an engineering one.

**Why it matters:** Placement impact beyond attention (purchase intent, traffic) is the metric brands ultimately pay against; today there is no path from a placement to a click, let alone a conversion.

**What building it takes:** The shared_links slug machinery is a natural base: add a redirect route (/s/:slug/go?placement=N) recording placement_id + destination + timestamp, and generate UTM-tagged product URLs at brand approval. Zero new external integrations for click counting; conversions would need a brand-side pixel or postback later.

### Gap 6: Publish-event tracking for the real distribution path: the honest flow (human-reviewed final render → creator downloads / A1 page → creator posts natively) produces no 'went live on platform X at time T' event. published_posts covers only in-app API publishing; generated_clips.publishClip requires manually pasting a URL; brand_placement_assignments has no post-URL field at all.

> ✅ **CLOSED** — The go-live step on the review lifecycle captures platform + post URL + publish time, with candidates auto-suggested from the creator's connected channel. `placement_renders` adds the delivery half (`delivered_at → downloaded_at → live_at`).

**Why it matters:** Every downstream measurement (retention, per-post metrics, exposure windows) hangs off a platformPostId; if the live post is never registered, the existing PLATFORM_FETCHERS have nothing to poll.

**What building it takes:** Add a 'mark live' step to the existing placement review lifecycle (reviewStatus render_ready → live) capturing postUrl/platform/liveAt on brand_placement_assignments, then feed the resolved platformPostId into collectPostAnalytics — the per-platform fetchers already exist and need only an id.

### Gap 7: Automated time-series collection: clip_analytics accumulates rows only on manual refresh; the periodic collector (startAnalyticsCollection) is a logging stub and is not even started at boot; YouTube/IG per-video view counts OVERWRITE video_index.view_count with no history; the longitudinal snapshot job covers Meta account-level only (no YouTube snapshots, no per-post snapshots).

> ✅ **CLOSED** (YouTube) — `video_stat_snapshots` appends every 6h and `video_daily_metrics` back-fills a per-day series retroactive to publish date. Twitch/TikTok/X have per-post fetchers with honest unavailability reasons — see the platform coverage matrix above.

**Why it matters:** Causal comparison needs pre/post trajectories and view velocity around placement go-live, not point-in-time totals — a single overwritten counter cannot distinguish a placement-driven lift from baseline growth.

**What building it takes:** Wire collectVideoAnalytics for all published/live posts into a real interval (the analyticsCollector stub and the 1-minute distribution scheduler both already exist as patterns), and extend runSocialInsightSnapshots to append per-video stat rows (fetchYouTubeVideoStats is already batch-50) instead of overwriting video_index.view_count.

### Gap 8: Cross-episode fixture exposure rollup + control baseline: scene_inventory occurrences/screenTimeSec live per video in jsonb; no table aggregates a fixture's cumulative screen time and audience across episodes, and no metric captures audience response for the same scene when NO product was placed (control condition).

> 🟡 **MOSTLY CLOSED** — `fixture_exposure` materializes per-fixture supply (scan-versioned, so dose-as-of-a-past-window is reconstructible) and control periods are explicit rows. Remaining: control-period *outcomes* depend on continued per-day collection accumulating history.

**Why it matters:** The fixture is the experimental unit; its denominator (total exposed screen-time × views across all content) and its no-treatment baseline are what every effect estimate divides by.

**What building it takes:** Materialize a fixture_exposure table (surface_group_id × video_id × screenTimeSec × occurrences) at scan finalize — the exact numbers are already computed in scanner_v2.ts:5728-5778 before being folded into jsonb; join with video_index.view_count (and, once gap 7 lands, view history) for the denominator. Control periods fall out of gap 2's assignment-period table (fixture time not covered by any assignment).

---

## 7. Standing data-quality notes for the analysis team

1. **Dual-ID wrinkle:** most tables key users by varchar UUID (`users.id`), but several
   outcome-adjacent tables (`clip_analytics`, `published_posts`, `distribution_profiles`,
   `publishing_schedules`) use integer user ids — joins go through `server/lib/stableUserId.ts`.
   Budget for this in any ETL.
2. **Outcome granularity:** audience outcomes are keyed at clip/post level. The fixture→outcome
   join today goes through `generated_clips.productPlacements` / `editorial_clips` jsonb — closing
   this at placement granularity is Gap #1 territory.
3. **Meta retention:** the Graph API retains ~90 days of insights; `social_insight_snapshots`
   exists precisely to accumulate history. Treat snapshot start-date as the series origin.
4. **Non-random assignment:** repeated for emphasis — `brand_match_scores` and
   `scene_analysis.placement_viability` decide which products land on which fixtures. They are
   confounders and must ride along in every model.
5. **Human review stage:** `saved_placements.review_status` records the human-in-the-loop step
   (submitted → in_review → render_ready | needs_changes). Only render-ready placements should be
   treated as shippable treatments.
