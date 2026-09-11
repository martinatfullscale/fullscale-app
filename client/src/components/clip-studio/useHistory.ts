import { useCallback, useState } from "react";

/**
 * An undo stack, because the editor did not have one.
 *
 * What stood in for undo was a button labelled "Undo {n}" that cleared every
 * word cut at once — twenty minutes of striking filler, gone, with nothing to
 * get it back. Cmd+Z in an editor is not a feature, it is the floor.
 *
 * The model is deliberately dumb: whole-state snapshots, not diffs. The state
 * here is one `StudioEdits` object — a few hundred numbers at worst, well
 * under the size where structural sharing would earn its complexity — and a
 * snapshot stack cannot drift out of sync with the thing it is describing,
 * which a diff stack can.
 *
 * ONE PIECE OF STATE, NOT THREE. past/present/future live in a single object
 * updated by one pure reducer. An earlier version held them in three useState
 * calls and updated the other two from inside setPresent's updater — updaters
 * are supposed to be pure, and React is free to call them more than once
 * (StrictMode does exactly that), which would have pushed the same entry
 * twice and corrupted the stack. This shape cannot do that.
 *
 * COALESCING. A drag fires a state change per pointermove; without grouping,
 * one nudge of a b-roll block would bury the previous forty actions. Callers
 * pass a `token` that stays stable for the life of one gesture and differs
 * for the next, so a whole drag collapses to a single entry and two separate
 * drags stay separate. Tokens must be unique per CONTROL as well as per
 * gesture — a bare "x" shared between two blocks merged their drags.
 */

export interface HistoryEntry {
  /** Shown in the history list. Written for a person: "Split at 0:14.2". */
  label: string;
}

export interface History<T> {
  state: T;
  /**
   * Push a new state. `token` groups a gesture: consecutive pushes carrying
   * the same non-empty token replace each other instead of stacking.
   */
  set: (next: T | ((prev: T) => T), label: string, token?: string) => void;
  /** Replace the state without touching the stack — for loading, not editing. */
  reset: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Newest first, for the history panel. */
  entries: HistoryEntry[];
  /** How many undoable actions are on the stack. */
  depth: number;
}

const LIMIT = 100;

interface Store<T> {
  past: Array<{ state: T; label: string }>;
  present: T;
  future: Array<{ state: T; label: string }>;
  /** The token of the entry on top of `past`, while that gesture is open. */
  openToken: string | null;
}

export function useHistory<T>(initial: T): History<T> {
  const [store, setStore] = useState<Store<T>>({ past: [], present: initial, future: [], openToken: null });

  const set = useCallback((next: T | ((prev: T) => T), label: string, token?: string) => {
    setStore((s) => {
      const value = typeof next === "function" ? (next as (p: T) => T)(s.present) : next;
      if (Object.is(value, s.present)) return s;

      // Coalescing: the top entry already holds the state from before this
      // gesture started, so leave it alone and only relabel it — the label is
      // what a person reads, and it should describe where the drag ended up.
      if (token && s.openToken === token && s.past.length > 0) {
        const past = s.past.slice();
        past[past.length - 1] = { ...past[past.length - 1], label };
        return { past, present: value, future: [], openToken: token };
      }

      const grown = [...s.past, { state: s.present, label }];
      return {
        past: grown.length > LIMIT ? grown.slice(grown.length - LIMIT) : grown,
        present: value,
        future: [],
        openToken: token ?? null,
      };
    });
  }, []);

  const reset = useCallback((next: T) => {
    setStore({ past: [], present: next, future: [], openToken: null });
  }, []);

  const undo = useCallback(() => {
    setStore((s) => {
      if (s.past.length === 0) return s;
      const top = s.past[s.past.length - 1];
      return {
        past: s.past.slice(0, -1),
        present: top.state,
        future: [...s.future, { state: s.present, label: top.label }],
        openToken: null,
      };
    });
  }, []);

  const redo = useCallback(() => {
    setStore((s) => {
      if (s.future.length === 0) return s;
      const top = s.future[s.future.length - 1];
      return {
        past: [...s.past, { state: s.present, label: top.label }],
        present: top.state,
        future: s.future.slice(0, -1),
        openToken: null,
      };
    });
  }, []);

  return {
    state: store.present,
    set,
    reset,
    undo,
    redo,
    canUndo: store.past.length > 0,
    canRedo: store.future.length > 0,
    entries: store.past.map((e) => ({ label: e.label })).reverse(),
    depth: store.past.length,
  };
}

/** A fresh gesture token. Call once at pointerdown, pass to every set() in the drag. */
let seq = 0;
export const newGestureToken = (prefix: string) => `${prefix}:${++seq}`;
