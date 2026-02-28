import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Animated,
  Dimensions,
} from 'react-native';
import CategoryPicker from '../components/CategoryPicker';
import GameModePopup from '../components/GameModePopup';
import { initAudio, playBackgroundMusic, toggleMute, getMuteState } from '../utils/audio';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

/**
 * StartScreen — landing page with animated zoom-reveal logo,
 * game mode popup, and category picker popup.
 *
 * Logo animation: starts zoomed in very tight (only see fragments of letters),
 * then zooms out dramatically to reveal the full "SQUINT" text.
 */
export default function StartScreen({ navigation }) {
  // Animated logo: start at 8x scale (super zoomed in), reveal to 1x
  const logoScale = useRef(new Animated.Value(8)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const buttonsOpacity = useRef(new Animated.Value(0)).current;

  // Popup states
  const [showModePopup, setShowModePopup] = useState(false);
  const [showCategoryPopup, setShowCategoryPopup] = useState(false);
  const [pendingMode, setPendingMode] = useState(null);
  const [muted, setMuted] = useState(getMuteState());

  useEffect(() => {
    initAudio();

    // Logo zoom reveal animation sequence
    Animated.sequence([
      // Fade in while zoomed in tight
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      // Dramatic zoom out from 8x to 1x
      Animated.spring(logoScale, {
        toValue: 1,
        tension: 8,
        friction: 5,
        useNativeDriver: true,
      }),
    ]).start(() => {
      // After logo settles, fade in tagline + buttons
      Animated.stagger(200, [
        Animated.timing(taglineOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(buttonsOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
      ]).start();
    });
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
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      {/* Mute toggle */}
      <TouchableOpacity style={styles.muteBtn} onPress={handleToggleMute}>
        <Text style={styles.muteText}>{muted ? '🔇' : '🔊'}</Text>
      </TouchableOpacity>

      <View style={styles.content}>
        {/* Animated logo — starts zoomed in tight, reveals on zoom out */}
        <Animated.View
          style={[
            styles.logoContainer,
            {
              opacity: logoOpacity,
              transform: [{ scale: logoScale }],
            },
          ]}
        >
          <Text style={styles.title}>SQUINT</Text>
        </Animated.View>

        {/* Tagline */}
        <Animated.Text style={[styles.tagline, { opacity: taglineOpacity }]}>
          How fast can you see it?
        </Animated.Text>

        {/* Action buttons */}
        <Animated.View style={[styles.buttonGroup, { opacity: buttonsOpacity }]}>
          <TouchableOpacity
            style={styles.playButton}
            activeOpacity={0.8}
            onPress={() => setShowModePopup(true)}
          >
            <Text style={styles.playText}>Play</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.leaderboardButton}
            activeOpacity={0.8}
            onPress={() => navigation.navigate('Leaderboard')}
          >
            <Text style={styles.leaderboardText}>🏆 Leaderboard</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>

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
  muteBtn: {
    position: 'absolute',
    top: 56,
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
  content: {
    alignItems: 'center',
  },
  logoContainer: {
    marginBottom: 12,
  },
  title: {
    fontSize: 72,
    fontWeight: '900',
    color: '#F5E642',
    letterSpacing: 10,
    textShadowColor: 'rgba(245, 230, 66, 0.4)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 30,
  },
  tagline: {
    fontSize: 18,
    color: '#888888',
    fontWeight: '600',
    marginBottom: 60,
  },
  buttonGroup: {
    width: SCREEN_WIDTH * 0.7,
    gap: 16,
  },
  playButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playText: {
    fontSize: 22,
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
  leaderboardText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
