import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LogOut, Loader2 } from "lucide-react";
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
          className="h-8"
          data-testid="img-logo"
        />
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
      </header>

      <main className="flex-1 flex flex-col items-center p-4 pt-8">
        <div className="w-full max-w-2xl text-center mb-6">
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
        </div>

        <Card className="w-full max-w-2xl border-border/50 flex-1 min-h-[600px]">
          <CardContent className="p-0 h-full">
            <iframe
              src={getAirtableUrl()}
              width="100%"
              height="100%"
              style={{ minHeight: "600px", border: "none", borderRadius: "8px" }}
              title="Creator Profile Form"
              data-testid="iframe-airtable-form"
            />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
