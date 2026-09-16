import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, Wand2, X } from "lucide-react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { fmtT, MAX_REEL_SEC, type BinSource, type ReelItem, newItemId } from "./types";
import { parseDurationSec, isLongForm } from "@shared/duration";

/**
 * Pick a long-form video, get several reels back.
 *
 * The point of the feature, and the thing that makes it different from
 * "generate a clip": each option is a set of SEPARATE CUTS, not one long
 * extract. They land on the timeline as individual blocks, so a creator can
 * swap a beat, re-order, razor one in half, or delete the bit that did not
 * land — which is the whole reason to bring an AI proposal into an editor
 * rather than just rendering it.
 *
 * Nothing is written server-side by proposing. No stitch plan, no clip, no
 * render — the options exist only here until one is applied to the timeline,
 * and even then it is a draft the creator owns before anything is built.
 */

interface VideoRow { id: number; title: string; duration?: string | null; thumbnailUrl?: string | null; filePath?: string | null; status?: string | null }

export interface AiSegment {
  start: number;
  end: number;
  /** Set only on a cross-video thread — a single-video option inherits the
   *  video the creator picked. */
  videoId?: number;
  videoTitle?: string;
  role: "hook" | "development" | "climax" | "payoff" | "bridge";
  narrativePurpose: string;
  suggestedTransition: "cut" | "crossfade" | "branded_wipe";
}
export interface AiOption {
  angle: string;
  rationale: string;
  narrativeArc: string;
  suggestedTitle: string;
  segments: AiSegment[];
  totalDuration: number;
}

const ROLE_TONE: Record<AiSegment["role"], string> = {
  hook: "bg-primary/15 border-primary/45 text-primary",
  development: "bg-white/5 border-border text-muted-foreground",
  climax: "bg-amber-500/15 border-amber-500/45 text-amber-300",
  payoff: "bg-emerald-500/15 border-emerald-500/45 text-emerald-300",
  bridge: "bg-white/5 border-border text-muted-foreground/70",
};

