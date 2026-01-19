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
import ReactGA from "react-ga4";

ReactGA.initialize(import.meta.env.VITE_GOOGLE_ANALYTICS_ID || "G-DEMO12345");

import NotFound from "@/pages/not-found";
import Landing from "@/pages/Landing";
import AuthPage from "@/pages/AuthPage";
import WaitlistPage from "@/pages/WaitlistPage";
import Dashboard from "@/pages/Dashboard";
import Library from "@/pages/Library";
import Opportunities from "@/pages/Opportunities";
import BrandMarketplace from "@/pages/BrandMarketplace";
import Campaigns from "@/pages/Campaigns";
import Settings from "@/pages/Settings";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";

interface AuthStatusResponse {
  authenticated: boolean;
  email?: string;
  isApproved?: boolean;
}

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

  // Admin email bypass for dev/testing (same list as Library.tsx)
  const ADMIN_EMAILS = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com'];
  const urlParams = new URLSearchParams(window.location.search);
  const adminEmailFromUrl = urlParams.get('admin_email') || '';
  const isAdminBypass = ADMIN_EMAILS.includes(adminEmailFromUrl);
  
  const isAuthenticated = !!user || isGoogleAuthenticated || isAdminBypass;

  useEffect(() => {
    ReactGA.send({ hitType: "pageview", page: location });
  }, [location]);

  // Check approval status for waitlist gating
  const { data: authStatus, isLoading: isLoadingAuthStatus } = useQuery<AuthStatusResponse>({
    queryKey: ["/api/auth/status"],
    enabled: isAuthenticated,
    retry: false,
    staleTime: 10000,
    refetchOnWindowFocus: true,
  });

  const { data: userTypeData, isLoading: isLoadingUserType } = useQuery<UserTypeResponse>({
    queryKey: ["/api/auth/user-type"],
    enabled: isAuthenticated && authStatus?.isApproved === true,
    retry: false,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  // Protected routes that require approval
  const protectedRoutes = ["/dashboard", "/library", "/opportunities", "/marketplace", "/campaigns", "/settings", "/earnings", "/upload"];
  const isProtectedRoute = protectedRoutes.some(route => location === route || location === "/");

  // Redirect based on approval status (skip for admin bypass)
  useEffect(() => {
    // Admin bypass skips approval check
    if (isAdminBypass) return;
    
    if (isAuthenticated && authStatus && !isLoadingAuthStatus) {
      // Redirect unapproved users to waitlist
      if (!authStatus.isApproved && isProtectedRoute && location !== "/waitlist") {
        setLocation("/waitlist");
      }
      // Redirect approved users away from waitlist
      if (authStatus.isApproved && location === "/waitlist") {
        setLocation("/dashboard");
      }
    }
  }, [authStatus, isAuthenticated, isLoadingAuthStatus, location, isProtectedRoute, setLocation, isAdminBypass]);

  useEffect(() => {
    // Only do role-based redirects if user is approved
    if (!authStatus?.isApproved || !userTypeData) return;
    
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
  }, [authStatus, userTypeData, location, setLocation]);

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
        <Route path="/auth" component={AuthPage} />
        <Route path="/login" component={AuthPage} />
        <Route path="/signup" component={AuthPage} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        <Route path="/waitlist" component={WaitlistPage} />
        <Route path="/dashboard" component={Landing} />
        <Route path="/:rest*" component={Landing} />
      </Switch>
    );
  }

  // Show loading while checking approval status (skip for admin bypass)
  if (isLoadingAuthStatus && !isAdminBypass) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  // User is authenticated but not approved - show waitlist (skip for admin bypass)
  if (authStatus && !authStatus.isApproved && !isAdminBypass) {
    // Redirect to waitlist if not already there (effect handles this)
    return (
      <Switch>
        <Route path="/waitlist" component={WaitlistPage} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        <Route component={WaitlistPage} />
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
    <Switch>
      <Route path="/home" component={Landing} />
      <Route>
        {() => (
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
        )}
      </Route>
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
