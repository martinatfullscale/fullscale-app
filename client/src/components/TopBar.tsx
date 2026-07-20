import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { Bell, Search, Briefcase, Video, ArrowLeftRight } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";

const SUPER_ADMIN_EMAIL = "martin@gofullscale.co";

interface UserTypeResponse {
  userType: string;
  viewRole: string;
  isAdmin: boolean;
  canSwitchRoles: boolean;
}

export function TopBar() {
  const { user } = useAuth();
  const { googleUser } = useHybridMode();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const currentUserEmail = googleUser?.email || user?.email || "";
  const isSuperAdmin = currentUserEmail.toLowerCase() === SUPER_ADMIN_EMAIL;

  const { data: userTypeData } = useQuery<UserTypeResponse>({
    queryKey: ["/api/auth/user-type"],
    enabled: !!currentUserEmail,
  });

  const switchRoleMutation = useMutation({
    mutationFn: async (role: "creator" | "brand") => {
      const res = await apiRequest("POST", "/api/auth/switch-role", { role });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user-type"] });
      // Force hard redirect to ensure session/cookie is recognized immediately
      if (data.viewRole === "brand") {
        window.location.href = "/marketplace";
      } else {
        window.location.href = "/dashboard";
      }
    },
  });

  const currentRole = userTypeData?.viewRole || "creator";

  // Real notifications drive the bell: unread count for the dot, recent
  // items in the dropdown.
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement | null>(null);
  const { data: notifData, refetch: refetchNotifications } = useQuery<{
    notifications: Array<{ id: number; type: string; title: string; body: string | null; linkPath: string | null; readAt: string | null; createdAt: string | null }>;
    unread: number;
  }>({
    queryKey: ["/api/notifications"],
    queryFn: async () => {
      const res = await fetch("/api/notifications", { credentials: "include" });
      if (!res.ok) return { notifications: [], unread: 0 };
      return res.json();
    },
    refetchInterval: 60_000,
  });
  const inboxCount = notifData?.unread ?? 0;
  const recentNotifications = notifData?.notifications ?? [];

  useEffect(() => {
    if (!bellOpen) return;
    const onClickAway = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [bellOpen]);

  const openNotification = async (n: { id: number; linkPath: string | null }) => {
    setBellOpen(false);
    fetch(`/api/notifications/${n.id}/read`, { method: "POST", credentials: "include" })
      .then(() => refetchNotifications())
      .catch(() => {});
    if (n.linkPath) setLocation(n.linkPath);
  };

  const handleSwitch = () => {
    const newRole = currentRole === "brand" ? "creator" : "brand";
    switchRoleMutation.mutate(newRole);
  };

  return (
    <header className="h-20 border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-10 flex items-center justify-between px-8 ml-64">
      <div className="flex items-center gap-4 flex-1">
        <div className="relative w-96 hidden md:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input 
            type="text" 
            placeholder="Search assets, scenes, or integrations..." 
            className="w-full bg-secondary/50 border border-border rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
          />
        </div>
      </div>

      <div className="flex items-center gap-6">
        {isSuperAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSwitch}
            disabled={switchRoleMutation.isPending}
            className="gap-2"
            data-testid="button-view-switcher"
          >
            <ArrowLeftRight className="w-4 h-4" />
            {currentRole === "brand" ? (
              <>
                <Video className="w-4 h-4" />
                <span>Creator Mode</span>
              </>
            ) : (
              <>
                <Briefcase className="w-4 h-4" />
                <span>Brand Mode</span>
              </>
            )}
          </Button>
        )}

        <div className="relative" ref={bellRef}>
          <button
            onClick={() => setBellOpen((v) => !v)}
            className="relative p-2 rounded-full hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            data-testid="button-notifications-bell"
            aria-label="Notifications"
          >
            <Bell className="w-5 h-5" />
            {inboxCount > 0 && (
              <span className="absolute top-2 right-2.5 w-2 h-2 bg-primary rounded-full ring-2 ring-background"></span>
            )}
          </button>
          {bellOpen && (
            <div className="absolute right-0 top-full mt-2 w-96 max-h-[420px] overflow-y-auto rounded-xl border border-border bg-background shadow-2xl z-50">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <span className="text-sm font-semibold">Notifications</span>
                {inboxCount > 0 && (
                  <button
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      fetch("/api/notifications/read-all", { method: "POST", credentials: "include" })
                        .then(() => refetchNotifications())
                        .catch(() => {});
                    }}
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {recentNotifications.length === 0 ? (
                <p className="px-4 py-8 text-sm text-muted-foreground text-center">Nothing yet — placement activity shows up here.</p>
              ) : (
                recentNotifications.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => openNotification(n)}
                    className={`w-full text-left px-4 py-3 border-b border-border/50 hover:bg-secondary/50 transition-colors ${n.readAt ? "opacity-60" : ""}`}
                    data-testid={`notification-${n.id}`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.readAt && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{n.title}</p>
                        {n.body && <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{n.body}</p>}
                        {n.createdAt && (
                          <p className="text-[10px] text-muted-foreground/70 mt-1">{new Date(n.createdAt).toLocaleString()}</p>
                        )}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pl-6 border-l border-border">
          <Badge 
            className={currentRole === "brand" 
              ? "bg-blue-500 hover:bg-blue-600 text-white border-blue-600" 
              : "bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-600"
            }
            data-testid="badge-current-role"
          >
            {currentRole === "brand" ? "Brand" : "Creator"}
          </Badge>
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium text-foreground">{user?.firstName || "Creator"} {user?.lastName || ""}</p>
            <p className="text-xs text-muted-foreground">Pro Plan</p>
          </div>
          <Avatar className="h-10 w-10 border-2 border-border">
            <AvatarImage src={user?.profileImageUrl ?? undefined} />
            <AvatarFallback className="bg-primary/10 text-primary font-bold">
              {user?.firstName?.[0] || "C"}
            </AvatarFallback>
          </Avatar>
        </div>
      </div>
    </header>
  );
}
