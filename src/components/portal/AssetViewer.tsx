"use client";

import { useState } from "react";

/**
 * In browser viewer for a single asset.
 *
 * PDFs go in an iframe with the native toolbar suppressed where the browser
 * supports it, images render inline with a fit or full size toggle. Dragging and
 * the context menu are blocked, which is a deterrent only: a viewer with dev
 * tools can still reach the bytes, and clients should be told that rather than
 * sold a guarantee we cannot make.
 */
export default function AssetViewer({
  src,
  title,
  mimeType,
}: {
  src: string;
  title: string;
  mimeType: string;
}) {
  const [zoomed, setZoomed] = useState(false);

  if (mimeType === "application/pdf") {
    return (
      <div className="surface overflow-hidden">
        <iframe
          src={`${src}#toolbar=0&navpanes=0&statusbar=0&view=FitH`}
          title={title}
          className="h-[75vh] min-h-[480px] w-full bg-mist"
        />
      </div>
    );
  }

  if (mimeType.startsWith("image/")) {
    return (
      <figure className="surface overflow-hidden">
        <div className={zoomed ? "max-h-[75vh] overflow-auto bg-mist" : "bg-mist"}>
          {/* Plain img on purpose: next/image would cache private data on a shared CDN. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={title}
            draggable={false}
            onContextMenu={(event) => event.preventDefault()}
            onClick={() => setZoomed((v) => !v)}
            className={[
              "select-none",
              zoomed
                ? "max-w-none cursor-zoom-out"
                : "max-h-[75vh] w-full cursor-zoom-in object-contain",
            ].join(" ")}
          />
        </div>
        <figcaption className="border-t border-ink/[0.08] px-4 py-2.5 text-xs text-ink/55">
          Click the image to {zoomed ? "fit it to the screen" : "view it at full size"}.
        </figcaption>
      </figure>
    );
  }

  return (
    <div className="surface p-6">
      <p className="text-sm text-ink/70">
        This file type cannot be previewed in the browser yet. Contact your project
        manager and we will publish a viewable version.
      </p>
    </div>
  );
}
