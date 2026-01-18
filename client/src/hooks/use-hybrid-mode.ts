import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./use-auth";

interface GoogleAuthStatus {
  authenticated: boolean;
  user?: {
    email: string;
    name: string;
    picture: string;
  };
}

export type HybridMode = "demo" | "real";

export function useHybridMode() {
  // Check session-based auth (Replit OIDC, Facebook, etc.)
  const { user: sessionUser, isLoading: isSessionLoading } = useAuth();
  
  // Check Google OAuth status
  const { data: authStatus, isLoading: isGoogleLoading } = useQuery<GoogleAuthStatus>({
    queryKey: ["/api/auth/google/status"],
    queryFn: async () => {
      const res = await fetch("/api/auth/google/status", { credentials: "include" });
      if (!res.ok) {
        return { authenticated: false };
      }
      return res.json();
    },
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  const isGoogleAuthenticated = authStatus?.authenticated ?? false;
  const isSessionAuthenticated = !!sessionUser;
  
  // User is in "real" mode if authenticated via ANY method (Google OAuth OR session)
  const isAuthenticated = isGoogleAuthenticated || isSessionAuthenticated;
  const mode: HybridMode = isAuthenticated ? "real" : "demo";
  const googleUser = authStatus?.user ?? null;

  return {
    mode,
    isAuthenticated,
    isLoading: isGoogleLoading || isSessionLoading,
    googleUser,
    // Expose which auth method is being used
    authMethod: isGoogleAuthenticated ? "google" : (isSessionAuthenticated ? "session" : null),
  };
}
