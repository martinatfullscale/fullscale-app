import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { PitchModeProvider } from "@/contexts/pitch-mode-context";
import { Loader2 } from "lucide-react";

import NotFound from "@/pages/not-found";
import Landing from "@/pages/Landing";
import Dashboard from "@/pages/Dashboard";
import Library from "@/pages/Library";
import Opportunities from "@/pages/Opportunities";
import BrandMarketplace from "@/pages/BrandMarketplace";
import Settings from "@/pages/Settings";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";

interface UserTypeResponse {
  email: string;
  userType: "creator" | "brand";
  companyName?: string;
}

function Router() {
  const { user, isLoading: isLoadingReplitAuth } = useAuth();
  const { isAuthenticated: isGoogleAuthenticated, isLoading: isLoadingGoogleAuth } = useHybridMode();
  const [location, setLocation] = useLocation();

  // User is authenticated if they have EITHER Replit Auth OR Google OAuth session
  const isAuthenticated = !!user || isGoogleAuthenticated;

  // Fetch user type for brand redirect
  const { data: userTypeData, isLoading: isLoadingUserType } = useQuery<UserTypeResponse>({
    queryKey: ["/api/auth/user-type"],
    enabled: isAuthenticated,
  });

  // Redirect brands to marketplace on initial load
  useEffect(() => {
    if (userTypeData?.userType === "brand" && location === "/") {
      setLocation("/marketplace");
    }
  }, [userTypeData, location, setLocation]);

  // Wait for auth systems to load
  if (isLoadingReplitAuth || isLoadingGoogleAuth) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  // Simple protection logic
  // If user is logged in (via either auth method) and on landing page, go to dashboard
  // If user is NOT logged in and tries to access dashboard, show landing
  
  if (!isAuthenticated) {
    return (
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        <Route path="/dashboard" component={Landing} />
        <Route path="/:rest*" component={Landing} />
      </Switch>
    );
  }

  // Show loading while checking user type for brand redirect
  if (isLoadingUserType && location === "/") {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/terms" component={Terms} />
      <Route path="/library" component={Library} />
      <Route path="/opportunities" component={Opportunities} />
      <Route path="/marketplace" component={BrandMarketplace} />
      <Route path="/settings" component={Settings} />
      <Route path="/earnings" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PitchModeProvider>
          <Toaster />
          <Router />
        </PitchModeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
