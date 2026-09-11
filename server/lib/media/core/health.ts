import { runProcess, type RunProcess } from "./processRunner.js";

export interface MediaBinaryStatus {
  name: "ffmpeg" | "ffprobe";
  command: string;
  source: "configured" | "path";
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface MediaBinaryHealth {
  ok: boolean;
  binaries: MediaBinaryStatus[];
}

function firstLine(stdout: string, stderr: string): string | null {
  return `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export async function checkMediaBinaries(options: {
  ffmpegBin?: string;
  ffprobeBin?: string;
  run?: RunProcess;
} = {}): Promise<MediaBinaryHealth> {
  const execute = options.run ?? runProcess;
  const probes = [
    { name: "ffmpeg" as const, command: options.ffmpegBin ?? "ffmpeg" },
    { name: "ffprobe" as const, command: options.ffprobeBin ?? "ffprobe" },
  ];
  const binaries = await Promise.all(probes.map(async ({ name, command }): Promise<MediaBinaryStatus> => {
    const source = command.includes("/") || command.includes("\\") ? "configured" : "path";
    try {
      const result = await execute(command, ["-version"], { timeoutMs: 15_000, maxOutputBytes: 32_768 });
      return { name, command, source, ok: true, version: firstLine(result.stdout, result.stderr), error: null };
    } catch (error) {
      return {
        name,
        command,
        source,
        ok: false,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  return { ok: binaries.every((binary) => binary.ok), binaries };
}
