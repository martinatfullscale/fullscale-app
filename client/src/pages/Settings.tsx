import { useState, useEffect } from "react";
import { TopBar } from "@/components/TopBar";
import { User, CreditCard, Bell, CheckCircle, ExternalLink, Save, Link2, Loader2 } from "lucide-react";
import { SiInstagram, SiFacebook, SiX, SiTiktok, SiYoutube, SiTwitch } from "react-icons/si";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

type TabType = "profile" | "payouts" | "notifications" | "integrations";

const tabs = [
  { id: "profile" as const, label: "General Profile", icon: User },
  { id: "integrations" as const, label: "Social Integrations", icon: Link2 },
  { id: "payouts" as const, label: "Payouts & Billing", icon: CreditCard },
  { id: "notifications" as const, label: "Notification Preferences", icon: Bell },
];

interface SocialConnection {
  id: string;
  name: string;
  icon: typeof SiInstagram;
  color: string;
  bgColor: string;
  status: "disconnected" | "connecting" | "connected";
  followers?: string;
  handle?: string;
}

const initialSocialConnections: SocialConnection[] = [
  { id: "instagram", name: "Instagram Professional", icon: SiInstagram, color: "#E4405F", bgColor: "bg-gradient-to-br from-[#833AB4] via-[#E4405F] to-[#FCAF45]", status: "disconnected", followers: "125K", handle: "@creator.ig" },
  { id: "facebook", name: "Facebook Page", icon: SiFacebook, color: "#1877F2", bgColor: "bg-[#1877F2]", status: "disconnected", followers: "89K", handle: "Justin's Page" },
  { id: "twitch", name: "Twitch Channel", icon: SiTwitch, color: "#9146FF", bgColor: "bg-[#9146FF]", status: "disconnected", followers: "156K", handle: "NinjaMode" },
  { id: "x", name: "X (Twitter)", icon: SiX, color: "#000000", bgColor: "bg-black", status: "disconnected", followers: "45K", handle: "@creator_x" },
  { id: "tiktok", name: "TikTok", icon: SiTiktok, color: "#000000", bgColor: "bg-gradient-to-br from-[#00F2EA] to-[#FF0050]", status: "disconnected", followers: "2.1M", handle: "@creator.tiktok" },
  { id: "youtube", name: "YouTube", icon: SiYoutube, color: "#FF0000", bgColor: "bg-[#FF0000]", status: "connected", followers: "850K", handle: "Creator Channel" },
];

