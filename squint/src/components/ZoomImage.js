import React, { useEffect, useRef, useState } from 'react';
import { View, Image, Animated, StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Image area fills most of the top portion — full width with small margins
const IMAGE_WIDTH = SCREEN_WIDTH - 16;
const IMAGE_HEIGHT = SCREEN_HEIGHT * 0.55;

/**
 * Zoom stage → scale factor.
 * FLIPPED: image starts TINY (you have to squint!) and grows each stage.
 * Stage 1: 5% size — nearly invisible, gotta squint hard
 * Stage 2: 15% — still tiny
 * Stage 3: 30% — starting to make it out
 * Stage 4: 55% — getting clearer
 * Stage 5: 100% — fully revealed
 */
const SCALE_BY_STAGE = {
  1: 0.05,
  2: 0.15,
  3: 0.30,
  4: 0.55,
  5: 1.0,
};

/** Blur radius per zoom stage — blurry when zoomed in, clear when revealed */
const BLUR_BY_STAGE = { 1: 12, 2: 8, 3: 4, 4: 1, 5: 0 };

/**
 * ZoomImage — renders a face image (or colored fallback) starting super tiny.
 * The image grows with each wrong guess — you literally have to squint to see it.
 *
 * Props:
 *   image       — image source (uri string, require(), or null)
 *   imageColor  — fallback background color
 *   initials    — fallback text when no image
 *   zoomStage   — current zoom stage (1-5)
 */
export default function ZoomImage({ image, imageColor, initials, zoomStage }) {
  const scaleAnim = useRef(new Animated.Value(SCALE_BY_STAGE[1])).current;
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    if (zoomStage === 1) {
      scaleAnim.setValue(SCALE_BY_STAGE[1]);
    } else {
      const targetScale = SCALE_BY_STAGE[zoomStage] || 1;
      Animated.spring(scaleAnim, {
        toValue: targetScale,
        tension: 40,
        friction: 7,
        useNativeDriver: true,
      }).start();
    }
  }, [zoomStage]);

  // Reset error state when image source changes
  useEffect(() => {
    setImageError(false);
  }, [image]);

  const hasImage = image && !imageError;
  const imageSource = typeof image === 'string' ? { uri: image } : image;

  return (
    <View style={styles.container}>
      <View style={styles.clipMask}>
        <Animated.View
          style={[
            styles.imageWrapper,
            { transform: [{ scale: scaleAnim }] },
          ]}
        >
          {hasImage ? (
            <Image
              source={imageSource}
              style={styles.image}
              resizeMode="cover"
              blurRadius={BLUR_BY_STAGE[zoomStage] || 0}
              onError={() => setImageError(true)}
            />
          ) : (
            <View style={[styles.placeholder, { backgroundColor: imageColor }]}>
              <Animated.Text style={styles.initials}>{initials}</Animated.Text>
            </View>
          )}
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
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#0D0D0D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageWrapper: {
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
  },
  placeholder: {
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  initials: {
    fontSize: 100,
    fontWeight: '900',
    color: 'rgba(255,255,255,0.25)',
    letterSpacing: 4,
  },
});
