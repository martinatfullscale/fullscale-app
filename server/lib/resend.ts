// Resend Email Integration
// Uses Replit's Resend connector for transactional emails

import { Resend } from 'resend';

// -----------------------------------------------------------------------
// Email domains — split into SEND vs INBOX so the two halves of the
// gofullscale.co → gofullscale.ai migration can move independently:
//
//   MAIL_FROM_DOMAIN  — the FROM address on outbound mail. Safe to flip to
//     gofullscale.ai as soon as that domain is VERIFIED IN RESEND. Resend
//     rejects sends from an unverified domain, so don't flip before then.
//
//   MAIL_INBOX_DOMAIN — the reply-to address + the internal notification
//     recipients (martin@, hello@). These must point at a domain that can
//     actually RECEIVE mail. Keep on gofullscale.co until the Google
//     Workspace alias for gofullscale.ai is live, otherwise replies and
//     admin notifications bounce.
//
// Both fall back to the single MAIL_DOMAIN var (and then .co) for
// convenience. Typical staged rollout:
//   1. Resend verifies .ai → set MAIL_FROM_DOMAIN=gofullscale.ai, redeploy
//      (mail now sends FROM .ai; replies still land safely on .co)
//   2. Workspace .ai alias live → set MAIL_INBOX_DOMAIN=gofullscale.ai
//      (replies + notifications now land on .ai too — full cutover)
// To revert either: unset the var.
// -----------------------------------------------------------------------
const MAIL_FROM_DOMAIN = process.env.MAIL_FROM_DOMAIN || process.env.MAIL_DOMAIN || 'gofullscale.co';
const MAIL_INBOX_DOMAIN = process.env.MAIL_INBOX_DOMAIN || process.env.MAIL_DOMAIN || 'gofullscale.co';
/** Sender identities, derived from MAIL_FROM_DOMAIN (Resend-verified). */
export const MAIL_FROM = {
  noreply: `FullScale <noreply@${MAIL_FROM_DOMAIN}>`,
  hello: `FullScale <hello@${MAIL_FROM_DOMAIN}>`,
  martin: `Martin at FullScale <martin@${MAIL_FROM_DOMAIN}>`,
  martinFrom: `Martin from FullScale <martin@${MAIL_FROM_DOMAIN}>`,
  studio: `FullScale Studio <noreply@${MAIL_FROM_DOMAIN}>`,
};
/** Reply-to + admin notification recipients — derived from MAIL_INBOX_DOMAIN
 *  (must be able to RECEIVE; lags MAIL_FROM_DOMAIN until Workspace is ready). */
export const MAIL_MARTIN_ADDRESS = `martin@${MAIL_INBOX_DOMAIN}`;
export const MAIL_HELLO_ADDRESS = `hello@${MAIL_INBOX_DOMAIN}`;

let connectionSettings: any;

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=resend',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.api_key)) {
    throw new Error('Resend not connected');
  }
  return { apiKey: connectionSettings.settings.api_key, fromEmail: connectionSettings.settings.from_email };
}

// Get fresh Resend client (never cache - tokens expire)
export async function getResendClient() {
  const { apiKey, fromEmail } = await getCredentials();
  return {
    client: new Resend(apiKey),
    fromEmail
  };
}

