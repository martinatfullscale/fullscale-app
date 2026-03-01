import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const MAX_PLAYERS = 4;

/**
 * GameModePopup — popup for choosing Solo or Elimination (multiplayer) mode.
 * In Elimination mode, players enter their names (2-4 players).
 *
 * Props:
 *   visible        — whether the modal is shown
 *   onStartSolo    — callback() for solo mode
 *   onStartMulti   — callback(players: string[]) for elimination mode
 *   onClose        — callback to dismiss
 */
export default function GameModePopup({ visible, onStartSolo, onStartMulti, onClose }) {
  const [mode, setMode] = useState(null); // null | 'solo' | 'elimination'
  const [players, setPlayers] = useState(['', '']);
  const [soloName, setSoloName] = useState('');

  const handleAddPlayer = () => {
    if (players.length < MAX_PLAYERS) {
      setPlayers([...players, '']);
    }
  };

  const handleRemovePlayer = (index) => {
    if (players.length > 2) {
      setPlayers(players.filter((_, i) => i !== index));
    }
  };

  const handlePlayerName = (text, index) => {
    const updated = [...players];
    updated[index] = text;
    setPlayers(updated);
  };

  const handleStartElimination = () => {
    const validPlayers = players.map((p, i) => p.trim() || `Player ${i + 1}`);
    onStartMulti(validPlayers);
    resetState();
  };

  const handleStartSolo = () => {
    onStartSolo(soloName.trim() || 'Player');
    resetState();
  };

  const resetState = () => {
    setMode(null);
    setPlayers(['', '']);
    setSoloName('');
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity style={styles.backdrop} onPress={handleClose} activeOpacity={1} />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          {/* Mode selection */}
          {mode === null && (
            <View style={styles.content}>
              <Text style={styles.title}>Game Mode</Text>

              <TouchableOpacity
                style={styles.modeCard}
                activeOpacity={0.7}
                onPress={() => setMode('solo')}
              >
                <Text style={styles.modeIcon}>🎯</Text>
                <View style={styles.modeInfo}>
                  <Text style={styles.modeName}>Solo</Text>
                  <Text style={styles.modeDesc}>Classic mode — test your eyes</Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modeCard, styles.eliminationCard]}
                activeOpacity={0.7}
                onPress={() => setMode('elimination')}
              >
                <Text style={styles.modeIcon}>💀</Text>
                <View style={styles.modeInfo}>
                  <Text style={styles.modeName}>Elimination</Text>
                  <Text style={styles.modeDesc}>
                    Squid Game style — lowest scorer each round faces elimination
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          )}

          {/* Solo name entry */}
          {mode === 'solo' && (
            <View style={styles.content}>
              <Text style={styles.title}>Enter Your Name</Text>

              <TextInput
                style={styles.nameInput}
                placeholder="Your name"
                placeholderTextColor="#555"
                value={soloName}
                onChangeText={setSoloName}
                maxLength={20}
                autoFocus
              />

              <TouchableOpacity
                style={styles.startButton}
                activeOpacity={0.8}
                onPress={handleStartSolo}
              >
                <Text style={styles.startText}>Let's Go</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setMode(null)} style={styles.backButton}>
                <Text style={styles.backText}>← Back</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Elimination player setup */}
          {mode === 'elimination' && (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              <Text style={styles.title}>💀 Elimination Mode</Text>
              <Text style={styles.subtitle}>
                Lowest scorer each round faces a sudden-death challenge. Miss it and you're OUT.
              </Text>

              {players.map((name, index) => (
                <View key={index} style={styles.playerRow}>
                  <View style={[styles.playerDot, { backgroundColor: PLAYER_COLORS[index] }]} />
                  <TextInput
                    style={styles.playerInput}
                    placeholder={`Player ${index + 1}`}
                    placeholderTextColor="#555"
                    value={name}
                    onChangeText={(text) => handlePlayerName(text, index)}
                    maxLength={20}
                  />
                  {players.length > 2 && (
                    <TouchableOpacity onPress={() => handleRemovePlayer(index)} style={styles.removeBtn}>
                      <Text style={styles.removeBtnText}>✕</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}

              {players.length < MAX_PLAYERS && (
                <TouchableOpacity style={styles.addPlayerBtn} onPress={handleAddPlayer}>
                  <Text style={styles.addPlayerText}>+ Add Player</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[styles.startButton, styles.eliminationStart]}
                activeOpacity={0.8}
                onPress={handleStartElimination}
              >
                <Text style={styles.startText}>Begin Elimination</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setMode(null)} style={styles.backButton}>
                <Text style={styles.backText}>← Back</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const PLAYER_COLORS = ['#F5E642', '#FF4444', '#4CAF50', '#2196F3'];

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  sheet: {
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: SCREEN_HEIGHT * 0.8,
    paddingBottom: 40,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#555',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 15,
    color: '#888',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0D0D0D',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 2,
    borderColor: '#F5E642',
  },
  eliminationCard: {
    borderColor: '#E74C3C',
  },
  modeIcon: {
    fontSize: 36,
    marginRight: 16,
  },
  modeInfo: {
    flex: 1,
  },
  modeName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  modeDesc: {
    fontSize: 14,
    color: '#888',
    lineHeight: 20,
  },
  nameInput: {
    backgroundColor: '#0D0D0D',
    borderRadius: 12,
    padding: 16,
    fontSize: 18,
    color: '#FFFFFF',
    fontWeight: '700',
    marginBottom: 24,
    borderWidth: 2,
    borderColor: '#333',
    textAlign: 'center',
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  playerDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    marginRight: 12,
  },
  playerInput: {
    flex: 1,
    backgroundColor: '#0D0D0D',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '700',
    borderWidth: 2,
    borderColor: '#333',
  },
  removeBtn: {
    marginLeft: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E74C3C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  addPlayerBtn: {
    borderWidth: 2,
    borderColor: '#333',
    borderStyle: 'dashed',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginBottom: 24,
  },
  addPlayerText: {
    color: '#888',
    fontSize: 16,
    fontWeight: '700',
  },
  startButton: {
    backgroundColor: '#F5E642',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  eliminationStart: {
    backgroundColor: '#E74C3C',
  },
  startText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0D0D0D',
  },
  backButton: {
    padding: 12,
    alignItems: 'center',
  },
  backText: {
    color: '#888',
    fontSize: 16,
    fontWeight: '600',
  },
});
