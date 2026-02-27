import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import ZoomImage from '../components/ZoomImage';
import AnswerCard from '../components/AnswerCard';
import TimerBar from '../components/TimerBar';
import ScoreDisplay from '../components/ScoreDisplay';
import famousFaces from '../data/famousFaces';
import { getPointsForStage } from '../utils/scoring';

const TOTAL_ROUNDS = 10;
const TIMER_SECONDS = 30;
const MAX_STAGES = 5;
const CORRECT_DELAY = 1500; // ms to show correct feedback before advancing

/**
 * GameScreen — the core gameplay loop.
 * Manages round progression, zoom stages, timer, answers, and scoring.
 * Uses refs for values needed inside timeouts to avoid stale closures.
 */
export default function GameScreen({ navigation }) {
  // Shuffle faces once at game start
  const [faces] = useState(() => shuffleArray([...famousFaces]).slice(0, TOTAL_ROUNDS));

  // Shuffle the options per round so the correct answer position varies
  const [shuffledOptions] = useState(() =>
    faces.map((face) => shuffleArray([...face.options]))
  );

  const [round, setRound] = useState(0);
  const [zoomStage, setZoomStage] = useState(1);
  const [score, setScore] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(TIMER_SECONDS);
  const [timerRunning, setTimerRunning] = useState(true);
  const [cardStates, setCardStates] = useState({});
  const [roundLocked, setRoundLocked] = useState(false);

  const timerRef = useRef(null);

  // Keep refs in sync so timeout callbacks always read the latest values
  const roundRef = useRef(round);
  const scoreRef = useRef(score);
  const correctRef = useRef(correctCount);
  useEffect(() => { roundRef.current = round; }, [round]);
  useEffect(() => { scoreRef.current = score; }, [score]);
  useEffect(() => { correctRef.current = correctCount; }, [correctCount]);

  const currentFace = faces[round];

  // --- Advance to next round or end game ---
  const advanceRound = useCallback(() => {
    const nextRound = roundRef.current + 1;

    if (nextRound >= TOTAL_ROUNDS) {
      navigation.replace('Score', {
        finalScore: scoreRef.current,
        correctCount: correctRef.current,
        totalRounds: TOTAL_ROUNDS,
      });
      return;
    }

    setRound(nextRound);
    setZoomStage(1);
    setSecondsLeft(TIMER_SECONDS);
    setTimerRunning(true);
    setCardStates({});
    setRoundLocked(false);
  }, [navigation]);

  // --- Timer countdown ---
  useEffect(() => {
    if (timerRunning && secondsLeft > 0) {
      timerRef.current = setTimeout(() => {
        setSecondsLeft((prev) => prev - 1);
      }, 1000);
    } else if (secondsLeft === 0 && timerRunning) {
      // Time expired — mark as missed
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
        // Correct — freeze, feedback, award points, advance after delay
        setRoundLocked(true);
        setTimerRunning(false);

        const points = getPointsForStage(zoomStage);
        setScore((prev) => prev + points);
        setCorrectCount((prev) => prev + 1);
        setCardStates({ [optionIndex]: 'correct' });

        setTimeout(() => advanceRound(), CORRECT_DELAY);
      } else {
        // Wrong — flash red, disable card, advance zoom stage
        setCardStates((prev) => ({ ...prev, [optionIndex]: 'wrong' }));

        if (zoomStage < MAX_STAGES) {
          setZoomStage((prev) => prev + 1);
        }

        // Reset wrong card to disabled after flash
        setTimeout(() => {
          setCardStates((prev) => ({ ...prev, [optionIndex]: 'disabled' }));
        }, 400);
      }
    },
    [roundLocked, currentFace, zoomStage, advanceRound]
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      {/* Header: Timer bar, round counter, score */}
      <View style={styles.header}>
        <TimerBar secondsLeft={secondsLeft} running={timerRunning} />
        <View style={styles.headerRow}>
          <Text style={styles.roundText}>{round + 1} of {TOTAL_ROUNDS}</Text>
          <ScoreDisplay score={score} />
        </View>
      </View>

      {/* Zoomed image — the star of the show */}
      <View style={styles.imageArea}>
        <ZoomImage
          imageColor={currentFace.imageColor}
          initials={currentFace.initials}
          zoomStage={zoomStage}
        />
      </View>

      {/* Answer cards — 2x2 grid */}
      <View style={styles.answersArea}>
        <View style={styles.answerRow}>
          {shuffledOptions[round].slice(0, 2).map((option, i) => (
            <AnswerCard
              key={`${round}-${i}`}
              label={option}
              state={cardStates[i] || 'default'}
              onPress={() => handleAnswer(option, i)}
            />
          ))}
        </View>
        <View style={styles.answerRow}>
          {shuffledOptions[round].slice(2, 4).map((option, i) => (
            <AnswerCard
              key={`${round}-${i + 2}`}
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
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  roundText: {
    color: '#888888',
    fontSize: 16,
    fontWeight: '700',
  },
  imageArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  answersArea: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 12,
  },
  answerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
});
