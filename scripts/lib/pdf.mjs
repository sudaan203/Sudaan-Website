/**
 * A small PDF writer: multi page, base-14 fonts, vector paths.
 *
 * Written by hand rather than pulling in a PDF library because the portal has no
 * runtime PDF dependency and these files are generated offline. It supports
 * exactly what a survey sheet needs: text, lines, filled rectangles and stroked
 * polylines.
 *
 * scripts/generate-reports.mjs has an older single page version of this for the
 * marketing site's sample downloads. This one exists because those samples were
 * being served to a real client as their actual deliverables, complete with the
 * wrong state and the wrong coordinate system.
 */

const esc = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Page sizes in PDF points, 72 to the inch. */
export const PAGE = {
  a4: [595.28, 841.89],
  a4l: [841.89, 595.28],
  a3l: [1190.55, 841.89],
};

export class Pdf {
  constructor({ title = "", author = "Sudaan Geo-Analytics" } = {}) {
    this.pages = [];
    this.title = title;
    this.author = author;
  }

  /** Start a page and return a drawing context bound to it. */
  page(size = PAGE.a4) {
    const ops = [];
    const [w, h] = size;
    const ctx = {
      width: w,
      height: h,

      /** Solid rectangle. */
      rect(x, y, rw, rh, [r, g, b]) {
        ops.push(`${r} ${g} ${b} rg`, `${f(x)} ${f(y)} ${f(rw)} ${f(rh)} re f`);
        return ctx;
      },

      /** Rectangle outline. */
      frame(x, y, rw, rh, [r, g, b], lineWidth = 0.75) {
        ops.push(
          `${r} ${g} ${b} RG`,
          `${f(lineWidth)} w`,
          `${f(x)} ${f(y)} ${f(rw)} ${f(rh)} re S`,
        );
        return ctx;
      },

      line(x1, y1, x2, y2, [r, g, b], lineWidth = 0.75) {
        ops.push(
          `${r} ${g} ${b} RG`,
          `${f(lineWidth)} w`,
          `${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`,
        );
        return ctx;
      },

      /** One stroked polyline from an array of [x, y] page points. */
      polyline(points, [r, g, b], lineWidth = 0.4) {
        if (points.length < 2) return ctx;
        ops.push(`${r} ${g} ${b} RG`, `${f(lineWidth)} w`);
        ops.push(`${f(points[0][0])} ${f(points[0][1])} m`);
        for (let i = 1; i < points.length; i += 1) {
          ops.push(`${f(points[i][0])} ${f(points[i][1])} l`);
        }
        ops.push("S");
        return ctx;
      },

      /** Clip everything drawn inside the callback to a rectangle. */
      clipped(x, y, cw, ch, draw) {
        ops.push("q", `${f(x)} ${f(y)} ${f(cw)} ${f(ch)} re W n`);
        draw(ctx);
        ops.push("Q");
        return ctx;
      },

      text(x, y, string, { size = 10, bold = false, color = [0.18, 0.18, 0.18] } = {}) {
        ops.push(
          "BT",
          `/${bold ? "F2" : "F1"} ${f(size)} Tf`,
          `${color[0]} ${color[1]} ${color[2]} rg`,
          `${f(x)} ${f(y)} Td`,
          `(${esc(string)}) Tj`,
          "ET",
        );
        return ctx;
      },

      /** Right aligned text, using the base-14 width tables. */
      textRight(xRight, y, string, opts = {}) {
        const w2 = measure(String(string), opts.size ?? 10, opts.bold ?? false);
        return ctx.text(xRight - w2, y, string, opts);
      },

      /** A label and value on one row, value right aligned. Returns the next y. */
      row(x, y, xRight, label, value, { size = 9.5, gap = 14 } = {}) {
        ctx.text(x, y, label, { size, color: [0.42, 0.42, 0.42] });
        ctx.textRight(xRight, y, value, { size, bold: true });
        return y - gap;
      },
    };

    this.pages.push({ size, ops });
    return ctx;
  }

  toBuffer() {
    const objects = [];
    const add = (body) => {
      objects.push(body);
      return objects.length; // 1-based object number
    };

    // Reserve 1 for the catalog and 2 for the page tree.
    objects.push(null, null);
    const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

    const pageIds = [];
    for (const p of this.pages) {
      const stream = p.ops.join("\n");
      const contentId = add(
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
      );
      const pageId = add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(p.size[0])} ${f(p.size[1])}] ` +
          `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
          `/Contents ${contentId} 0 R >>`,
      );
      pageIds.push(pageId);
    }

    const infoId = add(
      `<< /Title (${esc(this.title)}) /Author (${esc(this.author)}) /Producer (Sudaan Geo-Analytics portal pipeline) >>`,
    );

    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[1] =
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    let out = "%PDF-1.4\n";
    const offsets = [];
    for (let i = 0; i < objects.length; i += 1) {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefAt = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      out += `${String(off).padStart(10, "0")} 00000 n \n`;
    }
    out +=
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`;

    return Buffer.from(out, "latin1");
  }
}

/** PDF wants a plain decimal, and 6 places is well past what a page needs. */
function f(n) {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
}

/**
 * Helvetica advance widths, in 1/1000 em, for the printable ASCII range. Needed
 * only so right aligned text and the title block line up; without it every value
 * column drifts.
 */
const W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

export function measure(s, size, bold) {
  let total = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    total += code >= 32 && code <= 126 ? W[code - 32] : 556;
  }
  // Bold Helvetica is wider; 1.055 is close enough for column alignment.
  return (total / 1000) * size * (bold ? 1.055 : 1);
}
