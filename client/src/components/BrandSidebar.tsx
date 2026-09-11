import { Link, useLocation } from "wouter";
import { Search, Briefcase, Package, Bookmark, LogOut, ArrowLeftRight, Film, Send, Library as LibraryIcon } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
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

  // View-as options — for brand users who've been granted access to view
  // another user's library. Powers the "Other libraries" section below
  // the main nav. Endpoint returns either:
  //   { mode: "admin-all", grants: [] }       — caller is admin; UI could
  //                                              show a full picker (deferred)
  //   { mode: "granted",   grants: [{email, firstName, lastName}, ...] }
  // Empty grants → section is hidden. Cheap query, no cost when empty.
  const { data: viewAsData } = useQuery<{ mode: string; grants: Array<{ email: string; firstName: string | null; lastName: string | null }> }>({
    queryKey: ["/api/me/view-as-options"],
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
    { href: "/brand/clips", label: "Browse Clips", icon: Film },
    { href: "/brand/placements", label: "Requests", icon: Send },
    { href: "/campaigns", label: "My Campaigns", icon: Briefcase },
    { href: "/brand-products", label: "Product Catalog", icon: Package },
    { href: "/saved-placements", label: "Saved Placements", icon: Bookmark },
  ];

  return (
    <div className="w-64 h-screen bg-card border-r border-border fixed left-0 top-0 flex flex-col p-6 z-20">
      <Link href="/" className="block px-2 mb-10 cursor-pointer" data-testid="link-logo-home">
        <img src={logoUrl} alt="FullScale" className="h-10 w-auto cursor-pointer" />
      </Link>

      {/* min-h-0 + overflow-y-auto: lets the nav scroll when the combined
          height of links + "Other Libraries" exceeds the available space.
          Without min-h-0 the flex-1 child won't shrink below its content
          height in a flex column, so scroll never engages. */}
      <nav className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
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

        {/* View-as: show links to libraries this brand user has been granted
            access to. Hidden when no grants. One link per granter, opens
            /library?as=<email>. The App.tsx redirect was updated to allow
            brand users into /library specifically when ?as= is present. */}
        {viewAsData?.grants && viewAsData.grants.length > 0 && (
          <div className="pt-4 mt-4 border-t border-border/40">
            <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Other Libraries
            </div>
            {viewAsData.grants.map((g) => {
              const friendly = [g.firstName, g.lastName].filter(Boolean).join(" ") || g.email;
              return (
                <a
                  key={g.email}
                  href={`/library?as=${encodeURIComponent(g.email)}`}
                  className="sidebar-link"
                  data-testid={`link-view-as-${g.email}`}
                >
                  <LibraryIcon className="w-5 h-5 stroke-2" />
                  {friendly}'s Library
                </a>
              );
            })}
          </div>
        )}
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
