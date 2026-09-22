import type { NextFunction, RequestHandler, Response } from "express";

/**
 * Express 4 throws away a rejected promise from an async handler: nothing is
 * sent, the socket stays open, and a client without its own timeout waits
 * forever. That is one of the two ways a click on a library video could "do
 * nothing" — GET /api/video/:id/surfaces has no try/catch in its body, so any
 * database error meant a request that never settled.
 *
 * Wrapping a handler converts that into an ordinary 500 the UI already knows
 * how to show. The ~130 other bare async handlers in routes.ts have the same
 * shape and can be wrapped the same way.
 */
export function asyncRoute(
  handler: (req: any, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err: any) => {
      console.error(`[asyncRoute] ${req.method} ${req.originalUrl} failed:`, err?.message ?? err);
      // Headers already out means a stream or a partial write: there is no
      // status left to set, and only ending it frees the waiting client.
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(500).json({ error: "Something went wrong handling that request." });
    });
  };
}
