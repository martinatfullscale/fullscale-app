import React from 'react';
import { TouchableOpacity, Text, StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_WIDTH = (SCREEN_WIDTH - 44) / 2; // 2 columns with tighter padding

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
      <Text
        style={[styles.label, state === 'disabled' && styles.disabledLabel]}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    minHeight: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  disabledLabel: {
    opacity: 0.4,
  },
});
