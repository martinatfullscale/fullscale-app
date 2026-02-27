import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar } from 'react-native';

/**
 * StartScreen — landing page for Squint.
 * Shows the app name, tagline, and a single Play button.
 */
export default function StartScreen({ navigation }) {
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      <View style={styles.content}>
        {/* App title */}
        <Text style={styles.title}>SQUINT</Text>

        {/* Tagline */}
        <Text style={styles.tagline}>How fast can you see it?</Text>

        {/* Play button */}
        <TouchableOpacity
          style={styles.playButton}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('Game')}
        >
          <Text style={styles.playText}>Play</Text>
        </TouchableOpacity>
      </View>
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
  content: {
    alignItems: 'center',
  },
  title: {
    fontSize: 64,
    fontWeight: '900',
    color: '#F5E642',
    letterSpacing: 8,
    marginBottom: 12,
  },
  tagline: {
    fontSize: 18,
    color: '#888888',
    fontWeight: '600',
    marginBottom: 60,
  },
  playButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    paddingHorizontal: 80,
    borderRadius: 16,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0D0D0D',
  },
});
