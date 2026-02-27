import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

const TOTAL_DURATION = 30; // seconds

/**
 * TimerBar — animated countdown bar at the top of the game screen.
 * Shrinks from full width to zero over 30 seconds.
 * Turns red when under 10 seconds remain.
 *
 * Props:
 *   secondsLeft — remaining seconds (0-30)
 *   running     — whether the timer is active
 */
export default function TimerBar({ secondsLeft, running }) {
  const widthAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Map seconds remaining to a 0-1 fraction
    const fraction = secondsLeft / TOTAL_DURATION;
    Animated.timing(widthAnim, {
      toValue: fraction,
      duration: running ? 1000 : 200,
      useNativeDriver: false, // width animation can't use native driver
    }).start();
  }, [secondsLeft, running]);

  const isUrgent = secondsLeft <= 10;

  return (
    <View style={styles.track}>
      <Animated.View
        style={[
          styles.bar,
          {
            backgroundColor: isUrgent ? '#E74C3C' : '#F5E642',
            width: widthAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    height: 6,
    backgroundColor: '#333333',
    borderRadius: 3,
  },
  bar: {
    height: 6,
    borderRadius: 3,
  },
});
