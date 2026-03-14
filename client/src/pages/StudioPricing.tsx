import { useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Check,
  Wand2,
  ArrowRight,
  Zap,
  Crown,
  Building2,
  Sparkles,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

interface TierConfig {
  id: string;
  label: string;
  price: number;
  videosPerMonth: number;
  voiceTier: string;
  quality: string;
  visualMode: string;
  watermark: boolean;
}

interface StudioMeResponse {
  authenticated: boolean;
  email?: string;
  hasStudioAccess?: boolean;
  subscription?: {
    tier: string;
    status: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd?: boolean;
  };
  usage?: {
    videosGenerated: number;
    videosLimit: number;
    month: string;
  };
}

const TIER_FEATURES: Record<string, string[]> = {
  free: [
    "1 video per month",
    "Default voice",
    "720p quality",
    "Static slide visuals",
    "Watermarked output",
  ],
  starter: [
    "5 videos per month",
    "3 premium voices",
    "720p AI-generated visuals",
    "No watermark",
    "Download MP4",
    "Email support",
  ],
  pro: [
    "20 videos per month",
    "10+ voices + 1 voice clone",
    "1080p AI-generated visuals",
    "Priority processing queue",
    "Custom branding",
    "Priority support",
  ],
  business: [
    "Unlimited videos",
    "All voices + 5 voice clones",
    "1080p premium visuals",
    "API access",
    "White-label output",
    "Team seats",
    "Dedicated support",
  ],
};

const TIER_ICONS: Record<string, any> = {
  free: Sparkles,
  starter: Zap,
  pro: Crown,
  business: Building2,
};

const TIER_COLORS: Record<string, string> = {
  free: "text-white/70",
  starter: "text-blue-400",
  pro: "text-purple-400",
  business: "text-amber-400",
};

export default function StudioPricing() {
  const [isAnnual, setIsAnnual] = useState(false);

  const { data: studioMe, isLoading: isLoadingMe } = useQuery<StudioMeResponse>({
    queryKey: ["/api/studio/me"],
    retry: false,
  });

  const { data: tiersData } = useQuery<{ tiers: TierConfig[] }>({
    queryKey: ["/api/studio/tiers"],
  });

  const checkoutMutation = useMutation({
    mutationFn: async (tier: string) => {
      const response = await apiRequest("POST", "/api/studio/checkout", { tier });
      return response.json();
    },
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("GET", "/api/studio/billing-portal");
      return response.json();
    },
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
  });

  const tiers = tiersData?.tiers || [];
  const currentTier = studioMe?.subscription?.tier || "free";
  const isAuthenticated = studioMe?.authenticated;

  const getPrice = (price: number) => {
    if (price === 0) return "Free";
    const monthly = isAnnual ? Math.round(price * 10) / 12 : price;
    return `$${monthly.toFixed(monthly % 1 === 0 ? 0 : 2)}`;
  };

  const handleTierAction = (tierId: string) => {
    if (!isAuthenticated) {
      window.location.href = "/auth?redirect=/studio/pricing";
      return;
    }
    if (tierId === "free") return;
    if (currentTier === tierId) {
      portalMutation.mutate();
      return;
    }
    checkoutMutation.mutate(tierId);
  };

  const getButtonLabel = (tierId: string) => {
    if (!isAuthenticated) return "Get Started";
    if (tierId === "free" && currentTier === "free") return "Current Plan";
    if (tierId === currentTier) return "Manage Plan";
    const tierOrder = ["free", "starter", "pro", "business"];
    return tierOrder.indexOf(tierId) > tierOrder.indexOf(currentTier)
      ? "Upgrade"
      : "Downgrade";
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <a href="/">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <div className="flex items-center gap-3">
            <a
              href="/studio"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Studio
            </a>
            <Badge variant="outline" className="text-xs font-medium">
              <Wand2 className="w-3 h-3 mr-1" />
              Pricing
            </Badge>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-purple-950/30 via-background to-background" />
        <div className="relative z-10 max-w-6xl mx-auto px-6 pt-16 pb-10 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-4 text-white">
              Simple, Transparent Pricing
            </h1>
            <p className="text-lg text-white/60 max-w-xl mx-auto mb-8">
              Start free. Upgrade when you need more videos, voices, and quality.
            </p>

            {/* Annual toggle */}
            <div className="flex items-center justify-center gap-3 mb-2">
              <span
                className={cn(
                  "text-sm font-medium transition-colors",
                  !isAnnual ? "text-white" : "text-white/40"
                )}
              >
                Monthly
              </span>
              <Switch checked={isAnnual} onCheckedChange={setIsAnnual} />
              <span
                className={cn(
                  "text-sm font-medium transition-colors",
                  isAnnual ? "text-white" : "text-white/40"
                )}
              >
                Annual
              </span>
              {isAnnual && (
                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                  Save 17%
                </Badge>
              )}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="max-w-6xl mx-auto px-6 pb-20 -mt-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {(tiers.length > 0 ? tiers : defaultTiers).map((tier, idx) => {
            const TierIcon = TIER_ICONS[tier.id] || Sparkles;
            const isCurrentPlan = currentTier === tier.id && isAuthenticated;
            const isPopular = tier.id === "pro";

            return (
              <motion.div
                key={tier.id}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.1, duration: 0.5 }}
              >
                <Card
                  className={cn(
                    "relative h-full flex flex-col transition-all duration-300",
                    isPopular
                      ? "border-purple-500/50 shadow-lg shadow-purple-500/10"
                      : "border-white/5 hover:border-white/10",
                    isCurrentPlan && "ring-2 ring-primary"
                  )}
                >
                  {isPopular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-purple-600 text-white text-xs px-3">
                        Most Popular
                      </Badge>
                    </div>
                  )}
                  {isCurrentPlan && (
                    <div className="absolute -top-3 right-4">
                      <Badge className="bg-primary text-primary-foreground text-xs px-3">
                        Current Plan
                      </Badge>
                    </div>
                  )}

                  <CardContent className="p-6 flex flex-col flex-1">
                    {/* Tier header */}
                    <div className="mb-6">
                      <div
                        className={cn(
                          "w-10 h-10 rounded-xl flex items-center justify-center mb-3",
                          tier.id === "free" && "bg-white/5",
                          tier.id === "starter" && "bg-blue-500/10",
                          tier.id === "pro" && "bg-purple-500/10",
                          tier.id === "business" && "bg-amber-500/10"
                        )}
                      >
                        <TierIcon
                          className={cn("w-5 h-5", TIER_COLORS[tier.id])}
                        />
                      </div>
                      <h3 className="text-lg font-semibold text-foreground">
                        {tier.label}
                      </h3>
                      <div className="mt-2 flex items-baseline gap-1">
                        <span className="text-3xl font-bold text-white">
                          {getPrice(tier.price)}
                        </span>
                        {tier.price > 0 && (
                          <span className="text-sm text-muted-foreground">
                            /mo
                          </span>
                        )}
                      </div>
                      {isAnnual && tier.price > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          ${tier.price * 10}/year billed annually
                        </p>
                      )}
                    </div>

                    {/* Features list */}
                    <ul className="space-y-3 flex-1 mb-6">
                      {(TIER_FEATURES[tier.id] || []).map((feature) => (
                        <li key={feature} className="flex items-start gap-2.5">
                          <Check className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
                          <span className="text-sm text-muted-foreground">
                            {feature}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/* CTA */}
                    <Button
                      onClick={() => handleTierAction(tier.id)}
                      disabled={
                        checkoutMutation.isPending ||
                        portalMutation.isPending ||
                        (tier.id === "free" && isCurrentPlan)
                      }
                      className={cn(
                        "w-full gap-2",
                        isPopular
                          ? "bg-purple-600 hover:bg-purple-500"
                          : tier.id === "business"
                          ? "bg-amber-600 hover:bg-amber-500"
                          : ""
                      )}
                      variant={
                        isPopular || tier.id === "business"
                          ? "default"
                          : "outline"
                      }
                    >
                      {checkoutMutation.isPending || portalMutation.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          {getButtonLabel(tier.id)}
                          {tier.id !== "free" && !isCurrentPlan && (
                            <ArrowRight className="w-4 h-4" />
                          )}
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Usage bar for authenticated users */}
      {isAuthenticated && studioMe?.usage && (
        <section className="max-w-2xl mx-auto px-6 pb-16">
          <Card className="border-white/5">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-foreground">
                  Monthly Usage
                </h3>
                <span className="text-sm text-muted-foreground">
                  {studioMe.usage.videosGenerated} / {studioMe.usage.videosLimit} videos
                </span>
              </div>
              <div className="w-full bg-white/5 rounded-full h-2.5">
                <div
                  className={cn(
                    "h-2.5 rounded-full transition-all duration-500",
                    studioMe.usage.videosGenerated >= studioMe.usage.videosLimit
                      ? "bg-red-500"
                      : "bg-purple-500"
                  )}
                  style={{
                    width: `${Math.min(
                      (studioMe.usage.videosGenerated / studioMe.usage.videosLimit) * 100,
                      100
                    )}%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Resets at the start of each month
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Powered by{" "}
            <a href="/" className="text-primary font-medium hover:underline">
              FullScale
            </a>
          </p>
          <img src={logoUrl} alt="FullScale" className="h-5 opacity-40" />
        </div>
      </footer>
    </div>
  );
}

// Fallback tier data (used before API responds)
const defaultTiers: TierConfig[] = [
  { id: "free", label: "Free", price: 0, videosPerMonth: 1, voiceTier: "free", quality: "720p", visualMode: "static", watermark: true },
  { id: "starter", label: "Starter", price: 9, videosPerMonth: 5, voiceTier: "starter", quality: "720p", visualMode: "ai_generated", watermark: false },
  { id: "pro", label: "Pro", price: 29, videosPerMonth: 20, voiceTier: "pro", quality: "1080p", visualMode: "ai_generated", watermark: false },
  { id: "business", label: "Business", price: 99, videosPerMonth: 999, voiceTier: "business", quality: "1080p", visualMode: "ai_generated", watermark: false },
];