export default function Settings() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabType>("profile");
  const [socialConnections, setSocialConnections] = useState<SocialConnection[]>(initialSocialConnections);
  
  const [profile, setProfile] = useState({
    fullName: "Martin Creators",
    channelName: "Martin's Tech",
    email: "martin@creators.com",
  });

  const [notifications, setNotifications] = useState({
    newBrandOffer: true,
    videoAnalysisComplete: true,
    weeklyRevenueReport: false,
  });

  const handleConnectSocial = (id: string) => {
    const connection = socialConnections.find((c) => c.id === id);
    if (!connection) return;

    if (connection.status === "connected") {
      setSocialConnections((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "disconnected" as const } : c))
      );
      toast({
        title: `${connection.name} Disconnected`,
        description: `Your ${connection.name} account has been disconnected.`,
      });
      return;
    }

    setSocialConnections((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: "connecting" as const } : c))
    );

    setTimeout(() => {
      setSocialConnections((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "connected" as const } : c))
      );
      toast({
        title: `${connection.name} Connected`,
        description: `Successfully connected your ${connection.name} account!`,
      });
    }, 1500);
  };

  const handleSave = () => {
    toast({
      title: "Settings Saved",
      description: "Your preferences have been updated successfully.",
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <TopBar />

      <main className="p-8 max-w-6xl mx-auto">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-settings-title">
            Settings
          </h1>
          <p className="text-muted-foreground">Manage your account preferences and integrations</p>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex gap-8"
        >
          <div className="w-64 shrink-0">
            <nav className="space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  data-testid={`tab-${tab.id}`}
                  className={`w-full text-left px-4 py-3 rounded-lg flex items-center gap-3 transition-colors ${
                    activeTab === tab.id
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "text-muted-foreground hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  <span className="text-sm font-medium">{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1">
            {activeTab === "profile" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 rounded-xl border border-white/5 p-6"
              >
                <h2 className="text-xl font-semibold text-white mb-6">General Profile</h2>
                
                <div className="flex items-center gap-6 mb-8">
                  <Avatar className="w-20 h-20 border-2 border-primary/30">
                    <AvatarFallback className="bg-primary/20 text-primary text-2xl font-bold">
                      MC
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <Button variant="outline" size="sm" data-testid="button-change-avatar">
                      Change Avatar
                    </Button>
                    <p className="text-xs text-muted-foreground mt-2">JPG, PNG up to 2MB</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="fullName" className="text-white">Full Name</Label>
                    <Input
                      id="fullName"
                      value={profile.fullName}
                      onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
                      className="bg-black/30 border-white/10 text-white"
                      data-testid="input-full-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="channelName" className="text-white">Channel Name</Label>
                    <Input
                      id="channelName"
                      value={profile.channelName}
                      onChange={(e) => setProfile({ ...profile, channelName: e.target.value })}
                      className="bg-black/30 border-white/10 text-white"
                      data-testid="input-channel-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white">Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      value={profile.email}
                      onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                      className="bg-black/30 border-white/10 text-white"
                      data-testid="input-email"
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "integrations" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 rounded-xl border border-white/5 p-6"
              >
                <h2 className="text-xl font-semibold text-white mb-2">Social Integrations</h2>
                <p className="text-muted-foreground text-sm mb-6">Connect your social accounts to unlock multi-platform monetization</p>
                
                <div className="space-y-4">
                  {socialConnections.map((connection) => (
                    <div
                      key={connection.id}
                      className="bg-black/30 rounded-lg p-4 border border-white/5 flex flex-wrap items-center justify-between gap-4"
                      data-testid={`connection-${connection.id}`}
                    >
                      <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 ${connection.bgColor} rounded-xl flex items-center justify-center`}>
                          <connection.icon className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <p className="text-white font-medium">{connection.name}</p>
                          {connection.status === "connected" ? (
                            <p className="text-sm text-muted-foreground">
                              {connection.handle} • {connection.followers} followers
                            </p>
                          ) : (
                            <p className="text-sm text-muted-foreground">Not connected</p>
                          )}
                        </div>
                      </div>
                      
                      <Button
                        variant={connection.status === "connected" ? "outline" : "default"}
                        onClick={() => handleConnectSocial(connection.id)}
                        disabled={connection.status === "connecting"}
                        className={`min-w-[120px] gap-2 ${
                          connection.status === "connected"
                            ? "border-emerald-500/30 text-emerald-400"
                            : ""
                        }`}
                        data-testid={`button-connect-${connection.id}`}
                      >
                        {connection.status === "connecting" ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Connecting...
                          </>
                        ) : connection.status === "connected" ? (
                          <>
                            <CheckCircle className="w-4 h-4" />
                            Connected
                          </>
                        ) : (
                          <>
                            <Link2 className="w-4 h-4" />
                            Connect
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
                
                <div className="mt-6 p-4 rounded-lg bg-primary/10 border border-primary/20">
                  <p className="text-sm text-primary">
                    Connecting multiple platforms increases your earning potential by 40% on average.
                    Brands prefer creators with diverse audiences.
                  </p>
                </div>
                
                {/* Linked Accounts Card */}
                {socialConnections.filter(c => c.status === "connected").length > 0 && (
                  <div className="mt-6 bg-black/30 rounded-xl border border-white/5 p-6">
                    <h3 className="text-lg font-semibold text-white mb-4">Linked Accounts</h3>
                    <div className="space-y-3">
                      {socialConnections.filter(c => c.status === "connected").map((connection) => (
                        <div
                          key={connection.id}
                          className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                          data-testid={`linked-${connection.id}`}
                        >
                          <div className={`w-8 h-8 ${connection.bgColor} rounded-lg flex items-center justify-center`}>
                            <connection.icon className="w-4 h-4 text-white" />
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-medium text-white">{connection.name}</p>
                            <p className="text-xs text-muted-foreground">{connection.handle}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium text-emerald-400">{connection.followers}</p>
                            <p className="text-xs text-muted-foreground">followers</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === "payouts" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-6"
              >
                <div className="bg-white/5 rounded-xl border border-white/5 p-6">
                  <h2 className="text-xl font-semibold text-white mb-6">Payout Configuration</h2>
                  
                  <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 rounded-xl p-6 border border-emerald-500/20 mb-6">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <p className="text-sm text-emerald-400/80 font-mono uppercase tracking-wider mb-1">Current Balance</p>
                        <p className="text-4xl font-bold text-emerald-400" data-testid="text-balance">$4,250.00</p>
                      </div>
                      <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                        Ready for Payout
                      </Badge>
                    </div>
                  </div>

                  <div className="border-t border-white/5 pt-6">
                    <h3 className="text-lg font-semibold text-white mb-4">Stripe Connect</h3>
                    
                    <div className="bg-black/30 rounded-lg p-4 border border-white/5">
                      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-[#635BFF]/20 rounded-lg flex items-center justify-center">
                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
                              <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" fill="#635BFF"/>
                            </svg>
                          </div>
                          <div>
                            <p className="text-white font-medium">Stripe Account</p>
                            <p className="text-sm text-muted-foreground">Chase Bank ****8829</p>
                          </div>
                        </div>
                        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          Connected
                        </Badge>
                      </div>
                      <Button variant="outline" className="gap-2" data-testid="button-manage-stripe">
                        <ExternalLink className="w-4 h-4" />
                        Manage Payouts on Stripe
                      </Button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "notifications" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 rounded-xl border border-white/5 p-6"
              >
                <h2 className="text-xl font-semibold text-white mb-6">Notification Preferences</h2>
                
                <div className="space-y-6">
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <div>
                      <p className="text-white font-medium">New Brand Offer Received</p>
                      <p className="text-sm text-muted-foreground">Get notified when brands make offers on your content</p>
                    </div>
                    <Switch
                      checked={notifications.newBrandOffer}
                      onCheckedChange={(checked) => setNotifications({ ...notifications, newBrandOffer: checked })}
                      data-testid="switch-brand-offer"
                    />
                  </div>
                  
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <div>
                      <p className="text-white font-medium">Video Analysis Complete</p>
                      <p className="text-sm text-muted-foreground">Get notified when AI finishes analyzing your videos</p>
                    </div>
                    <Switch
                      checked={notifications.videoAnalysisComplete}
                      onCheckedChange={(checked) => setNotifications({ ...notifications, videoAnalysisComplete: checked })}
                      data-testid="switch-video-analysis"
                    />
                  </div>
                  
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-white font-medium">Weekly Revenue Report</p>
                      <p className="text-sm text-muted-foreground">Receive a summary of your earnings every Monday</p>
                    </div>
                    <Switch
                      checked={notifications.weeklyRevenueReport}
                      onCheckedChange={(checked) => setNotifications({ ...notifications, weeklyRevenueReport: checked })}
                      data-testid="switch-weekly-report"
                    />
                  </div>
                </div>
              </motion.div>
            )}

            <div className="flex justify-end mt-6">
              <Button onClick={handleSave} className="gap-2" data-testid="button-save-settings">
                <Save className="w-4 h-4" />
                Save Changes
              </Button>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
