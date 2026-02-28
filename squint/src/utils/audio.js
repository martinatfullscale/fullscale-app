/**
 * Audio manager for Squint.
 * Handles background music and sound effects using expo-av.
 *
 * SETUP: Add your audio files to assets/audio/ and update the paths below.
 * Supported formats: .mp3, .wav, .m4a
 */
import { Audio } from 'expo-av';

let bgMusic = null;
let isMuted = false;

/**
 * Initialize audio settings for background playback.
 */
export async function initAudio() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
  } catch (e) {
    console.warn('Audio init failed:', e);
  }
}

/**
 * Play background music (looped).
 * Uses a built-in generative tone as placeholder.
 */
export async function playBackgroundMusic() {
  try {
    if (bgMusic) {
      await bgMusic.playAsync();
      return;
    }
    // Placeholder: silent loop — replace with your music file
    // Example: const { sound } = await Audio.Sound.createAsync(require('../../assets/audio/bgm.mp3'));
    const { sound } = await Audio.Sound.createAsync(
      // Using a tiny silent audio as placeholder since we can't bundle music files
      // Replace this with: require('../../assets/audio/background.mp3')
      { uri: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGFOYQAAAABkYXRhAAAAAA==' },
      { isLooping: true, volume: 0.3, isMuted }
    );
    bgMusic = sound;
    await bgMusic.playAsync();
  } catch (e) {
    console.warn('BG music failed:', e);
  }
}

/**
 * Stop and unload background music.
 */
export async function stopBackgroundMusic() {
  try {
    if (bgMusic) {
      await bgMusic.stopAsync();
      await bgMusic.unloadAsync();
      bgMusic = null;
    }
  } catch (e) {
    console.warn('Stop BG music failed:', e);
  }
}

/**
 * Play a short sound effect.
 * @param {'correct'|'wrong'|'tick'|'eliminate'|'victory'} type
 */
export async function playSFX(type) {
  if (isMuted) return;

  try {
    // Placeholder sounds — replace with actual sound files
    // Example: const source = require('../../assets/audio/correct.mp3');
    const { sound } = await Audio.Sound.createAsync(
      { uri: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGFOYQAAAABkYXRhAAAAAA==' },
      { volume: type === 'eliminate' ? 0.8 : 0.5 }
    );
    await sound.playAsync();
    // Auto-unload after playing
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.didJustFinish) {
        sound.unloadAsync();
      }
    });
  } catch (e) {
    console.warn(`SFX ${type} failed:`, e);
  }
}

/**
 * Toggle mute state.
 * @returns {boolean} New mute state
 */
export async function toggleMute() {
  isMuted = !isMuted;
  try {
    if (bgMusic) {
      await bgMusic.setIsMutedAsync(isMuted);
    }
  } catch (e) {
    console.warn('Toggle mute failed:', e);
  }
  return isMuted;
}

/**
 * Get current mute state.
 */
export function getMuteState() {
  return isMuted;
}
