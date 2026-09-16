/**
 * Text overlays, rasterized rather than drawn by ffmpeg.
 *
 * The obvious implementation is ffmpeg's `drawtext`, and it is the wrong one
 * here: drawtext requires libfreetype, which several stock ffmpeg builds
 * (including this project's dev machine) are compiled without — and a
 * filtergraph naming a filter the build lacks fails the ENTIRE render, not
 * just the text. It also needs a font file path that differs per OS, and
 * escaping user text into a filter string is a quoting minefield where a
 * colon or apostrophe in a creator's headline breaks the graph.
 *
 * Rendering to a PNG with sharp and compositing it with `overlay` avoids all
 * of that: `overlay` is universally available, the text never touches a
 * filter string, and we get real typography (weights, a background plate,
 * proper wrapping) instead of drawtext's single-line primitives.
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";
import type { TextOverlay } from "./editStack";

export interface RasterizedText {
  path: string;
  w: number;
  h: number;
  overlay: TextOverlay;
}

/** XML-escape for the SVG document the text is rendered through. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Greedy wrap by estimated advance width — no font metrics available here. */
function wrap(text: string, fontPx: number, maxWidthPx: number): string[] {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // ~0.55em average advance for a humanist sans at typical mixed case.
  const perChar = fontPx * 0.55;
  const maxChars = Math.max(6, Math.floor(maxWidthPx / perChar));
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= maxChars) { cur = candidate; continue; }
    if (cur) lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 6); // a headline, not a paragraph
}

/**
 * Render one overlay to a PNG sized to its own text box.
 *
 * The PNG is transparent outside the (optional) background plate, so the
 * composite reads as text on video rather than a card.
 */
export async function rasterizeTextOverlay(
  ov: TextOverlay,
  outWidth: number,
  outHeight: number,
  tmpDir: string,
  index: number,
): Promise<RasterizedText | null> {
  const text = String(ov.text ?? "").trim();
  if (!text) return null;

  const sizeRatio = Math.min(0.25, Math.max(0.02, Number(ov.size) || 0.06));
  const fontPx = Math.round(outHeight * sizeRatio);
  // Keep the box inside a comfortable measure — full-bleed text reads badly
  // on 9:16 and wraps unpredictably.
  const boxMaxW = Math.round(outWidth * 0.86);
  const lines = wrap(text, fontPx, boxMaxW);
  if (lines.length === 0) return null;

  const lineHeight = Math.round(fontPx * 1.22);
  const padX = Math.round(fontPx * 0.5);
  const padY = Math.round(fontPx * 0.34);
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  const textW = Math.min(boxMaxW, Math.round(longest.length * fontPx * 0.55));
  const w = Math.min(outWidth, textW + padX * 2);
  const h = Math.min(outHeight, lines.length * lineHeight + padY * 2);

  const fill = `#${(/^#?([0-9a-f]{6})$/i.exec(ov.color ?? "")?.[1] ?? "ffffff").toLowerCase()}`;
  const plateHex = /^#?([0-9a-f]{6})$/i.exec(ov.background ?? "")?.[1];
  const weight = ov.weight === "bold" ? 700 : 400;
  const anchor = ov.align === "center" ? "middle" : ov.align === "right" ? "end" : "start";
  const tx = ov.align === "center" ? w / 2 : ov.align === "right" ? w - padX : padX;

  const plate = plateHex
    ? `<rect x="0" y="0" width="${w}" height="${h}" rx="${Math.round(fontPx * 0.22)}" fill="#${plateHex}" fill-opacity="0.82"/>`
    : "";

  // A soft shadow keeps light text legible over light footage without a plate.
  const shadow = plateHex
    ? ""
    : `<filter id="s" x="-20%" y="-20%" width="140%" height="140%">
         <feDropShadow dx="0" dy="${Math.max(1, Math.round(fontPx * 0.04))}" stdDeviation="${Math.max(1, Math.round(fontPx * 0.06))}" flood-color="#000" flood-opacity="0.65"/>
       </filter>`;

  const tspans = lines
    .map((ln, i) => `<tspan x="${tx}" dy="${i === 0 ? 0 : lineHeight}">${esc(ln)}</tspan>`)
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>${shadow}</defs>
  ${plate}
  <text x="${tx}" y="${padY + Math.round(fontPx * 0.82)}"
        font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-size="${fontPx}" font-weight="${weight}" fill="${fill}"
        text-anchor="${anchor}" ${plateHex ? "" : 'filter="url(#s)"'}>${tspans}</text>
</svg>`;

  const out = path.join(tmpDir, `text-${index}-${Date.now()}.png`);
  try {
    await sharp(Buffer.from(svg)).png().toFile(out);
  } catch (err: any) {
    console.warn(`[TextOverlay] Rasterize failed for overlay ${index}: ${err?.message}`);
    return null;
  }
  return { path: out, w, h, overlay: ov };
}

/** Rasterize a whole stack; failures drop that one overlay, never the render. */
export async function rasterizeTextOverlays(
  overlays: TextOverlay[] | null | undefined,
  outWidth: number,
  outHeight: number,
  tmpDir: string,
): Promise<RasterizedText[]> {
  const list = overlays ?? [];
  if (list.length === 0) return [];
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* exists */ }
  const out: RasterizedText[] = [];
  for (let i = 0; i < Math.min(list.length, 12); i++) {
    const r = await rasterizeTextOverlay(list[i], outWidth, outHeight, tmpDir, i);
    if (r) out.push(r);
  }
  return out;
}

export function cleanupRasterizedText(items: RasterizedText[]): void {
  for (const it of items) {
    try { fs.unlinkSync(it.path); } catch { /* already gone */ }
  }
}