// Send welcome email to new user
export async function sendWelcomeEmail(toEmail: string, firstName: string) {
  try {
    const { client, fromEmail } = await getResendClient();
    
    const result = await client.emails.send({
      from: MAIL_FROM.noreply,
      to: toEmail,
      subject: 'Welcome to FullScale!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #1a1a1a;">Welcome to FullScale, ${firstName}!</h1>
          <p style="color: #4a4a4a; font-size: 16px; line-height: 1.6;">
            Thank you for signing up for FullScale Creator Portal. Your application has been received and is being reviewed.
          </p>
          <p style="color: #4a4a4a; font-size: 16px; line-height: 1.6;">
            We'll be in touch soon with next steps. In the meantime, you can complete your full creator profile to speed up the review process.
          </p>
          <div style="margin: 30px 0;">
            <a href="https://gofullscale.co/auth" style="background-color: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              Complete Your Profile
            </a>
          </div>
          <p style="color: #888; font-size: 14px;">
            If you have any questions, reply to this email or reach out to our team.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          <p style="color: #888; font-size: 12px;">
            FullScale Creator Portal - AI-Powered Content Monetization
          </p>
        </div>
      `
    });
    
    console.log('[Resend] Welcome email sent to:', toEmail, result);
    return result;
  } catch (error) {
    console.error('[Resend] Failed to send welcome email:', error);
    throw error;
  }
}

// Send cohort invitation email
export async function sendCohortInviteEmail(toEmail: string, firstName: string) {
  try {
    const { client, fromEmail } = await getResendClient();
    
    // Use verified gofullscale.co domain
    const senderEmail = MAIL_FROM.martinFrom;
    
    const result = await client.emails.send({
      from: senderEmail,
      to: toEmail,
      subject: 'Thank You for Joining FullScale - Demo Coming Soon!',
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #030712; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #030712;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color: #0a1628; border-radius: 12px; border: 1px solid #1e293b;">
          
          <!-- Header with Brand Name -->
          <tr>
            <td style="padding: 30px 40px; border-bottom: 1px solid #1e293b; text-align: center;">
              <h1 style="margin: 0; font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">
                <span style="color: #ffffff;">Full</span><span style="color: #D90429;">Scale</span>
              </h1>
              <p style="margin: 8px 0 0; color: #64748b; font-size: 13px; text-transform: uppercase; letter-spacing: 2px;">Creator Portal</p>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 20px; color: #ffffff; font-size: 20px; font-weight: 600;">
                Hey ${firstName}!
              </p>
              
              <p style="margin: 0 0 20px; color: #94a3b8; font-size: 16px; line-height: 1.8;">
                Thank you for signing up for FullScale! We're thrilled to have you as part of our <strong style="color: #ffffff;">founding creator cohort</strong>.
              </p>
              
              <p style="margin: 0 0 20px; color: #94a3b8; font-size: 16px; line-height: 1.8;">
                We have a ton of <strong style="color: #D90429;">great announcements</strong> coming your way that will be meaningful, helpful, and frankly the foundation of who we are.
              </p>
              
              <p style="margin: 0 0 15px; color: #94a3b8; font-size: 16px; line-height: 1.8;">
                As a founding member, you'll get:
              </p>
              
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 25px;">
                <tr>
                  <td style="padding: 14px 18px; background-color: #0f172a; border-left: 4px solid #D90429; border-radius: 0 8px 8px 0;">
                    <strong style="color: #ffffff;">Early Access</strong>
                    <span style="color: #64748b;"> — Be among the first to use our AI video scanning</span>
                  </td>
                </tr>
                <tr><td style="height: 10px;"></td></tr>
                <tr>
                  <td style="padding: 14px 18px; background-color: #0f172a; border-left: 4px solid #D90429; border-radius: 0 8px 8px 0;">
                    <strong style="color: #ffffff;">Direct Feedback Channel</strong>
                    <span style="color: #64748b;"> — Shape the product with your input</span>
                  </td>
                </tr>
                <tr><td style="height: 10px;"></td></tr>
                <tr>
                  <td style="padding: 14px 18px; background-color: #0f172a; border-left: 4px solid #D90429; border-radius: 0 8px 8px 0;">
                    <strong style="color: #ffffff;">Priority Brand Matching</strong>
                    <span style="color: #64748b;"> — First in line for monetization opportunities</span>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 0 0 30px; color: #94a3b8; font-size: 16px; line-height: 1.8;">
                Keep an eye on your inbox — I'll be reaching out personally when we're ready to onboard you.
              </p>
              
              <p style="margin: 0; color: #ffffff; font-size: 16px;">
                Best,<br/>
                <strong>Martin Ekechukwu</strong><br/>
                <span style="color: #D90429;">Founder, FullScale</span>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #030712; border-radius: 0 0 12px 12px; text-align: center; border-top: 1px solid #1e293b;">
              <p style="margin: 0; color: #64748b; font-size: 13px;">
                FullScale Creator Portal — AI-Powered Content Monetization<br/>
                <a href="https://gofullscale.co" style="color: #D90429; text-decoration: none;">gofullscale.co</a>
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `
    });
    
    console.log('[Resend] Cohort invite email sent to:', toEmail, result);
    return { success: true, email: toEmail, result };
  } catch (error) {
    console.error('[Resend] Failed to send cohort invite to:', toEmail, error);
    return { success: false, email: toEmail, error: String(error) };
  }
}

