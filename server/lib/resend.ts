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
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f0f0f; padding: 40px; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #ffffff; font-size: 28px; margin: 0;">FullScale</h1>
            <p style="color: #6366f1; font-size: 14px; margin: 5px 0;">Creator Portal</p>
          </div>
          
          <p style="color: #ffffff; font-size: 18px; line-height: 1.6;">
            Hey ${firstName},
          </p>
          
          <p style="color: #d1d5db; font-size: 16px; line-height: 1.8;">
            Thank you for signing up for FullScale! We're thrilled to have you as part of our founding creator cohort.
          </p>
          
          <p style="color: #d1d5db; font-size: 16px; line-height: 1.8;">
            We're putting the finishing touches on our AI-powered content monetization platform, and we'll be opening the cohort for testing and demos <strong style="color: #6366f1;">very shortly</strong>.
          </p>
          
          <p style="color: #d1d5db; font-size: 16px; line-height: 1.8;">
            As a founding member, you'll get:
          </p>
          
          <ul style="color: #d1d5db; font-size: 16px; line-height: 1.8; padding-left: 20px;">
            <li><strong style="color: #ffffff;">Early Access</strong> - Be among the first to use our AI video scanning</li>
            <li><strong style="color: #ffffff;">Direct Feedback Channel</strong> - Shape the product with your input</li>
            <li><strong style="color: #ffffff;">Priority Brand Matching</strong> - First in line for monetization opportunities</li>
          </ul>
          
          <p style="color: #d1d5db; font-size: 16px; line-height: 1.8;">
            Keep an eye on your inbox - I'll be reaching out personally when we're ready to onboard you.
          </p>
          
          <p style="color: #ffffff; font-size: 16px; margin-top: 30px;">
            Best,<br/>
            <strong>Martin Ekechukwu</strong><br/>
            <span style="color: #6366f1;">Founder, FullScale</span>
          </p>
          
          <hr style="border: none; border-top: 1px solid #333; margin: 30px 0;" />
          
          <p style="color: #666; font-size: 12px; text-align: center;">
            FullScale Creator Portal - AI-Powered Content Monetization<br/>
            <a href="https://gofullscale.co" style="color: #6366f1;">gofullscale.co</a>
          </p>
        </div>
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
