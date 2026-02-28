import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  Dimensions,
} from 'react-native';
import { getCategoryList } from '../data/categories';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

/**
 * CategoryPicker — a popup modal for selecting a game category.
 * Slides up from the bottom with a dark overlay.
 *
 * Props:
 *   visible   — whether the modal is shown
 *   onSelect  — callback(categoryId) when a category is picked; null = "All"
 *   onClose   — callback to dismiss without selecting
 */
export default function CategoryPicker({ visible, onSelect, onClose }) {
  const categories = getCategoryList();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} onPress={onClose} activeOpacity={1} />

        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>Pick a Category</Text>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* All Categories option */}
            <TouchableOpacity
              style={[styles.categoryCard, { borderColor: '#F5E642' }]}
              activeOpacity={0.7}
              onPress={() => onSelect(null)}
            >
              <Text style={styles.categoryIcon}>🎯</Text>
              <Text style={styles.categoryName}>All Categories</Text>
              <Text style={styles.categoryCount}>100 faces</Text>
            </TouchableOpacity>

            {/* Individual categories */}
            {categories.map((cat) => (
              <TouchableOpacity
                key={cat.id}
                style={[styles.categoryCard, { borderColor: cat.color }]}
                activeOpacity={0.7}
                onPress={() => onSelect(cat.id)}
              >
                <Text style={styles.categoryIcon}>{cat.icon}</Text>
                <Text style={styles.categoryName}>{cat.name}</Text>
                <Text style={styles.categoryCount}>10 faces</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

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
    maxHeight: SCREEN_HEIGHT * 0.75,
    paddingBottom: 40,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#555',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '900',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 20,
    letterSpacing: 1,
  },
  scroll: {
    paddingHorizontal: 20,
  },
  scrollContent: {
    gap: 12,
    paddingBottom: 20,
  },
  categoryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0D0D0D',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 20,
    borderWidth: 2,
  },
  categoryIcon: {
    fontSize: 28,
    marginRight: 16,
  },
  categoryName: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  categoryCount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#888888',
  },
});
