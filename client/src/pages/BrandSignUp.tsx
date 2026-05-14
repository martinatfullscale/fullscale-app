/**
 * Brand Sign-Up — separate from the Creator AuthPage.
 *
 * Why this page exists:
 *   - Previously the "For Brands" CTA dropped people into the Creator
 *     AuthPage (same form, same destinations). Brands aren't creators —
 *     they don't need YouTube/Instagram OAuth, they don't need the Studio,
 *     and they shouldn't get instant access; they should be reviewed
 *     before they can browse the creator marketplace.
 *   - This page collects brand-specific info (company, website, message),
 *     posts to /api/brand-signup which (a) records the request and (b)
 *     notifies the admin allowlist. Approval is manual — once admin adds
 *     the email to allowed_users with userType="brand", the brand can
 *     sign in via the standard auth flow and see only marketplace pages.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mail, User, X, Briefcase, Globe, CheckCircle2 } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

export default function BrandSignUp() {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Form fields — kept intentionally small to remove signup friction.
  // Anything else (industry, budget, audience language, etc.) is captured
  // post-approval inside BrandOnboarding.tsx.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !companyName.trim()) {
      toast({
        title: "Missing required fields",
        description: "Please fill in your name, email, and company.",
        variant: "destructive",
      });
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch("/api/brand-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          companyName: companyName.trim(),
          websiteUrl: websiteUrl.trim() || undefined,
          message: message.trim() || undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast({
          title: "Could not submit",
          description: data.message || "Please try again or email us at fullscale_info@gofullscale.co",
          variant: "destructive",
        });
        return;
      }
      setSubmitted(true);
    } catch {
      toast({
        title: "Network error",
        description: "Could not reach the server. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4 relative">
      <a
        href="/"
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors text-muted-foreground hover:text-white"
        data-testid="button-brand-signup-close"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </a>

      <div className="w-full max-w-lg">
        <div className="flex flex-col items-center mb-8">
          <img src={logoUrl} alt="FullScale" className="h-12 w-auto mb-4" />
          <h1 className="text-2xl font-bold text-white">For Brands</h1>
          <p className="text-muted-foreground text-sm mt-1">Apply for marketplace access</p>
        </div>

        {submitted ? (
          <Card className="bg-card/50 border-emerald-500/30">
            <CardContent className="pt-8 pb-8 text-center">
              <div className="w-16 h-16 mx-auto mb-6 bg-emerald-500/20 rounded-full flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-3">Application received</h2>
              <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                Thanks {firstName}. We review every brand application personally — you'll hear back from us within 1–2 business days at <span className="text-white">{email}</span>.
              </p>
              <p className="text-xs text-muted-foreground/60 mb-6">
                Once approved, you'll get access to the FullScale creator marketplace where you can browse founding creators, view their content, and submit product placement bids.
              </p>
              <a
                href="/"
                className="inline-block px-6 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                data-testid="button-brand-signup-done"
              >
                Back to home
              </a>
            </CardContent>
          </Card>
        ) : (
          <Card className="bg-card/50 border-white/10">
            <CardHeader className="text-center pb-4">
              <CardTitle className="text-xl">Apply for brand access</CardTitle>
              <CardDescription>
                FullScale is invite-only for brands. We approve applications manually to keep the marketplace high-signal for our creators.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="brand-first-name">First Name</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="brand-first-name"
                        placeholder="Jane"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="pl-10"
                        required
                        data-testid="input-brand-first-name"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="brand-last-name">Last Name</Label>
                    <Input
                      id="brand-last-name"
                      placeholder="Doe"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                      data-testid="input-brand-last-name"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="brand-email">Work Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="brand-email"
                      type="email"
                      placeholder="jane@yourbrand.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10"
                      required
                      data-testid="input-brand-email"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="brand-company">Company Name</Label>
                  <div className="relative">
                    <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="brand-company"
                      placeholder="Your Brand"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      className="pl-10"
                      required
                      data-testid="input-brand-company"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="brand-website">Website (optional)</Label>
                  <div className="relative">
                    <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="brand-website"
                      type="url"
                      placeholder="https://yourbrand.com"
                      value={websiteUrl}
                      onChange={(e) => setWebsiteUrl(e.target.value)}
                      className="pl-10"
                      data-testid="input-brand-website"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="brand-message">What are you looking to do? (optional)</Label>
                  <Textarea
                    id="brand-message"
                    placeholder="Briefly describe your product, target audience, or the type of creator you'd like to partner with."
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={4}
                    data-testid="input-brand-message"
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={isLoading}
                  data-testid="button-brand-signup-submit"
                >
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Apply for Access
                </Button>

                <p className="text-xs text-muted-foreground text-center mt-4">
                  Already approved?{" "}
                  <a href="/auth?mode=login" className="underline hover:text-white" data-testid="link-brand-signin">
                    Sign in here
                  </a>
                </p>

                <p className="text-xs text-muted-foreground/60 text-center">
                  By applying you agree to our{" "}
                  <a href="/terms" className="underline hover:text-white">Terms</a>
                  {" "}and{" "}
                  <a href="/privacy" className="underline hover:text-white">Privacy Policy</a>.
                </p>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
