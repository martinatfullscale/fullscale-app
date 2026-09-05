import { useRef } from "react";
import { newGestureToken } from "./useHistory";
import { Copy, Trash2 } from "lucide-react";
import { baseGainOf, fmtTime, type BaseSegment, type BrollEdit, type StudioEdits, type TextOverlayEdit } from "./types";

/**
 * Inspectors — the six tools, redistributed.
 *
 * The old left rail was six mutually exclusive modes: pick "B-Roll" and the
 * whole screen became about b-roll whether or not a b-roll cut was selected.
 * Here the panel is a function of what is selected on the timeline, which is
 * the difference between a settings screen and an editor.
 *
 *   Transcript  → base segment, plus a full panel from the toolbar
 *   Captions    → one document-level panel (a property of the clip, not a selection)
 *   Text        → V2 block
 *   B-Roll      → V1 block, plus the bin
 *   Audio       → A1 block, and clip level on the base segment
 *   Motion      → split: stabilization on the base, Ken Burns on the b-roll
 */

// ── Small shared controls ────────────────────────────────────────────────

function Head({ dot, title, meta, sub }: { dot: string; title: string; meta?: string; sub?: string }) {
  return (
    <div className="p-3.5 border-b border-white/10 flex flex-col gap-1 shrink-0">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 shrink-0" style={{ background: dot }} />
        <span className="font-display text-sm font-semibold text-foreground">{title}</span>
        {meta && <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{meta}</span>}
      </div>
      {sub && <p className="text-[11px] text-muted-foreground/70 truncate">{sub}</p>}
    </div>
  );
}

function Group({ label, badge, children, note }: { label: string; badge?: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
        {badge && (
          <span className="h-4 px-1.5 rounded bg-primary/15 border border-primary/40 text-primary text-[9px] font-semibold flex items-center">
            {badge}
          </span>
        )}
      </div>
      {children}
      {note && <p className="text-[11px] leading-relaxed text-muted-foreground/70">{note}</p>}
    </div>
  );
}

const Rule = () => <div className="h-px bg-white/10" />;

