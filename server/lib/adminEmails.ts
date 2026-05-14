// Single source of truth for admin status. Anyone whose email matches
// one of these gets canSwitchRoles + access to /api/admin/* endpoints.
//
// Past mistake: the admin list was hardcoded in 10+ places across
// routes.ts. Adding a person required editing all of them, and the
// arrays drifted out of sync (some had different members than others).
// This module fixes that — everything imports from here.
//
// To add/remove an admin, edit the ADMIN_EMAILS array below. Do NOT
// re-introduce inline admin arrays elsewhere.

export const ADMIN_EMAILS: readonly string[] = [
  "martin@gofullscale.co",
  "tamara@gofullscale.co",
  "ben@muselabs.ai",
  "chu@gofullscale.co",
  "remiguyton@gmail.com",
];

/** Case-insensitive admin check. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return ADMIN_EMAILS.some(a => a.toLowerCase() === lower);
}
