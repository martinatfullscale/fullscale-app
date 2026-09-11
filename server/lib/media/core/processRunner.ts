import { spawn } from "node:child_process";

export type MediaProcessErrorCode = "unavailable" | "timed_out" | "cancelled" | "failed";

export class MediaProcessError extends Error {
  readonly code: MediaProcessErrorCode;
  readonly command: string;
  readonly exitCode: number | null;

  constructor(options: {
    code: MediaProcessErrorCode;
    message: string;
    command: string;
    exitCode?: number | null;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "MediaProcessError";
    this.code = options.code;
    this.command = options.command;
    this.exitCode = options.exitCode ?? null;
  }
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<RunProcessResult>;

function createTail(maxBytes: number) {
  let value = Buffer.alloc(0);
  let truncated = false;
  return {
    push(chunk: Buffer) {
      value = Buffer.concat([value, chunk]);
      if (value.length > maxBytes) {
        value = value.subarray(value.length - maxBytes);
        truncated = true;
      }
    },
    text: () => value.toString("utf8"),
    truncated: () => truncated,
  };
}

function createLineSplitter(onLine: ((line: string) => void) | undefined, maxBytes: number) {
  let buffer = "";
  return {
    push(chunk: string) {
      if (!onLine) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxBytes) buffer = buffer.slice(-maxBytes);
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    },
    flush() {
      if (onLine && buffer) onLine(buffer);
      buffer = "";
    },
  };
}

function stderrTail(stderr: string): string {
  return stderr.trim().split(/\r?\n/).slice(-4).join(" ").slice(-500);
}

export const runProcess: RunProcess = (
  command,
  args,
  {
    timeoutMs = 300_000,
    signal,
    cwd,
    env,
    maxOutputBytes = 1_048_576,
    onStdoutLine,
    onStderrLine,
  } = {},
) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new MediaProcessError({ code: "cancelled", message: `${command} was cancelled`, command }));
    return;
  }

  const outputLimit = Math.max(1, Math.floor(maxOutputBytes));
  const stdout = createTail(outputLimit);
  const stderr = createTail(outputLimit);
  const stdoutLines = createLineSplitter(onStdoutLine, outputLimit);
  const stderrLines = createLineSplitter(onStderrLine, outputLimit);
  const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let termination: "timed_out" | "cancelled" | null = null;
  let settled = false;

  const terminate = (reason: "timed_out" | "cancelled") => {
    if (settled || termination) return;
    termination = reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => terminate("timed_out"), Math.max(1, timeoutMs));
  const abort = () => terminate("cancelled");
  signal?.addEventListener("abort", abort, { once: true });

  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  };
  const fail = (error: MediaProcessError) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    stdoutLines.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    stderrLines.push(chunk.toString("utf8"));
  });

  child.once("error", (cause: NodeJS.ErrnoException) => {
    fail(new MediaProcessError({
      code: cause.code === "ENOENT" ? "unavailable" : "failed",
      message: cause.code === "ENOENT"
        ? `${command} is not installed or is not executable`
        : `${command} could not start: ${cause.message}`,
      command,
      cause,
    }));
  });

  child.once("close", (exitCode) => {
    if (settled) return;
    stdoutLines.flush();
    stderrLines.flush();
    if (termination) {
      fail(new MediaProcessError({
        code: termination,
        message: termination === "timed_out"
          ? `${command} timed out after ${timeoutMs}ms`
          : `${command} was cancelled`,
        command,
        exitCode,
      }));
      return;
    }
    if (exitCode !== 0) {
      fail(new MediaProcessError({
        code: "failed",
        message: `${command} exited ${exitCode}: ${stderrTail(stderr.text())}`,
        command,
        exitCode,
      }));
      return;
    }
    settled = true;
    cleanup();
    resolve({
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
    });
  });
});
