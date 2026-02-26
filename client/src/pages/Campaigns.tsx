import { TopBar } from "@/components/TopBar";
import { motion } from "framer-motion";
import { Briefcase, Clock, CheckCircle, DollarSign, Eye, Package, Calendar, Film } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";

interface Campaign {
  id: number;
  title: string;
  thumbnailUrl: string | null;
  productName: string;
  productImageUrl: string;
  surfaceType: string;
  videoId: number;
  creatorUserId: string | null;
  bidAmount: string | null;
  viewCount: number;
  status: string;
  createdAt: string | null;
}

const statusColors: Record<string, string> = {
  live: "bg-emerald-500/20 text-emerald-400",
  active: "bg-emerald-500/20 text-emerald-400",
  archived: "bg-gray-500/20 text-gray-400",
  pending: "bg-amber-500/20 text-amber-400",
};

const statusLabels: Record<string, string> = {
  live: "Live",
  active: "Live",
  archived: "Archived",
  pending: "Pending",
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Campaigns() {
  const { data: campaignsData, isLoading } = useQuery<Campaign[]>({
    queryKey: ["/api/brand/campaigns"],
  });

  const campaigns = campaignsData || [];

  const stats = {
    total: campaigns.length,
    live: campaigns.filter(c => c.status === "live" || c.status === "active").length,
    archived: campaigns.filter(c => c.status === "archived").length,
    totalSpend: campaigns.reduce((sum, c) => sum + parseFloat(c.bidAmount || "0"), 0),
    estimatedReach: campaigns.reduce((sum, c) => sum + (c.viewCount || 0), 0),
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <TopBar />

      <main className="p-8">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8"
          >
            <div className="flex items-center gap-3 mb-2">
              <Briefcase className="w-8 h-8 text-primary" />
              <h1 className="text-3xl font-bold font-display" data-testid="text-campaigns-title">
                My Placements
              </h1>
            </div>
            <p className="text-muted-foreground">
              Track your product placements across creator content
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8"
          >
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <Package className="w-4 h-4 text-primary" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Placements</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-total-placements">
                {stats.total}
              </p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Live</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-live-placements">
                {stats.live}
              </p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-green-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Spend</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-total-spend">
                {stats.totalSpend > 0 ? `$${stats.totalSpend.toLocaleString()}` : "—"}
              </p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <Eye className="w-4 h-4 text-blue-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Est. Reach</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-estimated-reach">
                {stats.estimatedReach >= 1000000
                  ? `${(stats.estimatedReach / 1000000).toFixed(1)}M`
                  : stats.estimatedReach >= 1000
                    ? `${(stats.estimatedReach / 1000).toFixed(0)}K`
                    : stats.estimatedReach.toLocaleString()}
              </p>
            </Card>
          </motion.div>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <p className="text-muted-foreground">Loading placements...</p>
            </div>
          ) : campaigns.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="p-12 text-center">
                <Package className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">No Placements Yet</h3>
                <p className="text-muted-foreground mb-6">
                  Browse creator content and place your products to get started
                </p>
                <Button variant="default" asChild>
                  <a href="/marketplace" data-testid="link-discover-creators">
                    Discover Creators
                  </a>
                </Button>
              </Card>
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="space-y-3"
            >
              {campaigns.map((campaign) => (
                <Card key={campaign.id} className="p-4 flex items-center gap-4 hover:border-primary/30 transition-colors" data-testid={`card-campaign-${campaign.id}`}>
                  {/* Video thumbnail */}
                  <div className="w-28 h-18 rounded-md overflow-hidden bg-muted flex-shrink-0 relative">
                    {campaign.thumbnailUrl ? (
                      <img
                        src={campaign.thumbnailUrl}
                        alt={campaign.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Film className="w-6 h-6 text-muted-foreground" />
                      </div>
                    )}
                    {/* Product image overlay */}
                    {campaign.productImageUrl && (
                      <div className="absolute -bottom-1 -right-1 w-8 h-8 rounded-md border-2 border-background bg-white overflow-hidden shadow-sm">
                        <img
                          src={campaign.productImageUrl}
                          alt={campaign.productName}
                          className="w-full h-full object-contain"
                        />
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate" data-testid={`text-campaign-title-${campaign.id}`}>
                      {campaign.title}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm text-muted-foreground truncate">
                        {campaign.productName}
                      </span>
                      {campaign.createdAt && (
                        <span className="text-xs text-muted-foreground/60 flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {formatDate(campaign.createdAt)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Badges */}
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" data-testid={`badge-surface-${campaign.id}`}>
                      {campaign.surfaceType}
                    </Badge>
                    <Badge variant="secondary" className="text-xs" data-testid={`badge-views-${campaign.id}`}>
                      <Eye className="w-3 h-3 mr-1" />
                      {campaign.viewCount >= 1000
                        ? `${(campaign.viewCount / 1000).toFixed(0)}K`
                        : campaign.viewCount} views
                    </Badge>
                  </div>

                  {/* Status & amount */}
                  <div className="text-right min-w-[100px] flex flex-col items-end gap-1.5">
                    {campaign.bidAmount && parseFloat(campaign.bidAmount) > 0 && (
                      <p className="font-bold text-lg" data-testid={`text-campaign-cost-${campaign.id}`}>
                        ${parseFloat(campaign.bidAmount).toLocaleString()}
                      </p>
                    )}
                    <Badge className={statusColors[campaign.status] || statusColors.live} data-testid={`badge-status-${campaign.id}`}>
                      {statusLabels[campaign.status] || campaign.status}
                    </Badge>
                  </div>
                </Card>
              ))}
            </motion.div>
          )}
        </div>
      </main>
    </div>
  );
}
