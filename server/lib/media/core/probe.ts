import { runProcess, type RunProcess } from "./processRunner.js";

export interface MediaProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  container: string;
}

type ProbeDocument = {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
  }>;
  format?: {
    duration?: string | number;
    format_name?: string;
    tags?: { major_brand?: string };
  };
};

function frameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numeratorText, denominatorText = "1"] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

function containerName(formatName: string, majorBrand?: string): string {
  const formats = formatName.split(",").map((value) => value.trim().toLowerCase());
  const brand = majorBrand?.trim().toLowerCase();
  if (formats.includes("mp4") || ["isom", "iso2", "avc1", "mp41", "mp42"].includes(brand ?? "")) return "mp4";
  return formats[0] || "unknown";
}

export function parseMediaProbeOutput(raw: string): MediaProbe {
  let document: ProbeDocument;
  try {
    document = JSON.parse(raw) as ProbeDocument;
  } catch (cause) {
    throw new Error("ffprobe returned invalid JSON", { cause });
  }

  const video = document.streams?.find((stream) => stream.codec_type === "video");
  const audio = document.streams?.find((stream) => stream.codec_type === "audio");
  const durationSec = Number(document.format?.duration);
  const fps = frameRate(video?.avg_frame_rate);
  if (!video?.width || !video.height) throw new Error("ffprobe output has no usable video stream");
  if (!Number.isFinite(durationSec) || durationSec < 0) throw new Error("ffprobe output has no valid duration");
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("ffprobe output has no valid frame rate");

  return {
    durationSec,
    width: video.width,
    height: video.height,
    fps,
    videoCodec: video.codec_name ?? "unknown",
    audioCodec: audio?.codec_name ?? null,
    container: containerName(document.format?.format_name ?? "", document.format?.tags?.major_brand),
  };
}

export async function probeMedia(
  filePath: string,
  options: { ffprobeBin?: string; run?: RunProcess; signal?: AbortSignal } = {},
): Promise<MediaProbe> {
  const execute = options.run ?? runProcess;
  const result = await execute(options.ffprobeBin ?? "ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    filePath,
  ], { timeoutMs: 30_000, signal: options.signal });
  return parseMediaProbeOutput(result.stdout);
}
