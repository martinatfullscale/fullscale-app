import { Link, useLocation } from "wouter";
import { LayoutDashboard, FolderOpen, Zap, DollarSign, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

export function Sidebar() {
  const [location] = useLocation();
  const { logout } = useAuth();

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/library", label: "My Library", icon: FolderOpen },
    { href: "/opportunities", label: "Opportunities", icon: Zap },
    { href: "/earnings", label: "Earnings", icon: DollarSign },
  ];

  return (
    <div className="w-64 h-screen bg-card border-r border-border fixed left-0 top-0 flex flex-col p-6 z-20">
      <Link href="/" className="block px-2 mb-10" data-testid="link-logo-home">
        <img src={logoUrl} alt="FullScale" className="h-10 w-auto" />
      </Link>

      <nav className="flex-1 space-y-2">
        {links.map((link) => {
          const Icon = link.icon;
          const isActive = location === link.href;
          return (
            <Link key={link.href} href={link.href} className={cn("sidebar-link", isActive && "active")}>
              <Icon className={cn("w-5 h-5", isActive ? "stroke-[2.5px]" : "stroke-2")} />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="pt-6 border-t border-border">
        <button 
          onClick={() => logout()}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-muted-foreground transition-all duration-200 hover:text-red-400 hover:bg-red-500/10"
        >
          <LogOut className="w-5 h-5" />
          Sign Out
        </button>
      </div>
    </div>
  );
}
