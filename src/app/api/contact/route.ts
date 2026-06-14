import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ContactPayload = {
  name?: string;
  company?: string;
  email?: string;
  phone?: string;
  sector?: string;
  projectType?: string;
  message?: string;
  // honeypot field, should stay empty for real users
  website?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: ContactPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Bot trap: silently accept and drop if the honeypot is filled.
  if (body.website) {
    return NextResponse.json({ ok: true });
  }

  const name = body.name?.trim();
  const email = body.email?.trim();
  const message = body.message?.trim();

  const errors: Record<string, string> = {};
  if (!name) errors.name = "Name is required.";
  if (!email || !EMAIL_RE.test(email)) errors.email = "A valid email is required.";
  if (!message || message.length < 10)
    errors.message = "Please include a short project description.";

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  const lead = {
    name,
    company: body.company?.trim() || null,
    email,
    phone: body.phone?.trim() || null,
    sector: body.sector || null,
    projectType: body.projectType || null,
    message,
    receivedAt: new Date().toISOString(),
  };

  // Delivery: log the lead server-side. To email it in production, set
  // RESEND_API_KEY and forward `lead` to Resend (or any provider) here.
  if (process.env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Sudaan Geo-Analytics <noreply@sudaangeo.in>",
          to: process.env.CONTACT_TO || "sudaan203@gmail.com",
          subject: `New consultation request from ${lead.name}`,
          text: JSON.stringify(lead, null, 2),
          reply_to: lead.email,
        }),
      });
    } catch (err) {
      console.error("Lead email delivery failed", err);
      // Do not fail the request for the user if email delivery hiccups.
    }
  } else {
    console.log("New contact lead:", lead);
  }

  return NextResponse.json({ ok: true });
}
