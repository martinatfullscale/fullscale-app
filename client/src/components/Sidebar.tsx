import { Link, useLocation } from "wouter";
import { LayoutDashboard, FolderOpen, Zap, DollarSign, LogOut, Settings, ArrowLeftRight, Globe, Wand2, Inbox, Library as LibraryIcon, BarChart3, Database } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";

export interface UserTypeResponse {
  email: string;
  name?: string | null;
  slug?: string | null;
  userType: "creator" | "brand";
  baseUserType: "creator" | "brand";
  companyName?: string;
  isAdmin: boolean;
  canSwitchRoles: boolean;
}

export function Sidebar() {
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
      window.location.href = data.redirectTo || "/marketplace";
    },
  });

  const handleSwitchToBrand = () => {
    switchRoleMutation.mutate("brand");
  };

  // Pending placement requests count — shows as a badge on the Inbox link.
  // Polls every 60s so creators see new requests without manually refreshing.
  const { data: inboxCountData } = useQuery<{ count: number }>({
    queryKey: ["/api/creator/placements/inbox/count"],
    refetchInterval: 60_000,
  });
  const inboxCount = inboxCountData?.count ?? 0;

  // View-as options — admins get every user with library content, others
  // get just the libraries they've been granted via LIBRARY_VIEW_GRANTS.
  // Used to render the "Other Libraries" dropdown in the creator sidebar
  // so admins can hop into another user's library to test remix engine /
  // distribution against real content (e.g. Scott + Juan testing against
  // Martin's library).
  const { data: viewAsData } = useQuery<{
    mode: string;
    grants: Array<{ email: string; firstName: string | null; lastName: string | null; videoCount?: number }>;
  }>({
    queryKey: ["/api/me/view-as-options"],
  });

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/library", label: "My Library", icon: FolderOpen },
    { href: "/inbox", label: "Inbox", icon: Inbox, badge: inboxCount },
    { href: "/analytics", label: "Analytics", icon: BarChart3 },
    { href: "/opportunities", label: "Opportunities", icon: Zap },
    { href: "/earnings", label: "Earnings", icon: DollarSign },
    ...(userTypeData?.isAdmin ? [{ href: "/admin/creators", label: "Creator Intel", icon: Database }] : []),
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="w-64 h-screen bg-card border-r border-border fixed left-0 top-0 flex flex-col p-6 z-20">
      <Link href="/" className="block px-2 mb-10 cursor-pointer" data-testid="link-logo-home">
        <img src={logoUrl} alt="FullScale" className="h-10 w-auto cursor-pointer" />
      </Link>

      {/* min-h-0 + overflow-y-auto: lets the nav scroll when the combined
          height of links + "Other Libraries" + portfolio exceeds the
          available space between the logo (top) and bottom buttons.
          Without min-h-0 the flex-1 child won't actually shrink below
          its content height in a flex column, so scroll never engages. */}
      <nav className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
        {links.map((link) => {
          const Icon = link.icon;
          const isActive = location === link.href;
          const badge = (link as any).badge as number | undefined;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn("sidebar-link relative", isActive && "active")}
              data-testid={`link-${link.label.toLowerCase().replace(/\s/g, "-")}`}
            >
              <Icon className={cn("w-5 h-5", isActive ? "stroke-[2.5px]" : "stroke-2")} />
              <span className="flex-1">{link.label}</span>
              {badge !== undefined && badge > 0 && (
                <span
                  className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold bg-emerald-500 text-white"
                  data-testid={`badge-${link.label.toLowerCase()}`}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </Link>
          );
        })}

        {/* "Other Libraries" — view-as dropdown. Admins see every user with
            content; non-admins with LIBRARY_VIEW_GRANTS entries see just
            those granters. Hidden when empty. Each option links to
            /library?as=<email> which the server gates via admin OR grant. */}
        {viewAsData?.grants && viewAsData.grants.length > 0 && (
          <div className="pt-4 mt-4 border-t border-border/40">
            <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Other Libraries{viewAsData.mode === "admin-all" ? " (Admin)" : ""}
            </div>
            {/* Cap to 8 entries to keep the sidebar compact. If more exist,
                they're reachable via /library?as=<email> direct URL. */}
            {viewAsData.grants.slice(0, 8).map((g) => {
              const friendly = [g.firstName, g.lastName].filter(Boolean).join(" ") || g.email;
              const labelCount = typeof g.videoCount === "number" && g.videoCount > 0 ? ` (${g.videoCount})` : "";
              return (
                <a
                  key={g.email}
                  href={`/library?as=${encodeURIComponent(g.email)}`}
                  className="sidebar-link"
                  data-testid={`link-view-as-${g.email}`}
                  title={g.email}
                >
                  <LibraryIcon className="w-5 h-5 stroke-2" />
                  <span className="truncate">{friendly}{labelCount}</span>
                </a>
              );
            })}
          </div>
        )}

        {/* Portfolio link */}
        <div className="pt-4 mt-4 border-t border-border/50">
          {userTypeData?.slug ? (
            <Link
              href={`/c/${userTypeData.slug}`}
              className={cn("sidebar-link", location === `/c/${userTypeData.slug}` && "active")}
              data-testid="link-my-portfolio"
            >
              <Globe className="w-5 h-5 stroke-2" />
              My Profile
            </Link>
          ) : (
            <Link
              href="/settings"
              className="sidebar-link text-muted-foreground/60"
              data-testid="link-setup-portfolio"
            >
              <Globe className="w-5 h-5 stroke-2" />
              Set Up Portfolio
            </Link>
          )}

          {/* Studio — admin only */}
          {userTypeData?.isAdmin && (
            <Link
              href="/studio/upload"
              className={cn("sidebar-link", location.startsWith("/studio") && "active")}
              data-testid="link-studio"
            >
              <Wand2 className="w-5 h-5 stroke-2" />
              Studio
            </Link>
          )}
        </div>
      </nav>

      <div className="pt-6 border-t border-border space-y-2">
        {userTypeData?.canSwitchRoles && (
          <button
            onClick={handleSwitchToBrand}
            disabled={switchRoleMutation.isPending}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-muted-foreground transition-all duration-200 hover:text-primary hover:bg-primary/10"
            data-testid="button-switch-to-brand"
          >
            <ArrowLeftRight className="w-5 h-5" />
            {switchRoleMutation.isPending ? "Switching..." : "Switch to Brand View"}
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
