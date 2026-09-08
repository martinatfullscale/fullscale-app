import { useLocale } from "@/lib/locale";
import type { ContentByPage } from "./types";
import { storyEn } from "./story.en";
import { storyAr } from "./story.ar";
import { brandsEn } from "./brands.en";
import { brandsAr } from "./brands.ar";
import { landingEn } from "./landing.en";
import { landingAr } from "./landing.ar";

/**
 * Resolve a page's copy for the current locale.
 *
 * English is the fallback and always present, so a page whose Arabic module
 * has not been written yet renders in English rather than breaking or showing
 * a half-translated screen. That is deliberate: a missing translation should
 * cost a reader nothing but the language.
 *
 * Modules are imported statically rather than lazily. They are a few kB of
 * text each, they are needed on first paint, and a suspense boundary around
 * the headline of a marketing page would be a worse trade than the bytes.
 */
const REGISTRY: { [K in keyof ContentByPage]: Record<string, ContentByPage[K]> } = {
  story: { en: storyEn, ar: storyAr },
  brands: { en: brandsEn, ar: brandsAr },
  landing: { en: landingEn, ar: landingAr },
};

export function useContent<K extends keyof ContentByPage>(page: K): ContentByPage[K] {
  const { locale } = useLocale();
  const byLocale = REGISTRY[page];
  return byLocale[locale] ?? byLocale.en;
}

export type { StoryContent, StorySection, BrandsContent, LandingContent, ContentByPage } from "./types";
