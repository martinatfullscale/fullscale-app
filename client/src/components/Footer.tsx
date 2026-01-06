import { Link } from "wouter";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { SiInstagram } from "react-icons/si";
import { Mail } from "lucide-react";

export function Footer() {
  return (
    <footer className="relative z-10 bg-card/50 border-t border-white/5">
      <div className="container mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
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
                  href="mailto:contact@fullscale.com"
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
