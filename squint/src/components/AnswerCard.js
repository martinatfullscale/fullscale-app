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

/** Strip trailing filler words that make truncated labels read awkwardly */
const FILLER = new Set([
  'who', 'that', 'which', 'on', 'in', 'for', 'from',
  'with', 'and', 'or', 'to', 'at', 'by', 'of', 'since',
  'the', 'a', 'an', 'its', 'their',
]);

/** Shorten a label to 2-3 meaningful words for compact display */
function shortenLabel(text) {
  if (!text) return '';
  // If em-dash present, take part before it (that's the name/title)
  const dashIdx = text.indexOf(' — ');
  if (dashIdx !== -1) return text.substring(0, dashIdx).trim();
  const dashIdx2 = text.indexOf(' – ');
  if (dashIdx2 !== -1) return text.substring(0, dashIdx2).trim();
  // Take first 3 words, strip trailing filler
  const words = text.trim().split(/\s+/);
  if (words.length <= 3) return text.trim();
  const sliced = words.slice(0, 3);
  while (sliced.length > 1 && FILLER.has(sliced[sliced.length - 1].toLowerCase())) {
    sliced.pop();
  }
  // If stripped to 1 word, keep first 2
  if (sliced.length === 1) return words.slice(0, 2).join(' ');
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
        adjustsFontSizeToFit
        minimumFontScale={0.7}
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
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 20,
  },
  disabledLabel: {
    opacity: 0.4,
  },
});
