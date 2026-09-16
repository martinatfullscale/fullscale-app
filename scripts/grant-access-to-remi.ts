/**
 * One-off script to grant Remi Guyton (remiguyton@gmail.com) the same
 * level of access as Ben Michals, and email her a welcome message.
 *
 * Run on Replit:
 *
 *   tsx scripts/grant-access-to-remi.ts
 *
 * What it does (idempotent — safe to re-run):
 *   1. Looks up Ben's allowed_users row to use as the template.
 *      You can change BEN_EMAIL below if his account uses a different
 *      email than the default. If Ben isn't found, the script falls back
 *      to a sensible creator default (userType=creator, isFeatured=false).
 *   2. Inserts or updates Remi's allowed_users row to mirror Ben's
 *      access (userType + featured flag), with her own name + email.
 *   3. Sends her a personal welcome email via the existing Resend
 *      integration. Skips email send if --dry-run is passed.
 *
 * Notes:
 *   - This script does NOT make Remi an admin. If you want admin access,
 *     also add her email to server/lib/adminEmails.ts ADMIN_EMAILS array.
 *   - The script does NOT create a User row in the users table — that's
 *     created on first sign-in via OAuth/email-password. The allowlist
 *     row is the gate that lets her sign in successfully.
 */
import { storage } from "../server/storage";
import { getResendClient } from "../server/lib/resend";

const REMI_EMAIL = "remiguyton@gmail.com";
const REMI_NAME = "Remi Guyton";

// If Ben Michals' allowlist email is different, change this and re-run.
// We try both common spellings; whichever exists wins.
const BEN_EMAIL_CANDIDATES = [
  "ben@muselabs.ai",       // the email used in the admin list
  "benmichals@gmail.com",
  "ben.michals@gmail.com",
  "ben@michals.com",
];

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`[grant-access-to-remi] Starting (dry-run=${DRY_RUN})`);

  // Step 1: find Ben's row to mirror access settings.
  let benRow: Awaited<ReturnType<typeof storage.getAllowedUser>> = undefined;
  for (const candidate of BEN_EMAIL_CANDIDATES) {
    benRow = await storage.getAllowedUser(candidate);
    if (benRow) {
      console.log(`[grant-access-to-remi] Using Ben's record at ${candidate}: userType=${benRow.userType} isFeatured=${benRow.isFeatured}`);
      break;
    }
  }
  if (!benRow) {
    console.warn(`[grant-access-to-remi] Ben's allowlist row not found in any of ${BEN_EMAIL_CANDIDATES.join(", ")}. Falling back to creator default.`);
  }

  // Step 2: check if Remi is already in the allowlist (idempotent).
  const existing = await storage.getAllowedUser(REMI_EMAIL);
  if (existing) {
    console.log(`[grant-access-to-remi] Remi already in allowlist (id=${existing.id}, userType=${existing.userType}). Skipping insert.`);
  } else if (DRY_RUN) {
    console.log(`[grant-access-to-remi] DRY-RUN: would insert allowedUsers row for ${REMI_EMAIL}`);
  } else {
    const newRow = await storage.addAllowedUser({
      email: REMI_EMAIL,
      name: REMI_NAME,
      userType: benRow?.userType ?? "creator",
      // Mirror Ben's featured flag but DON'T mirror Ben's slug/bio/etc —
      // those are personal to him.
      isFeatured: benRow?.isFeatured ?? false,
    });
    console.log(`[grant-access-to-remi] Added allowedUsers row id=${newRow.id} for ${REMI_EMAIL}`);
  }

  // Step 3: send welcome email.
  if (DRY_RUN) {
    console.log(`[grant-access-to-remi] DRY-RUN: would send welcome email to ${REMI_EMAIL}`);
    return;
  }
  try {
    const { client, fromEmail } = await getResendClient();
    const from = fromEmail || "FullScale <noreply@gofullscale.co>";
    await client.emails.send({
      from,
      to: REMI_EMAIL,
      reply_to: "martin@gofullscale.co",
      subject: "Welcome to FullScale — your access is ready",
      html: `
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111;line-height:1.55;">
  <h2 style="margin:0 0 12px;">Welcome to FullScale, Remi.</h2>
  <p>I've given you access to FullScale Creator Portal — you're in the founding cohort alongside Ben and a small group of creators we're starting with.</p>
  <p>To get in:</p>
  <ol style="padding-left:20px;">
    <li>Go to <a href="https://gofullscale.co/auth" style="color:#0a84ff;">gofullscale.co/auth</a></li>
    <li>Sign in with Google (use this email: ${REMI_EMAIL}) or create a password</li>
    <li>You'll land in the Creator Portal — connect your YouTube/Instagram and your library will start populating automatically</li>
  </ol>
  <p>If anything looks off or you want a quick walkthrough, just reply to this email — it goes straight to me.</p>
  <p style="margin-top:24px;">— Martin<br/><span style="color:#666;font-size:13px;">FullScale</span></p>
</body></html>
      `.trim(),
    });
    console.log(`[grant-access-to-remi] Welcome email sent to ${REMI_EMAIL}`);
  } catch (err: any) {
    console.error(`[grant-access-to-remi] Email send failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[grant-access-to-remi] Fatal:", err);
  process.exit(1);
});