export function AiReelPanel(props: {
  onClose: () => void;
  /** Apply an option: the sources it needs, and the blocks to lay down. */
  onApply: (sources: BinSource[], items: ReelItem[], title: string) => void;
}) {
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(true);
  const [videoId, setVideoId] = useState<number | null>(null);
  /** What the creator asked for, in their words. Optional — with nothing typed
   *  the model picks the strongest arcs on its own, which is the old behaviour. */
  const [query, setQuery] = useState("");
  /** "one" reads a single long-form video. "across" hunts one story through
   *  several of them. Two different questions, one panel. */
  const [scope, setScope] = useState<"one" | "across">("one");
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<AiOption[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openIdx, setOpenIdx] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithTimeout("/api/video-index", { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        const rows: VideoRow[] = (data.videos ?? []).filter((v: VideoRow) => !!v.title);
        setVideos(rows);
      } catch {
        setVideos([]);
      } finally {
        setLoadingVideos(false);
      }
    })();
  }, []);

  const video = useMemo(() => videos.find((v) => v.id === videoId) ?? null, [videos, videoId]);

  const propose = async () => {
    if (scope === "one" && videoId == null) return;
    setBusy(true);
    setErr(null);
    setOptions(null);
    try {
      if (scope === "across") {
        // The cross-video route returns ONE thread, not a set of options, and
        // its beats each carry their own videoId. Normalised into the same
        // shape so the review UI and `apply` below do not have to fork.
        const r = await fetchWithTimeout(
          "/api/remix/library-thread",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ segmentCount: 5, targetDuration: 110, query: query.trim() || undefined }),
          },
          180_000,
        );
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Couldn't find a story across your videos");
        const segs = (d.segments ?? []).map((sg: any) => ({
          start: Number(sg.start),
          end: Number(sg.end),
          role: (sg.role || "development") as AiSegment["role"],
          narrativePurpose: sg.reason || sg.videoTitle || "",
          suggestedTransition: sg.suggestedTransition || "crossfade",
          videoId: Number(sg.videoId),
          videoTitle: sg.videoTitle,
        }));
        setOptions([{
          angle: d.suggestedTitle || "Across your videos",
          rationale: d.narrativeArc || "",
          narrativeArc: d.narrativeArc || "",
          suggestedTitle: d.suggestedTitle || "Across your videos",
          segments: segs,
          totalDuration: Number(d.totalDuration) || segs.reduce((n: number, x: any) => n + (x.end - x.start), 0),
        }]);
        setOpenIdx(0);
        return;
      }

      const res = await fetchWithTimeout(
        `/api/remix/${videoId}/reel-options`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            optionCount: 5,
            segmentCount: 4,
            targetDuration: 110,
            query: query.trim() || undefined,
          }),
        },
        180_000,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't propose reels for this video");
      setOptions(data.options ?? []);
      setOpenIdx(0);
    } catch (e: any) {
      setErr(e?.message || "Couldn't propose reels for this video");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Turn one option into timeline blocks.
   *
   * Each cut becomes its OWN block, laid end to end. The times are in the
   * source video's clock, so the block's source range is the cut and its
   * timeline position is the running total — which is what makes the result
   * editable rather than a single opaque extract.
   */
  const apply = (opt: AiOption) => {
    const sources: BinSource[] = [];
    const items: ReelItem[] = [];
    let at = 0;
    opt.segments.forEach((seg, i) => {
      // A cross-video beat names its own source; a single-video option
      // inherits the one that was picked.
      const from = seg.videoId != null ? videos.find((v) => v.id === seg.videoId) ?? null : video;
      if (!from) return;
      const len = Math.max(0.5, seg.end - seg.start);
      if (at + len > MAX_REEL_SEC) return;             // the cap owns the ceiling
      const sk = `m:${from.id}:${seg.start.toFixed(2)}`;
      sources.push({
        sk,
        kind: "moment",
        label: seg.narrativePurpose?.slice(0, 60) || `${seg.role} · ${fmtT(seg.start)}`,
        meta: `${seg.videoTitle ?? from.title} · ${seg.role}`,
        // The source video's own file, so the block previews in the program
        // monitor instead of showing a gap.
        url: from.filePath || null,
        boundStart: seg.start,
        boundEnd: seg.end,
        // These times ARE source-video times already, unlike a rendered clip
        // whose file is zero-based — so no offset.
        srcOffset: 0,
        videoId: from.id,
      });
      items.push({
        id: newItemId(),
        sk,
        track: "V0",
        at,
        in: seg.start,
        out: seg.end,
        tin: i === 0 ? "cut" : seg.suggestedTransition,
      });
      at += len;
    });
    if (items.length < 2) {
      setErr("That option doesn't fit inside the reel cap. Try one of the shorter ones.");
      return;
    }
    props.onApply(sources, items, opt.suggestedTitle);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border/40">
        <Sparkles className="w-3.5 h-3.5 text-primary" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-primary">AI reel</span>
        <button onClick={props.onClose} className="ml-auto text-muted-foreground hover:text-foreground" data-testid="reel-ai-close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {scope === "one"
            ? "Pick a long-form video. You'll get several different reels cut from it — each one a set of separate moments you can re-order, trim or swap, not a single long extract."
            : "Finds one story running through several of your videos and cuts it into a single reel. Say what you're after and it looks for that; leave it blank and it finds the strongest thread on its own."}
        </p>

        <div className="flex border border-border">
          {(["one", "across"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setScope(m); setOptions(null); setErr(null); }}
              className={`flex-1 px-2 py-1.5 text-[11px] font-semibold ${
                scope === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`reel-ai-scope-${m}`}
            >
              {m === "one" ? "From one video" : "Across my videos"}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            What kind of reel? <span className="normal-case tracking-normal font-normal">(optional)</span>
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="best advice · funniest moments · anything about pricing"
            maxLength={300}
            className="w-full h-8 px-2 border border-border bg-background text-xs text-foreground outline-none focus:border-primary/60 placeholder:text-muted-foreground/60"
            data-testid="reel-ai-query"
          />
        </label>

        {scope === "one" && (
          <select
            value={videoId ?? ""}
            onChange={(e) => { setVideoId(Number(e.target.value) || null); setOptions(null); setErr(null); }}
            className="w-full h-8 px-2 border border-border bg-background text-xs text-foreground outline-none focus:border-primary/60"
            data-testid="reel-ai-video"
          >
            <option value="">{loadingVideos ? "Loading your videos…" : "Choose a video…"}</option>
            {/* Longest first, and the duration parsed rather than printed raw:
                video_index.duration is a varchar holding YouTube's ISO-8601, so
                the picker whose own instruction says "pick a long-form video"
                used to offer "My Podcast Ep 12 · PT1H5M12S". */}
            {[...videos]
              .map((v) => ({ v, secs: parseDurationSec(v.duration ?? null) }))
              .sort((a, b) => (b.secs ?? 0) - (a.secs ?? 0))
              .map(({ v, secs }) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                  {secs ? ` · ${fmtT(secs)}` : ""}
                  {isLongForm(secs) ? " · long form" : ""}
                </option>
              ))}
          </select>
        )}

        <button
          onClick={propose}
          disabled={(scope === "one" && videoId == null) || busy}
          className="w-full px-3 py-2 bg-primary text-white text-xs font-semibold disabled:opacity-40 inline-flex items-center justify-center gap-2"
          data-testid="reel-ai-propose"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
          {busy ? "Reading the transcript…" : "Propose reels"}
        </button>

        {busy && (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            This reads the whole transcript and takes up to a couple of minutes on a long video.
          </p>
        )}

        {err && <p className="text-[11px] leading-relaxed text-amber-300/90 border border-amber-500/30 bg-amber-500/[0.07] p-2">{err}</p>}

        {options?.length === 0 && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Nothing usable came back for that video. It usually means there isn't enough spoken material to cut
            several distinct reels from.
          </p>
        )}

        {options?.map((opt, i) => {
          const open = openIdx === i;
          return (
            <div key={i} className={`border ${open ? "border-primary/50" : "border-border"}`} data-testid={`reel-ai-option-${i}`}>
              <button
                onClick={() => setOpenIdx(open ? -1 : i)}
                className="w-full text-left px-2.5 py-2 flex items-baseline gap-2"
              >
                <span className="font-display text-[13px] font-semibold text-foreground truncate">{opt.angle}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {opt.segments.length} cuts · {fmtT(opt.totalDuration)}
                </span>
              </button>

              {open && (
                <div className="px-2.5 pb-2.5 flex flex-col gap-2">
                  {opt.rationale && <p className="text-[11px] leading-relaxed text-muted-foreground">{opt.rationale}</p>}

                  <ol className="flex flex-col gap-1">
                    {opt.segments.map((sg, j) => (
                      <li key={j} className="flex items-baseline gap-2 text-[10.5px]">
                        <span className={`shrink-0 px-1 border text-[8.5px] font-semibold uppercase ${ROLE_TONE[sg.role]}`}>
                          {sg.role}
                        </span>
                        <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                          {fmtT(sg.start)}–{fmtT(sg.end)}
                        </span>
                        <span className="text-foreground/75 truncate">{sg.narrativePurpose}</span>
                      </li>
                    ))}
                  </ol>

                  <button
                    onClick={() => apply(opt)}
                    className="px-2.5 py-1.5 bg-foreground text-background text-[11px] font-semibold self-start"
                    data-testid={`reel-ai-use-${i}`}
                  >
                    Put this on the timeline
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {options && options.length > 0 && (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            Applying one replaces what's on V0. Nothing is rendered until you press Build — every cut is still
            yours to move, trim or throw away first.
          </p>
        )}
      </div>
    </div>
  );
}
