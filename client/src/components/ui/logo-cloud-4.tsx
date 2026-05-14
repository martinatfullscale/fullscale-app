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

export function LogoCloud({ logos }: LogoCloudProps) {
  return (
    <div className="relative mx-auto max-w-5xl py-6">
      {/* Each brand sits in a white rounded pill so the marquee reads
          uniformly regardless of whether the source PNG has a
          transparent, white, or colored background. Mirrors the proven
          pattern from the previous Brands-page carousel. */}
      <InfiniteSlider gap={32} reverse speed={60} speedOnHover={20}>
        {logos.map((logo) => (
          <div
            key={`logo-${logo.alt}`}
            className="flex items-center justify-center shrink-0 rounded-xl bg-white/95 border border-white/10 backdrop-blur-md px-5 py-3 md:px-6 md:py-4 shadow-lg shadow-black/20"
            style={{ minWidth: "160px", height: "72px" }}
          >
            <img
              alt={logo.alt}
              src={logo.src}
              loading="lazy"
              className="pointer-events-none select-none max-h-10 md:max-h-12 w-auto object-contain"
              onError={(e) => {
                // Graceful fallback: if the logo file is missing (e.g.
                // the PNG hasn't been dropped into client/public/brand-logos
                // yet), swap the <img> for a styled text version of the
                // brand name so the marquee never breaks. Dark text on
                // the white pill keeps it readable.
                const img = e.currentTarget;
                const fallback = document.createElement("span");
                fallback.className =
                  "pointer-events-none select-none text-sm md:text-base font-bold tracking-tight text-slate-900 whitespace-nowrap";
                fallback.textContent = logo.alt;
                img.replaceWith(fallback);
              }}
            />
          </div>
        ))}
      </InfiniteSlider>

      {/* Narrower edge fade — wide blur was eating into visible logos. */}
      <ProgressiveBlur
        blurIntensity={1}
        className="pointer-events-none absolute top-0 left-0 h-full w-[80px]"
        direction="left"
      />
      <ProgressiveBlur
        blurIntensity={1}
        className="pointer-events-none absolute top-0 right-0 h-full w-[80px]"
        direction="right"
      />
    </div>
  );
}
