import { registerRootComponent } from 'expo';
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>SQUINT</Text>
      <Text style={styles.sub}>Loading test...</Text>
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
  title: {
    fontSize: 64,
    fontWeight: '900',
    color: '#F5E642',
  },
  sub: {
    fontSize: 18,
    color: '#888',
    marginTop: 12,
  },
});

export default App;
registerRootComponent(App);
