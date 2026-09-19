"use client";

import type { CrownProperties } from "@/lib/portal/forest-client";

/**
 * The tree popup — `docs/forest-tools-plan.md` §8: every attribute a clicked
 * tree carries, each labelled measured or estimated, with the confidence
 * score broken down component by component so a client can see *why* a tree
 * scored low, not only that it did.
 *
 * ## Why this is a docked panel, not a floating map popup
 *
 * Nothing else in this portal opens a `maplibre-gl` `Popup` anchored to a
 * clicked point — every other click-driven readout (hydrology's "Inspected",
 * a watershed, a flood) renders into the fixed inspector panel on the right,
 * which is already exactly where a client's eye goes after every other click
 * on this map. Building a second, floating-overlay mechanism for this one
 * feature would be a new interaction pattern for a portal that has
 * deliberately never needed one, so this follows the established shape
 * instead: a panel, mounted the same way `HydrologyPanel`'s results are.
 *
 * ## Where the data comes from
 *
 * `trees.bin` carries only the five numbers a filter needs quickly. This
 * panel needs everything else — perimeter, both extreme diameters, the DBH
 * attempt, and the confidence breakdown — which only `crowns.geojson`
 * carries. `MapViewer.tsx` joins a clicked point's id against a
 * `Map<string, CrownProperties>` built once when crowns are fetched, and
 * hands the joined record straight through as this component's only prop.
 */

const COMPONENT_LABELS: Record<string, string> = {
  flatness: "Flatness",
  rectangularity: "Rectangularity",
  apexProminence: "Apex prominence",
  radialDecay: "Radial decay",
  returnPorosity: "Return porosity (point cloud)",
  greenness: "Greenness (orthomosaic)",
  modelScore: "Detector's own score",
};

export function TreePopup({ tree, onClose }: { tree: CrownProperties; onClose: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
          Tree {tree.tree_id.slice(0, 8)}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] font-semibold text-accent-600 hover:text-accent-700"
        >
          Close
        </button>
      </div>

      <dl className="space-y-1.5 text-sm">
        <Row label="Height" value={`${tree.height_m.toFixed(2)} m`} />
        <Row label="Height class" value={tree.height_class} />
        <Row label="Ground elevation" value={`${tree.ground_elevation_m.toFixed(2)} m`} />
        <Row label="Tree-top elevation" value={`${tree.tree_top_elevation_m.toFixed(2)} m`} />
      </dl>

      <dl className="space-y-1.5 border-t border-ink/[0.08] pt-2.5 text-sm">
        <Row label="Crown area" value={`${tree.crown_area_m2.toFixed(1)} m²`} />
        <Row label="Crown perimeter" value={`${tree.crown_perimeter_m.toFixed(1)} m`} />
        <Row label="Crown diameter, max" value={`${tree.crown_diameter_max_m.toFixed(2)} m`} />
        <Row label="Crown diameter, min" value={`${tree.crown_diameter_min_m.toFixed(2)} m`} />
        <Row label="Crown diameter, avg" value={`${tree.crown_diameter_avg_m.toFixed(2)} m`} />
      </dl>
      <p className="text-[10px] leading-snug text-ink/45">
        Max/min are rotating-caliper widths over the crown&apos;s convex hull; avg is the
        equivalent-circle diameter, 2√(area/π) — three different, stated definitions of one
        word, per the plan.
      </p>

      {/* ---- DBH/girth, explicitly measured vs. estimated ------------------ */}
      <dl className="space-y-1.5 border-t border-ink/[0.08] pt-2.5 text-sm">
        <Row
          label="Estimated DBH"
          value={
            typeof tree.dbh_cm === "number"
              ? `${tree.dbh_cm.toFixed(1)} cm (estimated)`
              : "Not reliably detectable"
          }
        />
        <Row
          label="Estimated girth"
          value={tree.girth_m !== null ? `${tree.girth_m.toFixed(2)} m (estimated)` : "Not reliably detectable"}
        />
      </dl>
      {tree.dbh_reason ? (
        <p className="text-[10px] leading-snug text-ink/45">
          {tree.dbh_estimated
            ? "Estimated from the point cloud's stem-band returns, never measured on the ground."
            : `Not attempted: ${tree.dbh_reason}.`}
        </p>
      ) : null}

      {/* ---- confidence, broken down ---------------------------------------- */}
      <div className="space-y-1.5 border-t border-ink/[0.08] pt-2.5">
        <Row label="Confidence" value={tree.confidence.toFixed(3)} strong />
        <p className="text-[10px] leading-snug text-ink/45">{tree.confidence_note}</p>
        <table className="w-full text-[10.5px]">
          <thead>
            <tr className="text-left text-ink/45">
              <th className="font-medium">Discriminator</th>
              <th className="font-medium">Goodness</th>
              <th className="font-medium">Weight</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(tree.confidence_components).map(([key, c]) => (
              <tr key={key} className="border-t border-ink/[0.06]">
                <td className="py-0.5 pr-1 text-ink/70">{COMPONENT_LABELS[key] ?? key}</td>
                <td className="py-0.5 pr-1 font-mono text-ink-900">
                  {c.available ? c.goodness?.toFixed(2) : "—"}
                </td>
                <td className="py-0.5 font-mono text-ink/60">
                  {c.available ? (c.weight ?? 1).toFixed(1) : "not available"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] leading-snug text-ink/45">
          A component marked "not available" was not scored for or against this tree — a
          missing sensor (no point cloud, no orthomosaic) rather than a bad reading — and the
          overall score above is the weighted average of only the components that were.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink/60">{label}</dt>
      <dd className={`font-mono text-[13px] ${strong ? "font-semibold" : ""} text-ink-900`}>
        {value}
      </dd>
    </div>
  );
}