// Send Studio video completion email
export async function sendStudioVideoReadyEmail(
  toEmail: string,
  videoTitle: string,
  videoId: number,
  sceneCount: number,
  durationSeconds: number
) {
  try {
    const { client, fromEmail } = await getResendClient();
    const durationMin = Math.max(1, Math.round(durationSeconds / 60));
    const videoUrl = `https://gofullscale.co/api/studio/videos/${videoId}/download`;

    const result = await client.emails.send({
      from: MAIL_FROM.studio,
      to: toEmail,
      subject: `Your video "${videoTitle}" is ready!`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #030712; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #030712;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color: #0a1628; border-radius: 12px; border: 1px solid #1e293b;">

          <!-- Header -->
          <tr>
            <td style="padding: 30px 40px; border-bottom: 1px solid #1e293b; text-align: center;">
              <h1 style="margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">
                <span style="color: #ffffff;">Full</span><span style="color: #D90429;">Scale</span>
              </h1>
              <p style="margin: 8px 0 0; color: #64748b; font-size: 13px; text-transform: uppercase; letter-spacing: 2px;">Studio</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px;">
              <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; width: 60px; height: 60px; background-color: rgba(34, 197, 94, 0.1); border-radius: 50%; line-height: 60px; font-size: 28px;">
                  &#10003;
                </div>
              </div>

              <h2 style="margin: 0 0 15px; color: #ffffff; font-size: 22px; font-weight: 600; text-align: center;">
                Your Video is Ready!
              </h2>

              <p style="margin: 0 0 25px; color: #94a3b8; font-size: 16px; line-height: 1.8; text-align: center;">
                Your narrated video <strong style="color: #ffffff;">"${videoTitle}"</strong> has been generated and is ready to download.
              </p>

              <!-- Stats -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 30px;">
                <tr>
                  <td width="50%" style="padding: 14px 18px; background-color: #0f172a; border-radius: 8px 0 0 8px; text-align: center; border-right: 1px solid #1e293b;">
                    <div style="color: #D90429; font-size: 24px; font-weight: 700;">${sceneCount}</div>
                    <div style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Scenes</div>
                  </td>
                  <td width="50%" style="padding: 14px 18px; background-color: #0f172a; border-radius: 0 8px 8px 0; text-align: center;">
                    <div style="color: #D90429; font-size: 24px; font-weight: 700;">~${durationMin} min</div>
                    <div style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Duration</div>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <div style="text-align: center; margin-bottom: 20px;">
                <a href="${videoUrl}" style="display: inline-block; background-color: #7c3aed; color: #ffffff; padding: 14px 36px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                  Download Your Video
                </a>
              </div>

              <p style="margin: 0; color: #64748b; font-size: 13px; text-align: center;">
                You can also find your video in your Studio dashboard.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: #030712; border-radius: 0 0 12px 12px; text-align: center; border-top: 1px solid #1e293b;">
              <p style="margin: 0; color: #64748b; font-size: 13px;">
                FullScale Studio — Turn Decks Into Videos<br/>
                <a href="https://gofullscale.co" style="color: #D90429; text-decoration: none;">gofullscale.co</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `
    });

    console.log('[Resend] Studio video ready email sent to:', toEmail, result);
    return result;
  } catch (error) {
    console.error('[Resend] Failed to send studio video ready email:', error);
    // Don't throw — email failure shouldn't break the pipeline
  }
}

// Send brand brief notification to the FullScale team when a brand
// submits their onboarding wizard. The full brief is formatted as a
// structured HTML summary that reads like a creative brief.
export async function sendBrandBriefNotification(args: {
  brief: {
    brandName?: string | null;
    website?: string | null;
    industry?: string | null;
    brandVoice?: string[] | null;
    logoUrl?: string | null;
    placementTypes?: string[] | null;
    productDescription?: string | null;
    referenceImageUrls?: string[] | null;
    flexibility?: string | null;
    targetGeographies?: string[] | null;
    audienceAgeMin?: number | null;
    audienceAgeMax?: number | null;
    audienceInterests?: string[] | null;
    languages?: string[] | null;
    primaryObjective?: string | null;
    successMeasurement?: string | null;
    budgetRange?: string | null;
    timeline?: string | null;
    contentCategories?: string[] | null;
    specificCreators?: string | null;
    thingsToAvoid?: string | null;
    handsOnLevel?: string | null;
  };
  user: {
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  };
}) {
  const { brief, user } = args;

  const teamEmail = MAIL_HELLO_ADDRESS;
  const subjectBrand = brief.brandName || "Unnamed Brand";
  const subjectIndustry = brief.industry || "—";

  const fmtList = (v: string[] | null | undefined) =>
    v && v.length > 0 ? v.join(", ") : "—";
  const fmtText = (v: string | null | undefined) =>
    v && v.trim().length > 0 ? v : "—";
  const fmtAge = () =>
    brief.audienceAgeMin != null && brief.audienceAgeMax != null
      ? `${brief.audienceAgeMin}–${brief.audienceAgeMax}`
      : "—";

  // Human-friendly labels for enum-style answers
  const flexibilityLabel: Record<string, string> = {
    exact: "Exact products only",
    substitutes: "Open to close substitutes",
    flexible: "Flexible — brand visibility is the goal",
  };
  const objectiveLabel: Record<string, string> = {
    awareness: "Brand awareness",
    launch: "Product launch",
    pmf_test: "Test product–market fit",
    conversions: "Drive conversions / sales",
    partnerships: "Build creator partnerships",
    other: "Other",
  };
  const budgetLabel: Record<string, string> = {
    under_5k: "Under $5K",
    "5k_25k": "$5K–$25K",
    "25k_100k": "$25K–$100K",
    "100k_500k": "$100K–$500K",
    "500k_plus": "$500K+",
    discuss: "Prefer to discuss",
  };
  const timelineLabel: Record<string, string> = {
    one_time: "One-time campaign",
    "3mo": "3 months",
    "6mo": "6 months",
    ongoing: "Ongoing partnership",
    exploring: "Just exploring",
  };
  const handsOnLabel: Record<string, string> = {
    hands_off: "Hands-off (auto-match)",
    selective: "Selective (I'll review matches)",
    hands_on: "Hands-on (I'll pick everything)",
  };

  const row = (label: string, value: string) => `
    <tr>
      <td style="padding: 10px 14px; background-color: #0f172a; color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; width: 180px; vertical-align: top; border-bottom: 1px solid #1e293b;">${label}</td>
      <td style="padding: 10px 14px; background-color: #0a1628; color: #e2e8f0; font-size: 14px; vertical-align: top; border-bottom: 1px solid #1e293b;">${value}</td>
    </tr>
  `;

  const section = (title: string, rows: string) => `
    <tr>
      <td style="padding: 22px 40px 10px; color: #D90429; font-size: 13px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;">${title}</td>
    </tr>
    <tr>
      <td style="padding: 0 40px 10px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #1e293b;">
          ${rows}
        </table>
      </td>
    </tr>
  `;

  try {
    const { client, fromEmail } = await getResendClient();

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #030712; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #030712;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="720" cellspacing="0" cellpadding="0" style="background-color: #0a1628; border-radius: 12px; border: 1px solid #1e293b;">
          <tr>
            <td style="padding: 30px 40px; border-bottom: 1px solid #1e293b;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">
                <span style="color: #ffffff;">Full</span><span style="color: #D90429;">Scale</span>
                <span style="color: #64748b; font-size: 14px; font-weight: 400; letter-spacing: 2px; text-transform: uppercase; margin-left: 12px;">· New Brand Brief</span>
              </h1>
              <p style="margin: 10px 0 0; color: #94a3b8; font-size: 16px;">
                <strong style="color: #ffffff;">${subjectBrand}</strong> · ${subjectIndustry}
                ${user.firstName || user.lastName ? `<span style="color: #64748b;"> · submitted by ${[user.firstName, user.lastName].filter(Boolean).join(" ")} (${user.email || ""})</span>` : ""}
              </p>
            </td>
          </tr>

          ${section("Brand at a Glance", `
            ${row("Brand name", fmtText(brief.brandName))}
            ${row("Website", brief.website ? `<a href="${brief.website}" style="color:#D90429;text-decoration:none;">${brief.website}</a>` : "—")}
            ${row("Industry", fmtText(brief.industry))}
            ${row("Voice", fmtList(brief.brandVoice))}
            ${row("Logo", brief.logoUrl ? `<a href="${brief.logoUrl}" style="color:#D90429;text-decoration:none;">${brief.logoUrl}</a>` : "—")}
          `)}

          ${section("What You Want to Place", `
            ${row("Placement types", fmtList(brief.placementTypes))}
            ${row("Product description", fmtText(brief.productDescription))}
            ${row("Reference images", brief.referenceImageUrls && brief.referenceImageUrls.length > 0 ? brief.referenceImageUrls.map((u) => `<a href="${u}" style="color:#D90429;text-decoration:none;">${u}</a>`).join("<br>") : "—")}
            ${row("Flexibility", flexibilityLabel[brief.flexibility || ""] || fmtText(brief.flexibility))}
          `)}

          ${section("Who You Want to Reach", `
            ${row("Geographies", fmtList(brief.targetGeographies))}
            ${row("Age range", fmtAge())}
            ${row("Audience interests", fmtList(brief.audienceInterests))}
            ${row("Languages", fmtList(brief.languages))}
          `)}

          ${section("What Success Looks Like", `
            ${row("Primary objective", objectiveLabel[brief.primaryObjective || ""] || fmtText(brief.primaryObjective))}
            ${row("Success measurement", fmtText(brief.successMeasurement))}
            ${row("Budget range", budgetLabel[brief.budgetRange || ""] || fmtText(brief.budgetRange))}
            ${row("Timeline", timelineLabel[brief.timeline || ""] || fmtText(brief.timeline))}
          `)}

          ${section("Working Together", `
            ${row("Content categories", fmtList(brief.contentCategories))}
            ${row("Specific creators", fmtText(brief.specificCreators))}
            ${row("Things to avoid", fmtText(brief.thingsToAvoid))}
            ${row("Engagement style", handsOnLabel[brief.handsOnLevel || ""] || fmtText(brief.handsOnLevel))}
          `)}

          <tr>
            <td style="padding: 25px 40px; background-color: #030712; border-radius: 0 0 12px 12px; text-align: center; border-top: 1px solid #1e293b;">
              <p style="margin: 0; color: #64748b; font-size: 13px;">
                FullScale For Brands — brand onboarding brief<br/>
                <a href="https://gofullscale.co" style="color: #D90429; text-decoration: none;">gofullscale.co</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    const result = await client.emails.send({
      from: MAIL_FROM.noreply,
      to: teamEmail,
      subject: `[New brand brief] ${subjectBrand} — ${subjectIndustry}`,
      html,
    });

    console.log("[Resend] Brand brief notification sent:", result);
    return { success: true, result };
  } catch (error) {
    console.error("[Resend] Failed to send brand brief notification:", error);
    return { success: false, error: String(error) };
  }
}

// Send notification to admin about new signup
export async function sendAdminNotification(userData: {
  email: string;
  firstName: string;
  lastName: string;
  userType: string;
}) {
  try {
    const { client, fromEmail } = await getResendClient();
    
    const adminEmail = MAIL_MARTIN_ADDRESS;
    
    const result = await client.emails.send({
      from: MAIL_FROM.noreply,
      to: adminEmail,
      subject: `New FullScale Signup: ${userData.firstName} ${userData.lastName} (${userData.userType})`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">New User Signup</h2>
          <p style="color: #4a4a4a; font-size: 16px; line-height: 1.6;">
            A new user has signed up for FullScale and is waiting for review.
          </p>
          <p style="margin: 16px 0;">
            <a href="https://gofullscale.co/admin/signups" style="display: inline-block; background: #10b981; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600;">Review &amp; approve in one click</a>
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold; width: 120px;">Name:</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee;">${userData.firstName} ${userData.lastName}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Email:</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee;">${userData.email}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">User Type:</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee;">${userData.userType}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Status:</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee; color: #f59e0b;">Pending - Airtable not completed</td>
            </tr>
          </table>
          <p style="color: #4a4a4a; font-size: 14px;">
            You can view all signups in your <a href="https://airtable.com/appF4oLhgbf143xe7" style="color: #6366f1;">Airtable dashboard</a>.
          </p>
        </div>
      `
    });
    
    console.log('[Resend] Admin notification sent:', result);
    return result;
  } catch (error) {
    console.error('[Resend] Failed to send admin notification:', error);
    throw error;
  }
}

