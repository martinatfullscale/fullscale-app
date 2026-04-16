import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Briefcase,
  ArrowRight,
  ArrowLeft,
  Check,
  Loader2,
  Save,
  CheckCircle2,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

// ══════════════════════════════════════════════════════════════════════
// OPTIONS — kept here (not in schema) because they're presentation-only.
// Keys match what the API stores; labels are shown to the user.
// ══════════════════════════════════════════════════════════════════════

const INDUSTRY_OPTIONS = [
  "Beauty",
  "Beverage",
  "Food",
  "Fashion / Apparel",
  "Tech / Electronics",
  "Gaming",
  "Fitness / Health",
  "Lifestyle",
  "Auto",
  "Home / Décor",
  "Entertainment",
  "Other",
];

const BRAND_VOICE_OPTIONS = [
  "Premium",
  "Playful",
  "Minimalist",
  "Bold",
  "Authentic",
  "Edgy",
  "Wholesome",
  "Educational",
  "Aspirational",
  "Approachable",
];

const PLACEMENT_TYPE_OPTIONS = [
  "Physical product",
  "Sticker or branded asset",
  "On-screen overlay (UI / app preview)",
  "Service or app card",
  "Logo placement only",
  "Other",
];

const FLEXIBILITY_OPTIONS = [
  { value: "exact", label: "Exact products only" },
  { value: "substitutes", label: "Open to close substitutes" },
  { value: "flexible", label: "Flexible — brand visibility is the goal" },
];

const GEO_OPTIONS = ["US", "Canada", "UK", "EU", "LATAM", "MENA", "APAC", "Global"];

const INTEREST_OPTIONS = [
  "Tech",
  "Fitness",
  "Beauty",
  "Food",
  "Travel",
  "Music",
  "Gaming",
  "Fashion",
  "Sports",
  "Education",
  "Business / Entrepreneurship",
  "Lifestyle",
  "Parenting",
  "Finance",
  "Wellness",
  "Other",
];

const LANGUAGE_OPTIONS = [
  "English",
  "Spanish",
  "Portuguese",
  "French",
  "Arabic",
  "Mandarin",
  "Hindi",
  "Other",
];

const OBJECTIVE_OPTIONS = [
  { value: "awareness", label: "Brand awareness" },
  { value: "launch", label: "Product launch" },
  { value: "pmf_test", label: "Test product–market fit" },
  { value: "conversions", label: "Drive conversions / sales" },
  { value: "partnerships", label: "Build creator partnerships" },
  { value: "other", label: "Other" },
];

const BUDGET_OPTIONS = [
  { value: "under_5k", label: "Under $5K" },
  { value: "5k_25k", label: "$5K – $25K" },
  { value: "25k_100k", label: "$25K – $100K" },
  { value: "100k_500k", label: "$100K – $500K" },
  { value: "500k_plus", label: "$500K+" },
  { value: "discuss", label: "Prefer to discuss" },
];

const TIMELINE_OPTIONS = [
  { value: "one_time", label: "One-time campaign" },
  { value: "3mo", label: "3 months" },
  { value: "6mo", label: "6 months" },
  { value: "ongoing", label: "Ongoing partnership" },
  { value: "exploring", label: "Just exploring" },
];

const HANDS_ON_OPTIONS = [
  { value: "hands_off", label: "Hands-off — auto-match" },
  { value: "selective", label: "Selective — I'll review matches" },
  { value: "hands_on", label: "Hands-on — I'll pick everything myself" },
];

// ══════════════════════════════════════════════════════════════════════
// TYPES
// Mirrors the BrandBrief API shape. All fields optional so we can load
// a partial draft and save incrementally without TS complaining.
// ══════════════════════════════════════════════════════════════════════

