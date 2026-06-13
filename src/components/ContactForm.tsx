"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { sectors } from "@/lib/site";

const industriesList = [...sectors, "Other"];

const projectTypes = [
  "Orthomosaic Generation",
  "DSM / DTM",
  "Contour Mapping",
  "Point Cloud Processing",
  "Volumetric Analysis",
  "Progress Monitoring",
  "Corridor Mapping",
  "GIS Analytics",
  "Other",
];

const inputClass =
  "w-full rounded-lg border border-ink/10 bg-ink/[0.03] px-4 py-3 text-sm text-ink-900 placeholder:text-ink/50 transition-colors focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

// Static-site form backend. Set NEXT_PUBLIC_FORMSPREE_ID to your Formspree
// form id (the part after /f/ in https://formspree.io/f/XXXX).
// NOTE: on a server deploy (e.g. Vercel) rewire this back to /api/contact.
const FORMSPREE_ID = process.env.NEXT_PUBLIC_FORMSPREE_ID || "";
const FORMSPREE_ENDPOINT = FORMSPREE_ID
  ? `https://formspree.io/f/${FORMSPREE_ID}`
  : "";

export default function ContactForm() {
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());

    if (!FORMSPREE_ENDPOINT) {
      setErrorMsg(
        "The contact form is not configured yet. Please email us directly in the meantime."
      );
      setStatus("error");
      return;
    }

    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const firstError = data?.errors?.[0]?.message as string | undefined;
        throw new Error(
          firstError || "Something went wrong. Please try again."
        );
      }
      form.reset();
      setStatus("success");
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Something went wrong."
      );
      setStatus("error");
    }
  };

  if (status === "success") {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="surface flex flex-col items-center justify-center p-12 text-center"
      >
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-signal/15 text-signal">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h3 className="mt-6 text-xl font-semibold text-ink-900">
          Request received
        </h3>
        <p className="mt-2 max-w-sm text-sm text-ink/60">
          Thank you. Our team will review your project details and respond
          within one business day.
        </p>
        <button
          onClick={() => setStatus("idle")}
          className="btn-secondary mt-6"
        >
          Submit another request
        </button>
      </motion.div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="surface p-8" noValidate>
      {/* honeypot: hidden from users, catches bots */}
      <div className="hidden" aria-hidden="true">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" required>
          <input name="name" required className={inputClass} placeholder="Your full name" />
        </Field>
        <Field label="Company">
          <input name="company" className={inputClass} placeholder="Organisation" />
        </Field>
        <Field label="Email" required>
          <input
            name="email"
            type="email"
            required
            className={inputClass}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="Phone">
          <input name="phone" type="tel" className={inputClass} placeholder="+249 ..." />
        </Field>
        <Field label="Sector">
          <select name="sector" className={inputClass} defaultValue="">
            <option value="" disabled>
              Select sector
            </option>
            {industriesList.map((i) => (
              <option key={i} value={i} className="bg-panel">
                {i}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project Type">
          <select name="projectType" className={inputClass} defaultValue="">
            <option value="" disabled>
              Select project type
            </option>
            {projectTypes.map((p) => (
              <option key={p} value={p} className="bg-panel">
                {p}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-5">
        <Field label="Message" required>
          <textarea
            name="message"
            required
            rows={5}
            className={`${inputClass} resize-none`}
            placeholder="Tell us about your site, the data you have, and the deliverables you need."
          />
        </Field>
      </div>

      {status === "error" && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {errorMsg}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="btn-primary mt-6 w-full disabled:opacity-60"
      >
        {status === "submitting" ? "Sending..." : "Request Consultation"}
      </button>
      <p className="mt-3 text-center text-xs text-ink/50">
        We typically respond within one business day.
      </p>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink/60">
        {label}
        {required && <span className="text-accent-600"> *</span>}
      </span>
      {children}
    </label>
  );
}
