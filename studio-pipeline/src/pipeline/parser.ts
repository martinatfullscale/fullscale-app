import fs from "fs";
import path from "path";
import { createRequire } from "module";

export interface ParsedPage {
  pageNumber: number;
  title: string;
  body: string;
  notes: string;
}

export interface ParsedDocument {
  documentTitle: string;
  pageCount: number;
  pages: ParsedPage[];
}

/**
 * Wrap a promise with a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Parse a PDF buffer into structured document pages.
 * Uses pdf-parse to extract text, then splits into per-page chunks.
 *
 * NOTE: pdf-parse default export hangs in esbuild-bundled environments
 * because it tries to load a test PDF at require time. We import the
 * inner implementation directly via require() to bypass that.
 */
export async function parsePDF(buffer: Buffer): Promise<ParsedDocument> {
  console.log("[Parser] Starting PDF parse...");

  // Use require() to load pdf-parse's inner module, bypassing the
  // default entry point which tries to load a test PDF and hangs in
  // bundled environments.
  let pdfParse: (buffer: Buffer, options?: any) => Promise<any>;
  try {
    const require = createRequire(import.meta.url);
    pdfParse = require("pdf-parse/lib/pdf-parse.js");
    console.log("[Parser] pdf-parse/lib/pdf-parse.js loaded via require()");
  } catch (requireErr: any) {
    console.log("[Parser] require() failed, trying dynamic import fallback:", requireErr.message);
    // Fallback: try the default import (may work in non-bundled env)
    const mod = await import("pdf-parse");
    pdfParse = mod.default || mod;
    console.log("[Parser] pdf-parse loaded via dynamic import");
  }

  const data = await withTimeout(
    pdfParse(buffer, { max: 0 }),
    60_000,
    "PDF parsing"
  );

  console.log(`[Parser] PDF parsed: ${data.numpages} pages, ${data.text.length} chars`);

  const pageCount = data.numpages;
  const fullText = data.text;

  // pdf-parse concatenates all pages. Try to split by page breaks or heuristics.
  const pages = splitIntoPages(fullText, pageCount);

  // Derive document title from first meaningful line
  const firstLine = fullText.trim().split("\n")[0]?.trim() || "Untitled Document";
  const documentTitle = firstLine.length > 100 ? firstLine.slice(0, 100) : firstLine;

  return {
    documentTitle,
    pageCount,
    pages,
  };
}

/**
 * Parse a PPTX buffer into structured document pages.
 * Extracts slide text and speaker notes from each slide.
 */
export async function parsePPTX(buffer: Buffer): Promise<ParsedDocument> {
  // PPTX files are ZIP archives containing XML.
  // We use JSZip to extract slide content directly.
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);

  const slides: ParsedPage[] = [];
  let slideIndex = 1;

  // PPTX slides are in ppt/slides/slide1.xml, slide2.xml, etc.
  // Speaker notes are in ppt/notesSlides/notesSlide1.xml, etc.
  const slideFiles: string[] = [];
  zip.forEach((relativePath) => {
    if (relativePath.match(/^ppt\/slides\/slide\d+\.xml$/)) {
      slideFiles.push(relativePath);
    }
  });

  // Sort by slide number
  slideFiles.sort((a, b) => {
    const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
    const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
    return numA - numB;
  });

  for (const slideFile of slideFiles) {
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)?.[1] || "0");
    const slideXml = await zip.file(slideFile)?.async("text");
    if (!slideXml) continue;

    // Extract text from XML by stripping tags and getting <a:t> content
    const textParts = extractTextFromXml(slideXml);
    const title = textParts[0] || `Slide ${slideNum}`;
    const body = textParts.slice(1).join("\n").trim();

    // Try to get speaker notes
    let notes = "";
    const notesFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    const notesXml = await zip.file(notesFile)?.async("text");
    if (notesXml) {
      const notesParts = extractTextFromXml(notesXml);
      // Filter out the slide number placeholder that PPTX adds
      notes = notesParts.filter((n) => !n.match(/^\d+$/)).join("\n").trim();
    }

    slides.push({
      pageNumber: slideIndex,
      title,
      body,
      notes,
    });
    slideIndex++;
  }

  const documentTitle =
    slides[0]?.title || "Untitled Presentation";

  return {
    documentTitle,
    pageCount: slides.length,
    pages: slides,
  };
}

/**
 * Extract text content from PPTX XML by finding all <a:t> elements.
 */
function extractTextFromXml(xml: string): string[] {
  const results: string[] = [];
  // Match all <a:t>...</a:t> text runs
  const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
  let match;
  let currentParagraph = "";
  let lastIndex = 0;

  // Also track paragraph breaks via <a:p> elements
  const paragraphs: string[] = [];
  const pRegex = /<a:p[\s>]/g;
  const pEndRegex = /<\/a:p>/g;

  // Simple approach: collect all text runs, group by paragraph
  const fullMatches: Array<{ text: string; index: number }> = [];
  while ((match = regex.exec(xml)) !== null) {
    fullMatches.push({ text: match[1], index: match.index });
  }

  // Find paragraph boundaries
  const pStarts: number[] = [];
  while ((match = pRegex.exec(xml)) !== null) {
    pStarts.push(match.index);
  }

  // Group text runs into paragraphs
  let currentP = 0;
  let paraTexts: string[][] = pStarts.map(() => []);

  for (const fm of fullMatches) {
    // Find which paragraph this text belongs to
    while (currentP < pStarts.length - 1 && fm.index > pStarts[currentP + 1]) {
      currentP++;
    }
    if (paraTexts[currentP]) {
      paraTexts[currentP].push(fm.text);
    }
  }

  // Join text runs within each paragraph
  for (const pt of paraTexts) {
    const line = pt.join("").trim();
    if (line) {
      results.push(line);
    }
  }

  return results;
}

/**
 * Split raw PDF text into per-page chunks.
 * Uses form feed characters (\f) if present, otherwise splits evenly.
 */
export function splitIntoPages(text: string, pageCount: number): ParsedPage[] {
  // pdf-parse often inserts form feeds between pages
  const formFeedPages = text.split("\f").filter((p) => p.trim().length > 0);

  let rawPages: string[];
  if (formFeedPages.length >= pageCount) {
    rawPages = formFeedPages.slice(0, pageCount);
  } else {
    // Fall back to splitting by line count
    const lines = text.split("\n");
    const linesPerPage = Math.ceil(lines.length / pageCount);
    rawPages = [];
    for (let i = 0; i < pageCount; i++) {
      const start = i * linesPerPage;
      const end = Math.min(start + linesPerPage, lines.length);
      rawPages.push(lines.slice(start, end).join("\n"));
    }
  }

  return rawPages.map((raw, i) => {
    const trimmed = raw.trim();
    const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
    const title = lines[0] || `Page ${i + 1}`;
    const body = lines.slice(1).join("\n").trim();

    return {
      pageNumber: i + 1,
      title,
      body,
      notes: "",
    };
  });
}
