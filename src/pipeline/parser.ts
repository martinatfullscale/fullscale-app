import fs from "fs";
import path from "path";

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
 * Load pdf-parse safely, bypassing esbuild's CJS→ESM interop.
 *
 * Problem: esbuild bundles the server as CJS (dist/index.cjs) and marks
 * pdf-parse as external. When the bundled code does `import("pdf-parse")`,
 * esbuild wraps it with __toESM() which creates a proxy where .default
 * is undefined — because pdf-parse uses `module.exports = fn` with no
 * .default. This causes "e is not a function" at runtime.
 *
 * Solution: Use `new Function("return require")()` to get the raw Node.js
 * require function that esbuild cannot statically analyze or transform.
 */
let _pdfParse: ((buf: Buffer, opts?: any) => Promise<any>) | null = null;

/**
 * Get the real Node.js require function, bypassing esbuild's static analysis.
 *
 * In esbuild CJS output, `require` exists as a module-scoped variable.
 * - `new Function("return require")()` FAILS because require isn't global
 * - `eval("require")` WORKS because eval runs in the current scope
 * - esbuild cannot analyze eval string contents, so it won't transform it
 */
function getRawRequire(): NodeRequire | null {
  try {
    // eslint-disable-next-line no-eval
    return eval("typeof require !== 'undefined' ? require : null");
  } catch {
    return null;
  }
}

async function loadPdfParse() {
  if (_pdfParse) return _pdfParse;

  const rawRequire = getRawRequire();

  // Strategy 1: eval-based require (bypasses esbuild's __toESM wrapper)
  if (rawRequire) {
    try {
      const mod = rawRequire("pdf-parse");
      if (typeof mod === "function") {
        _pdfParse = mod;
        console.log("[Parser] pdf-parse loaded via eval require() — v1 API (function)");
        return _pdfParse;
      }
      // v2 pdf-parse has a different API — check for .default or .PdfParse
      if (mod && typeof mod.default === "function") {
        _pdfParse = mod.default;
        console.log("[Parser] pdf-parse loaded via eval require() — v2 API (.default)");
        return _pdfParse;
      }
      console.log("[Parser] Strategy 1: require returned:", typeof mod, "keys:", mod ? Object.keys(mod).slice(0, 10) : "null");
    } catch (err: any) {
      console.log("[Parser] Strategy 1 (eval require) failed:", err.message);
    }
  } else {
    console.log("[Parser] Strategy 1 skipped: require not available in scope");
  }

  // Strategy 2: Dynamic import with manual unwrapping of __toESM
  try {
    const mod: any = await import("pdf-parse");
    const fn = typeof mod === "function" ? mod
      : typeof mod.default === "function" ? mod.default
      : typeof mod.default?.default === "function" ? mod.default.default
      : null;
    if (fn) {
      _pdfParse = fn;
      console.log("[Parser] pdf-parse loaded via dynamic import");
      return _pdfParse!;
    }
    throw new Error(`Module shape: type=${typeof mod}, keys=[${Object.keys(mod)}], default type=${typeof mod.default}`);
  } catch (err: any) {
    console.log("[Parser] Strategy 2 (dynamic import) failed:", err.message);
  }

  throw new Error("All pdf-parse loading strategies failed — check that pdf-parse is installed");
}

/**
 * Parse a PDF buffer into structured document pages.
 * Uses pdf-parse to extract text, then splits into per-page chunks.
 */
export async function parsePDF(buffer: Buffer): Promise<ParsedDocument> {
  console.log(`[Parser] Starting PDF parse (${(buffer.length / 1024).toFixed(1)} KB)...`);

  const pdfParse = await loadPdfParse();

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

  // Also track paragraph breaks via <a:p> elements
  const pRegex = /<a:p[\s>]/g;

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
