/**
 * Face-detection child process entrypoint.
 *
 * TensorFlow lives HERE, not in the server. tfjs-node's native init and every
 * CPU inference are synchronous compute; in the server process they held the
 * one event loop that serves HTTP —
 *   [Stall] EVENT LOOP BLOCKED 12820ms — nothing else ran.
 * — which is what "the site locks up whenever a clip renders" was. In a child
 * process the same compute costs the same CPU seconds but blocks only this
 * process; requests keep being served, and if TF exhausts memory the OOM
 * killer takes THIS pid, not the server holding every open connection.
 *
 * Protocol (fork IPC, JSON):
 *   parent → child : { id, type: "clip",  videoPath, startTime, duration,
 *                      sampleIntervalSec?, deadlineMs? }
 *                    { id, type: "frame", framePath }
 *   child  → parent: { id, ok: true, result } | { id, ok: false, error }
 *                    { ready: true }  once, on boot
 *
 * Run via faceTracker.ts's manager — never directly. In production this file
 * is bundled separately (dist/facetrack-child.cjs, see script/build.ts); in
 * dev it is forked as TS, inheriting tsx's loader from execArgv.
 */

import { detectFacesInClipCore, detectPeopleInFrameCore } from "./faceDetectCore";

type ChildRequest =
  | { id: number; type: "clip"; videoPath: string; startTime: number; duration: number; sampleIntervalSec?: number; deadlineMs?: number }
  | { id: number; type: "frame"; framePath: string };

function main() {
  if (!process.send) {
    console.error("[FaceTrack:child] started without an IPC channel — this entrypoint is fork-only");
    process.exit(1);
  }

  // Parent gone (crash, restart, deploy) → nothing to report to; exit rather
  // than orbit as a TF-sized zombie on a memory-starved instance.
  process.on("disconnect", () => process.exit(0));

  process.on("message", async (msg: ChildRequest) => {
    if (!msg || typeof msg.id !== "number") return;
    try {
      let result: unknown;
      if (msg.type === "clip") {
        result = await detectFacesInClipCore(
          msg.videoPath,
          msg.startTime,
          msg.duration,
          msg.sampleIntervalSec ?? 0.5,
          msg.deadlineMs,
        );
      } else if (msg.type === "frame") {
        result = await detectPeopleInFrameCore(msg.framePath);
      } else {
        throw new Error(`unknown request type ${(msg as any).type}`);
      }
      process.send!({ id: msg.id, ok: true, result });
    } catch (err: any) {
      process.send!({ id: msg.id, ok: false, error: String(err?.message || err) });
    }
  });

  process.send({ ready: true });
  console.log(`[FaceTrack:child] ready (pid ${process.pid})`);
}

main();
