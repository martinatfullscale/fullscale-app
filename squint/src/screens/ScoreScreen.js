import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Alert,
  FlatList,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { getScoreLabel } from '../utils/scoring';
import { saveScore, getTopScores } from '../utils/storage';
import { stopBackgroundMusic } from '../utils/audio';

/**
 * ScoreScreen — final results after a game session.
 * Shows score + performance label + mini leaderboard snapshot.
 * No more misleading "X of Y correct" — just the score and where you rank.
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
  const [topScores, setTopScores] = useState([]);

  useEffect(() => {
    stopBackgroundMusic();

    const saveAndLoad = async () => {
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
          await saveScore({
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
      // Load top 5 for the mini leaderboard
      const top = await getTopScores(5);
      setTopScores(top);
    };

    saveAndLoad();
  }, []);

  const handleShare = async () => {
    const shareText = isElimination && winner
      ? `💀 SQUINT ELIMINATION\n${winner} survived!\nScore: ${playerScores?.[winner]?.score || 0} / 5000`
      : `🔍 SQUINT\nI scored ${finalScore} / 5000\n${label}`;
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
          </>
        )}

        {/* Mini leaderboard snapshot */}
        {topScores.length > 0 && (
          <View style={styles.miniLeaderboard}>
            <Text style={styles.miniTitle}>TOP SCORES</Text>
            {topScores.map((entry, i) => (
              <View key={entry.id || i} style={styles.miniRow}>
                <Text style={styles.miniRank}>{i + 1}.</Text>
                <Text style={styles.miniName} numberOfLines={1}>{entry.playerName}</Text>
                <Text style={styles.miniScore}>{entry.score}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.buttons}>
          <TouchableOpacity
            style={styles.primaryButton}
            activeOpacity={0.8}
            onPress={() => navigation.replace('EyeTest')}
          >
            <Text style={styles.primaryButtonText}>Play Again</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.leaderboardButton}
            activeOpacity={0.8}
            onPress={() => navigation.navigate('Leaderboard')}
          >
            <Text style={styles.leaderboardButtonText}>🏆 Full Leaderboard</Text>
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
    width: '100%',
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
    marginBottom: 20,
  },
  eliminatedSection: {
    marginTop: 16,
    marginBottom: 24,
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
  // --- Mini leaderboard ---
  miniLeaderboard: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  miniTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#888888',
    letterSpacing: 3,
    marginBottom: 10,
    textAlign: 'center',
  },
  miniRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  miniRank: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
    width: 24,
  },
  miniName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  miniScore: {
    fontSize: 14,
    fontWeight: '800',
    color: '#F5E642',
  },
  // --- Buttons ---
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
