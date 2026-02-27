import React from 'react';
import { TouchableOpacity, Text, StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_WIDTH = (SCREEN_WIDTH - 48) / 2; // 2 columns with padding

/**
 * AnswerCard — a tappable multiple-choice option.
 *
 * Props:
 *   label   — the answer text
 *   onPress — callback when tapped
 *   state   — "default" | "correct" | "wrong" | "disabled"
 */

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
      <Text style={[styles.label, state === 'disabled' && styles.disabledLabel]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    minHeight: 64,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  disabledLabel: {
    opacity: 0.4,
  },
});
