import { useEffect, useState } from "react";
import { InfiniteSlider } from "@/components/ui/infinite-slider";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";

export type Logo = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
};

type LogoCloudProps = React.ComponentProps<"div"> & {
  logos: Logo[];
};

/**
 * Hook returning true while the viewport is at or below the given px width.
 * Re-evaluates on resize. Used here to pass viewport-tuned numeric props
 * (gap, speed) to InfiniteSlider — Tailwind responsive classes can't reach
 * those because they're React props, not CSS.
 */
function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [breakpointPx]);
  return isMobile;
}

export function LogoCloud({ logos }: LogoCloudProps) {
  const isMobile = useIsMobile();

  // Numeric props can't be responsive via Tailwind — branch on viewport.
  const gap = isMobile ? 12 : 32;
  const speed = isMobile ? 25 : 45;
  const speedOnHover = isMobile ? 15 : 20;

  // FIXED pill dimensions (not min-w), so flex children can't expand the
  // pill beyond what we want. Previous min-w-[110px] meant a wide logo
  // image could blow the pill out and crowd siblings.
  const pillWidth = isMobile ? 130 : 180;
  const pillHeight = isMobile ? 60 : 72;

  return (
    <div className="relative mx-auto max-w-5xl py-4 md:py-6">
      {/* Each brand sits in a white rounded pill so the marquee reads
          uniformly regardless of whether the source PNG has a
          transparent, white, or colored background. */}
      <InfiniteSlider gap={gap} reverse speed={speed} speedOnHover={speedOnHover}>
        {logos.map((logo) => (
          <div
            key={`logo-${logo.alt}`}
            className="flex items-center justify-center shrink-0 rounded-xl bg-white/95 border border-white/10 backdrop-blur-md shadow-lg shadow-black/20 overflow-hidden"
            style={{
              width: `${pillWidth}px`,
              height: `${pillHeight}px`,
              padding: "8px",
            }}
          >
            <img
              alt={logo.alt}
              src={logo.src}
              // Eager load — was lazy, which on iOS Safari can defer
              // these long enough that pills appear empty for several
              // seconds while the marquee scrolls.
              loading="eager"
              decoding="async"
              className="pointer-events-none select-none object-contain"
              // Classic responsive-image pattern: width/height auto with
              // max constraints. This always renders correctly across
              // Safari/Chrome/Firefox, unlike h-full w-full which can
              // collapse to 0×0 inside flex containers on iOS Safari.
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                width: "auto",
                height: "auto",
              }}
              onError={(e) => {
                // Graceful fallback: if the logo file is missing, swap
                // the <img> for a styled text version of the brand name.
                const img = e.currentTarget;
                const fallback = document.createElement("span");
                fallback.className =
                  "pointer-events-none select-none text-xs md:text-base font-bold tracking-tight text-slate-900 whitespace-nowrap";
                fallback.textContent = logo.alt;
                img.replaceWith(fallback);
              }}
            />
          </div>
        ))}
      </InfiniteSlider>

      {/* Edge fade — narrow on mobile (24px) so we don't eat the viewport,
          fuller on desktop (80px). */}
      <ProgressiveBlur
        blurIntensity={1}
        className="pointer-events-none absolute top-0 left-0 h-full w-[24px] md:w-[80px]"
        direction="left"
      />
      <ProgressiveBlur
        blurIntensity={1}
        className="pointer-events-none absolute top-0 right-0 h-full w-[24px] md:w-[80px]"
        direction="right"
      />
    </div>
  );
}
