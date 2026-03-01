import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  StatusBar,
  Animated,
  TouchableOpacity,
  Dimensions,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import ZoomImage from '../components/ZoomImage';
import AnswerCard from '../components/AnswerCard';
import TimerBar from '../components/TimerBar';
import ScoreDisplay from '../components/ScoreDisplay';
import { getRandomFaces } from '../data/categories';
import { getPointsForStage } from '../utils/scoring';
import { playSFX } from '../utils/audio';

const TOTAL_ROUNDS = 10;
const TIMER_SECONDS = 30;
const MAX_STAGES = 5;
const MAX_HINTS = 4; // 4 hint rounds per face (peel the onion)
const CORRECT_DELAY = 1500;
const WRONG_DELAY = 600; // brief flash before new hints appear
const ELIMINATION_TIMER = 15;

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const PLAYER_COLORS = ['#F5E642', '#FF4444', '#4CAF50', '#2196F3'];
const SPLASH_DURATION = 2000; // ms to show icon splash before game starts
const ICON_SOURCE = require('../../assets/icon.png');

/**
 * GameScreen — the core gameplay loop.
 * Supports solo and elimination (multiplayer) modes.
 *
 * "Peel the Onion" mechanic:
 *   Each face has 4 hint rounds. Round 1 is the vaguest (tiny zoom, vague clues).
 *   Wrong answer → image reveals more + clues get more specific.
 *   Round 4 shows the flat names. If still wrong → 0 points, move on.
 */
