// Milestone 173: teacher password recovery, via Resend (https://resend.com) - a plain REST call
// with Node's built-in fetch (Node >=18, see package.json's "engines"), no SDK dependency needed.
// RESEND_API_KEY and RESEND_FROM_EMAIL are real secrets/config - Render env vars, never hardcoded
// here or committed anywhere (see server/.env.example for local dev).
//
// Resend's free tier only lets an unverified sending domain deliver to the Resend ACCOUNT
// OWNER'S OWN email address - to actually reach arbitrary teachers' real inboxes, the Resend
// account needs a verified sending domain (Resend's dashboard walks through the DNS records).
// Until that's done, this will silently fail to reach anyone but the Resend account holder.
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("Password reset email is not configured (RESEND_API_KEY/RESEND_FROM_EMAIL missing)");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: "Reset your Lorebound teacher password",
      html: `<p>Someone (hopefully you) asked to reset the password on your Lorebound teacher account.</p>
<p><a href="${resetUrl}">Click here to set a new password</a>. This link expires in 1 hour.</p>
<p>If you didn't request this, you can ignore this email - your password hasn't changed.</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}
