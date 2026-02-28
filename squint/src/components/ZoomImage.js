import React, { useEffect, useRef, useState } from 'react';
import { View, Image, Animated, StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Image area fills most of the top portion — full width with small margins
const IMAGE_WIDTH = SCREEN_WIDTH - 16;
const IMAGE_HEIGHT = SCREEN_HEIGHT * 0.55;

/**
 * Zoom stage → scale factor.
 * Higher scale = more zoomed in, less visible.
 */
const SCALE_BY_STAGE = {
  1: 3.5,
  2: 2.35,
  3: 1.77,
  4: 1.35,
  5: 1.0,
};

/**
 * ZoomImage — renders a face image (or colored fallback) at varying zoom levels.
 * Fills the top portion of the screen edge-to-edge.
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
      Animated.timing(scaleAnim, {
        toValue: targetScale,
        duration: 300,
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
    backgroundColor: '#1A1A1A',
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
  },
  initials: {
    fontSize: 100,
    fontWeight: '900',
    color: 'rgba(255,255,255,0.25)',
    letterSpacing: 4,
  },
});
