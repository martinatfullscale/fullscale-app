/**
 * The edit stack — everything a creator can do to a clip beyond trim and
 * captions, compiled into one ffmpeg filtergraph.
 *
 * WHY ONE MODULE. All seven of these features touch the SAME ffmpeg command,
 * and the order they compose in is the whole problem. Stabilization has to
 * run on source geometry before any crop; retiming has to happen before
 * overlays or the overlays drift; text has to land after the crop or its
 * coordinates are wrong; the audio chain has to be retimed identically to the
 * video or the clip desyncs. Spread across seven call sites that ordering
 * would be re-derived seven times and get it wrong at least once.
 *
 * THE CHAIN, source → output:
 *
 *   [0:v] stabilize ─► retime(segments) ─► b-roll ─► product overlays
 *          ─► crop/scale ─► text ─► captions ─► [vout]
 *   [0:a] retime(segments) ─► duck(under speech) ─► mix(music bed) ─► [aout]
 *
 * RETIMING IS THE HARD PART. Silence removal and speed ramps are the same
 * operation — a list of source segments, each played at a rate — so they are
 * compiled together into one trim/atrim + setpts/atempo + concat pass. Doing
 * them as separate filters would apply two independent time warps to video
 * and audio and drift them apart; a single segment list keeps them locked by
 * construction.
 *
 * DEGRADING. Every optional filter is capability-checked. A build without
 * libvidstab still stabilizes (deshake), a build without sidechaincompress
 * still plays a music bed (fixed attenuation), and anything genuinely
 * impossible is reported in `warnings` so the UI can say why instead of the
 * render dying at 90% with "No such filter".
 */

import { getFfmpegCapabilities } from "./ffmpegCapabilities";

// ── The model ───────────────────────────────────────────────────────────

export interface SpeedRamp {
  /** Clip-relative seconds. */
  start: number;
  end: number;
  /** 0.25–4. >1 is faster. */
  rate: number;
}

export interface TextOverlay {
  start: number;
  end: number;
  text: string;
  /** 0-1 of the OUTPUT frame (after crop), from top-left. */
  x: number;
  y: number;
  /** Fraction of output height for the cap height. 0.02–0.25. */
  size: number;
  color: string;          // #RRGGBB
  background: string | null; // #RRGGBB or null for no plate
  weight: "regular" | "bold";
  align: "left" | "center" | "right";
}

export interface BrollCut {
  start: number;
  end: number;
  /** media_assets.id — a video or image the creator uploaded. */
  assetId: number;
  /** Resolved by the caller before the graph is built. */
  localPath?: string;
  kind?: "video" | "image";
  /** cover fills the frame and crops; contain letterboxes. */
  fit: "cover" | "contain";
  /** 0-1. 1 = full frame takeover; smaller = picture-in-picture. */
  scale: number;
  /** PiP position, 0-1 of the output frame. Ignored at scale 1. */
  x: number;
  y: number;
  /** Mute the b-roll's own audio (almost always what you want). */
  muted: boolean;
}

