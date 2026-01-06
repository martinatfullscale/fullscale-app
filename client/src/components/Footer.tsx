import { useState } from "react";
import { Link } from "wouter";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { SiInstagram } from "react-icons/si";
import { Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function Footer() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");

  const handleSubscribe = () => {
    toast({
      title: "Thanks for subscribing!",
      description: "We'll keep you in the loop.",
    });
    setEmail("");
  };

  return (
    <footer className="relative z-10 bg-card/50 border-t border-white/5">
      <div className="container mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8">
          <div>
            <img src={logoUrl} alt="FullScale" className="h-8 w-auto mb-4" />
            <p className="text-sm text-muted-foreground/60 leading-relaxed">
              224 W 35th St Ste 500 #450,<br />
              New York, NY 10001
            </p>
          </div>

          <div>
            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/80 mb-4">Legal</h4>
            <ul className="space-y-3">
              <li>
                <Link href="/privacy" className="text-sm text-muted-foreground/60 hover:text-white transition-colors" data-testid="link-privacy">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="text-sm text-muted-foreground/60 hover:text-white transition-colors" data-testid="link-terms">
                  Terms of Service
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/80 mb-4">Connect</h4>
            <ul className="space-y-3">
              <li>
                <a 
                  href="https://www.instagram.com/gofullscale" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground/60 hover:text-white transition-colors inline-flex items-center gap-2"
                  data-testid="link-instagram"
                >
                  <SiInstagram className="w-4 h-4" />
                  Instagram
                </a>
              </li>
              <li>
                <a 
                  href="mailto:fullscale_info@gofullscale.co"
                  className="text-sm text-muted-foreground/60 hover:text-white transition-colors inline-flex items-center gap-2"
                  data-testid="link-contact"
                >
                  <Mail className="w-4 h-4" />
                  Contact Us
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/80 mb-4">Stay in the Loop</h4>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                className="flex-1 px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:border-primary/50 text-white placeholder:text-muted-foreground/40"
                data-testid="input-newsletter-email"
              />
              <button
                onClick={handleSubscribe}
                className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors"
                data-testid="button-subscribe"
              >
                Subscribe
              </button>
            </div>
          </div>

          <div className="mt-8">
            <p className="text-sm text-muted-foreground/40">
              &copy; 2025 FullScale Holdings.<br />
              All Rights Reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
