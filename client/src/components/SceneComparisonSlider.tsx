import { useState, useRef, useCallback, useEffect } from "react";
import { Layers, Sparkles } from "lucide-react";
import { Slider } from "@/components/ui/slider";

export interface SceneComparisonSliderProps {
  /** Image shown on the "reality" (left) side of the slider */
  realityImg: string;
  /** Image shown on the "AI augmented" (right) side of the slider */
  augmentedImg: string;
  realityAlt?: string;
  augmentedAlt?: string;
  /** Label on the top-left badge (default: "Reality") */
  realityLabel?: string;
  /** Label on the top-right badge (default: "AI Augmented") */
  augmentedLabel?: string;
  /** Testid prefix for the component. Handle, slider, and images get suffixed ids. */
  testIdPrefix?: string;
}

/**
 * Reality-vs-Augmented side-by-side comparison slider.
 *
 * Drag the container OR use the slider below to reveal the AI-augmented
 * version over the original "reality" image. Lifted from Landing.tsx's
 * RealityToAugmentedTransition function and parameterized for reuse —
 * used on /brands to show 3 different product-placement scenes.
 *
 * Interaction model:
 *   - Click+drag anywhere in the container to scrub the reveal
 *   - Touch+drag on mobile (uses touchstart/move/end)
 *   - Or drag the accessible <Slider> control below the image
 *
 * Global mouseup/touchend listeners reset drag state so the slider
 * doesn't stay "held" if the cursor leaves the container mid-drag.
 */
export function SceneComparisonSlider({
  realityImg,
  augmentedImg,
  realityAlt = "Original creator scene",
  augmentedAlt = "AI-augmented with placed product",
  realityLabel = "Reality",
  augmentedLabel = "AI Augmented",
  testIdPrefix = "scene-slider",
}: SceneComparisonSliderProps) {
  const [sliderValue, setSliderValue] = useState<number[]>([50]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleMove = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setSliderValue([percentage]);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      handleMove(e.clientX);
    },
    [handleMove]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) handleMove(e.clientX);
    },
    [isDragging, handleMove]
  );

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      setIsDragging(true);
      handleMove(e.touches[0].clientX);
    },
    [handleMove]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (isDragging) handleMove(e.touches[0].clientX);
    },
    [isDragging, handleMove]
  );

  // Global mouseup/touchend — resets drag if cursor leaves the container
  useEffect(() => {
    const reset = () => setIsDragging(false);
    window.addEventListener("mouseup", reset);
    window.addEventListener("touchend", reset);
    return () => {
      window.removeEventListener("mouseup", reset);
      window.removeEventListener("touchend", reset);
    };
  }, []);

  return (
    <div className="relative w-full">
      {/* Main comparison container */}
      <div
        ref={containerRef}
        className="relative aspect-video rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-emerald-500/10 cursor-ew-resize select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleMouseUp}
        data-testid={`${testIdPrefix}-container`}
      >
        {/* Reality image — base layer, always visible */}
        <img
          src={realityImg}
          alt={realityAlt}
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          data-testid={`${testIdPrefix}-img-reality`}
          draggable={false}
        />

        {/* Augmented image — overlay, revealed as slider moves right */}
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none"
          style={{ clipPath: `inset(0 ${100 - sliderValue[0]}% 0 0)` }}
        >
          <img
            src={augmentedImg}
            alt={augmentedAlt}
            className="absolute inset-0 w-full h-full object-cover"
            data-testid={`${testIdPrefix}-img-augmented`}
            draggable={false}
          />
        </div>

        {/* Slider divider line */}
        <div
          className="absolute top-0 bottom-0 w-1 bg-gradient-to-b from-emerald-400 via-white to-emerald-400 shadow-lg shadow-emerald-500/50 pointer-events-none"
          style={{ left: `${sliderValue[0]}%`, transform: "translateX(-50%)" }}
        >
          {/* Slider handle */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/80 border-2 border-emerald-400 flex items-center justify-center backdrop-blur-sm shadow-lg shadow-emerald-500/30">
            <Layers className="w-5 h-5 text-emerald-400" />
          </div>
        </div>

        {/* Reality label (top-left) */}
        <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/20 text-sm font-medium text-white pointer-events-none">
          {realityLabel}
        </div>

        {/* AI Augmented label (top-right) */}
        <div className="absolute top-4 right-4 px-3 py-1.5 rounded-full bg-emerald-500/20 backdrop-blur-md border border-emerald-500/30 text-sm font-medium text-emerald-400 flex items-center gap-1.5 pointer-events-none">
          <Sparkles className="w-3 h-3" />
          {augmentedLabel}
        </div>
      </div>

      {/* Slider control below — keyboard-accessible fallback + trackpad-friendly */}
      <div className="mt-6 px-4">
        <Slider
          value={sliderValue}
          onValueChange={setSliderValue}
          max={100}
          step={1}
          className="w-full"
          data-testid={`${testIdPrefix}-slider`}
        />
        <div className="flex justify-between gap-4 mt-2 text-xs text-muted-foreground">
          <span>{realityLabel}</span>
          <span>{augmentedLabel}</span>
        </div>
      </div>
    </div>
  );
}
