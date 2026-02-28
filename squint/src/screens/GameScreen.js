import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  Animated,
  TouchableOpacity,
  Dimensions,
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
const CORRECT_DELAY = 1500;
const ELIMINATION_TIMER = 15;

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const PLAYER_COLORS = ['#F5E642', '#FF4444', '#4CAF50', '#2196F3'];

/**
 * GameScreen — the core gameplay loop.
 * Supports solo and elimination (multiplayer) modes.
 *
 * Solo: Standard 10 rounds, guess the zoomed face.
 * Elimination: Players take turns. After every 3 rounds, lowest scorer
 * faces a sudden-death challenge. Fail = eliminated.
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

  const [shuffledOptions] = useState(() =>
    faces.map((face) => shuffleArray([...face.options]))
  );

  // Core game state
  const [round, setRound] = useState(0);
  const [zoomStage, setZoomStage] = useState(1);
  const [score, setScore] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(TIMER_SECONDS);
  const [timerRunning, setTimerRunning] = useState(!isElimination); // Pause for turn screen in multiplayer
  const [cardStates, setCardStates] = useState({});
  const [roundLocked, setRoundLocked] = useState(false);

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

  const timerRef = useRef(null);
  const roundRef = useRef(round);
  const scoreRef = useRef(score);
  const correctRef = useRef(correctCount);
  useEffect(() => { roundRef.current = round; }, [round]);
  useEffect(() => { scoreRef.current = score; }, [score]);
  useEffect(() => { correctRef.current = correctCount; }, [correctCount]);

  const currentFace = faces[round];
  const currentPlayer = isElimination ? activePlayers[currentPlayerIndex] : null;

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
    if (isElimination) {
      // In elimination: advance to next player or next round
      const nextPlayerIdx = currentPlayerIndex + 1;

      if (nextPlayerIdx < activePlayers.length) {
        // Next player's turn for the same round
        setCurrentPlayerIndex(nextPlayerIdx);
        setZoomStage(1);
        setSecondsLeft(TIMER_SECONDS);
        setTimerRunning(false);
        setCardStates({});
        setRoundLocked(false);
        setShowTurnScreen(true);
      } else {
        // All players have gone — check for elimination
        const newElimRoundCount = eliminationRoundCount + 1;
        setEliminationRoundCount(newElimRoundCount);

        if (newElimRoundCount % 3 === 0 && activePlayers.length > 1) {
          // Time for elimination check
          triggerEliminationCheck();
        } else {
          // Advance to next round
          advanceToNextRound();
        }
      }
    } else {
      // Solo mode
      const nextRound = roundRef.current + 1;
      if (nextRound >= TOTAL_ROUNDS) {
        endGame();
        return;
      }
      setRound(nextRound);
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
    setZoomStage(1);
    setSecondsLeft(TIMER_SECONDS);
    setTimerRunning(false);
    setCardStates({});
    setRoundLocked(false);
    setShowTurnScreen(true);
    // Reset phase scores
    const resetScores = {};
    activePlayers.forEach((p) => { resetScores[p] = 0; });
    setRoundScoresThisPhase(resetScores);
  }, [activePlayers, endGame]);

  const triggerEliminationCheck = useCallback(() => {
    // Find the player with the lowest phase score
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

    // Red flash animation
    Animated.sequence([
      Animated.timing(redFlash, { toValue: 1, duration: 200, useNativeDriver: false }),
      Animated.timing(redFlash, { toValue: 0, duration: 200, useNativeDriver: false }),
      Animated.timing(redFlash, { toValue: 1, duration: 200, useNativeDriver: false }),
      Animated.timing(redFlash, { toValue: 0, duration: 200, useNativeDriver: false }),
    ]).start();

    playSFX('eliminate');
  }, [activePlayers, roundScoresThisPhase, redFlash]);

  // Handle elimination challenge result
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
      // Game over — we have a winner
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
      setTimeout(() => advanceRound(), 1000);
    }
    return () => clearTimeout(timerRef.current);
  }, [secondsLeft, timerRunning, advanceRound]);

  // --- Handle answer tap ---
  const handleAnswer = useCallback(
    (selectedOption, optionIndex) => {
      if (roundLocked) return;

      const isCorrect = selectedOption === currentFace.name;

      if (isCorrect) {
        setRoundLocked(true);
        setTimerRunning(false);

        const points = getPointsForStage(zoomStage);
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
          // Also update the solo score display
          setScore((prev) => prev + points);
        } else {
          setScore((prev) => prev + points);
          setCorrectCount((prev) => prev + 1);
        }

        setCardStates({ [optionIndex]: 'correct' });
        setTimeout(() => advanceRound(), CORRECT_DELAY);
      } else {
        playSFX('wrong');
        setCardStates((prev) => ({ ...prev, [optionIndex]: 'wrong' }));
        if (zoomStage < MAX_STAGES) {
          setZoomStage((prev) => prev + 1);
        }
        setTimeout(() => {
          setCardStates((prev) => ({ ...prev, [optionIndex]: 'disabled' }));
        }, 400);
      }
    },
    [roundLocked, currentFace, zoomStage, advanceRound, isElimination, currentPlayer]
  );

  // --- Turn transition screen for multiplayer ---
  const handleStartTurn = () => {
    setShowTurnScreen(false);
    setTimerRunning(true);
  };

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

          {/* Active players list */}
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
          <ScoreDisplay score={isElimination ? (playerScores[currentPlayer]?.score || 0) : score} />
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
      </View>

      {/* Answer cards — 2x2 grid in bottom portion */}
      <View style={styles.answersArea}>
        <View style={styles.answerRow}>
          {shuffledOptions[round].slice(0, 2).map((option, i) => (
            <AnswerCard
              key={`${round}-${currentPlayerIndex}-${i}`}
              label={option}
              state={cardStates[i] || 'default'}
              onPress={() => handleAnswer(option, i)}
            />
          ))}
        </View>
        <View style={styles.answerRow}>
          {shuffledOptions[round].slice(2, 4).map((option, i) => (
            <AnswerCard
              key={`${round}-${currentPlayerIndex}-${i + 2}`}
              label={option}
              state={cardStates[i + 2] || 'default'}
              onPress={() => handleAnswer(option, i + 2)}
            />
          ))}
        </View>
      </View>
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
  // --- Image area (top 2/3) ---
  imageArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
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
});
