/**
 * The measurements a placement carries with it.
 *
 * Harmonizing a product already measures the region it lands in — the
 * surface's normal and tilt, the direction and strength of the shadow already
 * in the scene, the dominant hue and luminance, what else is nearby, how
 * crowded the spot is, and the scale the model thinks the product should be —
 * plus the scene's own light (a brightness factor and an average RGB sampled
 * from a ring around the placement). All of it was computed, used for one
 * render, and thrown away.
 *
 * Keeping it turns a placement from "a picture we made" into a measured
 * observation: the same spot, described in numbers a second placement can be
 * compared against. This module is the structural contract — shared/ cannot
 * import server code, so the shape is restated here and validated on the way
 * in, because it arrives from a browser.
 */

export interface RegionAnalysis {
  surfaceNormal: "horizontal" | "vertical" | "tilted-toward-camera" | "tilted-away";
  /** -45..45, 0 = perpendicular to the camera axis. */
  tiltDegrees: number;
  existingShadowDirection:
    | "top-left" | "top" | "top-right" | "left" | "right"
    | "bottom-left" | "bottom" | "bottom-right" | "ambient";
  existingShadowIntensity: number;
  dominantHueDeg: number;
  dominantSaturation: number;
  averageLuminance: number;
  neighboringObjects: string[];
  openSpaceClass: "cramped" | "open" | "isolated";
  recommendedScale: number;
}

export interface SceneAtmosphere {
  brightnessFactor: number;
  sceneRgb: { r: number; g: number; b: number };
  sceneBrightness: number;
}

export interface PlacementVector {
  regionAnalysis: RegionAnalysis | null;
  atmosphere: SceneAtmosphere | null;
  /** Sampled depth at this exact placement, when a path ran a depth map.
   *  Null on nearly every harmonize; the surface's own scan reading is the
   *  answer the dataset falls back to. */
  depth: DepthReading | null;
  /** Which harmonize path produced these numbers. */
  mode: string;
  /** The surface box they were measured against, frame-normalised. */
  bbox: { x: number; y: number; width: number; height: number } | null;
  frameDimensions: { width: number; height: number } | null;
  measuredAt: string;
}

// One vocabulary, defined with the surface-level measurement. A placement's
// region analysis is the same description applied to a sub-region of a
// surface, so the two are only comparable if they share these exact terms.
import {
  SURFACE_NORMALS, SHADOW_DIRECTIONS, OPEN_SPACE,
  DEPTH_BANDS, PERSON_DEPTH, DEPTH_SOURCES,
  type DepthReading,
} from "./surfaceMeasurement";

const MAX_NEIGHBORS = 16;

const num = (v: unknown, min: number, max: number): number | null => {
  // null and "" must NOT coerce. Number(null) is 0 and Number("") is 0, both
  // of which sit inside most of these ranges, so a model that answered null
  // because it could not tell would have been recorded as a confident zero —
  // a flat surface, or a spot at the far plane.
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const oneOf = <T extends readonly string[]>(v: unknown, allowed: T): T[number] | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;

function readRegionAnalysis(raw: any): RegionAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const surfaceNormal = oneOf(raw.surfaceNormal, SURFACE_NORMALS);
  const existingShadowDirection = oneOf(raw.existingShadowDirection, SHADOW_DIRECTIONS);
  const openSpaceClass = oneOf(raw.openSpaceClass, OPEN_SPACE);
  const tiltDegrees = num(raw.tiltDegrees, -90, 90);
  const existingShadowIntensity = num(raw.existingShadowIntensity, 0, 1);
  const dominantHueDeg = num(raw.dominantHueDeg, 0, 360);
  const dominantSaturation = num(raw.dominantSaturation, 0, 1);
  const averageLuminance = num(raw.averageLuminance, 0, 1);
  const recommendedScale = num(raw.recommendedScale, 0, 10);
  // Partial measurements are worse than none: a half-filled row reads as
  // measured and quietly skews anything that averages over it.
  if (
    surfaceNormal === null || existingShadowDirection === null || openSpaceClass === null ||
    tiltDegrees === null || existingShadowIntensity === null || dominantHueDeg === null ||
    dominantSaturation === null || averageLuminance === null || recommendedScale === null
  ) return null;
  const neighboringObjects = Array.isArray(raw.neighboringObjects)
    ? raw.neighboringObjects
        .filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
        .slice(0, MAX_NEIGHBORS)
        .map((s: string) => s.slice(0, 64))
    : [];
  return {
    surfaceNormal, tiltDegrees, existingShadowDirection, existingShadowIntensity,
    dominantHueDeg, dominantSaturation, averageLuminance, neighboringObjects,
    openSpaceClass, recommendedScale,
  };
}

/** Same drop-whole rule as the surface-side reading, restated here because
 *  this one arrives from a browser and shared/ cannot import server code. */
function readDepth(raw: any): DepthReading | null {
  if (!raw || typeof raw !== "object") return null;
  const band = oneOf(raw.band, DEPTH_BANDS);
  const relativeToPerson = oneOf(raw.relativeToPerson, PERSON_DEPTH);
  const rankInFrame = num(raw.rankInFrame, 1, 64);
  if (band === null || relativeToPerson === null || rankInFrame === null) return null;
  return {
    band,
    rankInFrame: Math.round(rankInFrame),
    relativeToPerson,
    relativeDepth: num(raw.relativeDepth, 0, 1),
    source: oneOf(raw.source, DEPTH_SOURCES) ?? "vision",
  };
}

function readAtmosphere(raw: any): SceneAtmosphere | null {
  if (!raw || typeof raw !== "object") return null;
  const brightnessFactor = num(raw.brightnessFactor, 0, 10);
  const sceneBrightness = num(raw.sceneBrightness, 0, 1);
  const r = num(raw?.sceneRgb?.r, 0, 255);
  const g = num(raw?.sceneRgb?.g, 0, 255);
  const b = num(raw?.sceneRgb?.b, 0, 255);
  if (brightnessFactor === null || sceneBrightness === null || r === null || g === null || b === null) return null;
  return { brightnessFactor, sceneBrightness, sceneRgb: { r, g, b } };
}

function readBox(raw: any): { x: number; y: number; width: number; height: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const x = num(raw.x, -1, 2), y = num(raw.y, -1, 2);
  const width = num(raw.width, 0, 2), height = num(raw.height, 0, 2);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

function readDims(raw: any): { width: number; height: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const width = num(raw.width, 1, 16384), height = num(raw.height, 1, 16384);
  return width === null || height === null ? null : { width, height };
}

/**
 * Validate a vector that arrived over HTTP. Returns null when there is nothing
 * worth storing, so a caller can write null rather than an empty shell.
 */
export function sanitizePlacementVector(raw: unknown): PlacementVector | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const regionAnalysis = readRegionAnalysis(r.regionAnalysis);
  const atmosphere = readAtmosphere(r.atmosphere);
  const depth = readDepth(r.depth);
  if (!regionAnalysis && !atmosphere && !depth) return null;
  const measuredAt = typeof r.measuredAt === "string" && !Number.isNaN(Date.parse(r.measuredAt))
    ? r.measuredAt
    : new Date().toISOString();
  return {
    regionAnalysis,
    atmosphere,
    depth,
    mode: typeof r.mode === "string" ? r.mode.slice(0, 32) : "unknown",
    bbox: readBox(r.bbox),
    frameDimensions: readDims(r.frameDimensions),
    measuredAt,
  };
}
