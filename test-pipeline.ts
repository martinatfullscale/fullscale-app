/**
 * Test script: Run the Studio pipeline locally on the FullScale pitch deck.
 * Usage: npx tsx studio-pipeline/test-pipeline.ts
 */
// Ensure Homebrew binaries (pdftoppm, ffmpeg) are on PATH
process.env.PATH = `/opt/homebrew/bin:${process.env.PATH}`;

import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import { runPipeline } from "./src/pipeline/index.js";

const DECK_PATH = "/Users/martinekechukwu/WHTWRKS Dropbox/martin ekechukwu/Fullscale/Full Deck/FullScale is for the Creator 2.4.pdf";

async function main() {
  console.log("=== FullScale Studio Pipeline Test ===\n");

  if (!fs.existsSync(DECK_PATH)) {
    console.error(`Deck not found: ${DECK_PATH}`);
    process.exit(1);
  }

  console.log(`Reading: ${DECK_PATH}`);
  const buffer = fs.readFileSync(DECK_PATH);
  console.log(`File size: ${(buffer.length / 1024 / 1024).toFixed(1)} MB\n`);

  const tier = (process.env.VISUAL_TIER as "mvp" | "v1" | "v2") || "mvp";
  console.log(`Visual tier: ${tier}\n`);

  const result = await runPipeline(buffer, "pdf", {
    visualTier: tier,
    onStageChange: (stage, progress) => {
      // Already logged by pipeline internals
    },
  });

  console.log("\n=== Pipeline Complete ===");
  console.log(`Job ID:    ${result.jobId}`);
  console.log(`Output:    ${result.outputPath}`);
  console.log(`Title:     ${result.metadata.title}`);
  console.log(`Scenes:    ${result.metadata.sceneCount}`);
  console.log(`Duration:  ~${Math.round(result.metadata.estimatedDurationSeconds / 60)} min`);

  // Check output file
  if (fs.existsSync(result.outputPath)) {
    const sizeMB = (fs.statSync(result.outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`File size: ${sizeMB} MB`);
    console.log(`\nOpen with: open "${result.outputPath}"`);
  }
}

main().catch((err) => {
  console.error("\nPipeline failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