export interface MusicBed {
  assetId: number;
  localPath?: string;
  /** 0-1 bed level before ducking. */
  volume: number;
  /** Pull the bed down under speech. */
  ducking: boolean;
  /** How far down, in dB, at full duck. 6–24. */
  duckAmountDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface Stabilization {
  enabled: boolean;
  /** 1 (light) – 10 (aggressive). Maps to vidstab smoothing / deshake radius. */
  strength: number;
}

export interface SilenceCut {
  enabled: boolean;
  /** dBFS below which audio counts as silence. -50 to -20. */
  thresholdDb: number;
  /** Only cut gaps longer than this. */
  minDurationSec: number;
  /** Leave this much of the gap on each side so cuts don't clip breaths. */
  paddingSec: number;
  /** Filled by the analysis pass — clip-relative silent spans. */
  detected?: Array<{ start: number; end: number }>;
}

export interface EditStack {
  stabilization?: Stabilization | null;
  silenceCut?: SilenceCut | null;
  speedRamps?: SpeedRamp[] | null;
  broll?: BrollCut[] | null;
  textOverlays?: TextOverlay[] | null;
  music?: MusicBed | null;
}

/** A source span played at a rate — the compiled form of silence + speed. */
export interface TimelineSegment {
  srcStart: number;
  srcEnd: number;
  rate: number;
}

// ── Compiling silence + speed into one segment list ──────────────────────

const EPS = 0.02; // 20ms — below this a segment isn't worth a concat leg

/**
 * Turn "cut these silences" + "play these ranges at this rate" into an
 * ordered list of source spans with a playback rate each.
 *
 * Both features are time warps over the same axis, so they MUST be resolved
 * together. Applying them as separate filter passes is what desyncs audio
 * from video: each pass computes its own PTS mapping and the second one is
 * working from timestamps the first already moved.
 */
export function compileTimeline(
  clipDurationSec: number,
  silence: SilenceCut | null | undefined,
  ramps: SpeedRamp[] | null | undefined,
): { segments: TimelineSegment[]; outputDurationSec: number; removedSec: number } {
  const duration = Math.max(0, Number(clipDurationSec) || 0);
  if (duration <= 0) return { segments: [], outputDurationSec: 0, removedSec: 0 };

  // 1. Keep-spans = the clip minus the padded silent spans.
  let keeps: Array<{ start: number; end: number }> = [{ start: 0, end: duration }];
  let removedSec = 0;

  if (silence?.enabled && silence.detected?.length) {
    const pad = Math.max(0, Number(silence.paddingSec) || 0);
    const cuts = silence.detected
      .map((s) => ({
        start: Math.max(0, Number(s.start) + pad),
        end: Math.min(duration, Number(s.end) - pad),
      }))
      .filter((s) => s.end - s.start > EPS)
      .sort((a, b) => a.start - b.start);

    const next: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const cut of cuts) {
      if (cut.start > cursor + EPS) next.push({ start: cursor, end: cut.start });
      removedSec += Math.max(0, Math.min(duration, cut.end) - Math.max(cursor, cut.start));
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < duration - EPS) next.push({ start: cursor, end: duration });
    if (next.length > 0) keeps = next;
  }

  // 2. Split each keep-span wherever a speed ramp starts or ends, so every
  //    resulting segment has exactly one rate.
  const validRamps = (ramps ?? [])
    .map((r) => ({
      start: Math.max(0, Number(r.start) || 0),
      end: Math.min(duration, Number(r.end) || 0),
      rate: Math.min(4, Math.max(0.25, Number(r.rate) || 1)),
    }))
    .filter((r) => r.end - r.start > EPS && Math.abs(r.rate - 1) > 0.01)
    .sort((a, b) => a.start - b.start);

  const rateAt = (t: number): number => {
    for (const r of validRamps) if (t >= r.start && t < r.end) return r.rate;
    return 1;
  };

  const segments: TimelineSegment[] = [];
  for (const keep of keeps) {
    const bounds = new Set<number>([keep.start, keep.end]);
    for (const r of validRamps) {
      if (r.start > keep.start && r.start < keep.end) bounds.add(r.start);
      if (r.end > keep.start && r.end < keep.end) bounds.add(r.end);
    }
    const ordered = Array.from(bounds).sort((a, b) => a - b);
    for (let i = 0; i < ordered.length - 1; i++) {
      const s = ordered[i];
      const e = ordered[i + 1];
      if (e - s <= EPS) continue;
      segments.push({ srcStart: s, srcEnd: e, rate: rateAt(s + EPS) });
    }
  }

  const outputDurationSec = segments.reduce((acc, s) => acc + (s.srcEnd - s.srcStart) / s.rate, 0);
  return { segments, outputDurationSec, removedSec };
}

/** Does this segment list actually change anything? */
export function timelineIsIdentity(segments: TimelineSegment[], clipDurationSec: number): boolean {
  if (segments.length !== 1) return false;
  const s = segments[0];
  return (
    Math.abs(s.rate - 1) < 0.01 &&
    s.srcStart < EPS &&
    Math.abs(s.srcEnd - clipDurationSec) < EPS
  );
}

/**
 * atempo is only defined for 0.5–2.0, so a rate outside that has to be
 * expressed as a chain of stages whose product is the target rate.
 */
export function atempoChain(rate: number): string[] {
  const stages: number[] = [];
  let remaining = Math.min(4, Math.max(0.25, rate));
  while (remaining > 2.0 + 1e-6) { stages.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5 - 1e-6) { stages.push(0.5); remaining /= 0.5; }
  stages.push(Number(remaining.toFixed(6)));
  return stages.map((r) => `atempo=${r}`);
}

// ── Graph construction ──────────────────────────────────────────────────

export interface EditGraphInput {
  /** Extra `-i` arguments, in the order their indices are referenced. */
  path: string;
  /** Still images need -loop so they last the overlay's duration. */
  loop?: boolean;
}

