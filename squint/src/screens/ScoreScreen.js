import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { getScoreLabel } from '../utils/scoring';

/**
 * ScoreScreen — final results after a game session.
 * Shows score, correct count, performance label, and action buttons.
 */
export default function ScoreScreen({ route, navigation }) {
  const { finalScore = 0, correctCount = 0, totalRounds = 10 } = route.params || {};
  const label = getScoreLabel(finalScore);

  /**
   * Copy score to clipboard for sharing.
   */
  const handleShare = async () => {
    const shareText = `🔍 SQUINT\nI scored ${finalScore} / 5000 (${correctCount}/${totalRounds} correct)\n${label}`;
    try {
      await Clipboard.setStringAsync(shareText);
      Alert.alert('Copied!', 'Score copied to clipboard.');
    } catch {
      Alert.alert('Oops', 'Could not copy to clipboard.');
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      <View style={styles.content}>
        {/* Score label */}
        <Text style={styles.label}>{label}</Text>

        {/* Score number */}
        <Text style={styles.score}>{finalScore}</Text>
        <Text style={styles.outOf}>out of 5,000</Text>

        {/* Correct count */}
        <Text style={styles.correct}>
          {correctCount} of {totalRounds} correct
        </Text>

        {/* Buttons */}
        <View style={styles.buttons}>
          <TouchableOpacity
            style={styles.primaryButton}
            activeOpacity={0.8}
            onPress={() => navigation.replace('Start')}
          >
            <Text style={styles.primaryButtonText}>Play Again</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            activeOpacity={0.8}
            onPress={handleShare}
          >
            <Text style={styles.secondaryButtonText}>Share Score</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  label: {
    fontSize: 24,
    fontWeight: '800',
    color: '#F5E642',
    marginBottom: 24,
    textTransform: 'uppercase',
    letterSpacing: 2,
  },
  score: {
    fontSize: 80,
    fontWeight: '900',
    color: '#FFFFFF',
    lineHeight: 88,
  },
  outOf: {
    fontSize: 18,
    color: '#888888',
    fontWeight: '600',
    marginBottom: 16,
  },
  correct: {
    fontSize: 20,
    color: '#FFFFFF',
    fontWeight: '700',
    marginBottom: 48,
  },
  buttons: {
    width: '100%',
    gap: 16,
  },
  primaryButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  primaryButtonText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0D0D0D',
  },
  secondaryButton: {
    backgroundColor: '#1A1A1A',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    borderWidth: 2,
    borderColor: '#F5E642',
  },
  secondaryButtonText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#F5E642',
  },
});
