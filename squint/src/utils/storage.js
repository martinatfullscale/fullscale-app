/**
 * Local storage utility for Squint leaderboard.
 * Uses AsyncStorage for persistent score tracking.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const LEADERBOARD_KEY = '@squint_leaderboard';
const MAX_ENTRIES = 50;

/**
 * Save a score to the leaderboard.
 * @param {Object} entry
 * @param {string} entry.playerName
 * @param {number} entry.score
 * @param {number} entry.correctCount
 * @param {number} entry.totalRounds
 * @param {string} entry.category — category id or 'all'
 * @param {string} entry.mode — 'solo' | 'elimination'
 */
export async function saveScore(entry) {
  try {
    const existing = await getLeaderboard();
    const newEntry = {
      ...entry,
      id: Date.now().toString(),
      date: new Date().toISOString(),
    };
    const updated = [...existing, newEntry]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(LEADERBOARD_KEY, JSON.stringify(updated));
    return updated;
  } catch (e) {
    console.warn('Save score failed:', e);
    return [];
  }
}

/**
 * Get the full leaderboard (sorted by score descending).
 * @returns {Array} Leaderboard entries
 */
export async function getLeaderboard() {
  try {
    const data = await AsyncStorage.getItem(LEADERBOARD_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.warn('Get leaderboard failed:', e);
    return [];
  }
}

/**
 * Clear the entire leaderboard.
 */
export async function clearLeaderboard() {
  try {
    await AsyncStorage.removeItem(LEADERBOARD_KEY);
  } catch (e) {
    console.warn('Clear leaderboard failed:', e);
  }
}

/**
 * Get the top N scores.
 * @param {number} n — number of entries to return
 */
export async function getTopScores(n = 10) {
  const board = await getLeaderboard();
  return board.slice(0, n);
}