export interface EditGraphResult {
  /** Additional inputs beyond the source video (index 1, 2, …). */
  extraInputs: EditGraphInput[];
  /** Filter nodes to prepend to the video chain, ending at `videoOutLabel`. */
  videoPre: string[];
  /** Filter nodes for text, applied AFTER the crop/scale chain. */
  videoPost: (inLabel: string, outLabel: string) => string[];
  /** Audio chain nodes ending at `[aout]`, or null to pass audio through. */
  audio: string[] | null;
  audioOutLabel: string | null;
  /** Where the pre-chain ends — feed this into the existing overlay/crop code. */
  videoOutLabel: string;
  /** Output duration after retiming; drives `-t`. */
  outputDurationSec: number;
  /** Things asked for that this ffmpeg build could not do, in plain words. */
  warnings: string[];
  /** True when nothing in the stack applies — caller can take the old path. */
  isEmpty: boolean;
}

const hex = (h: string | null | undefined, fallback = "000000"): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? "").trim());
  return m ? m[1].toLowerCase() : fallback;
};

/**
 * Compile an edit stack into filtergraph fragments.
 *
 * `sourceIndex` is the ffmpeg input index of the main video (always 0 today);
 * `nextInputIndex` is the first free index — the caller owns indices for its
 * own product-overlay images and tells us where ours may start.
 */
