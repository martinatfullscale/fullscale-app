import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import StartScreen from './src/screens/StartScreen';
import GameScreen from './src/screens/GameScreen';
import ScoreScreen from './src/screens/ScoreScreen';

const Stack = createNativeStackNavigator();

/**
 * Squint — a trivia game where you guess famous people from zoomed-in images.
 * Navigation flow: Start → Game → Score → Start (loop)
 */
export default function App() {
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
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
