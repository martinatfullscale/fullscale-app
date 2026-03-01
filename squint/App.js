import { registerRootComponent } from 'expo';
import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import EyeTestScreen from './src/screens/EyeTestScreen';
import StartScreen from './src/screens/StartScreen';
import GameScreen from './src/screens/GameScreen';
import ScoreScreen from './src/screens/ScoreScreen';
import LeaderboardScreen from './src/screens/LeaderboardScreen';

const Stack = createNativeStackNavigator();
const EYE_TEST_KEY = '@squint/eyeTestSeen';

/**
 * Squint — a trivia game where you guess famous people from zoomed-in images.
 * Supports solo and elimination (multiplayer) modes with 10 cultural categories.
 * Navigation: EyeTest (first launch) → Start → Game → Score → Start (loop),
 * with Leaderboard accessible from Start & Score.
 */
function App() {
  const [isReady, setIsReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState('Start');

  useEffect(() => {
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(EYE_TEST_KEY);
        if (!seen) setInitialRoute('EyeTest');
      } catch (e) {
        // On error, skip eye test
      }
      setIsReady(true);
    })();
  }, []);

  if (!isReady) return null;

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName={initialRoute}
          screenOptions={{
            headerShown: false,
            animation: 'fade',
            contentStyle: { backgroundColor: '#0D0D0D' },
          }}
        >
          <Stack.Screen name="EyeTest" component={EyeTestScreen} />
          <Stack.Screen name="Start" component={StartScreen} />
          <Stack.Screen name="Game" component={GameScreen} />
          <Stack.Screen name="Score" component={ScoreScreen} />
          <Stack.Screen name="Leaderboard" component={LeaderboardScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default App;
registerRootComponent(App);