export async function buildEditGraph(opts: {
  stack: EditStack;
  clipDurationSec: number;
  outWidth: number;
  outHeight: number;
  nextInputIndex: number;
  /** Rasterized text PNGs, one per overlay, produced by textOverlay.ts. */
  textImages?: Array<{ path: string; w: number; h: number; overlay: TextOverlay }>;
  /** Path to the vidstab transform file when a detect pass already ran. */
  vidstabTransformsPath?: string | null;
  /** False when the source has no audio stream — a graph naming [0:a] on a
   *  silent video fails the whole render with "Stream specifier matches no
   *  streams". Retime then runs video-only; a music bed becomes the output
   *  audio outright. */
  hasAudio?: boolean;
}): Promise<EditGraphResult> {
  const caps = await getFfmpegCapabilities();
  const { stack, clipDurationSec, outWidth, outHeight } = opts;
  const warnings: string[] = [];
  const extraInputs: EditGraphInput[] = [];
  const videoPre: string[] = [];
  let inputIdx = opts.nextInputIndex;
  let label = "[0:v]";
  let n = 0;
  const nextLabel = () => `[e${n++}]`;

  // ── 1. Stabilization (source geometry, before anything crops) ──────
  const stab = stack.stabilization;
  if (stab?.enabled) {
    const strength = Math.min(10, Math.max(1, Number(stab.strength) || 5));
    if (caps.vidstab && opts.vidstabTransformsPath) {
      const smoothing = Math.round(5 + strength * 2.5); // 8–30 frames
      const out = nextLabel();
      videoPre.push(
        `${label}vidstabtransform=input='${opts.vidstabTransformsPath.replace(/'/g, "'\\''")}':smoothing=${smoothing}:crop=black:zoom=0${out}`,
      );
      label = out;
    } else if (caps.deshake) {
      // deshake is a weaker single-pass stabilizer, but it is present in
      // stock builds where libvidstab is not. Better than declining.
      const rx = Math.min(64, 8 + strength * 4);
      const out = nextLabel();
      videoPre.push(`${label}deshake=rx=${rx}:ry=${rx}:edge=clamp${out}`);
      label = out;
      if (!caps.vidstab) {
        warnings.push(
          "Stabilized with deshake — this server's ffmpeg lacks libvidstab, which gives a noticeably smoother result.",
        );
      }
    } else {
      warnings.push("Stabilization skipped — this server's ffmpeg has neither vidstab nor deshake.");
    }
  }

  // ── 2. Retiming: silence removal + speed ramps, compiled together ──
  const { segments, outputDurationSec, removedSec } = compileTimeline(
    clipDurationSec, stack.silenceCut, stack.speedRamps,
  );
  const retimes = segments.length > 0 && !timelineIsIdentity(segments, clipDurationSec);
  let audio: string[] | null = null;
  let audioOutLabel: string | null = null;

  const hasAudio = opts.hasAudio !== false;

  if (retimes) {
    if (!caps.trim || !caps.concat) {
      warnings.push("Silence removal and speed ramps skipped — this ffmpeg lacks trim/concat.");
    } else {
      // Video: one trim+setpts leg per segment, then concat.
      const vLegs: string[] = [];
      const aLegs: string[] = [];
      segments.forEach((seg, i) => {
        const v = `[sv${i}]`;
        const a = `[sa${i}]`;
        vLegs.push(v);
        aLegs.push(a);
        videoPre.push(
          `${label}trim=start=${seg.srcStart.toFixed(3)}:end=${seg.srcEnd.toFixed(3)},` +
          `setpts=(PTS-STARTPTS)/${seg.rate.toFixed(4)}${v}`,
        );
      });
      // Every leg reads the SAME upstream label, so it has to be split first.
      videoPre.unshift(`${label}split=${segments.length}${vLegs.map((_, i) => `[vsplit${i}]`).join("")}`);
      for (let i = 0; i < segments.length; i++) {
        // Rewrite each leg to read its own split output.
        const at = videoPre.findIndex((f) => f.startsWith(`${label}trim=start=${segments[i].srcStart.toFixed(3)}`));
        if (at >= 0) videoPre[at] = videoPre[at].replace(label, `[vsplit${i}]`);
      }
      const vconcat = nextLabel();
      videoPre.push(`${vLegs.join("")}concat=n=${segments.length}:v=1:a=0${vconcat}`);
      label = vconcat;

      // Audio: the identical segmentation, so A/V stay locked by construction.
      // Silent sources skip this leg entirely — there is nothing to retime.
      if (hasAudio) {
      audio = [];
      audio.push(`[0:a]asplit=${segments.length}${segments.map((_, i) => `[asplit${i}]`).join("")}`);
      segments.forEach((seg, i) => {
        const tempo = Math.abs(seg.rate - 1) > 0.01 && caps.atempo
          ? "," + atempoChain(seg.rate).join(",")
          : "";
        audio!.push(
          `[asplit${i}]atrim=start=${seg.srcStart.toFixed(3)}:end=${seg.srcEnd.toFixed(3)},` +
          `asetpts=PTS-STARTPTS${tempo}${aLegs[i]}`,
        );
      });
      audio.push(`${aLegs.join("")}concat=n=${segments.length}:v=0:a=1[aret]`);
      audioOutLabel = "[aret]";
      if (removedSec > 0.05) {
        console.log(`[EditStack] Silence removal drops ${removedSec.toFixed(1)}s across ${segments.length} segment(s)`);
      }
      if (!caps.atempo && (stack.speedRamps ?? []).length > 0) {
        warnings.push("Speed ramps applied to video only — this ffmpeg lacks atempo, so audio pitch/length is unchanged.");
      }
      }
    }
  }

  // ── 3. B-roll (source space, timed, over the retimed base) ──────────
  for (const cut of stack.broll ?? []) {
    if (!cut.localPath) {
      warnings.push("A b-roll cut was skipped — its media could not be resolved.");
      continue;
    }
    const isImage = cut.kind === "image";
    extraInputs.push({ path: cut.localPath, loop: isImage });
    const idx = inputIdx++;
    const scale = Math.min(1, Math.max(0.1, Number(cut.scale) || 1));
    const w = Math.round(outWidth * scale);
    const h = Math.round(outHeight * scale);
    const prepped = `[br${idx}]`;
    // cover crops to fill; contain letterboxes inside the box.
    const fitChain = cut.fit === "contain"
      ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    extraInputs[extraInputs.length - 1].loop = isImage;
    videoPre.push(`[${idx}:v]${fitChain},setsar=1${prepped}`);
    const px = scale >= 0.999 ? 0 : Math.round(Math.min(1, Math.max(0, cut.x)) * (outWidth - w));
    const py = scale >= 0.999 ? 0 : Math.round(Math.min(1, Math.max(0, cut.y)) * (outHeight - h));
    const out = nextLabel();
    videoPre.push(
      `${label}${prepped}overlay=x=${px}:y=${py}:eof_action=pass:` +
      `enable='between(t,${cut.start.toFixed(3)},${cut.end.toFixed(3)})'${out}`,
    );
    label = out;
  }

  // ── 4. Text overlays — applied AFTER the crop, so in output pixels ──
  // Rasterized with sharp rather than drawtext: drawtext needs libfreetype,
  // which several stock ffmpeg builds (including this project's dev machine)
  // do not have, and a missing filter fails the entire render.
  const textInputs: Array<{ idx: number; img: NonNullable<typeof opts.textImages>[number] }> = [];
  for (const img of opts.textImages ?? []) {
    extraInputs.push({ path: img.path, loop: true });
    textInputs.push({ idx: inputIdx++, img });
  }
  const videoPost = (inLabel: string, outLabel: string): string[] => {
    if (textInputs.length === 0) return [];
    const parts: string[] = [];
    let cur = inLabel;
    textInputs.forEach((t, i) => {
      const last = i === textInputs.length - 1;
      const out = last ? outLabel : `[tx${i}]`;
      const ov = t.img.overlay;
      const maxX = Math.max(0, outWidth - t.img.w);
      const maxY = Math.max(0, outHeight - t.img.h);
      const px = Math.round(Math.min(1, Math.max(0, ov.x)) * maxX);
      const py = Math.round(Math.min(1, Math.max(0, ov.y)) * maxY);
      parts.push(
        `${cur}[${t.idx}:v]overlay=x=${px}:y=${py}:eof_action=pass:` +
        `enable='between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})'${out}`,
      );
      cur = out;
    });
    return parts;
  };

  // ── 5. Music bed + ducking ─────────────────────────────────────────
  const music = stack.music;
  if (music) {
    if (!music.localPath) {
      warnings.push("Music bed skipped — the track could not be resolved.");
    } else if (!caps.amix) {
      warnings.push("Music bed skipped — this ffmpeg lacks amix.");
    } else {
      extraInputs.push({ path: music.localPath });
      const idx = inputIdx++;
      audio = audio ?? [];
      const speech = audioOutLabel ?? (hasAudio ? "[0:a]" : null);
      const vol = Math.min(1, Math.max(0, Number(music.volume) || 0.2));
      const dur = outputDurationSec > 0 ? outputDurationSec : clipDurationSec;
      const fadeIn = Math.max(0, Number(music.fadeInSec) || 0);
      const fadeOut = Math.max(0, Number(music.fadeOutSec) || 0);

      // The bed is looped to the clip length and trimmed — a 20s track under
      // a 60s clip should not just stop.
      let bed = `[${idx}:a]aloop=loop=-1:size=2e9,atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol.toFixed(3)}`;
      if (fadeIn > 0) bed += `,afade=t=in:st=0:d=${fadeIn.toFixed(2)}`;
      if (fadeOut > 0) bed += `,afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`;
      audio.push(`${bed}[bed]`);

      if (!speech) {
        // Silent source: the bed IS the audio. Ducking has nothing to duck under.
        if (music.ducking) warnings.push("Ducking skipped — the source video has no audio to duck under.");
        audio.push(`[bed]anull[aout]`);
      } else if (music.ducking && caps.sidechaincompress) {
        // Speech drives the compressor's sidechain, so the bed drops itself
        // whenever someone talks. The speech leg is split because it is both
        // the control signal and half the final mix.
        const ratio = Math.min(20, Math.max(2, (Number(music.duckAmountDb) || 12) / 1.5));
        audio.push(`${speech}asplit=2[sp_mix][sp_key]`);
        audio.push(`[bed][sp_key]sidechaincompress=threshold=0.05:ratio=${ratio.toFixed(1)}:attack=20:release=350[bedduck]`);
        audio.push(`[sp_mix][bedduck]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      } else {
        if (music.ducking && !caps.sidechaincompress) {
          warnings.push(
            "Ducking unavailable on this server — the bed plays at a fixed level instead of dipping under speech.",
          );
        }
        audio.push(`${speech}[sp_mix]`);
        audio.push(`[sp_mix][bed]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      }
      audioOutLabel = "[aout]";
    }
  }

  const isEmpty =
    videoPre.length === 0 &&
    textInputs.length === 0 &&
    (audio === null || audio.length === 0);

  return {
    extraInputs,
    videoPre,
    videoPost,
    audio,
    audioOutLabel,
    videoOutLabel: label,
    outputDurationSec: retimes ? outputDurationSec : clipDurationSec,
    warnings,
    isEmpty,
  };
}

/** Are any of the stack's features actually turned on? */
export function editStackIsActive(stack: EditStack | null | undefined): boolean {
  if (!stack) return false;
  return !!(
    stack.stabilization?.enabled ||
    (stack.silenceCut?.enabled && stack.silenceCut.detected?.length) ||
    (stack.speedRamps ?? []).length > 0 ||
    (stack.broll ?? []).length > 0 ||
    (stack.textOverlays ?? []).length > 0 ||
    stack.music
  );
}
