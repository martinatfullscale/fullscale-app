import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
const logoUrl = "/fullscale-logo.png";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="container mx-auto px-6 h-20 flex items-center justify-between border-b border-white/5">
        <Link href="/">
          <img src={logoUrl} alt="FullScale Creator Portal" className="h-10 w-auto" />
        </Link>
        <Link href="/" className="text-sm text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </nav>

      <main className="p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-4">Privacy Policy for FullScale Creator Portal</h1>
        <p className="mb-4">Effective Date: {new Date().toLocaleDateString()}</p>
        <p className="mb-4">FullScale Creator Portal ('we', 'us') respects your privacy. We only collect your email address and profile name via Google OAuth for the purpose of account authentication and access management.</p>
        <p className="mb-4">We do not sell your personal data to third parties. If you wish to delete your data, please contact support.</p>
        <p className="text-sm text-muted-foreground mt-8">
          Questions? Contact us at fullscale_info@gofullscale.co
        </p>
      </main>
    </div>
  );
}
