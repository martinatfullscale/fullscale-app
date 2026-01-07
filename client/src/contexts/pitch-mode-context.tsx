import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface PitchModeContextType {
  isPitchMode: boolean;
  setPitchMode: (value: boolean) => void;
  togglePitchMode: () => void;
}

const PitchModeContext = createContext<PitchModeContextType | undefined>(undefined);

export function PitchModeProvider({ children }: { children: ReactNode }) {
  const [isPitchMode, setIsPitchMode] = useState(false);

  const setPitchMode = useCallback((value: boolean) => {
    setIsPitchMode(value);
  }, []);

  const togglePitchMode = useCallback(() => {
    setIsPitchMode(prev => !prev);
  }, []);

  return (
    <PitchModeContext.Provider value={{ isPitchMode, setPitchMode, togglePitchMode }}>
      {children}
    </PitchModeContext.Provider>
  );
}

export function usePitchMode() {
  const context = useContext(PitchModeContext);
  if (context === undefined) {
    throw new Error("usePitchMode must be used within a PitchModeProvider");
  }
  return context;
}