type BrandBriefState = {
  brandName?: string;
  website?: string;
  industry?: string;
  brandVoice?: string[];
  logoUrl?: string;
  placementTypes?: string[];
  productDescription?: string;
  referenceImageUrls?: string[];
  flexibility?: string;
  targetGeographies?: string[];
  audienceAgeMin?: number;
  audienceAgeMax?: number;
  audienceInterests?: string[];
  languages?: string[];
  primaryObjective?: string;
  successMeasurement?: string;
  budgetRange?: string;
  timeline?: string;
  contentCategories?: string[];
  specificCreators?: string;
  thingsToAvoid?: string;
  handsOnLevel?: string;
};

const STEP_TITLES = [
  "Your Brand at a Glance",
  "What You Want to Place",
  "Who You Want to Reach",
  "What Success Looks Like",
  "Working Together",
];

const STEP_INTROS = [
  "Quick intros. This helps us know who you are and how you sound.",
  "Tell us what you're putting in the world. The more specific, the better we can match.",
  "Who's the audience you most want to put your product in front of?",
  "How will you know this worked? We'd rather match you to the right outcomes than overpromise.",
  "Last bit. How do you want to work with creators and what's off-limits?",
];

// ══════════════════════════════════════════════════════════════════════
// Reusable chip-picker for multi-select values.
// ══════════════════════════════════════════════════════════════════════

