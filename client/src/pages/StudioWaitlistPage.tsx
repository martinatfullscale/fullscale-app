import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Wand2, ArrowRight, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

interface AuthStatus {
  authenticated: boolean;
  email?: string;
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
}

interface WaitlistStatus {
  authenticated: boolean;
  hasAccess: boolean;
  status: "pending" | "approved" | "rejected" | null;
}

export default function StudioWaitlistPage() {
  const [, setLocation] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [useCase, setUseCase] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
    retry: false,
  });

  const { data: waitlistStatus, isLoading } = useQuery<WaitlistStatus>({
    queryKey: ["/api/studio/waitlist/status"],
    retry: false,
  });

  // Pre-fill from auth status
  useEffect(() => {
    if (authStatus?.name && !name) setName(authStatus.name);
    if (authStatus?.email && !email) setEmail(authStatus.email);
  }, [authStatus]);

  // Redirect if already approved
  useEffect(() => {
    if (waitlistStatus?.hasAccess) {
      setLocation("/studio/upload");
    }
  }, [waitlistStatus, setLocation]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/studio/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, useCase }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      return res.json();
    },
    onSuccess: (data) => {
      setSubmitted(true);
      if (data.status === "approved") {
        setLocation("/studio/upload");
      }
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
      </div>
    );
  }

  const isPending = waitlistStatus?.status === "pending" || submitted;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <a href="/">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <a href="/studio" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            About Studio
          </a>
        </div>
      </header>

      {/* Content */}
      <div className="relative">
        <div className="absolute inset-0 bg-gradient-to-b from-purple-950/30 via-background to-background" />
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-purple-500/8" />

        <div className="relative z-10 max-w-lg mx-auto px-6 pt-20 pb-24">
          {isPending ? (
            /* Confirmation state */
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-purple-500/15 border border-purple-500/25 mb-6">
                <CheckCircle2 className="w-8 h-8 text-purple-400" />
              </div>
              <h1 className="text-3xl font-bold text-white mb-3">
                You're on the list
              </h1>
              <p className="text-white/60 text-lg mb-8 leading-relaxed">
                We'll reach out when Studio is ready for you. In the meantime, check out what Studio can do.
              </p>
              <a href="/studio">
                <Button variant="outline" className="gap-2 border-purple-500/30 text-purple-300 hover:bg-purple-500/10">
                  <Wand2 className="w-4 h-4" />
                  Explore Studio
                </Button>
              </a>
            </div>
          ) : (
            /* Form state */
            <div>
              <div className="text-center mb-10">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-sm font-medium mb-6">
                  <Sparkles className="w-4 h-4" />
                  Early Access
                </div>
                <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
                  Get early access to Studio
                </h1>
                <p className="text-white/60 text-lg leading-relaxed">
                  Turn documents into polished videos with AI. Request access and be among the first to try it.
                </p>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitMutation.mutate();
                }}
                className="space-y-4"
              >
                <div>
                  <label htmlFor="name" className="text-sm text-white/70 mb-1.5 block">
                    Name
                  </label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    required
                    className="bg-card border-white/10 focus:border-purple-500/50"
                  />
                </div>
                <div>
                  <label htmlFor="email" className="text-sm text-white/70 mb-1.5 block">
                    Email
                  </label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    className="bg-card border-white/10 focus:border-purple-500/50"
                  />
                </div>
                <div>
                  <label htmlFor="useCase" className="text-sm text-white/70 mb-1.5 block">
                    What do you want to create?
                  </label>
                  <Textarea
                    id="useCase"
                    value={useCase}
                    onChange={(e) => setUseCase(e.target.value)}
                    placeholder="e.g. Turn my pitch decks into video presentations, create product demos..."
                    rows={3}
                    className="bg-card border-white/10 focus:border-purple-500/50 resize-none"
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full gap-2 bg-purple-600 hover:bg-purple-500 mt-2"
                  disabled={submitMutation.isPending}
                >
                  {submitMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ArrowRight className="w-4 h-4" />
                  )}
                  Request Access
                </Button>
                {submitMutation.isError && (
                  <p className="text-red-400 text-sm text-center">
                    Something went wrong. Please try again.
                  </p>
                )}
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