export default function GameScreen({ route, navigation }) {
  const {
    categoryId = null,
    mode = 'solo',
    players = null,
    playerName = 'Player',
  } = route.params || {};

  const isElimination = mode === 'elimination';

  // Get faces for selected category
  const [faces] = useState(() => {
    const pool = getRandomFaces(categoryId, TOTAL_ROUNDS);
    return shuffleArray(pool);
  });

  // Pre-shuffle hints for every face × every hint round.
  // shuffledHints[faceIdx][hintRound] = { options: string[], correctIdx: number }
  const [shuffledHints] = useState(() =>
    faces.map((face) => {
      const hints = face.hints || [face.options || []];
      return hints.map((roundOpts) => {
        const correct = roundOpts[0]; // first is always correct before shuffle
        const shuffled = shuffleArray([...roundOpts]);
        return {
          options: shuffled,
          correctIdx: shuffled.indexOf(correct),
        };
      });
    })
  );

  // Splash screen state — show icon before game starts
  const [showSplash, setShowSplash] = useState(true);
  const splashOpacity = useRef(new Animated.Value(1)).current;
  const splashScale = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    // Animate icon in
    Animated.spring(splashScale, {
      toValue: 1,
      tension: 40,
      friction: 7,
      useNativeDriver: true,
    }).start();

    // After delay, fade out and start game
    const timer = setTimeout(() => {
      Animated.timing(splashOpacity, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start(() => setShowSplash(false));
    }, SPLASH_DURATION);

    return () => clearTimeout(timer);
  }, []);

  // Core game state
  const [round, setRound] = useState(0);
  const [hintRound, setHintRound] = useState(0); // 0-3 = which layer of the onion
  const [zoomStage, setZoomStage] = useState(1);
  const [score, setScore] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(TIMER_SECONDS);
  const [timerRunning, setTimerRunning] = useState(false); // starts after splash
  const [cardStates, setCardStates] = useState({});
  const [roundLocked, setRoundLocked] = useState(false);
  const [revealName, setRevealName] = useState(null); // show name on miss-all
  const [isPaused, setIsPaused] = useState(false);

  // Elimination mode state
  const [activePlayers, setActivePlayers] = useState(players ? [...players] : []);
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0);
  const [playerScores, setPlayerScores] = useState(() => {
    if (!players) return {};
    const scores = {};
    players.forEach((p) => { scores[p] = { score: 0, correct: 0 }; });
    return scores;
  });
  const [eliminatedOrder, setEliminatedOrder] = useState([]);
  const [showTurnScreen, setShowTurnScreen] = useState(isElimination);
  const [showEliminationScreen, setShowEliminationScreen] = useState(false);
  const [eliminationTarget, setEliminationTarget] = useState(null);
  const [roundScoresThisPhase, setRoundScoresThisPhase] = useState(() => {
    if (!players) return {};
    const scores = {};
    players.forEach((p) => { scores[p] = 0; });
    return scores;
  });
  const [eliminationRoundCount, setEliminationRoundCount] = useState(0);

  // Elimination animation
  const redFlash = useRef(new Animated.Value(0)).current;

  // Start timer when splash finishes (solo mode only; elimination waits for turn screen)
  useEffect(() => {
    if (!showSplash && !isElimination) {
      setTimerRunning(true);
    }
  }, [showSplash, isElimination]);

  const timerRef = useRef(null);
  const roundRef = useRef(round);
  const scoreRef = useRef(score);
  const correctRef = useRef(correctCount);
  useEffect(() => { roundRef.current = round; }, [round]);
  useEffect(() => { scoreRef.current = score; }, [score]);
  useEffect(() => { correctRef.current = correctCount; }, [correctCount]);

  const currentFace = faces[round];
  const currentPlayer = isElimination ? activePlayers[currentPlayerIndex] : null;
  const currentHintData = shuffledHints[round]?.[hintRound] || { options: [], correctIdx: -1 };

  // --- End game (navigate to score screen) ---
  const endGame = useCallback(() => {
    if (isElimination) {
      const winner = activePlayers.length > 0 ? activePlayers[0] : eliminatedOrder[eliminatedOrder.length - 1];
      navigation.replace('Score', {
        finalScore: playerScores[winner]?.score || 0,
        correctCount: playerScores[winner]?.correct || 0,
        totalRounds: TOTAL_ROUNDS,
        mode: 'elimination',
        playerScores,
        eliminatedOrder,
        winner,
        categoryId,
      });
    } else {
      navigation.replace('Score', {
        finalScore: scoreRef.current,
        correctCount: correctRef.current,
        totalRounds: TOTAL_ROUNDS,
        mode: 'solo',
        playerName,
        categoryId,
      });
    }
  }, [isElimination, navigation, activePlayers, playerScores, eliminatedOrder, playerName, categoryId]);

  // --- Advance to next round or end game ---
  const advanceRound = useCallback(() => {
    setRevealName(null);

    if (isElimination) {
      const nextPlayerIdx = currentPlayerIndex + 1;

      if (nextPlayerIdx < activePlayers.length) {
        setCurrentPlayerIndex(nextPlayerIdx);
        setHintRound(0);
        setZoomStage(1);
        setSecondsLeft(TIMER_SECONDS);
        setTimerRunning(false);
        setCardStates({});
        setRoundLocked(false);
        setShowTurnScreen(true);
      } else {
        const newElimRoundCount = eliminationRoundCount + 1;
        setEliminationRoundCount(newElimRoundCount);

        if (newElimRoundCount % 3 === 0 && activePlayers.length > 1) {
          triggerEliminationCheck();
        } else {
          advanceToNextRound();
        }
      }
    } else {
      const nextRound = roundRef.current + 1;
      if (nextRound >= TOTAL_ROUNDS) {
        endGame();
        return;
      }
      setRound(nextRound);
      setHintRound(0);
      setZoomStage(1);
      setSecondsLeft(TIMER_SECONDS);
      setTimerRunning(true);
      setCardStates({});
      setRoundLocked(false);
    }
  }, [isElimination, currentPlayerIndex, activePlayers, eliminationRoundCount, endGame]);

  const advanceToNextRound = useCallback(() => {
    const nextRound = roundRef.current + 1;
    if (nextRound >= TOTAL_ROUNDS || activePlayers.length <= 1) {
      endGame();
      return;
    }
    setRound(nextRound);
    setCurrentPlayerIndex(0);
    setHintRound(0);
    setZoomStage(1);
    setSecondsLeft(TIMER_SECONDS);
    setTimerRunning(false);
    setCardStates({});
    setRoundLocked(false);
    setShowTurnScreen(true);
    const resetScores = {};
    activePlayers.forEach((p) => { resetScores[p] = 0; });
    setRoundScoresThisPhase(resetScores);
  }, [activePlayers, endGame]);

  const triggerEliminationCheck = useCallback(() => {
    let lowestScore = Infinity;
    let lowestPlayer = null;
    activePlayers.forEach((p) => {
      const s = roundScoresThisPhase[p] || 0;
      if (s < lowestScore) {
        lowestScore = s;
        lowestPlayer = p;
      }
    });

    setEliminationTarget(lowestPlayer);
    setShowEliminationScreen(true);

    Animated.sequence([
      Animated.timing(redFlash, { toValue: 1, duration: 200, useNativeDriver: false }),
      Animated.timing(redFlash, { toValue: 0, duration: 200, useNativeDriver: false }),
      Animated.timing(redFlash, { toValue: 1, duration: 200, useNativeDriver: false }),
      Animated.timing(redFlash, { toValue: 0, duration: 200, useNativeDriver: false }),
    ]).start();

    playSFX('eliminate');
  }, [activePlayers, roundScoresThisPhase, redFlash]);

  const handleEliminationSurvive = useCallback(() => {
    setShowEliminationScreen(false);
    setEliminationTarget(null);
    advanceToNextRound();
  }, [advanceToNextRound]);

  const handleEliminationEliminate = useCallback(() => {
    if (!eliminationTarget) return;

    const newActive = activePlayers.filter((p) => p !== eliminationTarget);
    const newEliminated = [...eliminatedOrder, eliminationTarget];

    setActivePlayers(newActive);
    setEliminatedOrder(newEliminated);
    setShowEliminationScreen(false);
    setEliminationTarget(null);

    if (newActive.length <= 1) {
      setTimeout(() => {
        const winner = newActive[0] || newEliminated[newEliminated.length - 1];
        navigation.replace('Score', {
          finalScore: playerScores[winner]?.score || 0,
          correctCount: playerScores[winner]?.correct || 0,
          totalRounds: TOTAL_ROUNDS,
          mode: 'elimination',
          playerScores,
          eliminatedOrder: newEliminated,
          winner,
          categoryId,
        });
      }, 500);
    } else {
      advanceToNextRound();
    }
  }, [eliminationTarget, activePlayers, eliminatedOrder, playerScores, navigation, categoryId, advanceToNextRound]);

  // --- Timer countdown ---
  useEffect(() => {
    if (timerRunning && secondsLeft > 0) {
      timerRef.current = setTimeout(() => {
        setSecondsLeft((prev) => prev - 1);
      }, 1000);
    } else if (secondsLeft === 0 && timerRunning) {
      setTimerRunning(false);
      setRoundLocked(true);
      // Time's up — reveal answer briefly then advance
      setZoomStage(MAX_STAGES);
      setRevealName(currentFace.name);
      setTimeout(() => advanceRound(), CORRECT_DELAY);
    }
    return () => clearTimeout(timerRef.current);
  }, [secondsLeft, timerRunning, advanceRound, currentFace]);

  // --- Handle answer tap ---
  const handleAnswer = useCallback(
    (optionIndex) => {
      if (roundLocked) return;

      const isCorrect = optionIndex === currentHintData.correctIdx;

      if (isCorrect) {
        setRoundLocked(true);
        setTimerRunning(false);

        const points = getPointsForStage(hintRound + 1); // hintRound 0→stage 1 (500pts)
        playSFX('correct');

        if (isElimination && currentPlayer) {
          setPlayerScores((prev) => ({
            ...prev,
            [currentPlayer]: {
              score: (prev[currentPlayer]?.score || 0) + points,
              correct: (prev[currentPlayer]?.correct || 0) + 1,
            },
          }));
          setRoundScoresThisPhase((prev) => ({
            ...prev,
            [currentPlayer]: (prev[currentPlayer] || 0) + points,
          }));
          setScore((prev) => prev + points);
        } else {
          setScore((prev) => prev + points);
          setCorrectCount((prev) => prev + 1);
        }

        setCardStates({ [optionIndex]: 'correct' });
        // Reveal full unblurred photo + name on correct answer
        setZoomStage(MAX_STAGES);
        setRevealName(currentFace.name);
        setTimeout(() => advanceRound(), CORRECT_DELAY);
      } else {
        playSFX('wrong');
        setCardStates({ [optionIndex]: 'wrong' });

        setTimeout(() => {
          if (hintRound < MAX_HINTS - 1) {
            // Peel the next layer — new clues + zoom out
            setHintRound((prev) => prev + 1);
            setZoomStage((prev) => Math.min(prev + 1, MAX_STAGES));
            setCardStates({});
          } else {
            // All 4 hint rounds exhausted — reveal and move on
            setRoundLocked(true);
            setTimerRunning(false);
            setZoomStage(MAX_STAGES);
            setRevealName(currentFace.name);
            setTimeout(() => advanceRound(), CORRECT_DELAY);
          }
        }, WRONG_DELAY);
      }
    },
    [roundLocked, currentHintData, hintRound, advanceRound, isElimination, currentPlayer, currentFace]
  );

  // --- Turn transition screen for multiplayer ---
  const handleStartTurn = () => {
    setShowTurnScreen(false);
    setTimerRunning(true);
  };

  // --- Pause / Resume ---
  const handlePause = () => {
    setIsPaused(true);
    setTimerRunning(false);
  };

  const handleResume = () => {
    setIsPaused(false);
    setTimerRunning(true);
  };

  // --- Exit game with confirmation ---
  const handleExit = () => {
    const wasRunning = timerRunning;
    setTimerRunning(false);
    Alert.alert(
      'Exit Game?',
      'Your progress will be lost.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => { if (wasRunning) setTimerRunning(true); } },
        { text: 'Exit', style: 'destructive', onPress: () => navigation.replace('EyeTest') },
      ]
    );
  };

  // ============================================
  // ICON SPLASH — shown briefly before game starts
  // ============================================
  if (showSplash) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
        <Animated.View
          style={[
            styles.splashContent,
            {
              opacity: splashOpacity,
              transform: [{ scale: splashScale }],
            },
          ]}
        >
          <Image
            source={ICON_SOURCE}
            style={styles.splashIcon}
            resizeMode="contain"
          />
          <Text style={styles.splashText}>SQUINT</Text>
          <Text style={styles.splashSubtext}>Get ready...</Text>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ============================================
  // ELIMINATION CHALLENGE SCREEN
  // ============================================
  if (showEliminationScreen && eliminationTarget) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
        <Animated.View
          style={[
            styles.eliminationOverlay,
            {
              backgroundColor: redFlash.interpolate({
                inputRange: [0, 1],
                outputRange: ['rgba(231,76,60,0)', 'rgba(231,76,60,0.3)'],
              }),
            },
          ]}
        />
        <View style={styles.eliminationContent}>
          <Text style={styles.redLightText}>RED LIGHT</Text>
          <Text style={styles.eliminationName}>{eliminationTarget}</Text>
          <Text style={styles.eliminationDesc}>
            Lowest scorer this phase — you face elimination!
          </Text>

          <View style={styles.eliminationButtons}>
            <TouchableOpacity
              style={styles.surviveButton}
              onPress={handleEliminationSurvive}
            >
              <Text style={styles.surviveText}>🟢 Survived</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.eliminateButton}
              onPress={handleEliminationEliminate}
            >
              <Text style={styles.eliminateText}>💀 Eliminated</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.eliminationHint}>
            Challenge the player IRL — quiz them, dare them, or let the group decide!
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ============================================
  // TURN TRANSITION SCREEN (Multiplayer)
  // ============================================
  if (showTurnScreen && isElimination) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
        <View style={styles.turnContent}>
          <Text style={styles.turnRound}>Round {round + 1}</Text>
          <View
            style={[
              styles.playerBadge,
              { backgroundColor: PLAYER_COLORS[currentPlayerIndex % PLAYER_COLORS.length] },
            ]}
          >
            <Text style={styles.playerBadgeText}>
              {currentPlayer}
            </Text>
          </View>
          <Text style={styles.turnLabel}>Your turn</Text>
          <Text style={styles.turnHint}>
            Hand the phone to {currentPlayer}
          </Text>
          <TouchableOpacity style={styles.readyButton} onPress={handleStartTurn}>
            <Text style={styles.readyText}>I'm Ready</Text>
          </TouchableOpacity>

          <View style={styles.playersAlive}>
            {activePlayers.map((p, i) => (
              <View
                key={p}
                style={[
                  styles.aliveChip,
                  p === currentPlayer && styles.aliveChipActive,
                ]}
              >
                <View style={[styles.chipDot, { backgroundColor: PLAYER_COLORS[players.indexOf(p) % PLAYER_COLORS.length] }]} />
                <Text style={[styles.chipName, p === currentPlayer && styles.chipNameActive]}>
                  {p}
                </Text>
              </View>
            ))}
            {eliminatedOrder.map((p) => (
              <View key={p} style={[styles.aliveChip, styles.eliminatedChip]}>
                <Text style={styles.chipEliminated}>💀 {p}</Text>
              </View>
            ))}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ============================================
  // MAIN GAME SCREEN
  // ============================================
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      {/* Header: Timer bar, round counter, score, player name */}
      <View style={styles.header}>
        <TimerBar secondsLeft={secondsLeft} running={timerRunning} />
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <TouchableOpacity style={styles.exitButton} onPress={handleExit}>
              <Text style={styles.exitText}>✕</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.pauseButton} onPress={handlePause}>
              <Text style={styles.pauseText}>⏸</Text>
            </TouchableOpacity>
            <Text style={styles.roundText}>{round + 1} of {TOTAL_ROUNDS}</Text>
            {isElimination && currentPlayer && (
              <View style={styles.playerTag}>
                <View
                  style={[
                    styles.playerTagDot,
                    { backgroundColor: PLAYER_COLORS[currentPlayerIndex % PLAYER_COLORS.length] },
                  ]}
                />
                <Text style={styles.playerTagName}>{currentPlayer}</Text>
              </View>
            )}
          </View>
          <View style={styles.headerRight}>
            {/* Hint round dots — shows which layer of the onion */}
            <View style={styles.hintDots}>
              {Array.from({ length: MAX_HINTS }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.hintDot,
                    i < hintRound && styles.hintDotUsed,
                    i === hintRound && styles.hintDotActive,
                  ]}
                />
              ))}
            </View>
            <ScoreDisplay score={isElimination ? (playerScores[currentPlayer]?.score || 0) : score} />
          </View>
        </View>
      </View>

      {/* Zoomed image — fills top portion */}
      <View style={styles.imageArea}>
        <ZoomImage
          image={currentFace.image}
          imageColor={currentFace.imageColor}
          initials={currentFace.initials}
          zoomStage={zoomStage}
        />
        {/* Reveal overlay — shows name when all hints exhausted or time's up */}
        {revealName && (
          <View style={styles.revealOverlay}>
            <Text style={styles.revealText}>{revealName}</Text>
          </View>
        )}
      </View>

      {/* Answer cards — 2x2 grid in bottom portion */}
      <View style={styles.answersArea}>
        <View style={styles.answerRow}>
          {currentHintData.options.slice(0, 2).map((option, i) => (
            <AnswerCard
              key={`${round}-${hintRound}-${currentPlayerIndex}-${i}`}
              label={option}
              state={cardStates[i] || 'default'}
              onPress={() => handleAnswer(i)}
            />
          ))}
        </View>
        <View style={styles.answerRow}>
          {currentHintData.options.slice(2, 4).map((option, i) => (
            <AnswerCard
              key={`${round}-${hintRound}-${currentPlayerIndex}-${i + 2}`}
              label={option}
              state={cardStates[i + 2] || 'default'}
              onPress={() => handleAnswer(i + 2)}
            />
          ))}
        </View>
      </View>

      {/* Pause overlay — covers everything so they can't cheat */}
      {isPaused && (
        <View style={styles.pauseOverlay}>
          <Text style={styles.pauseTitle}>PAUSED</Text>
          <Text style={styles.pauseHint}>The image is hidden so you can't cheat 👀</Text>
          <TouchableOpacity style={styles.resumeButton} onPress={handleResume} activeOpacity={0.8}>
            <Text style={styles.resumeText}>Resume</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

/** Fisher-Yates shuffle */
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  // --- Splash screen ---
  splashContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashIcon: {
    width: 180,
    height: 180,
    borderRadius: 36,
    marginBottom: 24,
  },
  splashText: {
    fontSize: 48,
    fontWeight: '900',
    color: '#F5E642',
    letterSpacing: 8,
    marginBottom: 8,
  },
  splashSubtext: {
    fontSize: 18,
    fontWeight: '600',
    color: '#888888',
  },
  // --- Header ---
  header: {
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  exitButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3A3A3A',
    borderWidth: 1.5,
    borderColor: '#555',
    alignItems: 'center',
    justifyContent: 'center',
  },
  exitText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  pauseButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3A3A3A',
    borderWidth: 1.5,
    borderColor: '#555',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseText: {
    fontSize: 16,
  },
  roundText: {
    color: '#888888',
    fontSize: 15,
    fontWeight: '700',
  },
  playerTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  playerTagDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  playerTagName: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  // --- Hint round dots ---
  hintDots: {
    flexDirection: 'row',
    gap: 5,
  },
  hintDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#333333',
  },
  hintDotActive: {
    backgroundColor: '#F5E642',
  },
  hintDotUsed: {
    backgroundColor: '#E74C3C',
  },
  // --- Image area (top 2/3) ---
  imageArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  // --- Reveal overlay ---
  revealOverlay: {
    position: 'absolute',
    bottom: 16,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  revealText: {
    color: '#F5E642',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
  },
  // --- Answers area (bottom 1/3) ---
  answersArea: {
    paddingHorizontal: 12,
    paddingBottom: 20,
    gap: 10,
  },
  answerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  // --- Turn transition screen ---
  turnContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  turnRound: {
    fontSize: 18,
    fontWeight: '700',
    color: '#888',
    marginBottom: 24,
  },
  playerBadge: {
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 20,
    marginBottom: 16,
  },
  playerBadgeText: {
    fontSize: 32,
    fontWeight: '900',
    color: '#0D0D0D',
  },
  turnLabel: {
    fontSize: 24,
    fontWeight: '800',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  turnHint: {
    fontSize: 16,
    color: '#888',
    marginBottom: 40,
  },
  readyButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    paddingHorizontal: 60,
    borderRadius: 16,
    marginBottom: 40,
  },
  readyText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0D0D0D',
  },
  playersAlive: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  aliveChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  aliveChipActive: {
    borderWidth: 2,
    borderColor: '#F5E642',
  },
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  chipName: {
    color: '#888',
    fontSize: 14,
    fontWeight: '700',
  },
  chipNameActive: {
    color: '#FFFFFF',
  },
  eliminatedChip: {
    opacity: 0.5,
  },
  chipEliminated: {
    color: '#E74C3C',
    fontSize: 14,
    fontWeight: '700',
  },
  // --- Elimination screen ---
  eliminationOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  eliminationContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    zIndex: 1,
  },
  redLightText: {
    fontSize: 42,
    fontWeight: '900',
    color: '#E74C3C',
    letterSpacing: 6,
    marginBottom: 24,
    textShadowColor: 'rgba(231,76,60,0.5)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 20,
  },
  eliminationName: {
    fontSize: 32,
    fontWeight: '900',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  eliminationDesc: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginBottom: 40,
    lineHeight: 24,
  },
  eliminationButtons: {
    width: '100%',
    gap: 14,
    marginBottom: 24,
  },
  surviveButton: {
    backgroundColor: '#2ECC71',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  surviveText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0D0D0D',
  },
  eliminateButton: {
    backgroundColor: '#E74C3C',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
  },
  eliminateText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  eliminationHint: {
    fontSize: 14,
    color: '#555',
    textAlign: 'center',
    lineHeight: 20,
    fontStyle: 'italic',
  },
  // --- Pause overlay ---
  pauseOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0D0D0D',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  pauseTitle: {
    fontSize: 48,
    fontWeight: '900',
    color: '#F5E642',
    letterSpacing: 8,
    marginBottom: 16,
  },
  pauseHint: {
    fontSize: 16,
    color: '#888888',
    fontWeight: '600',
    marginBottom: 48,
  },
  resumeButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    paddingHorizontal: 60,
    borderRadius: 16,
  },
  resumeText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0D0D0D',
  },
});
