import React, { useEffect, useState } from 'react';
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
import { saveScore } from '../utils/storage';
import { stopBackgroundMusic } from '../utils/audio';

/**
 * ScoreScreen — final results after a game session.
 * Handles both solo and elimination mode results.
 * Auto-saves scores to the leaderboard.
 */
export default function ScoreScreen({ route, navigation }) {
  const {
    finalScore = 0,
    correctCount = 0,
    totalRounds = 10,
    mode = 'solo',
    playerName = 'Player',
    playerScores = null,
    eliminatedOrder = null,
    winner = null,
    categoryId = null,
  } = route.params || {};

  const label = getScoreLabel(finalScore);
  const isElimination = mode === 'elimination';
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    stopBackgroundMusic();

    if (!saved) {
      if (isElimination && playerScores) {
        Object.entries(playerScores).forEach(([name, data]) => {
          saveScore({
            playerName: name,
            score: data.score,
            correctCount: data.correct,
            totalRounds,
            category: categoryId || 'all',
            mode: 'elimination',
          });
        });
      } else {
        saveScore({
          playerName,
          score: finalScore,
          correctCount,
          totalRounds,
          category: categoryId || 'all',
          mode: 'solo',
        });
      }
      setSaved(true);
    }
  }, []);

  const handleShare = async () => {
    const shareText = isElimination && winner
      ? `💀 SQUINT ELIMINATION\n${winner} survived!\nScore: ${playerScores?.[winner]?.score || 0} / 5000`
      : `🔍 SQUINT\nI scored ${finalScore} / 5000 (${correctCount}/${totalRounds} correct)\n${label}`;
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
        {isElimination && winner ? (
          <>
            <Text style={styles.winnerLabel}>SURVIVOR</Text>
            <Text style={styles.winnerName}>{winner}</Text>
            <Text style={styles.score}>{playerScores?.[winner]?.score || 0}</Text>
            <Text style={styles.outOf}>out of 5,000</Text>

            {eliminatedOrder && eliminatedOrder.length > 0 && (
              <View style={styles.eliminatedSection}>
                <Text style={styles.eliminatedTitle}>Eliminated</Text>
                {eliminatedOrder.map((name, i) => (
                  <Text key={i} style={styles.eliminatedName}>
                    💀 {name} — {playerScores?.[name]?.score || 0} pts
                  </Text>
                ))}
              </View>
            )}
          </>
        ) : (
          <>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.score}>{finalScore}</Text>
            <Text style={styles.outOf}>out of 5,000</Text>
            <Text style={styles.correct}>
              {correctCount} of {totalRounds} correct
            </Text>
          </>
        )}

        <View style={styles.buttons}>
          <TouchableOpacity
            style={styles.primaryButton}
            activeOpacity={0.8}
            onPress={() => navigation.replace('Start')}
          >
            <Text style={styles.primaryButtonText}>Play Again</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.leaderboardButton}
            activeOpacity={0.8}
            onPress={() => navigation.navigate('Leaderboard')}
          >
            <Text style={styles.leaderboardButtonText}>🏆 Leaderboard</Text>
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
  winnerLabel: {
    fontSize: 20,
    fontWeight: '800',
    color: '#2ECC71',
    letterSpacing: 4,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  winnerName: {
    fontSize: 36,
    fontWeight: '900',
    color: '#FFFFFF',
    marginBottom: 16,
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
    marginBottom: 40,
  },
  eliminatedSection: {
    marginTop: 16,
    marginBottom: 32,
    alignItems: 'center',
  },
  eliminatedTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#E74C3C',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  eliminatedName: {
    fontSize: 16,
    color: '#888',
    fontWeight: '600',
    marginBottom: 4,
  },
  buttons: {
    width: '100%',
    gap: 14,
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
  leaderboardButton: {
    backgroundColor: '#1A1A1A',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#333',
  },
  leaderboardButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  secondaryButton: {
    backgroundColor: '#1A1A1A',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#F5E642',
  },
  secondaryButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#F5E642',
  },
});
