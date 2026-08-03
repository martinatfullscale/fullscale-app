/**
 * Admin signups panel — the first-party approval path. One click flips
 * isApproved, writes the allowlist, and sends the founder-voice approval
 * email. Airtable stays a CRM mirror, not a load-bearing automation.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { TopBar } from "@/components/TopBar";
import { Loader2, CheckCircle2, ShieldCheck, UserCheck, Clock, FileCheck2 } from "lucide-react";

interface SignupRow {
  email: string;
  name: string | null;
  hasUserRow: boolean;
  isApproved?: boolean;
  authProvider?: string | null;
  profileSubmitted?: boolean;
  createdAt?: string | null;
  allowlistType?: string | null;
  allowlistAddedAt?: string | null;
  isAdmin?: boolean;
}

export default function AdminSignups() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<{ signups: SignupRow[] }>({
    queryKey: ["/api/admin/list-signups"],
    queryFn: async () => {
      const res = await fetch("/api/admin/list-signups", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load signups (${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const approveMutation = useMutation({
    mutationFn: async (row: SignupRow) => {
      const res = await fetch("/api/admin/approve-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: row.email, userType: row.allowlistType === "brand" ? "brand" : "creator" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Approval failed");
      return body;
    },
    onSuccess: (body) => {
      toast({
        title: `Approved ${body.email}`,
        description: body.approvalEmail?.sent
          ? "Approval email sent — they're in on their next page refresh."
          : `Account approved, but the email didn't send (${body.approvalEmail?.reason ?? "unknown"}) — drop them a note.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/list-signups"] });
    },
    onError: (err: Error) => {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    },
  });

  const rows = data?.signups ?? [];
  const pending = rows.filter((r) => r.hasUserRow && !r.isApproved && !r.isAdmin);
  const approved = rows.filter((r) => (r.isApproved || (!r.hasUserRow && r.allowlistType)) && !r.isAdmin);

  const fmtDate = (d?: string | null) =>
    d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";

  const RowCard = ({ row, showApprove }: { row: SignupRow; showApprove: boolean }) => (
    <div
      className="flex items-center gap-3 py-3 px-4 border-b border-white/5 last:border-b-0"
      data-testid={`signup-row-${row.email}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{row.name || row.email}</p>
        <p className="text-xs text-muted-foreground truncate">{row.email}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {row.profileSubmitted && (
          <Badge variant="outline" className="gap-1 text-emerald-400 border-emerald-500/30">
            <FileCheck2 className="w-3 h-3" />
            Profile
          </Badge>
        )}
        {!row.hasUserRow && row.allowlistType && (
          <Badge variant="outline" className="gap-1 text-sky-400 border-sky-500/30">
            Pre-approved · awaiting signup
          </Badge>
        )}
        {row.allowlistType === "brand" && <Badge variant="outline">Brand</Badge>}
        <span className="text-xs text-muted-foreground w-14 text-right">{fmtDate(row.createdAt || row.allowlistAddedAt)}</span>
        {showApprove ? (
          <Button
            size="sm"
            className="gap-1.5"
            disabled={approveMutation.isPending}
            onClick={() => approveMutation.mutate(row)}
            data-testid={`button-approve-${row.email}`}
          >
            {approveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
            Approve
          </Button>
        ) : (
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <main className="p-8 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold font-display">Signups &amp; Approvals</h1>
        </div>
        <p className="text-muted-foreground text-sm mb-8">
          One click approves the account, sends your approval email, and lets them in
          on their next page refresh. No Airtable automation required.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : isError ? (
          <p className="text-destructive text-sm">Couldn't load signups — are you signed in as an admin?</p>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-amber-400" />
              <h2 className="font-semibold text-sm">Waiting for review ({pending.length})</h2>
            </div>
            <Card className="border-border/50 mb-10">
              <CardContent className="p-0">
                {pending.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-6 text-center">No one waiting — inbox zero.</p>
                ) : (
                  pending.map((row) => <RowCard key={row.email} row={row} showApprove />)
                )}
              </CardContent>
            </Card>

            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h2 className="font-semibold text-sm">Approved ({approved.length})</h2>
            </div>
            <Card className="border-border/50">
              <CardContent className="p-0">
                {approved.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-6 text-center">No approvals yet.</p>
                ) : (
                  approved.map((row) => <RowCard key={row.email} row={row} showApprove={false} />)
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
