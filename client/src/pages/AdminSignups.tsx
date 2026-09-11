/**
 * Admin signups panel — the first-party approval path. One click flips
 * isApproved, writes the allowlist, and sends the founder-voice approval
 * email. Airtable stays a CRM mirror, not a load-bearing automation.
 */
import { useState } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { TopBar } from "@/components/TopBar";
import { Loader2, CheckCircle2, ShieldCheck, UserCheck, Clock, FileCheck2, Mail, Clapperboard, XCircle } from "lucide-react";

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
      const res = await fetchWithTimeout("/api/admin/list-signups", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load signups (${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const approveMutation = useMutation({
    mutationFn: async (row: SignupRow) => {
      const res = await fetchWithTimeout("/api/admin/approve-user", {
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

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviting, setInviting] = useState(false);

  const sendInvite = async () => {
    setInviting(true);
    try {
      const res = await fetchWithTimeout("/api/admin/send-team-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: inviteEmail.trim(), firstName: inviteName.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Send failed");
      toast({ title: `Invite sent to ${inviteEmail.trim()}`, description: "They'll get sign-in instructions from martin@." });
      setInviteEmail("");
      setInviteName("");
    } catch (err: any) {
      toast({ title: "Couldn't send invite", description: err?.message, variant: "destructive" });
    } finally {
      setInviting(false);
    }
  };

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

        <Card className="border-border/50 mb-8">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Mail className="w-4 h-4 text-primary" />
              <p className="text-sm font-medium">Send a teammate their access instructions</p>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              For people already on the admin allowlist. The email explains how to sign in
              (Google — the password form is blocked for admin addresses) and what the admin
              screens do.
            </p>
            <div className="flex gap-2 flex-wrap">
              <input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="First name"
                className="h-9 px-3 rounded-md bg-white/5 border border-white/10 text-sm w-32"
                data-testid="invite-name"
              />
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="h-9 px-3 rounded-md bg-white/5 border border-white/10 text-sm flex-1 min-w-[220px]"
                data-testid="invite-email"
              />
              <Button disabled={inviting || !inviteEmail.trim()} onClick={sendInvite} data-testid="send-invite">
                {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send invite"}
              </Button>
            </div>
          </CardContent>
        </Card>

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

            {/* Studio early access. These requests had no screen at all:
                "Request Early Access" wrote a studio_waitlist row and the
                only way to find one was to query the table by hand. */}
            <StudioWaitlistSection />
          </>
        )}
      </main>
    </div>
  );
}

interface StudioWaitlistRow {
  id: number;
  name: string;
  email: string;
  useCase: string | null;
  status: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

/**
 * Studio early-access queue.
 *
 * Approving is the whole action — Studio access is gated on this row's
 * status (hasApprovedStudioAccess), so there is no second step to forget.
 */
function StudioWaitlistSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery<{ entries: StudioWaitlistRow[]; pending: number }>({
    queryKey: ["/api/admin/studio-waitlist"],
  });

  const review = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "approved" | "rejected" }) => {
      const res = await fetchWithTimeout(`/api/admin/studio-waitlist/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not update the request");
      return body;
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/studio-waitlist"] });
      toast({
        title: vars.status === "approved" ? "Studio access granted" : "Request declined",
        description: vars.status === "approved" ? "They can use Studio on their next page load." : undefined,
      });
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const entries = data?.entries ?? [];
  const waiting = entries.filter((e) => e.status === "pending");
  const decided = entries.filter((e) => e.status !== "pending");

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

  return (
    <>
      <div className="flex items-center gap-2 mb-3 mt-10">
        <Clapperboard className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-sm">Studio early access ({waiting.length} waiting)</h2>
      </div>
      <Card className="border-border/50">
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-6 text-center flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading requests…
            </p>
          ) : isError ? (
            <p className="text-sm text-muted-foreground p-6 text-center">Couldn't load Studio requests.</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">No Studio requests yet.</p>
          ) : (
            <div className="divide-y divide-border/50">
              {[...waiting, ...decided].map((row) => (
                <div key={row.id} className="p-4 flex items-start gap-3 flex-wrap" data-testid={`studio-waitlist-${row.id}`}>
                  <div className="flex-1 min-w-[200px]">
                    <p className="text-sm font-medium">
                      {row.name}
                      <span className="text-muted-foreground font-normal"> · {row.email}</span>
                    </p>
                    {row.useCase && (
                      <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{row.useCase}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground/70 mt-1">
                      Requested {fmt(row.submittedAt)}
                      {row.reviewedAt && ` · reviewed ${fmt(row.reviewedAt)}${row.reviewedBy ? ` by ${row.reviewedBy}` : ""}`}
                    </p>
                  </div>
                  {row.status === "pending" ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: row.id, status: "approved" })}
                        data-testid={`studio-approve-${row.id}`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Grant access
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: row.id, status: "rejected" })}
                        data-testid={`studio-reject-${row.id}`}
                      >
                        Decline
                      </Button>
                    </div>
                  ) : (
                    <Badge
                      variant="outline"
                      className={row.status === "approved"
                        ? "border-emerald-500/40 text-emerald-400"
                        : "border-red-500/40 text-red-400"}
                    >
                      {row.status === "approved"
                        ? <><CheckCircle2 className="w-3 h-3 mr-1" /> Has access</>
                        : <><XCircle className="w-3 h-3 mr-1" /> Declined</>}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
