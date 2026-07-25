/**
 * Sets the expectation that the portal is a viewer, not a download centre.
 * Worded honestly: we do not offer downloads, and we do not pretend the browser
 * makes copying impossible.
 */
export default function ViewOnlyNote() {
  return (
    <p className="rounded-xl border border-ink/10 bg-mist/40 px-4 py-3 text-xs leading-relaxed text-ink/60">
      <span className="font-semibold text-ink/75">View only access.</span> Deliverables
      open in your browser and are not available for download. If you need a file
      released for offline use, contact your Sudaan Geo-Analytics project manager.
    </p>
  );
}
