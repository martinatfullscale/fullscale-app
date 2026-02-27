import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CONTAINER_SIZE = SCREEN_WIDTH * 0.85;

/**
 * Zoom stage → scale factor.
 * Higher scale = more zoomed in, less visible.
 * Stage 1: 8% visible → scale ~3.5x (1/√0.08)
 * Stage 2: 18% → scale ~2.35x
 * Stage 3: 32% → scale ~1.77x
 * Stage 4: 55% → scale ~1.35x
 * Stage 5: 100% → scale 1x
 */
const SCALE_BY_STAGE = {
  1: 3.5,
  2: 2.35,
  3: 1.77,
  4: 1.35,
  5: 1.0,
};

/**
 * ZoomImage — the visual star of Squint.
 * Renders a placeholder color block with initials at varying zoom levels.
 * Smooth animated transitions between stages.
 *
 * Props:
 *   imageColor  — background color of the placeholder
 *   initials    — text initials displayed on the placeholder
 *   zoomStage   — current zoom stage (1-5)
 */
export default function ZoomImage({ imageColor, initials, zoomStage }) {
  const scaleAnim = useRef(new Animated.Value(SCALE_BY_STAGE[1])).current;

  useEffect(() => {
    const targetScale = SCALE_BY_STAGE[zoomStage] || 1;
    Animated.timing(scaleAnim, {
      toValue: targetScale,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [zoomStage]);

  return (
    <View style={styles.container}>
      <View style={styles.clipMask}>
        <Animated.View
          style={[
            styles.imageWrapper,
            { transform: [{ scale: scaleAnim }] },
          ]}
        >
          <View style={[styles.placeholder, { backgroundColor: imageColor }]}>
            <Animated.Text style={styles.initials}>{initials}</Animated.Text>
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipMask: {
    width: CONTAINER_SIZE,
    height: CONTAINER_SIZE,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#1A1A1A',
  },
  imageWrapper: {
    width: CONTAINER_SIZE,
    height: CONTAINER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: {
    width: CONTAINER_SIZE,
    height: CONTAINER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontSize: 80,
    fontWeight: '900',
    color: 'rgba(255,255,255,0.3)',
    letterSpacing: 4,
  },
});