function Chips<T extends string | number>({
  options, value, onChange, testId,
}: { options: Array<{ v: T; label: string }>; value: T; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map((o) => {
        const on = o.v === value;
        return (
          <button
            key={String(o.v)}
            onClick={() => onChange(o.v)}
            className={`h-[26px] px-2.5 rounded-[7px] text-[11px] transition-colors ${
              on
                ? "bg-white/10 border border-white/25 text-foreground font-semibold"
                : "border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/20"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A slider that owns its own gesture boundary.
 *
 * Callers used to pass a fixed coalescing token like "x" or "basegain". A
 * constant token never stops matching, so EVERY later drag of that control
 * folded into the first one's undo entry — after the second drag, one Cmd+Z
 * jumped all the way back past both. Worse, a literal shared between two
 * b-roll blocks merged their separate drags.
 *
 * The gesture starts on pointerdown/keydown and ends on pointerup/keyup/blur,
 * and the token is minted fresh each time, so one drag is one entry and the
 * next drag is the next entry — which is what a person means by undo.
 */
function Slide({
  label, value, min, max, step, format, token, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  format?: (v: number) => string;
  /** Base name for this control. Made unique per gesture internally. */
  token: string;
  onChange: (v: number, token: string) => void;
}) {
  const gesture = useRef<string | null>(null);
  const begin = () => { if (!gesture.current) gesture.current = newGestureToken(token); };
  const end = () => { gesture.current = null; };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground/80">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={begin}
        onKeyDown={begin}
        onChange={(e) => { begin(); onChange(Number(e.target.value), gesture.current!); }}
        onPointerUp={end}
        onKeyUp={end}
        onBlur={end}
        className="w-full h-1 appearance-none rounded bg-white/10 accent-primary cursor-pointer"
      />
    </div>
  );
}

function Toggle({ label, on, onChange, testId }: { label: string; on: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="h-8 px-2.5 rounded-lg border border-white/10 hover:border-white/20 flex items-center justify-between gap-3"
      data-testid={testId}
    >
      <span className="text-xs text-foreground/85">{label}</span>
      <span className={`relative w-[34px] h-[18px] rounded-full transition-colors ${on ? "bg-primary" : "bg-white/15"}`}>
        <span
          className="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all"
          style={{ left: on ? 16 : 2 }}
        />
      </span>
    </button>
  );
}

function Footer({ onDuplicate, onDelete }: { onDuplicate?: () => void; onDelete: () => void }) {
  return (
    <div className="mt-auto p-3 border-t border-white/10 flex gap-2 shrink-0">
      {onDuplicate && (
        <button
          onClick={onDuplicate}
          className="flex-1 h-[30px] rounded-lg border border-white/10 hover:border-white/25 text-xs text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1.5"
          data-testid="inspector-duplicate"
        >
          <Copy className="w-3 h-3" />
          Duplicate
        </button>
      )}
      <button
        onClick={onDelete}
        className="flex-1 h-[30px] rounded-lg border border-primary/40 hover:border-primary text-xs text-primary inline-flex items-center justify-center gap-1.5"
        data-testid="inspector-delete"
      >
        <Trash2 className="w-3 h-3" />
        Delete
      </button>
    </div>
  );
}

/**
 * A two-handle range over a source file — the control that did not exist.
 *
 * Its whole job is to answer "which part of my 90-second upload plays here",
 * a question the b-roll model previously had no field for and the render
 * answered by always using the head.
 */
function SourceRange({
  duration, from, to, onChange, onCommit,
}: { duration: number; from: number; to: number; onChange: (a: number, b: number) => void; onCommit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (clientX: number) => {
    const el = ref.current;
    if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };
  const drag = (edge: "a" | "b") => (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const t = at(ev.clientX);
      if (edge === "a") onChange(Math.min(t, to - 0.1), to);
      else onChange(from, Math.max(t, from + 0.1));
    };
    const up = () => {
      onCommit();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);
  return (
    <>
      <div
        ref={ref}
        className="relative h-11 rounded-lg border border-white/10 overflow-hidden bg-gradient-to-r from-[#141b26] to-[#1b2330]"
        data-testid="inspector-source-range"
      >
        <div className="absolute inset-y-0 left-0 bg-black/70" style={{ width: `${pct(from)}%` }} />
        <div className="absolute inset-y-0 right-0 bg-black/70" style={{ width: `${100 - pct(to)}%` }} />
        <div className="absolute inset-y-0 border-[1.5px] border-indigo-400" style={{ left: `${pct(from)}%`, right: `${100 - pct(to)}%` }} />
        <div
          onPointerDown={drag("a")}
          className="absolute top-2 bottom-2 w-2 bg-indigo-400 cursor-ew-resize -translate-x-1/2"
          style={{ left: `${pct(from)}%` }}
        />
        <div
          onPointerDown={drag("b")}
          className="absolute top-2 bottom-2 w-2 bg-indigo-400 cursor-ew-resize -translate-x-1/2"
          style={{ left: `${pct(to)}%` }}
        />
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>srcStart {fmtTime(from)}</span>
        <span>srcEnd {fmtTime(to)}</span>
      </div>
    </>
  );
}

// ── Base segment ─────────────────────────────────────────────────────────

export function BaseSegmentInspector(props: {
  segment: BaseSegment;
  total: number;
  edits: StudioEdits;
  /** Assembled clip: everything here is dropped at render, so say so. */
  locked: boolean;
  /** Ramps the segment list cannot show, because their bounds match nothing. */
  orphanRamps: Array<{ start: number; end: number; rate: number }>;
  onClearOrphanRamps: () => void;
  words: Array<{ word: string; start: number; end: number }>;
  isCut: (w: { start: number; end: number }) => boolean;
  onToggleWord: (w: { word: string; start: number; end: number }) => void;
  onRate: (rate: number) => void;
  onRemoveSegment: () => void;
  onRestoreSegment: () => void;
  onSplitAtPlayhead: () => void;
  onStabilize: (v: { enabled: boolean; strength: number } | null) => void;
  /** Separate from onStabilize so the drag can carry a coalescing token — a
   *  1→10 sweep was landing nine entries on the undo stack. */
  onStabilizeStrength: (strength: number, token: string) => void;
  onBaseAudio: (level: number, token: string) => void;
}) {
  const { segment, total, edits, words, locked } = props;
  const inSeg = words.filter((w) => w.end > segment.start && w.start < segment.end);
  const gain = baseGainOf(edits) ?? 1;
  /** A rate the four chips cannot express — a 0.4x from an older editor, say. */
  const offScale = Math.abs(segment.rate - 1) > 0.01 && ![0.5, 0.75, 1.25, 1.5, 2].some((r) => Math.abs(r - segment.rate) < 0.01);

  return (
    <>
      <Head
        dot="#94a3b8"
        title="Base segment"
        meta={`V0 · seg ${segment.index + 1} of ${total}`}
        sub={segment.removed ? "Removed — this stretch will not be in the export" : undefined}
      />
      <div className={`p-3.5 flex flex-col gap-4 overflow-y-auto ${locked ? "opacity-60" : ""}`}>
        {locked && (
          <p className="text-[11px] leading-relaxed text-amber-300/85 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-2.5">
            This clip is assembled from several beats, so speed, clip audio and stabilization are dropped at
            render. Collapse it to one range to make them stick.
          </p>
        )}
        {props.orphanRamps.length > 0 && (
          <div className="text-[11px] leading-relaxed rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-2.5 flex flex-col gap-2">
            <span className="text-amber-200">
              {props.orphanRamps.length} speed ramp{props.orphanRamps.length === 1 ? "" : "s"} from an earlier edit
              {props.orphanRamps.length === 1 ? " does" : " do"} not line up with any segment. {props.orphanRamps.length === 1 ? "It still renders" : "They still render"},
              but the chips below cannot reach {props.orphanRamps.length === 1 ? "it" : "them"}.
            </span>
            <button
              onClick={props.onClearOrphanRamps}
              className="self-start h-[26px] px-2.5 rounded-[7px] border border-amber-500/40 text-[11px] text-amber-200 hover:border-amber-400"
              data-testid="inspector-clear-orphan-ramps"
            >
              Clear {props.orphanRamps.length === 1 ? "it" : "them"}
            </button>
          </div>
        )}
        <Group label="Range" note="Where this segment sits in the clip. Drag the seam on V0, or split again to subdivide.">
          <div className="grid grid-cols-2 gap-2">
            <div className="h-8 flex items-center px-2.5 rounded-lg border border-white/10 font-mono text-xs tabular-nums text-foreground/85">
              {fmtTime(segment.start)}
            </div>
            <div className="h-8 flex items-center px-2.5 rounded-lg border border-white/10 font-mono text-xs tabular-nums text-foreground/85">
              {fmtTime(segment.end)}
            </div>
          </div>
        </Group>

        <Rule />

        <Group
          label="Speed"
          note="Writes a speed ramp for this segment. Audio follows via atempo, so lip sync holds."
        >
          <Chips
            options={[
              { v: 0.5, label: "0.5×" },
              { v: 0.75, label: "0.75×" },
              { v: 1, label: "1.00×" },
              { v: 1.25, label: "1.25×" },
              { v: 1.5, label: "1.5×" },
              { v: 2, label: "2×" },
            ]}
            value={Number(segment.rate.toFixed(2)) as number}
            onChange={props.onRate}
            testId="inspector-speed"
          />
          {offScale && (
            <p className="text-[11px] text-amber-300/85">
              This segment is at {segment.rate.toFixed(2)}× — a rate the chips do not carry. Picking one replaces it.
            </p>
          )}
        </Group>

        <Rule />

        <Group
          label="Transcript in this segment"
          note="Struck words compile to the same segment list the razor produces. Every strike is one undo entry now, not 'clear all cuts'."
        >
          {inSeg.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/70">No transcript covers this stretch.</p>
          ) : (
            <p className="text-xs leading-relaxed max-h-32 overflow-y-auto">
              {inSeg.map((w, i) => {
                const cut = props.isCut(w);
                return (
                  <span
                    key={i}
                    onClick={() => props.onToggleWord(w)}
                    className={`cursor-pointer rounded px-0.5 ${
                      cut ? "line-through text-primary/70 bg-primary/10" : "text-foreground/85 hover:bg-white/10"
                    }`}
                  >
                    {w.word}{" "}
                  </span>
                );
              })}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={props.onSplitAtPlayhead}
              className="h-[26px] px-2.5 rounded-[7px] border border-white/10 hover:border-white/25 text-[11px] text-muted-foreground hover:text-foreground"
              data-testid="inspector-split-here"
            >
              Split at playhead
            </button>
            {segment.removed ? (
              <button
                onClick={props.onRestoreSegment}
                className="h-[26px] px-2.5 rounded-[7px] border border-emerald-500/40 text-[11px] text-emerald-300"
                data-testid="inspector-restore-segment"
              >
                Restore segment
              </button>
            ) : (
              <button
                onClick={props.onRemoveSegment}
                className="h-[26px] px-2.5 rounded-[7px] border border-primary/40 text-[11px] text-primary"
                data-testid="inspector-remove-segment"
              >
                Remove segment
              </button>
            )}
          </div>
        </Group>

        <Rule />

        <Group label="Clip audio" badge="NEW" note="Gain on the clip's own audio. The music bed always had a level; the speech under it never did.">
          {/* No onCommit. It used to re-send the settled value as a
              committed change, which pushed a SECOND identical history entry —
              so the first Cmd+Z after a drag appeared to do nothing. The drag
              already coalesces into one entry; the gesture ends when the token
              stops being reused. */}
          <Slide
            label="Level"
            value={gain}
            min={0}
            max={2}
            step={0.05}
            format={(v) => (v === 1 ? "unchanged" : `${v.toFixed(2)}×`)}
            token="clip-audio"
            onChange={(v, tk) => props.onBaseAudio(v, tk)}
          />
        </Group>

        <Rule />

        <Group label="Motion" note="Stabilization is applied at render — it is the one thing here the preview cannot show.">
          <Toggle
            label={`Stabilize${edits.stabilization?.enabled ? ` · strength ${edits.stabilization.strength}` : ""}`}
            on={!!edits.stabilization?.enabled}
            onChange={(v) => props.onStabilize(v ? { enabled: true, strength: edits.stabilization?.strength ?? 5 } : null)}
            testId="inspector-stabilize"
          />
          {edits.stabilization?.enabled && (
            <Slide
              label="Strength"
              value={edits.stabilization.strength}
              min={1}
              max={10}
              step={1}
              format={(v) => String(v)}
              token="stabilize-strength"
              onChange={(v, tk) => props.onStabilizeStrength(v, tk)}
            />
          )}
        </Group>
      </div>
    </>
  );
}

// ── B-roll block ─────────────────────────────────────────────────────────

export function BrollInspector(props: {
  cut: BrollEdit;
  index: number;
  count: number;
  assetName: string;
  /** Source length in seconds, or 0 when unknown (stills, failed probes). */
  assetDuration: number;
  isImage: boolean;
  onPatch: (patch: Partial<BrollEdit>, label: string, token?: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { cut, assetDuration, isImage } = props;
  const from = Number.isFinite(Number(cut.srcStart)) ? Number(cut.srcStart) : 0;
  const to = Number.isFinite(Number(cut.srcEnd)) ? Number(cut.srcEnd) : Math.min(assetDuration || cut.end - cut.start, cut.end - cut.start);
  const rangeToken = useRef(`src:${props.index}:${Math.round(cut.start * 1000)}`);

  return (
    <>
      <Head dot="#818cf8" title="B-roll block" meta={`V1 · ${props.index + 1} of ${props.count}`} sub={`${props.assetName} · selected on the timeline`} />
      <div className="p-3.5 flex flex-col gap-4 overflow-y-auto">
        <Group label="Placement on output">
          <div className="grid grid-cols-2 gap-2">
            <div className="h-8 flex items-center px-2.5 rounded-lg border border-white/10 font-mono text-xs tabular-nums text-foreground/85">
              start {fmtTime(cut.start)}
            </div>
            <div className="h-8 flex items-center px-2.5 rounded-lg border border-white/10 font-mono text-xs tabular-nums text-foreground/85">
              end {fmtTime(cut.end)}
            </div>
          </div>
        </Group>

        {isImage ? (
          <Group label="Source" note="A still has no source timeline — the whole image is used, and the Ken Burns move below is what gives it life.">
            <p className="text-[11px] text-muted-foreground/70">Still image</p>
          </Group>
        ) : (
          <Group
            label="Source in / out"
            badge="NEW FIELD"
            note={
              assetDuration > 0
                ? "Preview and render read the same in-point. Before this field, the export always used the head of the file."
                : "This file's length was never probed, so the range is bounded by the block instead. It still aims the render."
            }
          >
            <SourceRange
              duration={assetDuration > 0 ? assetDuration : Math.max(to, cut.end - cut.start, 1)}
              from={from}
              to={to}
              onChange={(a, b) => props.onPatch({ srcStart: a, srcEnd: b }, `Set source in ${fmtTime(a)}`, rangeToken.current)}
              onCommit={() => { rangeToken.current = `src:${props.index}:${Math.random().toString(36).slice(2)}`; }}
            />
            <p className="font-mono text-[10px] text-muted-foreground/60">
              {(to - from).toFixed(1)}s of source, held for {(cut.end - cut.start).toFixed(1)}s on the timeline
            </p>
          </Group>
        )}

        <Rule />

        <Group label="Fit & frame" note="Position is set by dragging on the canvas; the sliders mirror it for typed precision.">
          <Chips
            options={[
              { v: "full", label: "Full frame" },
              { v: "pip", label: "PiP" },
            ]}
            value={cut.scale >= 0.999 ? "full" : "pip"}
            onChange={(v) =>
              props.onPatch(
                { scale: v === "full" ? 1 : 0.4 },
                v === "full" ? "B-roll full frame" : "B-roll picture-in-picture",
              )
            }
            testId="inspector-fit"
          />
          {cut.scale < 0.999 && (
            <>
              <Slide label="scale" value={cut.scale} min={0.1} max={0.95} step={0.01} token={`broll-scale:${props.index}`} onChange={(v, tk) => props.onPatch({ scale: v }, `B-roll scale ${v.toFixed(2)}`, tk)} />
              <div className="grid grid-cols-2 gap-2">
                <Slide label="x" value={cut.x} min={0} max={1} step={0.01} token={`broll-x:${props.index}`} onChange={(v, tk) => props.onPatch({ x: v }, `B-roll x ${v.toFixed(2)}`, tk)} />
                <Slide label="y" value={cut.y} min={0} max={1} step={0.01} token={`broll-y:${props.index}`} onChange={(v, tk) => props.onPatch({ y: v }, `B-roll y ${v.toFixed(2)}`, tk)} />
              </div>
            </>
          )}
          <Chips
            options={[
              { v: "cover", label: "Crop to fill" },
              { v: "contain", label: "Fit inside" },
            ]}
            value={cut.fit === "contain" ? "contain" : "cover"}
            onChange={(v) => props.onPatch({ fit: v }, v === "contain" ? "B-roll fit inside" : "B-roll crop to fill")}
          />
        </Group>

        <Rule />

        <Group label="Motion" note={isImage ? undefined : "Ken Burns applies to stills only — footage already moves."}>
          <Chips
            options={[
              { v: "none", label: "None" },
              { v: "push", label: "Push in" },
              { v: "pull", label: "Pull out" },
            ]}
            value={cut.motion ?? "push"}
            onChange={(v) => props.onPatch({ motion: v as BrollEdit["motion"] }, `B-roll motion ${v}`)}
            testId="inspector-motion"
          />
          <Toggle
            label="Mute source audio"
            on={cut.muted !== false}
            onChange={(v) => props.onPatch({ muted: v }, v ? "Mute b-roll" : "Unmute b-roll")}
            testId="inspector-broll-mute"
          />
        </Group>
      </div>
      <Footer onDuplicate={props.onDuplicate} onDelete={props.onDelete} />
    </>
  );
}

// ── Text block ───────────────────────────────────────────────────────────

const TEXT_ROWS: Array<{ v: number; label: string }> = [
  { v: 0.12, label: "Top" },
  { v: 0.5, label: "Middle" },
  { v: 0.82, label: "Lower" },
];

export function TextInspector(props: {
  overlay: TextOverlayEdit;
  index: number;
  count: number;
  onPatch: (patch: Partial<TextOverlayEdit>, label: string, token?: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { overlay: o } = props;
  return (
    <>
      <Head dot="#fbbf24" title="Text block" meta={`V2 · ${props.index + 1} of ${props.count}`} />
      <div className="p-3.5 flex flex-col gap-4 overflow-y-auto">
        <Group label="Copy">
          <textarea
            value={o.text}
            maxLength={200}
            rows={2}
            onChange={(e) => props.onPatch({ text: e.target.value }, "Edit text", `text:${props.index}`)}
            className="w-full rounded-lg border border-white/10 bg-transparent px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary/50 resize-none"
            data-testid="inspector-text-copy"
          />
        </Group>

        <Group label="Position" badge="x UNFROZEN" note="Drag the text on the video, or set it here. x was hardcoded to 0.5 and nothing ever wrote it.">
          <Slide label="x" value={o.x} min={0} max={1} step={0.01} token={`text-x:${props.index}`} onChange={(v, tk) => props.onPatch({ x: v }, `Text x ${v.toFixed(2)}`, tk)} />
          <Slide label="y" value={o.y} min={0} max={1} step={0.01} token={`text-y:${props.index}`} onChange={(v, tk) => props.onPatch({ y: v }, `Text y ${v.toFixed(2)}`, tk)} />
          <Chips
            options={TEXT_ROWS.map((r) => ({ v: r.v, label: r.label }))}
            value={TEXT_ROWS.find((r) => Math.abs(r.v - o.y) < 0.02)?.v ?? (-1 as number)}
            onChange={(v) => props.onPatch({ y: v }, "Text row")}
          />
        </Group>

        <Rule />

        <Group
          label="Type"
          note="One face, set by the rasterizer. A font picker and a real outline are named in the engine-gap list, not drawn here."
        >
          <Slide label="size" value={o.size} min={0.02} max={0.25} step={0.005} format={(v) => `${Math.round(v * 100)}% of frame height`} token={`text-size:${props.index}`} onChange={(v, tk) => props.onPatch({ size: v }, `Text size ${(v * 100).toFixed(0)}%`, tk)} />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(o.color) ? o.color : "#ffffff"}
                onChange={(e) => props.onPatch({ color: e.target.value }, "Text colour", `tc:${props.index}`)}
                className="w-7 h-7 rounded border border-white/15 bg-transparent cursor-pointer"
              />
              {o.color}
            </label>
            <Chips
              options={[
                { v: "regular", label: "Regular" },
                { v: "bold", label: "Bold" },
              ]}
              value={o.weight}
              onChange={(v) => props.onPatch({ weight: v as TextOverlayEdit["weight"] }, "Text weight")}
            />
          </div>
          <Chips
            options={[
              { v: "shadow", label: "Shadow" },
              { v: "box", label: "Box" },
            ]}
            value={o.background ? "box" : "shadow"}
            onChange={(v) => props.onPatch({ background: v === "box" ? "#000000" : null }, v === "box" ? "Text on a plate" : "Text with a shadow")}
          />
          <Chips
            options={[
              { v: "left", label: "Left" },
              { v: "center", label: "Center" },
              { v: "right", label: "Right" },
            ]}
            value={o.align}
            onChange={(v) => props.onPatch({ align: v as TextOverlayEdit["align"] }, "Text align")}
          />
        </Group>

        <Rule />

        <Group
          label="Timing"
          note="Cut in, cut out — no fade. The overlay is gated by enable='between(t,…)', which is binary; a fade is an alpha expression the engine does not have yet."
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="h-8 flex items-center px-2.5 rounded-lg border border-white/10 font-mono text-xs tabular-nums text-foreground/85">
              {fmtTime(o.start)}
            </div>
            <div className="h-8 flex items-center px-2.5 rounded-lg border border-white/10 font-mono text-xs tabular-nums text-foreground/85">
              {fmtTime(o.end)}
            </div>
          </div>
        </Group>
      </div>
      <Footer onDuplicate={props.onDuplicate} onDelete={props.onDelete} />
    </>
  );
}

// ── Music bed ────────────────────────────────────────────────────────────

export function MusicInspector(props: {
  music: NonNullable<StudioEdits["music"]>;
  assetName: string;
  onPatch: (patch: Partial<NonNullable<StudioEdits["music"]>>, label: string, token?: string) => void;
  onDelete: () => void;
}) {
  const m = props.music;
  return (
    <>
      <Head dot="#34d399" title="Music bed" meta="A1" sub={props.assetName} />
      <div className="p-3.5 flex flex-col gap-4 overflow-y-auto">
        <Group label="Level" note="The bed is looped to the clip length and trimmed, so a short track under a long clip does not just stop.">
          <Slide label="volume" value={m.volume} min={0} max={1} step={0.01} token="bed-volume" onChange={(v, tk) => props.onPatch({ volume: v }, `Bed volume ${v.toFixed(2)}`, tk)} />
        </Group>
        <Rule />
        <Group label="Ducking" note="Pulls the bed down under speech with a sidechain compressor.">
          <Toggle label="Duck under speech" on={m.ducking} onChange={(v) => props.onPatch({ ducking: v }, v ? "Ducking on" : "Ducking off")} testId="inspector-duck" />
          {m.ducking && (
            <Slide label="amount" value={m.duckAmountDb} min={6} max={24} step={1} format={(v) => `−${v} dB`} token="bed-duck" onChange={(v, tk) => props.onPatch({ duckAmountDb: v }, `Duck ${v} dB`, tk)} />
          )}
        </Group>
        <Rule />
        <Group label="Fades">
          <Slide label="in" value={m.fadeInSec} min={0} max={10} step={0.5} format={(v) => `${v.toFixed(1)}s`} token="bed-fade-in" onChange={(v, tk) => props.onPatch({ fadeInSec: v }, `Fade in ${v}s`, tk)} />
          <Slide label="out" value={m.fadeOutSec} min={0} max={10} step={0.5} format={(v) => `${v.toFixed(1)}s`} token="bed-fade-out" onChange={(v, tk) => props.onPatch({ fadeOutSec: v }, `Fade out ${v}s`, tk)} />
        </Group>
      </div>
      <Footer onDelete={props.onDelete} />
    </>
  );
}

/** Nothing selected. Says what to do rather than sitting blank. */
export function EmptyInspector({ locked }: { locked: boolean }) {
  return (
    <div className="p-6 flex flex-col gap-3 text-center items-center justify-center h-full">
      <p className="font-display text-sm font-semibold text-foreground">Nothing selected</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground max-w-[240px]">
        {locked
          ? "This clip is assembled from several beats, so the layer tracks are unavailable. Collapse it to one range to use them."
          : "Click a segment on V0, a block on V1 or V2, or the bed on A1. The panel follows the selection."}
      </p>
    </div>
  );
}
