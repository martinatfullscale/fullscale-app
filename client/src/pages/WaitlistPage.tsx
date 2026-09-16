import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LogOut, Loader2, Home, CheckCircle2, Mail, Clock, PencilLine } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

interface AuthStatus {
  authenticated: boolean;
  email?: string;
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  isApproved?: boolean;
  profileSubmitted?: boolean;
}

/**
 * Waitlist page — the only page an unapproved account can see.
 *
 * Three honest states:
 *  1. Form not yet submitted → Airtable embed + an explicit "I've submitted
 *     my application" confirmation button (the cross-origin iframe can't
 *     tell us itself, which is how users ended up refilling it 2-3 times).
 *  2. Submitted → "Application received" confirmation. Review is a HUMAN
 *     step — the copy says so, instead of implying the form unlocks the
 *     dashboard.
 *  3. Approved → auto-redirect. The page polls auth status every 30s, so
 *     approval lands live without a re-login.
 */
export default function WaitlistPage() {
  const queryClient = useQueryClient();
  const [justConfirmed, setJustConfirmed] = useState(false);

  const { data: authStatus, isLoading } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
    // Live approval: the moment the flag flips in the DB, the effect below
    // routes the user into the product — no re-login, no manual refresh.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      window.location.href = "/";
    },
  });

  const submittedMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/waitlist/profile-submitted");
    },
    onSuccess: () => {
      setJustConfirmed(true);
      queryClient.setQueryData<AuthStatus | undefined>(["/api/auth/status"], (prev) =>
        prev ? { ...prev, profileSubmitted: true } : prev,
      );
    },
  });

  // Approved → straight into the product.
  useEffect(() => {
    if (authStatus?.isApproved) {
      window.location.href = "/dashboard";
    }
  }, [authStatus?.isApproved]);

  const getAirtableUrl = () => {
    const baseUrl = "https://airtable.com/embed/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form";
    if (!authStatus?.email) return baseUrl;
    const fullName = [authStatus.firstName, authStatus.lastName].filter(Boolean).join(" ") || authStatus.name || "";
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

  const submitted = justConfirmed || !!authStatus?.profileSubmitted;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between p-4 border-b border-border/50">
        <img
          src={logoUrl}
          alt="FullScale"
          className="h-8 cursor-pointer"
          onClick={() => { window.location.href = "/"; }}
          data-testid="img-logo"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { window.location.href = "/"; }}
            data-testid="button-back-home"
          >
            <Home className="w-4 h-4 mr-2" />
            Back to homepage
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            {logoutMutation.isPending ? "Logging out..." : "Logout"}
          </Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center p-4 pt-8 overflow-auto">
        {submitted ? (
          <div className="w-full max-w-xl text-center mt-8" data-testid="waitlist-submitted-state">
            <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mb-5">
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-3" data-testid="text-waitlist-title">
              Application received — you're in the review queue
            </h1>
            <p className="text-muted-foreground mb-8">
              Every creator application is reviewed personally — that's what keeps the
              founding group strong. There's nothing else you need to do.
            </p>
            <Card className="border-border/50 text-left">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <Clock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <p className="text-sm text-muted-foreground">
                    Reviews usually take a day or two.
                  </p>
                </div>
                <div className="flex items-start gap-3">
                  <Mail className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <p className="text-sm text-muted-foreground">
                    The moment you're approved, you'll get an email from Martin at{" "}
                    <span className="text-foreground font-medium">{authStatus?.email}</span>{" "}
                    — and this page will let you straight in.
                  </p>
                </div>
              </CardContent>
            </Card>
            <button
              className="text-xs text-muted-foreground/60 underline mt-6 hover:text-muted-foreground"
              onClick={() => setJustConfirmed(false)}
              style={{ display: authStatus?.profileSubmitted && !justConfirmed ? "none" : undefined }}
              data-testid="button-edit-application"
            >
              Need to change something? Reopen the form
            </button>
          </div>
        ) : (
          <>
            <div className="w-full max-w-2xl text-center mb-6 shrink-0">
              <h1 className="text-2xl font-bold text-foreground mb-2" data-testid="text-waitlist-title">
                Step 2: Complete Your Creator Profile
              </h1>
              <p className="text-muted-foreground" data-testid="text-waitlist-info">
                Your account is created. Tell us about your content below — then we
                personally review every application before opening the dashboard.
              </p>
              <p className="text-sm text-muted-foreground/70 mt-2">
                Once you submit the form, hit the confirmation button underneath so we
                mark your application complete.
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

            <div className="w-full max-w-2xl mt-4 mb-10 shrink-0">
              <Button
                className="w-full gap-2"
                size="lg"
                onClick={() => submittedMutation.mutate()}
                disabled={submittedMutation.isPending}
                data-testid="button-confirm-submitted"
              >
                {submittedMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <PencilLine className="w-4 h-4" />
                )}
                I've submitted my application
              </Button>
              <p className="text-xs text-muted-foreground/60 text-center mt-2">
                Filled it out already on another visit? Click the button — you never
                need to fill it twice.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
