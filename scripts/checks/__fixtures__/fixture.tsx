// Fixtures for hookOrder.test.ts — not shipped, not imported by the app.
import { useEffect, useState } from "react";

export function BrokenModal({ open }: { open: boolean }) {
  if (!open) return null;
  useEffect(() => {}, [open]);
  return <div />;
}

export function FineModal({ open }: { open: boolean }) {
  const [x] = useState(0);
  useEffect(() => {}, [open]);
  if (!open) return null;
  return <div>{x}</div>;
}

/** A hook inside the returned expression is not an early return. */
export function useThing(id: number) {
  if (!id) return null;
  return useQueryLike(id);
}
function useQueryLike(id: number) {
  return { id };
}