function ChipPicker({
  options,
  value,
  onChange,
  testIdPrefix,
}: {
  options: string[];
  value: string[] | undefined;
  onChange: (next: string[]) => void;
  testIdPrefix: string;
}) {
  const selected = value ?? [];
  const toggle = (opt: string) => {
    if (selected.includes(opt)) {
      onChange(selected.filter((v) => v !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const isSelected = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all duration-200 ${
              isSelected
                ? "bg-emerald-500/20 border-emerald-400/60 text-emerald-300 shadow-sm shadow-emerald-500/10"
                : "bg-white/5 border-white/15 text-white/75 hover:bg-white/10 hover:border-white/30"
            }`}
            data-testid={`${testIdPrefix}-${opt.replace(/\s+/g, "-").toLowerCase()}`}
            aria-pressed={isSelected}
          >
            {isSelected && <Check className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />}
            {opt}
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// VALIDATION — returns array of error strings per step. Empty = valid.
// ══════════════════════════════════════════════════════════════════════

function validateStep(step: number, b: BrandBriefState): string[] {
  const errs: string[] = [];
  switch (step) {
    case 0:
      if (!b.brandName?.trim()) errs.push("Brand name is required");
      if (!b.website?.trim()) errs.push("Website is required");
      if (!b.industry) errs.push("Industry is required");
      if (!b.brandVoice || b.brandVoice.length === 0)
        errs.push("Pick at least one brand voice attribute");
      break;
    case 1:
      if (!b.placementTypes || b.placementTypes.length === 0)
        errs.push("Pick at least one placement type");
      if (!b.productDescription?.trim())
        errs.push("Tell us about your product");
      if (!b.flexibility) errs.push("Pick a flexibility option");
      break;
    case 2:
      if (!b.targetGeographies || b.targetGeographies.length === 0)
        errs.push("Pick at least one geography");
      if (!b.audienceInterests || b.audienceInterests.length < 2)
        errs.push("Pick at least two audience interests");
      if (!b.languages || b.languages.length === 0)
        errs.push("Pick at least one language");
      break;
    case 3:
      if (!b.primaryObjective) errs.push("Pick a primary objective");
      if (!b.successMeasurement?.trim())
        errs.push("Describe how you'll measure success");
      if (!b.budgetRange) errs.push("Pick a budget range");
      if (!b.timeline) errs.push("Pick a timeline");
      break;
    case 4:
      if (!b.contentCategories || b.contentCategories.length === 0)
        errs.push("Pick at least one content category");
      if (!b.handsOnLevel) errs.push("Pick an engagement style");
      break;
  }
  return errs;
}

// ══════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════

export default function BrandOnboarding() {
  const [, setLocation] = useLocation();
  const [brief, setBrief] = useState<BrandBriefState>({
    audienceAgeMin: 18,
    audienceAgeMax: 45,
    languages: ["English"],
  });
  const [currentStep, setCurrentStep] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  // ── Load existing brief on mount ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch("/api/brand-brief/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.brief) {
          // If brief is already submitted, go straight to success view
          if (data.brief.status === "submitted") {
            setIsSuccess(true);
          } else {
            // Hydrate form with saved draft
            setBrief({
              brandName: data.brief.brandName ?? "",
              website: data.brief.website ?? "",
              industry: data.brief.industry ?? "",
              brandVoice: data.brief.brandVoice ?? [],
              logoUrl: data.brief.logoUrl ?? "",
              placementTypes: data.brief.placementTypes ?? [],
              productDescription: data.brief.productDescription ?? "",
              referenceImageUrls: data.brief.referenceImageUrls ?? [],
              flexibility: data.brief.flexibility ?? "",
              targetGeographies: data.brief.targetGeographies ?? [],
              audienceAgeMin: data.brief.audienceAgeMin ?? 18,
              audienceAgeMax: data.brief.audienceAgeMax ?? 45,
              audienceInterests: data.brief.audienceInterests ?? [],
              languages: data.brief.languages?.length
                ? data.brief.languages
                : ["English"],
              primaryObjective: data.brief.primaryObjective ?? "",
              successMeasurement: data.brief.successMeasurement ?? "",
              budgetRange: data.brief.budgetRange ?? "",
              timeline: data.brief.timeline ?? "",
              contentCategories: data.brief.contentCategories ?? [],
              specificCreators: data.brief.specificCreators ?? "",
              thingsToAvoid: data.brief.thingsToAvoid ?? "",
              handsOnLevel: data.brief.handsOnLevel ?? "",
            });
          }
        }
        setInitialLoadDone(true);
      })
      .catch((err) => {
        console.error("[BrandOnboarding] Failed to load existing brief", err);
        setInitialLoadDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Autosave on brief change (debounced) ────────────────────────────
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedJson = useRef<string>("");
  useEffect(() => {
    if (!initialLoadDone) return;
    // Don't re-save identical payloads
    const nextJson = JSON.stringify(brief);
    if (nextJson === lastSavedJson.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus("saving");
    saveTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/brand-brief/me", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: nextJson,
        });
        if (res.ok) {
          lastSavedJson.current = nextJson;
          setSaveStatus("saved");
          // Reset the "saved" pill back to idle after a moment
          setTimeout(() => {
            setSaveStatus((s) => (s === "saved" ? "idle" : s));
          }, 2500);
        } else {
          setSaveStatus("error");
        }
      } catch (err) {
        console.error("[BrandOnboarding] Autosave failed", err);
        setSaveStatus("error");
      }
    }, 1500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [brief, initialLoadDone]);

  // ── Field updater ──
  const update = useCallback(<K extends keyof BrandBriefState>(key: K, value: BrandBriefState[K]) => {
    setBrief((prev) => ({ ...prev, [key]: value }));
    // If user is actively fixing fields after seeing errors, hide the
    // error banner once this step is valid
    setShowErrors(false);
  }, []);

  // ── Nav ──
  const currentErrors = validateStep(currentStep, brief);
  const canAdvance = currentErrors.length === 0;

  const handleNext = () => {
    if (!canAdvance) {
      setShowErrors(true);
      return;
    }
    if (currentStep < STEP_TITLES.length - 1) {
      setCurrentStep((s) => s + 1);
      setShowErrors(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleBack = () => {
    setCurrentStep((s) => Math.max(0, s - 1));
    setShowErrors(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async () => {
    // Final validation — all steps must be valid
    for (let i = 0; i < STEP_TITLES.length; i++) {
      const errs = validateStep(i, brief);
      if (errs.length > 0) {
        setCurrentStep(i);
        setShowErrors(true);
        return;
      }
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // First flush any pending autosave
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const putRes = await fetch("/api/brand-brief/me", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brief),
      });
      if (!putRes.ok) {
        throw new Error("Failed to save final draft before submit");
      }
      // Then submit
      const submitRes = await fetch("/api/brand-brief/me/submit", {
        method: "POST",
        credentials: "include",
      });
      if (!submitRes.ok) {
        const errJson = await submitRes.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to submit brief");
      }
      setIsSuccess(true);
    } catch (err: any) {
      setSubmitError(err.message || "Failed to submit brief");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Render: initial load ──
  if (!initialLoadDone) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
      </div>
    );
  }

  // ── Render: success view ──
  if (isSuccess) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
            <a href="/"><img src={logoUrl} alt="FullScale" className="h-7" /></a>
            <span className="text-xs uppercase tracking-widest text-emerald-300 font-semibold">Brand Brief</span>
          </div>
        </header>
        <main className="max-w-2xl mx-auto px-6 py-24 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-emerald-400/10 border border-emerald-400/40 mb-8">
              <CheckCircle2 className="w-10 h-10 text-emerald-300" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground mb-5">
              Brief submitted.
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed mb-10 max-w-lg mx-auto">
              We'll review your brief, match you to creators that fit, and reach out within 48 hours with next steps. In the meantime, you can explore the brand marketplace.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a href="/marketplace" data-testid="link-success-marketplace">
                <Button size="lg" className="gap-2 bg-emerald-500 hover:bg-emerald-500/90 text-white">
                  Go to Marketplace
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </a>
              <a href="mailto:hello@gofullscale.co">
                <Button size="lg" variant="outline" className="gap-2 border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10">
                  <Mail className="w-4 h-4" />
                  Email our team
                </Button>
              </a>
            </div>
          </motion.div>
        </main>
      </div>
    );
  }

  // ── Render: wizard ──
  const progressPct = ((currentStep + 1) / STEP_TITLES.length) * 100;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
          <a href="/" data-testid="link-onboarding-logo">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <div className="flex items-center gap-3">
            <SaveIndicator status={saveStatus} />
            <span className="text-xs uppercase tracking-widest text-emerald-300 font-semibold hidden sm:inline">
              <Briefcase className="w-3 h-3 inline-block mr-1 -mt-0.5" />
              Brand Brief
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 pb-32">
        {/* Progress bar + step label */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3 text-sm">
            <span className="text-xs uppercase tracking-widest text-emerald-300/90 font-semibold">
              Step {currentStep + 1} of {STEP_TITLES.length}
            </span>
            <span className="text-xs text-muted-foreground">
              {Math.round(progressPct)}% complete
            </span>
          </div>
          <Progress value={progressPct} className="h-1.5" data-testid="progress-bar" />
        </div>

        {/* Step title + intro */}
        <motion.div
          key={`heading-${currentStep}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-10"
        >
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-3">
            {STEP_TITLES[currentStep]}
          </h1>
          <p className="text-base text-muted-foreground leading-relaxed">
            {STEP_INTROS[currentStep]}
          </p>
        </motion.div>

        {/* Step content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`step-${currentStep}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {currentStep === 0 && <Step1 brief={brief} update={update} />}
            {currentStep === 1 && <Step2 brief={brief} update={update} />}
            {currentStep === 2 && <Step3 brief={brief} update={update} />}
            {currentStep === 3 && <Step4 brief={brief} update={update} />}
            {currentStep === 4 && <Step5 brief={brief} update={update} />}
          </motion.div>
        </AnimatePresence>

        {/* Inline errors */}
        {showErrors && currentErrors.length > 0 && (
          <div className="mt-8 p-4 rounded-xl border border-red-500/30 bg-red-500/5">
            <p className="text-sm font-semibold text-red-400 mb-2">Before continuing:</p>
            <ul className="text-sm text-red-300 space-y-1 list-disc list-inside">
              {currentErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Submit error */}
        {submitError && (
          <div className="mt-8 p-4 rounded-xl border border-red-500/30 bg-red-500/5">
            <p className="text-sm text-red-300">{submitError}</p>
          </div>
        )}

        {/* Nav buttons */}
        <div className="mt-10 flex items-center justify-between gap-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 0 || isSubmitting}
            className="gap-2 border-white/20 text-white hover:bg-white/10"
            data-testid="button-back"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>

          {currentStep < STEP_TITLES.length - 1 ? (
            <Button
              type="button"
              onClick={handleNext}
              className="gap-2 bg-emerald-500 hover:bg-emerald-500/90 text-white"
              data-testid="button-next"
            >
              Next
              <ArrowRight className="w-4 h-4" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="gap-2 bg-emerald-500 hover:bg-emerald-500/90 text-white"
              data-testid="button-submit"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  Submit Brief
                  <Check className="w-4 h-4" />
                </>
              )}
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// SaveIndicator — pill in header showing saving / saved / error
// ══════════════════════════════════════════════════════════════════════

function SaveIndicator({ status }: { status: "idle" | "saving" | "saved" | "error" }) {
  if (status === "idle") return null;
  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white/70">
        <Loader2 className="w-3 h-3 animate-spin" />
        Saving draft…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
        <Save className="w-3 h-3" />
        Draft saved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-xs text-red-300">
      Save failed — will retry
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════
// STEP COMPONENTS
// Split into their own sub-components so the AnimatePresence transition
// is clean and each step's validation is local.
// ══════════════════════════════════════════════════════════════════════

type StepProps = {
  brief: BrandBriefState;
  update: <K extends keyof BrandBriefState>(key: K, value: BrandBriefState[K]) => void;
};

function Step1({ brief, update }: StepProps) {
  return (
    <div className="space-y-8">
      <Field label="Brand name" required htmlFor="brandName">
        <Input
          id="brandName"
          value={brief.brandName ?? ""}
          onChange={(e) => update("brandName", e.target.value)}
          placeholder="Acme Beverages"
          data-testid="input-brand-name"
        />
      </Field>

      <Field label="Website" required htmlFor="website">
        <Input
          id="website"
          type="url"
          value={brief.website ?? ""}
          onChange={(e) => update("website", e.target.value)}
          placeholder="https://yourbrand.com"
          data-testid="input-website"
        />
      </Field>

      <Field label="Industry" required htmlFor="industry">
        <Select
          value={brief.industry ?? ""}
          onValueChange={(v) => update("industry", v)}
        >
          <SelectTrigger id="industry" data-testid="select-industry">
            <SelectValue placeholder="Select your industry" />
          </SelectTrigger>
          <SelectContent>
            {INDUSTRY_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Brand voice / personality"
        required
        description="Pick any that describe how your brand shows up."
      >
        <ChipPicker
          options={BRAND_VOICE_OPTIONS}
          value={brief.brandVoice}
          onChange={(v) => update("brandVoice", v)}
          testIdPrefix="chip-voice"
        />
      </Field>

      <Field
        label="Logo URL"
        htmlFor="logoUrl"
        description="Paste a link to your logo (transparent PNG preferred). Optional for now — file upload coming soon."
      >
        <Input
          id="logoUrl"
          type="url"
          value={brief.logoUrl ?? ""}
          onChange={(e) => update("logoUrl", e.target.value)}
          placeholder="https://yourbrand.com/logo.png"
          data-testid="input-logo-url"
        />
      </Field>
    </div>
  );
}

function Step2({ brief, update }: StepProps) {
  return (
    <div className="space-y-8">
      <Field label="What kind of placement are you looking for?" required>
        <ChipPicker
          options={PLACEMENT_TYPE_OPTIONS}
          value={brief.placementTypes}
          onChange={(v) => update("placementTypes", v)}
          testIdPrefix="chip-placement"
        />
      </Field>

      <Field
        label="Tell us about your product"
        required
        htmlFor="productDescription"
        description="Context, hero use cases, what makes it special. 3-5 sentences is plenty."
      >
        <Textarea
          id="productDescription"
          value={brief.productDescription ?? ""}
          onChange={(e) => update("productDescription", e.target.value)}
          rows={5}
          placeholder="We make a plant-based protein bar focused on clean ingredients…"
          data-testid="textarea-product-description"
        />
      </Field>

      <Field
        label="Reference image URLs"
        htmlFor="referenceImageUrls"
        description="One URL per line. Product shots, mood boards, brand references. Optional. (File upload coming soon.)"
      >
        <Textarea
          id="referenceImageUrls"
          value={(brief.referenceImageUrls ?? []).join("\n")}
          onChange={(e) =>
            update(
              "referenceImageUrls",
              e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
            )
          }
          rows={3}
          placeholder={"https://yourbrand.com/product.jpg\nhttps://yourbrand.com/mood.jpg"}
          data-testid="textarea-reference-urls"
        />
      </Field>

      <Field label="How flexible are you about which products get featured?" required>
        <RadioGroup
          value={brief.flexibility ?? ""}
          onValueChange={(v) => update("flexibility", v)}
          className="space-y-2"
        >
          {FLEXIBILITY_OPTIONS.map((opt) => (
            <RadioRow key={opt.value} value={opt.value} label={opt.label} testId={`radio-flex-${opt.value}`} />
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}

function Step3({ brief, update }: StepProps) {
  const ageMin = brief.audienceAgeMin ?? 18;
  const ageMax = brief.audienceAgeMax ?? 45;
  return (
    <div className="space-y-8">
      <Field label="Target geographies" required description="Pick any that apply.">
        <ChipPicker
          options={GEO_OPTIONS}
          value={brief.targetGeographies}
          onChange={(v) => update("targetGeographies", v)}
          testIdPrefix="chip-geo"
        />
      </Field>

      <Field
        label={`Target audience age range: ${ageMin}–${ageMax}`}
        description="Drag the handles. Min is 13, max is 65."
      >
        <div className="pt-4 space-y-4">
          <div>
            <Label className="text-xs text-muted-foreground">Minimum age</Label>
            <Slider
              value={[ageMin]}
              onValueChange={([v]) =>
                update("audienceAgeMin", Math.min(v, ageMax))
              }
              min={13}
              max={65}
              step={1}
              data-testid="slider-age-min"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Maximum age</Label>
            <Slider
              value={[ageMax]}
              onValueChange={([v]) =>
                update("audienceAgeMax", Math.max(v, ageMin))
              }
              min={13}
              max={65}
              step={1}
              data-testid="slider-age-max"
            />
          </div>
        </div>
      </Field>

      <Field label="Audience interests" required description="Pick at least two.">
        <ChipPicker
          options={INTEREST_OPTIONS}
          value={brief.audienceInterests}
          onChange={(v) => update("audienceInterests", v)}
          testIdPrefix="chip-interest"
        />
      </Field>

      <Field label="Languages" required description="Content will be matched to these languages.">
        <ChipPicker
          options={LANGUAGE_OPTIONS}
          value={brief.languages}
          onChange={(v) => update("languages", v)}
          testIdPrefix="chip-lang"
        />
      </Field>
    </div>
  );
}

function Step4({ brief, update }: StepProps) {
  return (
    <div className="space-y-8">
      <Field label="Primary objective" required>
        <RadioGroup
          value={brief.primaryObjective ?? ""}
          onValueChange={(v) => update("primaryObjective", v)}
          className="space-y-2"
        >
          {OBJECTIVE_OPTIONS.map((opt) => (
            <RadioRow key={opt.value} value={opt.value} label={opt.label} testId={`radio-obj-${opt.value}`} />
          ))}
        </RadioGroup>
      </Field>

      <Field
        label="How will you measure success?"
        required
        htmlFor="successMeasurement"
        description="Engagement, reach, conversions, qualitative feedback — whatever matters most."
      >
        <Textarea
          id="successMeasurement"
          value={brief.successMeasurement ?? ""}
          onChange={(e) => update("successMeasurement", e.target.value)}
          rows={4}
          placeholder="We're looking for brand lift in the fitness vertical, measured by..."
          data-testid="textarea-success-measurement"
        />
      </Field>

      <Field label="Approximate budget range" required htmlFor="budgetRange">
        <Select
          value={brief.budgetRange ?? ""}
          onValueChange={(v) => update("budgetRange", v)}
        >
          <SelectTrigger id="budgetRange" data-testid="select-budget">
            <SelectValue placeholder="Select a budget range" />
          </SelectTrigger>
          <SelectContent>
            {BUDGET_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Timeline" required>
        <RadioGroup
          value={brief.timeline ?? ""}
          onValueChange={(v) => update("timeline", v)}
          className="space-y-2"
        >
          {TIMELINE_OPTIONS.map((opt) => (
            <RadioRow key={opt.value} value={opt.value} label={opt.label} testId={`radio-tl-${opt.value}`} />
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}

function Step5({ brief, update }: StepProps) {
  return (
    <div className="space-y-8">
      <Field
        label="What kinds of content do you want to come from?"
        required
        description="Same categories as audience interests, but for the content itself."
      >
        <ChipPicker
          options={INTEREST_OPTIONS}
          value={brief.contentCategories}
          onChange={(v) => update("contentCategories", v)}
          testIdPrefix="chip-cat"
        />
      </Field>

      <Field
        label="Any specific creators in mind?"
        htmlFor="specificCreators"
        description="Drop names or handles. Leave blank if you'd like us to match."
      >
        <Textarea
          id="specificCreators"
          value={brief.specificCreators ?? ""}
          onChange={(e) => update("specificCreators", e.target.value)}
          rows={3}
          placeholder="@yourfavcreator, @anotherone, or names of specific people"
          data-testid="textarea-specific-creators"
        />
      </Field>

      <Field
        label="Anything creators should avoid?"
        htmlFor="thingsToAvoid"
        description="Brand safety zones, off-limits topics, competitors to steer clear of."
      >
        <Textarea
          id="thingsToAvoid"
          value={brief.thingsToAvoid ?? ""}
          onChange={(e) => update("thingsToAvoid", e.target.value)}
          rows={3}
          placeholder="No competitor mentions, no political content, no..."
          data-testid="textarea-things-to-avoid"
        />
      </Field>

      <Field label="How hands-on do you want to be?" required>
        <RadioGroup
          value={brief.handsOnLevel ?? ""}
          onValueChange={(v) => update("handsOnLevel", v)}
          className="space-y-2"
        >
          {HANDS_ON_OPTIONS.map((opt) => (
            <RadioRow key={opt.value} value={opt.value} label={opt.label} testId={`radio-hands-${opt.value}`} />
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Small shared helpers
// ══════════════════════════════════════════════════════════════════════

function Field({
  label,
  required,
  description,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="text-sm font-semibold text-foreground mb-1 block">
        {label}
        {required && <span className="text-emerald-400 ml-1">*</span>}
      </Label>
      {description && (
        <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{description}</p>
      )}
      {!description && <div className="mb-3" />}
      {children}
    </div>
  );
}

function RadioRow({ value, label, testId }: { value: string; label: string; testId: string }) {
  return (
    <label
      htmlFor={`radio-${value}`}
      className="flex items-center gap-3 p-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 cursor-pointer transition-colors"
    >
      <RadioGroupItem value={value} id={`radio-${value}`} data-testid={testId} />
      <span className="text-sm text-foreground">{label}</span>
    </label>
  );
}
