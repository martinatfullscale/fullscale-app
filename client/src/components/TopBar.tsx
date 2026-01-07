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

        <button className="relative p-2 rounded-full hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
          <Bell className="w-5 h-5" />
          <span className="absolute top-2 right-2.5 w-2 h-2 bg-primary rounded-full ring-2 ring-background"></span>
        </button>

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
