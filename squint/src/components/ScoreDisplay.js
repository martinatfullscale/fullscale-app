import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';

/**
 * ScoreDisplay — shows the running score in the top right.
 * Brief scale-up animation when the score changes.
 *
 * Props:
 *   score — current total score
 */
export default function ScoreDisplay({ score }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Pulse animation when score updates
    if (score > 0) {
      Animated.sequence([
        Animated.timing(scaleAnim, {
          toValue: 1.3,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [score]);

  return (
    <Animated.View style={[styles.container, { transform: [{ scale: scaleAnim }] }]}>
      <Text style={styles.text}>⭐ {score}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-end',
  },
  text: {
    color: '#F5E642',
    fontSize: 18,
    fontWeight: '800',
  },
});
