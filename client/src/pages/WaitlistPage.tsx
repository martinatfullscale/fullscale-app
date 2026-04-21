import { useLocation } from "wouter";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LogOut, Loader2, X, Home } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

interface AuthStatus {
  authenticated: boolean;
  email?: string;
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  isApproved?: boolean;
}

export default function WaitlistPage() {
  const [, setLocation] = useLocation();

  const { data: authStatus, isLoading } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      window.location.href = "/";
    },
  });

  const handleLogout = () => {
    logoutMutation.mutate();
  };

  // Escape hatch: navigate to the public creator marketing page.
  // Uses hard navigation (window.location.href) to bypass the SPA auth guard
  // that would otherwise bounce unapproved users back to /waitlist.
  const handleContinueLater = () => {
    // If approved, go to dashboard. Otherwise to the public /creates page.
    if (authStatus?.isApproved) {
      window.location.href = "/dashboard";
    } else {
      window.location.href = "/creates";
    }
  };

  // Defensive redirect: if an approved user somehow lands here, bounce to dashboard.
  useEffect(() => {
    if (authStatus?.isApproved) {
      window.location.href = "/dashboard";
    }
  }, [authStatus?.isApproved]);

  const getAirtableUrl = () => {
    const baseUrl = "https://airtable.com/embed/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form";
    
    if (!authStatus?.email) return baseUrl;
    
    const fullName = [authStatus.firstName, authStatus.lastName]
      .filter(Boolean)
      .join(" ") || authStatus.name || "";
    
    const params = new URLSearchParams();
    if (fullName) params.set("prefill_Name", fullName);
    if (authStatus.email) params.set("prefill_Email", authStatus.email);
    
    return `${baseUrl}?${params.toString()}`;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between p-4 border-b border-border/50">
        <img
          src={logoUrl}
          alt="FullScale"
          className="h-8 cursor-pointer"
          onClick={handleContinueLater}
          data-testid="img-logo"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleContinueLater}
            data-testid="button-continue-later"
          >
            <Home className="w-4 h-4 mr-2" />
            {authStatus?.isApproved ? "Go to Dashboard" : "Continue Later"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            {logoutMutation.isPending ? "Logging out..." : "Logout"}
          </Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center p-4 pt-8 overflow-auto">
        <div className="w-full max-w-2xl text-center mb-6 shrink-0">
          <h1 
            className="text-2xl font-bold text-foreground mb-2"
            data-testid="text-waitlist-title"
          >
            Step 2: Complete Your Creator Profile
          </h1>
          <p 
            className="text-muted-foreground"
            data-testid="text-waitlist-info"
          >
            Your account has been created. Please complete this form to access the FullScale Dashboard.
          </p>
          <p className="text-sm text-muted-foreground/70 mt-2">
            Don't have time now? Click "Continue Later" to come back and finish this anytime.
          </p>
        </div>

        <Card className="w-full max-w-2xl border-border/50 shrink-0">
          <CardContent className="p-0">
            <iframe
              src={getAirtableUrl()}
              width="100%"
              style={{ height: "1200px", border: "none", borderRadius: "8px" }}
              title="Creator Profile Form"
              data-testid="iframe-airtable-form"
            />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
