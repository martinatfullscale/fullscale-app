/**
 * Timing Engine — Reconciles Claude's estimated region activation times
 * with ElevenLabs' actual measured word timestamps.
 *
 * Ensures regions animate in sync with the spoken narration:
 * - When the narrator says "team", the headshot region activates
 * - When the narrator says "fifty billion", the number region lifts
 *
 * The engine fuzzy-matches each region's `activateAtWord` against the
 * word timing array, then sets `actualStartSec` / `actualEndSec` based
 * on the real spoken timing.
 */

import type { Scene, SlideRegion } from "./storyExtractor.js";
import type { WordTiming, VoiceResult } from "./voiceSynth.js";

// ── Types ──────────────────────────────────────────────────────

export interface ReconciledRegion extends SlideRegion {
  actualStartSec: number;
  actualEndSec: number;
}

export interface ReconciledScene {
  sceneNumber: number;
  regions: ReconciledRegion[];
  actualAudioDuration: number;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Reconcile all scenes' region timings with actual voice timestamps.
 * Scenes and voiceResults are matched by index.
 */
export function reconcileAllScenes(
  scenes: Scene[],
  voiceResults: VoiceResult[]
): ReconciledScene[] {
  return scenes.map((scene, i) => {
    const voice = voiceResults[i];
    if (!voice) {
      return {
        sceneNumber: scene.sceneNumber,
        regions: (scene.regions || []).map((r) => ({
          ...r,
          actualStartSec: r.activateAtSec,
          actualEndSec: r.deactivateAtSec,
        })),
        actualAudioDuration: scene.estimatedDurationSeconds,
      };
    }
    return reconcileSceneTiming(scene, voice.wordTimings, voice.actualDurationSec);
  });
}

/**
 * Reconcile a single scene's region timings with actual word timestamps.
 */
export function reconcileSceneTiming(
  scene: Scene,
  wordTimings: WordTiming[],
  actualAudioDuration: number
): ReconciledScene {
  const regions = scene.regions || [];

  if (regions.length === 0 || wordTimings.length === 0) {
    // No regions or no timing data — use Claude's estimates, scaled to actual duration
    const scale = actualAudioDuration > 0 && scene.estimatedDurationSeconds > 0
      ? actualAudioDuration / scene.estimatedDurationSeconds
      : 1;
    return {
      sceneNumber: scene.sceneNumber,
      regions: regions.map((r) => ({
        ...r,
        actualStartSec: Math.max(0, r.activateAtSec * scale),
        actualEndSec: Math.min(actualAudioDuration, r.deactivateAtSec * scale),
      })),
      actualAudioDuration,
    };
  }

  const reconciled: ReconciledRegion[] = regions.map((region) => {
    const triggerWord = (region.activateAtWord || "").toLowerCase().trim();
    const estimatedDuration = region.deactivateAtSec - region.activateAtSec;

    // Try to find the trigger word in the actual word timings
    const match = findWordMatch(triggerWord, wordTimings);

    let actualStart: number;
    let actualEnd: number;

    if (match) {
      // Found the word — use its actual timing
      actualStart = Math.max(0, match.start - 0.15); // 150ms pre-roll for fade-in
      actualEnd = Math.min(actualAudioDuration - 0.05, match.start + estimatedDuration);
    } else {
      // No match — proportionally scale Claude's estimate to actual duration
      const scale = actualAudioDuration / Math.max(1, scene.estimatedDurationSeconds);
      actualStart = Math.max(0, region.activateAtSec * scale);
      actualEnd = Math.min(actualAudioDuration - 0.05, region.deactivateAtSec * scale);
    }

    // Ensure minimum 0.5s duration
    if (actualEnd - actualStart < 0.5) {
      actualEnd = Math.min(actualAudioDuration, actualStart + 0.5);
    }

    return {
      ...region,
      actualStartSec: actualStart,
      actualEndSec: actualEnd,
    };
  });

  return {
    sceneNumber: scene.sceneNumber,
    regions: reconciled,
    actualAudioDuration,
  };
}

// ── Word Matching ──────────────────────────────────────────────

/**
 * Find a word timing entry that matches the trigger word/phrase.
 * Tries exact match first, then substring match, then prefix match.
 */
function findWordMatch(
  triggerWord: string,
  wordTimings: WordTiming[]
): WordTiming | null {
  if (!triggerWord) return null;

  const normalized = triggerWord.toLowerCase().replace(/[^a-z0-9\s'-]/g, "");
  const triggerWords = normalized.split(/\s+/).filter(Boolean);

  if (triggerWords.length === 0) return null;

  // Try matching the first significant word of the trigger phrase
  const primaryWord = triggerWords.find((w) => w.length > 3) || triggerWords[0];

  // Pass 1: exact word match (case-insensitive)
  for (const wt of wordTimings) {
    if (wt.word.toLowerCase() === primaryWord) return wt;
  }

  // Pass 2: word starts with the trigger (handles partial matches like "market" → "marketplace")
  for (const wt of wordTimings) {
    if (wt.word.toLowerCase().startsWith(primaryWord)) return wt;
  }

  // Pass 3: trigger is contained in the word
  for (const wt of wordTimings) {
    if (wt.word.toLowerCase().includes(primaryWord)) return wt;
  }

  // Pass 4: word contains the trigger's first 4 characters (very fuzzy)
  if (primaryWord.length >= 4) {
    const prefix = primaryWord.slice(0, 4);
    for (const wt of wordTimings) {
      if (wt.word.toLowerCase().includes(prefix)) return wt;
    }
  }

  return null;
}
