import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { Loader2 } from "lucide-react";

import NotFound from "@/pages/not-found";
import Landing from "@/pages/Landing";
import Dashboard from "@/pages/Dashboard";
import Library from "@/pages/Library";
import Opportunities from "@/pages/Opportunities";
import Settings from "@/pages/Settings";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";

function Router() {
  const { user, isLoading: isLoadingReplitAuth } = useAuth();
  const { isAuthenticated: isGoogleAuthenticated, isLoading: isLoadingGoogleAuth } = useHybridMode();
  const [location, setLocation] = useLocation();

  // Wait for both auth systems to load
  if (isLoadingReplitAuth || isLoadingGoogleAuth) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  // User is authenticated if they have EITHER Replit Auth OR Google OAuth session
  const isAuthenticated = !!user || isGoogleAuthenticated;

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

  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/terms" component={Terms} />
      <Route path="/library" component={Library} />
      <Route path="/opportunities" component={Opportunities} />
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
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
