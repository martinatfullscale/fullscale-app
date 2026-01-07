import { TopBar } from "@/components/TopBar";
import { motion } from "framer-motion";
import { Briefcase, Clock, CheckCircle, DollarSign, Eye } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";

interface Campaign {
  id: number;
  title: string;
  thumbnailUrl: string | null;
  date: string | null;
  status: string;
  videoId: number | null;
  creatorUserId: string | null;
  creatorName: string | null;
  brandEmail: string | null;
  brandName: string | null;
  bidAmount: string | null;
  sceneType: string | null;
  genre: string | null;
  viewCount: number;
}

const statusColors: Record<string, string> = {
  pending: "bg-amber-500/20 text-amber-400",
  accepted: "bg-emerald-500/20 text-emerald-400",
  live: "bg-blue-500/20 text-blue-400",
  rejected: "bg-red-500/20 text-red-400",
  expired: "bg-gray-500/20 text-gray-400",
};

const statusLabels: Record<string, string> = {
  pending: "Pending",
  accepted: "Approved",
  live: "Live",
  rejected: "Declined",
  expired: "Expired",
};

export default function Campaigns() {
  const { data: campaignsData, isLoading } = useQuery<Campaign[]>({
    queryKey: ["/api/brand/campaigns"],
  });

  const campaigns = campaignsData || [];

  const stats = {
    total: campaigns.length,
    pending: campaigns.filter(c => c.status === "pending").length,
    accepted: campaigns.filter(c => c.status === "accepted" || c.status === "live").length,
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
                My Campaigns
              </h1>
            </div>
            <p className="text-muted-foreground">
              Track your brand placement bids and active campaigns
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="grid grid-cols-5 gap-4 mb-8"
          >
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <Briefcase className="w-4 h-4 text-primary" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Placements</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-total-bids">
                {stats.total}
              </p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-4 h-4 text-amber-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Pending</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-pending-bids">
                {stats.pending}
              </p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Active</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-accepted-bids">
                {stats.accepted}
              </p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-green-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Spend</p>
              </div>
              <p className="text-3xl font-bold text-foreground" data-testid="text-total-spend">
                ${stats.totalSpend.toLocaleString()}
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
              <p className="text-muted-foreground">Loading campaigns...</p>
            </div>
          ) : campaigns.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="p-12 text-center">
                <Briefcase className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">No Campaigns Yet</h3>
                <p className="text-muted-foreground mb-6">
                  Start bidding on creator videos in the Discovery feed to launch your first campaign
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
              className="space-y-4"
            >
              {campaigns.map((campaign) => (
                <Card key={campaign.id} className="p-4 flex items-center gap-4" data-testid={`card-campaign-${campaign.id}`}>
                  <div className="w-24 h-16 rounded-md overflow-hidden bg-muted flex-shrink-0">
                    {campaign.thumbnailUrl ? (
                      <img 
                        src={campaign.thumbnailUrl} 
                        alt={campaign.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Briefcase className="w-6 h-6 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate" data-testid={`text-campaign-title-${campaign.id}`}>{campaign.title}</h3>
                    <p className="text-sm text-muted-foreground" data-testid={`text-campaign-creator-${campaign.id}`}>
                      {campaign.creatorName || campaign.creatorUserId || "Pro Creator"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {campaign.sceneType && (
                      <Badge variant="outline" data-testid={`badge-surface-${campaign.id}`}>
                        {campaign.sceneType}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-xs" data-testid={`badge-views-${campaign.id}`}>
                      <Eye className="w-3 h-3 mr-1" />
                      {campaign.viewCount >= 1000 
                        ? `${(campaign.viewCount / 1000).toFixed(0)}K` 
                        : campaign.viewCount} views
                    </Badge>
                  </div>
                  <div className="text-right min-w-[100px]">
                    <p className="font-bold text-lg" data-testid={`text-campaign-cost-${campaign.id}`}>
                      ${parseFloat(campaign.bidAmount || "0").toLocaleString()}
                    </p>
                    <Badge className={statusColors[campaign.status] || statusColors.pending} data-testid={`badge-status-${campaign.id}`}>
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
