/**
 * Scoring utility for Squint.
 * Points drop STEEPLY with each wrong answer — guessing wrong and fast
 * should NOT yield a high score.
 *
 * Stage 1 (first try):      500 pts
 * Stage 2 (after 1 wrong):  300 pts
 * Stage 3 (after 2 wrong):  150 pts
 * Stage 4 (after 3 wrong):   50 pts
 * Time-out / all wrong:       0 pts
 */

const POINTS_BY_STAGE = {
  1: 500,
  2: 300,
  3: 150,
  4: 50,
  5: 0,
};

/**
 * Get the points awarded for a correct answer at the given stage.
 * @param {number} stage - Current hint stage (1-4 playable, 5 = time-out)
 * @returns {number} Points earned
 */
export function getPointsForStage(stage) {
  return POINTS_BY_STAGE[stage] || 0;
}

/**
 * Get performance label based on final score.
 * @param {number} score - Total score (0-5000)
 * @returns {string} Performance label
 */
export function getScoreLabel(score) {
  if (score >= 4001) return 'Eagle Vision';
  if (score >= 2501) return 'Sharp Eyes';
  if (score >= 1001) return 'Getting Warmer';
  return 'Keep Squinting';
}

export default { getPointsForStage, getScoreLabel };