/**
 * Email an applicant whose Airtable application was approved by admin.
 * Branches copy by userType — brands and creators get different welcome
 * framing because their next steps differ.
 *
 * Triggered by the Airtable approval webhook
 * (POST /api/admin/airtable-approval-webhook in routes.ts).
 */
export async function sendApprovalEmail(params: {
  email: string;
  firstName: string;
  userType: "brand" | "creator";
  companyName?: string;
}): Promise<{ sent: boolean; id?: string; reason?: string }> {
  try {
    const { client } = await getResendClient();
    if (!client) return { sent: false, reason: "Resend client not available" };

    // Personal touches:
    //  - Sent FROM martin@gofullscale.co (not noreply@) so it reads as a
    //    1:1 note and replies land in Martin's inbox.
    //  - reply_to set explicitly as a belt-and-suspenders in case any
    //    relay rewrites the From.
    //  - Founder-voice copy, no bulleted feature dump.
    const fromAddress = MAIL_FROM.martin;
    const replyTo = MAIL_MARTIN_ADDRESS;
    // Sign-IN, not sign-up: everyone receiving this already has an account.
    // ?mode=signup opened the Register tab and dead-ended them on
    // "User already exists with this email".
    const loginUrl = "https://gofullscale.co/auth";
    const calendarUrl = "https://cal.com/martinatfullscale";
    const p = "margin: 0 0 16px 0; line-height: 1.55;";
    const link = "color: #10b981; font-weight: 500;";

    const body =
      params.userType === "brand"
        ? `
          <p style="${p}">Hi ${params.firstName},</p>
          <p style="${p}">I went through your application${params.companyName ? ` for <strong>${params.companyName}</strong>` : ""} myself — really glad to have you in. We're keeping the founding group small and intentional${params.companyName ? `, and ${params.companyName} is exactly the kind of brand we built this for` : ""}.</p>
          <p style="${p}">To get started, sign in at <a href="${loginUrl}" style="${link}">gofullscale.co</a> with ${params.email} and you'll land in the marketplace. Two things worth doing first: add your products under <strong>Products</strong> so placements can be mocked up on real packaging, then browse the creator roster and flag anyone whose content feels right${params.companyName ? ` for ${params.companyName}` : ""}. The founding creator roster is coming online right now, so new creators appear there as they approve their first placements — if it looks thin today, that's why, and it fills in week over week.</p>
          <p style="${p}">Once you've flagged a few, I'll put together a tailored placement brief and walk you through it personally.</p>
          <p style="${p}">If you'd rather talk it through first, grab any time that works: <a href="${calendarUrl}" style="${link}">cal.com/martinatfullscale</a>. I'd genuinely love to hear what you're trying to accomplish.</p>
          <p style="${p}">Talk soon,</p>
        `
        : `
          <p style="${p}">Hi ${params.firstName},</p>
          <p style="${p}">Just approved your account — welcome in. You're part of the founding creator cohort, which means you're helping shape how this whole thing works.</p>
          <p style="${p}">Here's the whole flow, start to finish. It takes about ten minutes:</p>
          <ol style="margin: 0 0 16px 0; padding-left: 20px; line-height: 1.7;">
            <li style="margin-bottom: 10px;"><strong>Sign in</strong> at <a href="${loginUrl}" style="${link}">gofullscale.co</a> using ${params.email} — the same way you signed up.</li>
            <li style="margin-bottom: 10px;"><strong>Bring in a video.</strong> Connect your YouTube channel from the dashboard, or just paste a link into the bar at the top of your Library — YouTube, Twitch, TikTok, and X all work.</li>
            <li style="margin-bottom: 10px;"><strong>Hit Scan.</strong> Our AI watches the whole video, maps every recurring scene, and finds the walls, desks, and tables a brand could actually live on. A long episode takes a few minutes — you can close the tab.</li>
            <li style="margin-bottom: 10px;"><strong>Open the results and try a placement.</strong> Pick a surface you like, drop a product onto it, and save. You're choosing <em>where the product lives</em> — it doesn't need to look perfect, that's our job.</li>
            <li style="margin-bottom: 10px;"><strong>We take it from there.</strong> A real person on our team reviews every placement and produces the final polished render — nothing ships straight off the tool. You'll see the status on each placement as it moves.</li>
            <li><strong>Approve what brands can see.</strong> Nothing about your content reaches a brand until you approve it — that switch is yours, always.</li>
          </ol>
          <p style="${p}">The same checklist is waiting on your dashboard and ticks itself off as you go, so you don't need to keep this email open.</p>
          <p style="${p}">One ask: this is early, and you'll probably hit something rough. Tell me when you do — just reply here, it comes straight to me. That feedback is genuinely why the founding cohort exists.</p>
          <p style="${p}">Glad you're here,</p>
        `;

    // Personal subject — no "access approved" corporate phrasing.
    const subject = `Welcome to FullScale, ${params.firstName}`;

    const result = await client.emails.send({
      from: fromAddress,
      replyTo,
      to: params.email,
      subject,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
          ${body}
          <p style="margin: 0; line-height: 1.4;"><strong>Martin</strong><br/><span style="color: #6b7280;">Founder, FullScale</span></p>
        </div>
      `,
    });

    const id = (result as any)?.data?.id;
    console.log(`[Resend] Approval email sent to ${params.email} (${params.userType}): ${id}`);
    return { sent: true, id };
  } catch (error: any) {
    console.error("[Resend] Failed to send approval email:", error?.message || error);
    return { sent: false, reason: error?.message || String(error) };
  }
}

/**
 * Email a demo requester with Martin's cal.com booking link so they can
 * self-schedule. Triggered by the Airtable approval webhook when a row
 * lands in the FullScale Demo table (requestType="demo").
 *
 * Unlike the approval email, this grants no access — it's purely a warm
 * "let's find a time" note. Sent from martin@ so replies reach him.
 */
export async function sendDemoSchedulingEmail(params: {
  email: string;
  firstName: string;
  companyName?: string;
}): Promise<{ sent: boolean; id?: string; reason?: string }> {
  try {
    const { client } = await getResendClient();
    if (!client) return { sent: false, reason: "Resend client not available" };

    const fromAddress = MAIL_FROM.martin;
    const replyTo = MAIL_MARTIN_ADDRESS;
    const calendarUrl = "https://cal.com/martinatfullscale";
    const p = "margin: 0 0 16px 0; line-height: 1.55;";
    const link = "color: #10b981; font-weight: 500;";

    const result = await client.emails.send({
      from: fromAddress,
      replyTo,
      to: params.email,
      subject: `Let's find a time, ${params.firstName}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
          <p style="${p}">Hi ${params.firstName},</p>
          <p style="${p}">Thanks for asking for a look at FullScale${params.companyName ? ` — I'd love to show you what it could do for <strong>${params.companyName}</strong>` : ""}. I'll walk you through it personally: how the AI places products into real creator content, and where it fits for what you're working on.</p>
          <p style="${p}">Grab whatever time works best here: <a href="${calendarUrl}" style="${link}">cal.com/martinatfullscale</a></p>
          <p style="${p}">If none of those slots work, just reply to this email and we'll figure it out.</p>
          <p style="${p}">Looking forward to it,</p>
          <p style="margin: 0; line-height: 1.4;"><strong>Martin</strong><br/><span style="color: #6b7280;">Founder, FullScale</span></p>
        </div>
      `,
    });

    const id = (result as any)?.data?.id;
    console.log(`[Resend] Demo scheduling email sent to ${params.email}: ${id}`);
    return { sent: true, id };
  } catch (error: any) {
    console.error("[Resend] Failed to send demo scheduling email:", error?.message || error);
    return { sent: false, reason: error?.message || String(error) };
  }
}

/**
 * Internal ops ping: a creator saved a placement — the human review + final
 * render step starts now. Without this, saves were silent and the ops queue
 * could never begin.
 */
export async function sendPlacementSubmittedNotification(params: {
  placementId: number;
  creatorEmail: string;
  videoTitle: string;
}): Promise<void> {
  const { client } = await getResendClient();
  if (!client) return;
  await client.emails.send({
    from: MAIL_FROM.noreply,
    to: MAIL_MARTIN_ADDRESS,
    subject: `Placement #${params.placementId} submitted for review — ${params.videoTitle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">New placement to review</h2>
        <p style="color: #4a4a4a; font-size: 15px; line-height: 1.6;">
          <strong>${params.creatorEmail}</strong> chose a placement on
          <strong>${params.videoTitle}</strong>. Review the choice and produce the
          final render, then mark it in the queue so they see the status.
        </p>
        <p style="margin: 16px 0;">
          <a href="https://gofullscale.co/admin/placements" style="display: inline-block; background: #6366f1; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600;">Open the review queue</a>
        </p>
      </div>
    `,
  });
  console.log(`[Resend] Placement-review notification sent for #${params.placementId}`);
}
