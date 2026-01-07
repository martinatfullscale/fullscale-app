import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { PitchModeProvider } from "@/contexts/pitch-mode-context";
import { Sidebar } from "@/components/Sidebar";
import { BrandSidebar } from "@/components/BrandSidebar";
import { Loader2 } from "lucide-react";

import NotFound from "@/pages/not-found";
import Landing from "@/pages/Landing";
import Dashboard from "@/pages/Dashboard";
import Library from "@/pages/Library";
import Opportunities from "@/pages/Opportunities";
import BrandMarketplace from "@/pages/BrandMarketplace";
import Campaigns from "@/pages/Campaigns";
import Settings from "@/pages/Settings";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";

interface UserTypeResponse {
  authenticated: boolean;
  email?: string;
  userType?: "creator" | "brand" | null;
  baseUserType?: "creator" | "brand";
  companyName?: string;
  isAdmin?: boolean;
  canSwitchRoles?: boolean;
}

function AuthenticatedLayout({ children, userType }: { children: React.ReactNode; userType: "creator" | "brand" }) {
  return (
    <div className="min-h-screen bg-background">
      {userType === "brand" ? <BrandSidebar /> : <Sidebar />}
      <main className="ml-64">
        {children}
      </main>
    </div>
  );
}

function Router() {
  const { user, isLoading: isLoadingReplitAuth } = useAuth();
  const { isAuthenticated: isGoogleAuthenticated, isLoading: isLoadingGoogleAuth } = useHybridMode();
  const [location, setLocation] = useLocation();

  const isAuthenticated = !!user || isGoogleAuthenticated;

  const { data: userTypeData, isLoading: isLoadingUserType } = useQuery<UserTypeResponse>({
    queryKey: ["/api/auth/user-type"],
    enabled: isAuthenticated,
    retry: false,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (userTypeData?.userType === "brand" && location === "/") {
      setLocation("/marketplace");
    }
    // Sidebar guard: redirect if role doesn't match current URL
    if (userTypeData?.userType === "creator" && location === "/marketplace") {
      window.location.href = "/dashboard";
    }
    if (userTypeData?.userType === "brand" && (location === "/dashboard" || location === "/library" || location === "/opportunities")) {
      window.location.href = "/marketplace";
    }
  }, [userTypeData, location, setLocation]);

  if (isLoadingReplitAuth || isLoadingGoogleAuth) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

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

  if (isLoadingUserType && location === "/") {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  const currentRole = userTypeData?.userType || "creator";

  return (
    <AuthenticatedLayout userType={currentRole}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        <Route path="/library" component={Library} />
        <Route path="/opportunities" component={Opportunities} />
        <Route path="/marketplace" component={BrandMarketplace} />
        <Route path="/campaigns" component={Campaigns} />
        <Route path="/settings" component={Settings} />
        <Route path="/earnings" component={Dashboard} />
        <Route component={NotFound} />
      </Switch>
    </AuthenticatedLayout>
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
