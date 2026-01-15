import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Clock, LogOut } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

export default function WaitlistPage() {
  const [, setLocation] = useLocation();

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

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-border/50">
        <CardContent className="pt-8 pb-8 px-8 text-center">
          <div className="flex justify-center mb-6">
            <img 
              src={logoUrl} 
              alt="FullScale" 
              className="h-8"
              data-testid="img-logo"
            />
          </div>
          
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <Clock className="w-8 h-8 text-primary" />
          </div>
          
          <h1 
            className="text-2xl font-bold text-foreground mb-2"
            data-testid="text-waitlist-title"
          >
            Application Received
          </h1>
          
          <p 
            className="text-muted-foreground mb-6"
            data-testid="text-waitlist-position"
          >
            You are currently <span className="text-primary font-semibold">#402</span> on the waitlist.
          </p>
          
          <p 
            className="text-sm text-muted-foreground mb-8"
            data-testid="text-waitlist-info"
          >
            We will notify you when your cohort opens. Thank you for your patience.
          </p>
          
          <Button
            variant="outline"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="w-full"
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            {logoutMutation.isPending ? "Logging out..." : "Logout"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
