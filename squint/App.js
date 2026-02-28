import { registerRootComponent } from 'expo';
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import StartScreen from './src/screens/StartScreen';
import GameScreen from './src/screens/GameScreen';
import ScoreScreen from './src/screens/ScoreScreen';
import LeaderboardScreen from './src/screens/LeaderboardScreen';

const Stack = createNativeStackNavigator();

/**
 * Squint — a trivia game where you guess famous people from zoomed-in images.
 * Supports solo and elimination (multiplayer) modes with 10 cultural categories.
 * Navigation: Start → Game → Score → Start (loop), with Leaderboard accessible from Start & Score.
 */
function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Start"
          screenOptions={{
            headerShown: false,
            animation: 'fade',
            contentStyle: { backgroundColor: '#0D0D0D' },
          }}
        >
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
