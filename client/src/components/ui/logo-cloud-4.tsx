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
  // Mobile: tighter gap + faster scroll so logos cycle visibly inside the
  // narrower viewport. Desktop: roomier gap + slower, calmer scroll.
  const gap = isMobile ? 16 : 32;
  const speed = isMobile ? 25 : 45;
  const speedOnHover = isMobile ? 15 : 20;

  return (
    <div className="relative mx-auto max-w-5xl py-4 md:py-6">
      {/* Each brand sits in a white rounded pill so the marquee reads
          uniformly regardless of whether the source PNG has a
          transparent, white, or colored background. Pill sizing is
          mobile-first: 110px wide / 56px tall on phones, 160px / 72px
          on tablet+ where there's room. */}
      <InfiniteSlider gap={gap} reverse speed={speed} speedOnHover={speedOnHover}>
        {logos.map((logo) => (
          <div
            key={`logo-${logo.alt}`}
            className="flex items-center justify-center shrink-0 rounded-xl bg-white/95 border border-white/10 backdrop-blur-md p-2 shadow-lg shadow-black/20 overflow-hidden min-w-[110px] h-14 md:min-w-[160px] md:h-[72px]"
          >
            <img
              alt={logo.alt}
              src={logo.src}
              loading="lazy"
              // h-full + w-full + object-contain: logo fills the pill's
              // full bounding box (minus the 8px p-2 padding) while
              // preserving its aspect ratio so it never gets distorted.
              className="pointer-events-none select-none h-full w-full object-contain"
              onError={(e) => {
                // Graceful fallback: if the logo file is missing (e.g.
                // the PNG hasn't been dropped into client/public/brand-logos
                // yet), swap the <img> for a styled text version of the
                // brand name so the marquee never breaks. Dark text on
                // the white pill keeps it readable.
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

      {/* Edge fade — narrower on mobile (32px) so we don't eat half the
          viewport, fuller on desktop (80px). */}
      <ProgressiveBlur
        blurIntensity={1}
        className="pointer-events-none absolute top-0 left-0 h-full w-[32px] md:w-[80px]"
        direction="left"
      />
      <ProgressiveBlur
        blurIntensity={1}
        className="pointer-events-none absolute top-0 right-0 h-full w-[32px] md:w-[80px]"
        direction="right"
      />
    </div>
  );
}
