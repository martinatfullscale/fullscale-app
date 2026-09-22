import { useEffect, useRef, useState } from "react";
import { AlertCircle, Circle, Loader2, Search, Sparkles, Square, Video, X } from "lucide-react";
import { fetchWithTimeout } from "@/lib/queryClient";

/**
 * The three bin sources that aren't just "files you already own": record a
 * take, pull a stock clip, generate a still.
 *
 * All three write a `media_assets` row, which is the pool the bin already
 * lists — so nothing here needs its own plumbing back into the timeline. The
 * bin refetches and the new item is simply there.
 *
 * The credit model for AI stills is NOT new and is NOT enforced here: the
 * server owns it (DAILY_FREE_IMAGES = 5 in server/lib/aiGeneration.ts, priced
 * per request by priceFor, charged by runGeneration, 402 when it needs
 * credits). This panel reads the allowance to SHOW the cost before someone
 * commits — a price you only learn after clicking is not a price.
 */

// ── Webcam ───────────────────────────────────────────────────────────────

/**
 * Lifted from the old ReelBuilder modal, which had this and the new route did
 * not — a straight downgrade the moment the modal stopped being mounted.
 * Unchanged in substance: it was already self-contained, taking nothing but
 * a close and a capture callback.
 */
export function WebcamPanel({ onCapture, busy }: { onCapture: (file: File) => void; busy: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
        setReady(true);
      } catch (err: any) {
        setError(
          err?.name === "NotAllowedError"
            ? "Camera access was blocked. Allow it for this site in your browser, then try again."
            : err?.message || "Couldn't open the camera.",
        );
      }
    })();
    return () => {
      cancelled = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setReady(false);
    };
  }, [armed]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const start = () => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    // Prefer mp4 where the browser offers it; webm otherwise. ffmpeg reads both.
    const mime = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
      .find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
    rec.onstop = () => {
      const type = rec.mimeType || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      // "webcam" in the name is what the bin's Webcam filter matches on —
      // media_assets has no column that records how a file arrived.
      onCapture(new File([new Blob(chunksRef.current, { type })], `webcam-recording-${Date.now()}.${ext}`, { type }));
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setElapsed(0);
  };
  const stop = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setRecording(false);
  };

  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  if (!armed) {
    return (
      <div className="p-4 flex flex-col gap-3 items-start">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Record straight from this laptop — camera and microphone. The take lands in your bin like any other file.
        </p>
        <button
          onClick={() => setArmed(true)}
          className="inline-flex items-center gap-2 px-3 py-2 bg-primary text-white text-xs font-semibold"
          data-testid="reel-webcam-arm"
        >
          <Video className="w-3.5 h-3.5" /> Turn on the camera
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 flex flex-col gap-3 items-start">
        <AlertCircle className="w-5 h-5 text-primary" />
        <p className="text-[11px] leading-relaxed text-foreground/85">{error}</p>
        <button onClick={() => { setError(null); setArmed(false); }} className="px-2.5 py-1.5 border border-border text-[11px]">
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="relative bg-black border border-border overflow-hidden" style={{ aspectRatio: "9 / 16" }}>
        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
        {recording && (
          <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 px-2 py-1 bg-primary text-white text-[10px] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> {mmss}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {!recording ? (
          <button
            onClick={start}
            disabled={!ready || busy}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 bg-primary text-white text-xs font-semibold disabled:opacity-50"
            data-testid="reel-webcam-start"
          >
            <Circle className="w-3.5 h-3.5 fill-white" /> {ready ? "Record" : "Starting camera…"}
          </button>
        ) : (
          <button
            onClick={stop}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 bg-foreground text-background text-xs font-semibold"
            data-testid="reel-webcam-stop"
          >
            <Square className="w-3.5 h-3.5 fill-current" /> Stop &amp; add
          </button>
        )}
        <button onClick={() => { stop(); setArmed(false); }} className="px-2.5 py-2 border border-border text-[11px]" title="Turn the camera off">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {busy && <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Uploading the take…</p>}
    </div>
  );
}

// ── Stock ────────────────────────────────────────────────────────────────

interface StockVideo { uid: string; previewUrl: string; fileUrl: string; durationSec?: number; author?: string; providerLabel?: string; pageUrl?: string }

export function StockPanel({ onImported }: { onImported: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<StockVideo[]>([]);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const search = async (term: string) => {
    const query = term.trim();
    if (!query) { setErr("Type what you want to see — a place, an object, an action."); return; }
    setSearching(true);
    setErr(null);
    try {
      const res = await fetchWithTimeout(
        `/api/media-assets/stock/search?q=${encodeURIComponent(query)}&orientation=portrait`,
        { credentials: "include" },
        60_000,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Stock search failed");
      setResults(data.videos ?? []);
      if ((data.videos ?? []).length === 0) setErr("Nothing came back for that. Try a plainer noun.");
    } catch (e: any) {
      setErr(e?.message || "Stock search failed");
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const importOne = async (v: StockVideo) => {
    setImporting(v.uid);
    try {
      const res = await fetchWithTimeout("/api/media-assets/stock/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fileUrl: v.fileUrl, name: `Stock · ${q.trim()}`.slice(0, 120),
          durationSec: v.durationSec, photographer: v.author, pageUrl: v.pageUrl,
        }),
      }, 180_000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Import failed");
      // It is a media_assets row now, so the bin picks it up on refetch.
      onImported();
    } catch (e: any) {
      setErr(e?.message || "Import failed");
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="p-3 flex flex-col gap-2.5">
      <form onSubmit={(e) => { e.preventDefault(); search(q); }} className="flex gap-1.5">
        <label className="flex-1 flex items-center gap-2 px-2 h-8 border border-border focus-within:border-primary/60">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="city street, coffee pour, hands typing…"
            className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            data-testid="reel-stock-query"
          />
        </label>
        <button type="submit" disabled={searching} className="px-2.5 h-8 bg-primary text-white text-[11px] font-semibold disabled:opacity-50" data-testid="reel-stock-search">
          {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Search"}
        </button>
      </form>

      {err && <p className="text-[11px] leading-relaxed text-amber-300/90 border border-amber-500/30 bg-amber-500/[0.07] p-2">{err}</p>}

      <div className="grid grid-cols-2 gap-1.5">
        {results.map((v) => (
          <button
            key={v.uid}
            onClick={() => importOne(v)}
            disabled={importing !== null}
            className="relative border border-border hover:border-primary/60 overflow-hidden disabled:opacity-50 group"
            title={`Add to your bin — ${v.providerLabel ?? "stock"}${v.author ? `, by ${v.author}` : ""}`}
            data-testid={`reel-stock-${v.uid}`}
          >
            <img src={v.previewUrl} alt="" loading="lazy" className="w-full object-cover" style={{ aspectRatio: "9 / 16" }} />
            {importing === v.uid && (
              <span className="absolute inset-0 grid place-items-center bg-black/70">
                <Loader2 className="w-4 h-4 animate-spin text-white" />
              </span>
            )}
            {v.providerLabel && (
              <span className="absolute top-1 left-1 px-1 bg-black/70 text-[8px] text-white/90">{v.providerLabel}</span>
            )}
          </button>
        ))}
      </div>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        Clicking a result downloads it into your own bin — it is not hot-linked, so a saved reel can't break later.
      </p>
    </div>
  );
}

// ── AI stills ────────────────────────────────────────────────────────────

interface GenModel { id: string; label: string; credits?: number; kind?: string; note?: string }
interface Allowance { freeImagesLeft: number; freeImagesPerDay: number; balance?: number }

export function AiStillPanel({ onGenerated }: { onGenerated: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [models, setModels] = useState<GenModel[]>([]);
  const [modelId, setModelId] = useState<string>("image-fast");
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadOptions = async () => {
    try {
      const res = await fetchWithTimeout("/api/ai/generation/options", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      setAvailable(data.available !== false);
      setReason(data.reason ?? null);
      setModels(data.models ?? []);
      setAllowance(data.allowance ?? null);
      if (data.models?.[0]?.id) setModelId((m) => (data.models.some((x: GenModel) => x.id === m) ? m : data.models[0].id));
    } catch {
      setAvailable(false);
      setReason("Couldn't reach image generation.");
    }
  };
  useEffect(() => { void loadOptions(); }, []);

  const generate = async () => {
    if (!prompt.trim()) { setErr("Describe the still you want."); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetchWithTimeout("/api/ai/generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ modelId, prompt: prompt.trim(), promptSource: "manual", aspectRatio: "9:16" }),
      }, 180_000);
      const data = await res.json().catch(() => ({}));
      // 402 is the "you've used your free ones" path, and it deserves its own
      // message rather than being folded into a generic failure.
      if (res.status === 402) {
        setAllowance(data.allowance ?? allowance);
        setErr(data.reason || data.error || "That one costs credits, and there aren't enough on the account.");
        return;
      }
      if (!res.ok || !data.ok) throw new Error(data.reason || data.error || "Generation failed");
      setAllowance(data.allowance ?? allowance);
      setPrompt("");
      onGenerated();
    } catch (e: any) {
      setErr(e?.message || "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  const chosen = models.find((m) => m.id === modelId);
  const free = (allowance?.freeImagesLeft ?? 0) > 0;

  if (available === false) {
    return (
      <div className="p-4">
        <p className="text-[11px] leading-relaxed text-amber-300/90 border border-amber-500/30 bg-amber-500/[0.07] p-2">
          {reason || "Image generation isn't configured on this server."}
        </p>
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-2.5">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        maxLength={500}
        placeholder="A close-up of hands pouring coffee, morning light, shallow depth of field…"
        className="w-full px-2.5 py-2 border border-border bg-transparent text-xs text-foreground outline-none focus:border-primary/60 resize-none placeholder:text-muted-foreground/60"
        data-testid="reel-ai-prompt"
      />

      {models.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => setModelId(m.id)}
              className={`px-2 py-1 text-[10.5px] font-semibold border ${
                modelId === m.id ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground"
              }`}
              title={m.note}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      <button
        onClick={generate}
        disabled={busy || !prompt.trim()}
        className="w-full px-3 py-2 bg-primary text-white text-xs font-semibold disabled:opacity-40 inline-flex items-center justify-center gap-2"
        data-testid="reel-ai-generate"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
        {busy ? "Generating…" : free ? "Generate — free" : `Generate — ${chosen?.credits ?? 1} credit${(chosen?.credits ?? 1) === 1 ? "" : "s"}`}
      </button>

      {/* The price is stated BEFORE the click, not discovered after it. The
          server is the authority on both the allowance and the charge; this
          only reports what it said. */}
      {allowance && (
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          {allowance.freeImagesLeft} of {allowance.freeImagesPerDay} free images left today
          {allowance.balance != null ? ` · ${allowance.balance} credit${allowance.balance === 1 ? "" : "s"} on the account` : ""}.
          {" "}After the free ones, each still costs credits.
        </p>
      )}

      {err && <p className="text-[11px] leading-relaxed text-amber-300/90 border border-amber-500/30 bg-amber-500/[0.07] p-2">{err}</p>}

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        A still lands in your bin and can go on V0 as a held beat or on V1 as an overlay. It renders with a slow push
        so it reads as filmed rather than frozen.
      </p>
    </div>
  );
}
