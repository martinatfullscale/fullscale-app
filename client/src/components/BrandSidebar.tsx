import { Link, useLocation } from "wouter";
import { Search, Briefcase, LogOut, ArrowLeftRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import logoUrl from "@assets/fullscale-logo.png";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";

interface UserTypeResponse {
  email: string;
  userType: "creator" | "brand";
  baseUserType: "creator" | "brand";
  companyName?: string;
  isAdmin: boolean;
  canSwitchRoles: boolean;
}

export function BrandSidebar() {
  const [location, setLocation] = useLocation();
  const { logout } = useAuth();

  const { data: userTypeData } = useQuery<UserTypeResponse>({
    queryKey: ["/api/auth/user-type"],
  });

  const switchRoleMutation = useMutation({
    mutationFn: async (role: "creator" | "brand") => {
      const response = await apiRequest("POST", "/api/auth/switch-role", { role });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user-type"] });
      // Force hard redirect to ensure session is recognized immediately
      window.location.href = data.redirectTo || "/dashboard";
    },
  });

  const handleSwitchToCreator = () => {
    switchRoleMutation.mutate("creator");
  };

  const links = [
    { href: "/marketplace", label: "Discovery", icon: Search },
    { href: "/campaigns", label: "My Campaigns", icon: Briefcase },
  ];

  return (
    <div className="w-64 h-screen bg-card border-r border-border fixed left-0 top-0 flex flex-col p-6 z-20">
      <Link href="/" className="block px-2 mb-10 cursor-pointer" data-testid="link-logo-home">
        <img src={logoUrl} alt="FullScale" className="h-10 w-auto cursor-pointer" />
      </Link>

      <nav className="flex-1 space-y-2">
        {links.map((link) => {
          const Icon = link.icon;
          const isActive = location === link.href;
          return (
            <Link 
              key={link.href} 
              href={link.href} 
              className={cn("sidebar-link", isActive && "active")}
              data-testid={`link-${link.label.toLowerCase().replace(/\s/g, "-")}`}
            >
              <Icon className={cn("w-5 h-5", isActive ? "stroke-[2.5px]" : "stroke-2")} />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="pt-6 border-t border-border space-y-2">
        {userTypeData?.canSwitchRoles && (
          <button
            onClick={handleSwitchToCreator}
            disabled={switchRoleMutation.isPending}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-muted-foreground transition-all duration-200 hover:text-primary hover:bg-primary/10"
            data-testid="button-switch-to-creator"
          >
            <ArrowLeftRight className="w-5 h-5" />
            {switchRoleMutation.isPending ? "Switching..." : "Switch to Creator View"}
          </button>
        )}
        <button 
          onClick={() => logout()}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-muted-foreground transition-all duration-200 hover:text-red-400 hover:bg-red-500/10"
          data-testid="button-sign-out"
        >
          <LogOut className="w-5 h-5" />
          Sign Out
        </button>
      </div>
    </div>
  );
}
