// Resend Email Integration
// Uses Replit's Resend connector for transactional emails

import { Resend } from 'resend';

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
      from: fromEmail || 'FullScale <noreply@gofullscale.co>',
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
    const senderEmail = 'Martin from FullScale <martin@gofullscale.co>';
    
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
          
          <!-- Header with Logo -->
          <tr>
            <td style="padding: 30px 40px; border-bottom: 1px solid #1e293b; text-align: center;">
              <img src="https://gofullscale.co/fullscale-logo.png" alt="FullScale" width="180" style="display: block; margin: 0 auto;" />
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
                We're putting the finishing touches on our AI-powered content monetization platform, and we'll be opening the cohort for testing and demos <strong style="color: #D90429;">very shortly</strong>.
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

// Send notification to admin about new signup
export async function sendAdminNotification(userData: {
  email: string;
  firstName: string;
  lastName: string;
  userType: string;
}) {
  try {
    const { client, fromEmail } = await getResendClient();
    
    const adminEmail = 'martin@gofullscale.co';
    
    const result = await client.emails.send({
      from: fromEmail || 'FullScale <noreply@gofullscale.co>',
      to: adminEmail,
      subject: `New FullScale Signup: ${userData.firstName} ${userData.lastName} (${userData.userType})`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">New User Signup</h2>
          <p style="color: #4a4a4a; font-size: 16px; line-height: 1.6;">
            A new user has signed up for FullScale but has not completed the Airtable form yet.
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
