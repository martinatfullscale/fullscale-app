import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

const EYE_TEST_KEY = '@squint/eyeTestSeen';

const EYE_CHART_ROWS = [
  { letters: 'S', size: 72 },
  { letters: 'Q  U', size: 54 },
  { letters: 'I  N  T', size: 40 },
  { letters: 'E  Y  E  S', size: 28 },
  { letters: 'C  A  N   Y  O  U', size: 20 },
  { letters: 'R  E  A  D   T  H  I  S', size: 14 },
  { letters: 'Y O U  D E F I N I T E L Y  N E E D  G L A S S E S', size: 8 },
];

/**
 * EyeTestScreen — a tongue-in-cheek "visual acuity test" shown on first launch.
 * Features a progressively smaller eye chart that spells out a joke,
 * a funny pharmaceutical-style warning, and a proceed button.
 * Uses AsyncStorage to only show once.
 */
export default function EyeTestScreen({ navigation }) {
  const handleProceed = async () => {
    try {
      await AsyncStorage.setItem(EYE_TEST_KEY, 'true');
    } catch (e) {
      // Silently fail — worst case they see it again
    }
    navigation.replace('Start');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Text style={styles.header}>VISUAL ACUITY TEST</Text>

        {/* Eye chart */}
        <View style={styles.chartContainer}>
          {EYE_CHART_ROWS.map((row, i) => (
            <Text
              key={i}
              style={[
                styles.chartRow,
                { fontSize: row.size },
                i === 0 && { color: '#F5E642' },
              ]}
            >
              {row.letters}
            </Text>
          ))}
        </View>

        {/* Warning */}
        <View style={styles.warningBox}>
          <Text style={styles.warningLabel}>WARNING</Text>
          <Text style={styles.warningText}>
            This game may confirm what your optometrist has been telling you
          </Text>
        </View>

        {/* Side effects */}
        <Text style={styles.sideEffects}>
          Side effects may include: squinting, holding your phone at arm's
          length, accidentally texting your eye doctor, and the sudden urge
          to buy reading glasses
        </Text>

        {/* Proceed button */}
        <TouchableOpacity
          style={styles.proceedButton}
          onPress={handleProceed}
          activeOpacity={0.8}
        >
          <Text style={styles.proceedText}>I Can See Just Fine</Text>
        </TouchableOpacity>

        {/* Fine print */}
        <Text style={styles.finePrint}>
          Squint is not a substitute for an actual eye exam.
          {'\n'}But let's be honest, you probably need one.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  header: {
    fontSize: 14,
    fontWeight: '700',
    color: '#888888',
    letterSpacing: 6,
    marginBottom: 30,
  },
  chartContainer: {
    alignItems: 'center',
    marginBottom: 36,
    gap: 8,
  },
  chartRow: {
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: 4,
    textAlign: 'center',
  },
  warningBox: {
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#F5E642',
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 20,
    width: '100%',
    alignItems: 'center',
  },
  warningLabel: {
    fontSize: 14,
    fontWeight: '900',
    color: '#F5E642',
    letterSpacing: 4,
    marginBottom: 8,
  },
  warningText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 24,
  },
  sideEffects: {
    fontSize: 13,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 20,
    fontStyle: 'italic',
    marginBottom: 36,
    paddingHorizontal: 12,
  },
  proceedButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    paddingHorizontal: 48,
    borderRadius: 16,
    marginBottom: 24,
  },
  proceedText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0D0D0D',
  },
  finePrint: {
    fontSize: 11,
    color: '#555555',
    textAlign: 'center',
    lineHeight: 16,
  },
});
