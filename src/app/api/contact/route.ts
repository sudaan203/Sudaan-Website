import { NextResponse } from "next/server";
import { hit } from "@/lib/portal/rate-limit";
import { clientIp } from "@/lib/portal/request-ip";

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

/** Generous for a human filling in a consultation form, useless for a script. */
const MAX_PER_IP = 5;
const CONTACT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Caps on what we will accept, because every field here ends up in an email we
 * send and a log we read. Without them a single request can post megabytes.
 */
const LIMITS: Record<string, number> = {
  name: 120,
  company: 160,
  email: 254,
  phone: 40,
  sector: 80,
  projectType: 80,
  message: 5000,
};

export async function POST(request: Request) {
  // This endpoint is public, unauthenticated, and on its way to sending mail
  // through a paid API. The honeypot alone stops naive bots and nothing else:
  // anyone who looks at the request once can replay it in a loop, running up a
  // Resend bill and burying real enquiries.
  const ip = clientIp(request);
  if (hit(`contact|${ip}`, MAX_PER_IP, CONTACT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429 },
    );
  }

  let body: ContactPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  for (const [field, max] of Object.entries(LIMITS)) {
    const value = body[field as keyof ContactPayload];
    if (typeof value === "string" && value.length > max) {
      return NextResponse.json(
        { errors: { [field]: `That ${field} is too long.` } },
        { status: 422 },
      );
    }
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
