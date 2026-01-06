import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Clock, MessageSquare, CheckCircle, DollarSign } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";

const columns = [
  {
    title: "New Offers",
    subtitle: "Lead Gen",
    color: "border-blue-500/50",
    headerBg: "bg-blue-500/10",
    cards: [
      {
        brand: "Samsung",
        campaign: "Galaxy S24 Launch",
        amount: "$1,500",
        tag: "Expires in 24h",
        tagColor: "bg-orange-500/20 text-orange-400",
        icon: Clock,
      },
      {
        brand: "HelloFresh",
        campaign: "Q1 Partnership",
        amount: "$850",
        tag: "New",
        tagColor: "bg-blue-500/20 text-blue-400",
        icon: null,
      },
    ],
  },
  {
    title: "Negotiation",
    subtitle: "Active",
    color: "border-yellow-500/50",
    headerBg: "bg-yellow-500/10",
    cards: [
      {
        brand: "Nike",
        campaign: "Run Club",
        amount: "$1,200",
        tag: "Counter-offer sent",
        tagColor: "bg-yellow-500/20 text-yellow-400",
        icon: MessageSquare,
      },
      {
        brand: "Bose",
        campaign: "Noise Canceling",
        amount: "$2,100",
        tag: "Waiting for brand",
        tagColor: "bg-gray-500/20 text-gray-400",
        icon: Clock,
      },
    ],
  },
  {
    title: "Placed / Paid",
    subtitle: "Revenue",
    color: "border-emerald-500/50",
    headerBg: "bg-emerald-500/10",
    cards: [
      {
        brand: "Sony",
        campaign: "Vlog #45",
        amount: "$2,400",
        tag: "Funds Escrowed",
        tagColor: "bg-emerald-500/20 text-emerald-400",
        icon: DollarSign,
      },
      {
        brand: "Squarespace",
        campaign: "Portfolio Review",
        amount: "$1,200",
        tag: "Paid",
        tagColor: "bg-emerald-500/20 text-emerald-400",
        icon: CheckCircle,
      },
    ],
  },
];

export default function Opportunities() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <Sidebar />
      <TopBar />

      <main className="ml-64 p-8 max-w-7xl mx-auto">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-opportunities-title">
            Deal Flow
          </h1>
          <p className="text-muted-foreground">
            Track brand partnerships from offer to payment
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6"
        >
          {columns.map((column, colIdx) => (
            <div 
              key={colIdx} 
              className={`rounded-xl border ${column.color} bg-white/[0.02] overflow-hidden`}
              data-testid={`column-${colIdx}`}
            >
              <div className={`px-4 py-3 ${column.headerBg} border-b border-white/5`}>
                <h2 className="font-semibold text-white">{column.title}</h2>
                <p className="text-xs text-muted-foreground">{column.subtitle}</p>
              </div>
              <div className="p-3 space-y-3">
                {column.cards.map((card, cardIdx) => (
                  <div 
                    key={cardIdx}
                    className="bg-white/5 rounded-lg p-4 border border-white/5 hover:bg-white/[0.08] transition-colors cursor-pointer"
                    data-testid={`card-${colIdx}-${cardIdx}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <span className="font-semibold text-white">{card.brand}</span>
                      <span className="text-lg font-bold text-white">{card.amount}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">{card.campaign}</p>
                    <div className="flex items-center gap-2">
                      {card.icon && <card.icon className="w-3 h-3 text-muted-foreground" />}
                      <span className={`px-2 py-0.5 rounded-full ${card.tagColor} text-xs font-medium`}>
                        {card.tag}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </motion.div>
      </main>
    </div>
  );
}
