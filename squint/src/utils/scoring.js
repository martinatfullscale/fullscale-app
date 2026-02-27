/**
 * Scoring utility for Squint.
 * Points decrease as more of the image is revealed.
 */

const POINTS_BY_STAGE = {
  1: 500,
  2: 400,
  3: 300,
  4: 200,
  5: 100,
};

/**
 * Get the points awarded for a correct answer at the given zoom stage.
 * @param {number} stage - Current zoom stage (1-5)
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
