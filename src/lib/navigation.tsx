import { createContext, useContext, type ReactNode } from "react";
import type { ScreenId } from "../types";

interface NavigationState {
  navigate: (screen: ScreenId) => void;
}

const NavigationContext = createContext<NavigationState | null>(null);

export function NavigationProvider({
  navigate,
  children,
}: {
  navigate: (screen: ScreenId) => void;
  children: ReactNode;
}) {
  return (
    <NavigationContext.Provider value={{ navigate }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): NavigationState {
  const ctx = useContext(NavigationContext);
  if (!ctx)
    throw new Error("useNavigation must be used within a NavigationProvider");
  return ctx;
}
