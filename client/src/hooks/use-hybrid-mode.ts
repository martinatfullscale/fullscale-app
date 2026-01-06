import { useQuery } from "@tanstack/react-query";

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
  const { data: authStatus, isLoading } = useQuery<GoogleAuthStatus>({
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

  const isAuthenticated = authStatus?.authenticated ?? false;
  const mode: HybridMode = isAuthenticated ? "real" : "demo";
  const googleUser = authStatus?.user ?? null;

  return {
    mode,
    isAuthenticated,
    isLoading,
    googleUser,
  };
}
