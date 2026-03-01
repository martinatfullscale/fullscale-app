import React from 'react';
import { TouchableOpacity, Text, StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_WIDTH = (SCREEN_WIDTH - 44) / 2; // 2 columns with tighter padding

/**
 * AnswerCard — a tappable multiple-choice option.
 *
 * Props:
 *   label   — the answer text (can be a short name OR a longer description)
 *   onPress — callback when tapped
 *   state   — "default" | "correct" | "wrong" | "disabled"
 */

/** Words that dangle awkwardly at the end of a truncated phrase */
const TRAILING_FILLER = new Set([
  'who', 'that', 'which', 'on', 'in', 'for', 'from',
  'with', 'and', 'or', 'to', 'at', 'by', 'of', 'since',
  'the', 'a', 'an', 'its', 'their', 'his', 'her',
  'known', 'famous', 'nicknamed', 'called', 'turned',
  'whose', 'behind', 'became', 'as', 'is', 'was', 'been',
]);

/**
 * Shorten a label to 2-3 distinctive words for compact card display.
 *
 * Strategy:
 *  1. Em-dash → take the name/title portion before it.
 *  2. Strip leading articles (A, An, The) — they waste card space.
 *  3. Keep first 2-3 words, strip trailing filler.
 */
function shortenLabel(text) {
  if (!text) return '';

  // If em-dash present, take part before it (that's the name/title)
  const dashIdx = text.indexOf(' — ');
  if (dashIdx !== -1) return text.substring(0, dashIdx).trim();
  const dashIdx2 = text.indexOf(' – ');
  if (dashIdx2 !== -1) return text.substring(0, dashIdx2).trim();

  // Strip leading articles — they eat up space and aren't distinctive
  const cleaned = text.trim().replace(/^(A|An|The)\s+/i, '');
  const words = cleaned.split(/\s+/);

  if (words.length <= 2) return cleaned;

  // Take first 2 words
  const sliced = words.slice(0, 2);

  // If the 2nd word is filler, grab a 3rd to keep it meaningful
  if (TRAILING_FILLER.has(sliced[1].toLowerCase()) && words.length > 2) {
    sliced.push(words[2]);
  }

  // Strip trailing filler
  while (sliced.length > 1 && TRAILING_FILLER.has(sliced[sliced.length - 1].toLowerCase())) {
    sliced.pop();
  }

  // Safety: if stripped to 1 word, grab the next word too
  if (sliced.length === 1 && words.length > 1) {
    sliced.push(words[1]);
  }

  return sliced.join(' ');
}

const BG_COLORS = {
  default: '#1A1A1A',
  correct: '#2ECC71',
  wrong: '#E74C3C',
  disabled: '#1A1A1A',
};

export default function AnswerCard({ label, onPress, state = 'default' }) {
  const isDisabled = state === 'disabled' || state === 'correct' || state === 'wrong';

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: BG_COLORS[state] || BG_COLORS.default }]}
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.7}
    >
      <Text
        style={[styles.label, state === 'disabled' && styles.disabledLabel]}
        numberOfLines={2}
        ellipsizeMode="tail"
      >
        {shortenLabel(label)}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    minHeight: 64,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 22,
  },
  disabledLabel: {
    opacity: 0.4,
  },
});
