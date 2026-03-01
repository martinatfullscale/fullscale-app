import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  ScrollView,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CategoryPicker from '../components/CategoryPicker';
import GameModePopup from '../components/GameModePopup';
import { initAudio, playBackgroundMusic, toggleMute, getMuteState } from '../utils/audio';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const EYE_CHART_ROWS = [
  { letters: 'S', size: 72 },
  { letters: 'Q  U', size: 54 },
  { letters: 'I  N  T', size: 40 },
  { letters: 'E  Y  E  S', size: 28 },
  { letters: 'C  A  N   Y  O  U', size: 20 },
  { letters: 'R  E  A  D   T  H  I  S', size: 14 },
  { letters: 'Y O U  D E F I N I T E L Y  N E E D  G L A S S E S', size: 8 },
];

/**
 * EyeTestScreen — the home/landing screen for Squint.
 * Shows a tongue-in-cheek "visual acuity test" with an eye chart,
 * pharmaceutical-style warning, and the play button ("I Can See Just Fine").
 * Tapping the play button opens the game mode popup → category picker → game.
 */
export default function EyeTestScreen({ navigation }) {
  // Popup states (same flow as old StartScreen)
  const [showModePopup, setShowModePopup] = useState(false);
  const [showCategoryPopup, setShowCategoryPopup] = useState(false);
  const [pendingMode, setPendingMode] = useState(null);
  const [muted, setMuted] = useState(getMuteState());

  useEffect(() => {
    initAudio();
  }, []);

  const handleSoloStart = (playerName) => {
    setPendingMode({ mode: 'solo', playerName });
    setShowModePopup(false);
    setShowCategoryPopup(true);
  };

  const handleMultiStart = (players) => {
    setPendingMode({ mode: 'elimination', players });
    setShowModePopup(false);
    setShowCategoryPopup(true);
  };

  const handleCategorySelect = (categoryId) => {
    setShowCategoryPopup(false);
    playBackgroundMusic();
    navigation.navigate('Game', {
      categoryId,
      mode: pendingMode?.mode || 'solo',
      players: pendingMode?.players || null,
      playerName: pendingMode?.playerName || 'Player',
    });
    setPendingMode(null);
  };

  const handleToggleMute = async () => {
    const newState = await toggleMute();
    setMuted(newState);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      {/* Mute toggle */}
      <TouchableOpacity style={styles.muteBtn} onPress={handleToggleMute}>
        <Text style={styles.muteText}>{muted ? '🔇' : '🔊'}</Text>
      </TouchableOpacity>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Text style={styles.header}>VISUAL ACUITY TEST</Text>

        {/* Eye chart */}
        <View style={styles.chartContainer}>
          {EYE_CHART_ROWS.map((row, i) => (
            <Text
              key={i}
              style={[
                styles.chartRow,
                { fontSize: row.size },
                i === 0 && { color: '#F5E642' },
              ]}
            >
              {row.letters}
            </Text>
          ))}
        </View>

        {/* Warning */}
        <View style={styles.warningBox}>
          <Text style={styles.warningLabel}>WARNING</Text>
          <Text style={styles.warningText}>
            This game may confirm what your optometrist has been telling you
          </Text>
        </View>

        {/* Side effects */}
        <Text style={styles.sideEffects}>
          Side effects may include: squinting, holding your phone at arm's
          length, accidentally texting your eye doctor, and the sudden urge
          to buy reading glasses
        </Text>

        {/* Play button (was "I Can See Just Fine") */}
        <TouchableOpacity
          style={styles.playButton}
          onPress={() => setShowModePopup(true)}
          activeOpacity={0.8}
        >
          <Text style={styles.playText}>I Can See Just Fine</Text>
        </TouchableOpacity>

        {/* Leaderboard button */}
        <TouchableOpacity
          style={styles.leaderboardButton}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('Leaderboard')}
        >
          <Text style={styles.leaderboardText}>🏆 Leaderboard</Text>
        </TouchableOpacity>

        {/* Fine print */}
        <Text style={styles.finePrint}>
          Squint is not a substitute for an actual eye exam.
          {'\n'}But let's be honest, you probably need one.
        </Text>
      </ScrollView>

      {/* Game mode popup */}
      <GameModePopup
        visible={showModePopup}
        onStartSolo={handleSoloStart}
        onStartMulti={handleMultiStart}
        onClose={() => setShowModePopup(false)}
      />

      {/* Category picker popup */}
      <CategoryPicker
        visible={showCategoryPopup}
        onSelect={handleCategorySelect}
        onClose={() => {
          setShowCategoryPopup(false);
          setPendingMode(null);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  muteBtn: {
    position: 'absolute',
    top: 8,
    right: 20,
    zIndex: 10,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  muteText: {
    fontSize: 24,
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  header: {
    fontSize: 14,
    fontWeight: '700',
    color: '#888888',
    letterSpacing: 6,
    marginBottom: 30,
  },
  chartContainer: {
    alignItems: 'center',
    marginBottom: 36,
    gap: 8,
  },
  chartRow: {
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: 4,
    textAlign: 'center',
  },
  warningBox: {
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#F5E642',
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 20,
    width: '100%',
    alignItems: 'center',
  },
  warningLabel: {
    fontSize: 14,
    fontWeight: '900',
    color: '#F5E642',
    letterSpacing: 4,
    marginBottom: 8,
  },
  warningText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 24,
  },
  sideEffects: {
    fontSize: 13,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 20,
    fontStyle: 'italic',
    marginBottom: 36,
    paddingHorizontal: 12,
  },
  playButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    paddingHorizontal: 48,
    borderRadius: 16,
    marginBottom: 16,
    width: SCREEN_WIDTH * 0.7,
    alignItems: 'center',
  },
  playText: {
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
    marginBottom: 24,
    width: SCREEN_WIDTH * 0.7,
  },
  leaderboardText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  finePrint: {
    fontSize: 11,
    color: '#555555',
    textAlign: 'center',
    lineHeight: 16,
  },
});
