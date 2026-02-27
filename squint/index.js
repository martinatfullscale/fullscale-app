import { registerRootComponent } from 'expo';

let App;
try {
  App = require('./App').default;
} catch (e) {
  const { Text, View } = require('react-native');
  App = () => (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0D0D0D' }}>
      <Text style={{ color: 'red', fontSize: 16, padding: 20 }}>{String(e)}</Text>
    </View>
  );
  console.error('Failed to load App:', e);
}

registerRootComponent(App);
