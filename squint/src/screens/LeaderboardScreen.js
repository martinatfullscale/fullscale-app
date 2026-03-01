import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  FlatList,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getLeaderboard, clearLeaderboard } from '../utils/storage';

const MEDAL_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32']; // gold, silver, bronze

/**
 * LeaderboardScreen — shows the top scores stored locally.
 */
export default function LeaderboardScreen({ navigation }) {
  const [scores, setScores] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadScores = useCallback(async () => {
    const board = await getLeaderboard();
    setScores(board);
  }, []);

  useEffect(() => {
    loadScores();
  }, [loadScores]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadScores();
    setRefreshing(false);
  };

  const handleClear = () => {
    Alert.alert(
      'Clear Leaderboard',
      'Are you sure? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearLeaderboard();
            setScores([]);
          },
        },
      ]
    );
  };

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  };

  const renderItem = ({ item, index }) => {
    const isTop3 = index < 3;
    return (
      <View style={[styles.row, isTop3 && styles.topRow]}>
        <View style={styles.rankCol}>
          {isTop3 ? (
            <View style={[styles.medal, { backgroundColor: MEDAL_COLORS[index] }]}>
              <Text style={styles.medalText}>{index + 1}</Text>
            </View>
          ) : (
            <Text style={styles.rankText}>{index + 1}</Text>
          )}
        </View>

        <View style={styles.infoCol}>
          <Text style={styles.playerName}>{item.playerName || 'Player'}</Text>
          <Text style={styles.meta}>
            {item.mode === 'elimination' ? '💀' : '🎯'}{' '}
            {item.correctCount}/{item.totalRounds} correct
            {item.date ? ` · ${formatDate(item.date)}` : ''}
          </Text>
        </View>

        <Text style={[styles.scoreText, isTop3 && styles.topScoreText]}>
          {item.score.toLocaleString()}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Leaderboard</Text>
        <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
          <Text style={styles.clearText}>Clear</Text>
        </TouchableOpacity>
      </View>

      {scores.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>🏆</Text>
          <Text style={styles.emptyTitle}>No Scores Yet</Text>
          <Text style={styles.emptySubtitle}>Play a game to get on the board!</Text>
          <TouchableOpacity
            style={styles.playButton}
            onPress={() => navigation.replace('EyeTest')}
          >
            <Text style={styles.playButtonText}>Play Now</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={scores}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    color: '#F5E642',
    fontSize: 28,
    fontWeight: '700',
  },
  title: {
    fontSize: 24,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  clearText: {
    color: '#E74C3C',
    fontSize: 14,
    fontWeight: '700',
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    padding: 16,
    marginBottom: 8,
  },
  topRow: {
    borderWidth: 1,
    borderColor: '#333',
  },
  rankCol: {
    width: 44,
    alignItems: 'center',
  },
  medal: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medalText: {
    fontSize: 14,
    fontWeight: '900',
    color: '#0D0D0D',
  },
  rankText: {
    color: '#888',
    fontSize: 16,
    fontWeight: '700',
  },
  infoCol: {
    flex: 1,
    marginLeft: 8,
  },
  playerName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 2,
  },
  meta: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
  },
  scoreText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
    marginLeft: 8,
  },
  topScoreText: {
    color: '#F5E642',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyIcon: {
    fontSize: 60,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginBottom: 32,
  },
  playButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 16,
  },
  playButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0D0D0D',
  },
});
