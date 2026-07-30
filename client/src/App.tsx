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
import CreatorProfile from "@/pages/CreatorProfile";
import BrandProducts from "@/pages/BrandProducts";
import SavedPlacements from "@/pages/SavedPlacements";
import PlacementInbox from "@/pages/PlacementInbox";
import BrandClipsBrowser from "@/pages/BrandClipsBrowser";
import BrandPlacementRequests from "@/pages/BrandPlacementRequests";
import CreatorAnalytics from "@/pages/CreatorAnalytics";
import AdminCreatorIntelligence from "@/pages/AdminCreatorIntelligence";
import AdminDataInventory from "@/pages/AdminDataInventory";
import RemixEngine from "@/components/RemixEngine";
import SharedView from "@/pages/SharedView";
import ComingSoon from "@/pages/ComingSoon";
import FullScaleCreates from "@/pages/FullScaleCreates";
import Brands from "@/pages/Brands";
import BrandOnboarding from "@/pages/BrandOnboarding";
import BrandSignUp from "@/pages/BrandSignUp";
import StudioUpload from "@/pages/StudioUpload";
import FullScaleStudio from "@/pages/FullScaleStudio";
import StudioPricing from "@/pages/StudioPricing";
import StudioLibrary from "@/pages/StudioLibrary";
import StudioWaitlistPage from "@/pages/StudioWaitlistPage";

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

function StudioAccessGuard({ children }: { children: React.ReactNode }) {
  const [, setLocation] = useLocation();
  const { data: studioMe, isLoading } = useQuery<{ hasStudioAccess?: boolean; authenticated?: boolean }>({
    queryKey: ["/api/studio/me"],
    staleTime: 30000,
    retry: false,
  });

  useEffect(() => {
    if (!isLoading && studioMe?.authenticated && !studioMe.hasStudioAccess) {
      setLocation("/studio/waitlist");
    }
  }, [studioMe, isLoading, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}

function Router() {
  const { user, isLoading: isLoadingReplitAuth } = useAuth();
  const { isAuthenticated: isGoogleAuthenticated, isLoading: isLoadingGoogleAuth } = useHybridMode();
  const [location, setLocation] = useLocation();

  // Admin email bypass for LOCAL DEV ONLY. In production this was a URL-param
  // auth bypass: ?admin_email=<known admin> set isAuthenticated=true with no
  // session, exposing an authenticated-looking (but broken) shell and leaking
  // the admin list in the bundle. Gated behind a non-production hostname so it
  // works for local dev and is dead on gofullscale.co. (Server data-gating
  // already holds regardless; this just closes the client-side shell.)
  const isDevHost = window.location.hostname !== "gofullscale.co";
  const ADMIN_EMAILS = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com'];
  const urlParams = new URLSearchParams(window.location.search);
  const adminEmailFromUrl = urlParams.get('admin_email') || '';
  const isAdminBypass = isDevHost && ADMIN_EMAILS.includes(adminEmailFromUrl);

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
    // Brand users get bounced off creator-side pages — UNLESS they're
    // explicitly viewing another user's library via ?as=<email>. The
    // server-side view-as check (admin OR LIBRARY_VIEW_GRANTS) gates the
    // data; we just need to NOT redirect them away before the page renders.
    const hasViewAsParam = typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("as");
    if (
      userTypeData?.userType === "brand" &&
      (location === "/dashboard" || location === "/library" || location === "/opportunities") &&
      !(location === "/library" && hasViewAsParam)
    ) {
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
        {/* /content redirects to /creates for backward compat */}
        <Route path="/content">{() => { window.location.replace("/creates"); return null; }}</Route>
        <Route path="/studio" component={FullScaleStudio} />
        <Route path="/studio/pricing" component={StudioPricing} />
        <Route path="/studio/waitlist" component={StudioWaitlistPage} />
        <Route path="/studio/upload">{() => <StudioAccessGuard><StudioUpload /></StudioAccessGuard>}</Route>
        <Route path="/studio/library">{() => <StudioAccessGuard><StudioLibrary /></StudioAccessGuard>}</Route>
        <Route path="/creates" component={FullScaleCreates} />
        <Route path="/brands" component={Brands} />
        <Route path="/brands/onboarding" component={BrandOnboarding} />
        <Route path="/brand-signup" component={BrandSignUp} />
        <Route path="/about" component={ComingSoon} />
        <Route path="/waitlist" component={WaitlistPage} />
        <Route path="/c/:slug" component={CreatorProfile} />
        <Route path="/s/:slug" component={SharedView} />
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

  // User is authenticated but not approved - allow public marketing pages
  // and waitlist; everything else bounces to waitlist via the catch-all.
  // Without these explicit routes the "Continue Later" button on the
  // waitlist page looks broken: it hard-navigates to /creates but the
  // catch-all here catches /creates and re-renders WaitlistPage.
  if (authStatus && !authStatus.isApproved && !isAdminBypass) {
    return (
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/creates" component={FullScaleCreates} />
        <Route path="/brands" component={Brands} />
        <Route path="/brand-signup" component={BrandSignUp} />
        <Route path="/about" component={ComingSoon} />
        <Route path="/c/:slug" component={CreatorProfile} />
        <Route path="/s/:slug" component={SharedView} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        <Route path="/waitlist" component={WaitlistPage} />
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
      <Route path="/content">{() => { window.location.replace("/creates"); return null; }}</Route>
      <Route path="/studio" component={FullScaleStudio} />
      <Route path="/studio/pricing" component={StudioPricing} />
      <Route path="/studio/waitlist" component={StudioWaitlistPage} />
      <Route path="/creates" component={FullScaleCreates} />
      <Route path="/brands" component={Brands} />
      <Route path="/brands/onboarding" component={BrandOnboarding} />
      <Route path="/brand-signup" component={BrandSignUp} />
      <Route path="/about" component={ComingSoon} />
      <Route path="/c/:slug" component={CreatorProfile} />
      <Route path="/s/:slug" component={SharedView} />
      <Route path="/remix/:videoId" component={RemixEngine} />
      <Route path="/studio/upload" component={StudioUpload} />
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
              <Route path="/brand-products" component={BrandProducts} />
              <Route path="/saved-placements" component={SavedPlacements} />
              <Route path="/inbox" component={PlacementInbox} />
              <Route path="/analytics" component={CreatorAnalytics} />
              <Route path="/admin/creators" component={AdminCreatorIntelligence} />
              <Route path="/admin/data-inventory" component={AdminDataInventory} />
              <Route path="/brand/clips" component={BrandClipsBrowser} />
              <Route path="/brand/placements" component={BrandPlacementRequests} />
              <Route path="/settings" component={Settings} />
              <Route path="/earnings" component={Dashboard} />
              <Route path="/studio/upload">{() => <StudioAccessGuard><StudioUpload /></StudioAccessGuard>}</Route>
              <Route path="/studio/library">{() => <StudioAccessGuard><StudioLibrary /></StudioAccessGuard>}</Route>
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
