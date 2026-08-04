/**
 * First-login onboarding checklist. Shown on the Dashboard for approved
 * users until every step is done or they dismiss it. Steps reflect REAL
 * account state from /api/onboarding/progress (has a video? has a scan?
 * has a placement?) — not click-tracking — so it survives logouts and
 * always points at the next genuine action.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Circle, X, ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

interface OnboardingProgress {
  hasConnection: boolean;
  hasVideo: boolean;
  hasScan: boolean;
  hasPlacement: boolean;
  dismissedAt: string | null;
  complete: boolean;
}

export function OnboardingChecklist() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const { data: progress } = useQuery<OnboardingProgress>({
    queryKey: ["/api/onboarding/progress"],
    queryFn: async () => {
      const res = await fetch("/api/onboarding/progress", { credentials: "include" });
      if (!res.ok) throw new Error("progress unavailable");
      return res.json();
    },
    staleTime: 30_000,
    retry: 1,
  });

  if (!progress || progress.dismissedAt || progress.complete) return null;

  const steps: Array<{ key: string; done: boolean; title: string; detail: string; cta: string; go: () => void }> = [
    {
      key: "import",
      done: progress.hasVideo,
      title: "Bring in your first video",
      detail: progress.hasConnection
        ? "Your channel is connected — sync it, or paste any video URL in the Library."
        : "Connect YouTube below, or paste a YouTube / Twitch / TikTok / X link in the Library.",
      cta: "Open Library",
      go: () => navigate("/library"),
    },
    {
      key: "scan",
      done: progress.hasScan,
      title: "Scan it for placement spots",
      detail: "Hit Scan on the video — our AI maps every scene and finds the walls, desks, and tables a brand could live on.",
      cta: "Go scan",
      go: () => navigate("/library"),
    },
    {
      key: "place",
      done: progress.hasPlacement,
      title: "Place a product and save it",
      detail: "Open the scan results, drop a product onto a surface you like, and save. You're choosing WHERE the product lives — our team reviews it and produces the final polished render, which lands in your Deliveries ready to post.",
      cta: "Try a placement",
      go: () => navigate("/library"),
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);

  const dismiss = async () => {
    try {
      await fetch("/api/onboarding/dismiss", { method: "POST", credentials: "include" });
    } catch {
      /* non-fatal */
    }
    queryClient.setQueryData(["/api/onboarding/progress"], { ...progress, dismissedAt: new Date().toISOString() });
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className="relative mb-6 rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-transparent to-transparent p-5"
        data-testid="onboarding-checklist"
      >
        <button
          onClick={dismiss}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
          aria-label="Dismiss onboarding"
          data-testid="onboarding-dismiss"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4 text-emerald-400" />
          <h3 className="font-semibold text-sm">Welcome to FullScale — here's how to get paid</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Three steps to your first placement — you choose where the product lives, our team polishes it into the final render. {doneCount}/{steps.length} done.
        </p>

        <div className="space-y-3">
          {steps.map((step, i) => (
            <div key={step.key} className="flex items-start gap-3" data-testid={`onboarding-step-${step.key}`}>
              {step.done ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <Circle className={`w-5 h-5 shrink-0 mt-0.5 ${step === next ? "text-emerald-400" : "text-muted-foreground/40"}`} />
              )}
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${step.done ? "line-through text-muted-foreground" : ""}`}>
                  {i + 1}. {step.title}
                </p>
                {!step.done && step === next && (
                  <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
                )}
              </div>
              {!step.done && step === next && (
                <Button size="sm" className="shrink-0 gap-1" onClick={step.go} data-testid={`onboarding-cta-${step.key}`}>
                  {step.cta}
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
