/**
 * Telling someone they have been invited.
 *
 * Before this, `inviteUserAction` wrote a row and said "they can now sign in
 * with that Google account" to the owner — and nobody told the client. The
 * invitation was real and completely silent, so it travelled by WhatsApp or not
 * at all. A row in a table that the person it concerns never hears about is not
 * an invitation.
 *
 * ## Sending must never fail the invite
 *
 * The access grant is the thing that matters and it is already committed by the
 * time this runs. If Resend is down, or `RESEND_API_KEY` is unset on this
 * deployment, the person still has access — they just have not been told yet,
 * and an owner can tell them. So every failure here is reported back as "not
 * sent" and never thrown: an owner who sees "invited, but the email did not go
 * out" can act, while an owner who sees a red error assumes nothing happened and
 * invites again.
 */

/** What the caller should tell the owner, on top of "invited". */
export type InviteMailResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "failed" };

/**
 * The sign-in URL to put in the email.
 *
 * `AUTH_URL` is the same base Google's redirect URI is registered against, so if
 * it is wrong sign-in is already broken and a wrong link here is the smaller
 * problem. Falling back to the production host rather than localhost: an email
 * sent from a machine with no AUTH_URL should still point somewhere real.
 */
function portalUrl(): string {
  const base = process.env.AUTH_URL?.replace(/\/+$/, "") || "https://sudaangeo.in";
  return `${base}/portal/login`;
}

function body(clientName: string, invitedBy: string, url: string) {
  const text = `You have been given access to the Sudaan Geo-Analytics client portal for ${clientName}.

Sign in here with this Google account:
${url}

Your survey deliverables — orthomosaics, surface and terrain models, contours,
reports and drawings — are all in one place, and you will only ever see the
sites processed for ${clientName}.

If you were not expecting this, reply to ${invitedBy} and we will remove the access.`;

  // Deliberately plain. A client opening this on a phone in the field wants the
  // link, not a layout, and a text part is what keeps it out of spam folders.
  const html = text
    .split("\n\n")
    .map((p) =>
      p.includes(url)
        ? `<p>${p.replace(url, `<a href="${url}">${url}</a>`).replace(/\n/g, "<br>")}</p>`
        : `<p>${p.replace(/\n/g, " ")}</p>`,
    )
    .join("\n");

  return { text, html };
}

/**
 * @param to the invited address
 * @param clientName the organisation they have been given access to
 * @param invitedBy the owner's email, so a surprised recipient has a human to reply to
 */
export async function sendInviteEmail(
  to: string,
  clientName: string,
  invitedBy: string,
): Promise<InviteMailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: "not_configured" };

  const url = portalUrl();
  const { text, html } = body(clientName, invitedBy, url);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Sudaan Geo-Analytics <noreply@sudaangeo.in>",
        to,
        subject: `Your Sudaan Geo-Analytics portal access for ${clientName}`,
        text,
        html,
        // So a confused recipient reaches the person who invited them rather
        // than an unmonitored noreply box.
        reply_to: invitedBy,
      }),
    });

    if (!response.ok) {
      console.error(
        "[portal] invite email rejected",
        response.status,
        (await response.text()).slice(0, 300),
      );
      return { sent: false, reason: "failed" };
    }
    return { sent: true };
  } catch (err) {
    console.error("[portal] invite email failed to send", err);
    return { sent: false, reason: "failed" };
  }
}
