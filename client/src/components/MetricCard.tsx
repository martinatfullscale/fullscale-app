import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";

interface MetricCardProps {
  title: string;
  value: string | number;
  trend?: string;
  icon: React.ReactNode;
  delay?: number;
  colorClass?: string;
}

export function MetricCard({ title, value, trend, icon, delay = 0, colorClass = "bg-primary" }: MetricCardProps) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: delay * 0.1 }}
      className="bg-card border border-border rounded-2xl p-6 relative overflow-hidden group hover:border-border/80 transition-colors"
    >
      <div className={cn("absolute top-0 right-0 w-32 h-32 opacity-[0.03] rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 group-hover:opacity-[0.08] transition-opacity duration-500", colorClass)} />
      
      <div className="flex justify-between items-start mb-4">
        <div className={cn("p-3 rounded-xl bg-secondary/50 text-foreground group-hover:scale-105 transition-transform duration-300", 
          "group-hover:text-primary group-hover:bg-primary/10")}>
          {icon}
        </div>
        {trend && (
          <div className="flex items-center gap-1 text-xs font-medium text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-full">
            <ArrowUpRight className="w-3 h-3" />
            {trend}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-muted-foreground font-medium text-sm">{title}</h3>
        <p className="text-3xl font-bold font-display mt-1 tracking-tight text-foreground">{value}</p>
      </div>
    </motion.div>
  );
}
