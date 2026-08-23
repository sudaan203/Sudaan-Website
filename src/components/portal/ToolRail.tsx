"use client";

import { useEffect, useRef, useState } from "react";
import {
  TOOL_GROUPS,
  toolsIn,
  type Tool,
  type ToolGroupKey,
  type ToolStatus,
} from "@/lib/portal/tool-catalogue";

/**
 * The tool rail: Malhar's five documents, as five groups, above the map.
 *
 * ## What changed, and why
 *
 * The first version showed every tool in a group at once, including the ones
 * that do nothing, each greyed out, followed by a paragraph naming them all
 * again. It was honest and it was 230px of a 1000px screen spent telling a
 * client what they *cannot* do, above a map that is the entire product. Eight
 * disabled buttons is not transparency, it is noise wearing transparency's
 * clothes.
 *
 * So: the tools that work are shown, and the ones that do not collapse into a
 * single quiet count that opens a list with a reason against each. Nothing is
 * hidden — it is one click away and still says exactly what it is waiting on.
 * That is the difference between disclosing and dumping.
 *
 * The group tabs stay, because the specification is organised by discipline and
 * a mining client should not read past the road tools to reach stockpile volume.
 * The tool number stays beside each name, because it is the only identifier
 * Malhar's documents and this code share.
 */

export type RailAction =
  | {
      kind: "measure";
      mode:
        | "spot"
        | "distance"
        | "area"
        | "volume"
        | "alignment"
        | "grid"
        | "compare";
      /**
       * Which question the mode is asking, where a mode serves several tools.
       *
       * Tools 4 and 15 both draw a polygon and both return a volume, but a
       * stockpile additionally reports base area and height and has its own op
       * on the server. Tools 19, 20, 21 and 16 all draw the same centreline and
       * ask four different things of it. Without this, each group would be one
       * button wearing several names.
       */
      op?:
        | "volume"
        | "stockpile"
        | "difference"
        | "tolerance"
        | "chainage"
        | "corridor"
        | "cross-sections"
        | "bench";
    }
  | { kind: "hydrology"; mode: "inspect" | "watershed" | "flood" }
  | { kind: "sinks" }
  | { kind: "layer"; layer: string };

/**
 * Which tools are wired to something clickable, and to what.
 *
 * Deliberately a lookup rather than a field on the catalogue: the catalogue
 * describes what was *specified*, and this describes what this particular
 * surface can currently drive.
 */
const ACTIONS: Partial<Record<number, RailAction>> = {
  1: { kind: "measure", mode: "spot" },
  2: { kind: "measure", mode: "grid" },
  3: { kind: "measure", mode: "distance" },
  4: { kind: "measure", mode: "volume", op: "volume" },
  5: { kind: "measure", mode: "compare", op: "difference" },
  13: { kind: "measure", mode: "compare", op: "tolerance" },
  14: { kind: "layer", layer: "slope_degrees" },
  15: { kind: "measure", mode: "volume", op: "stockpile" },
  16: { kind: "measure", mode: "alignment", op: "bench" },
  19: { kind: "measure", mode: "alignment", op: "chainage" },
  20: { kind: "measure", mode: "alignment", op: "corridor" },
  21: { kind: "measure", mode: "alignment", op: "cross-sections" },
  25: { kind: "layer", layer: "flow_accumulation" },
  26: { kind: "hydrology", mode: "watershed" },
  27: { kind: "sinks" },
  28: { kind: "hydrology", mode: "flood" },
};

/**
 * Two tools Malhar specified in prose rather than as numbered entries, so they
 * sit at the end of their group instead of being smuggled in under a number
 * that means something else.
 *
 * Area is item 4 of Important Notes.txt. Inspect is the hydrology prompt's own
 * sentence, and is deliberately *not* mapped to tool 24: flow direction is one
 * of the things it reports, but 24 asks for arrows drawn across the terrain, and
 * letting a general point query stand in for that would mark a tool delivered
 * that is not.
 */
const AREA_ACTION: RailAction = { kind: "measure", mode: "area" };
const INSPECT_ACTION: RailAction = { kind: "hydrology", mode: "inspect" };

const STATUS_LABEL: Record<ToolStatus, string> = {
  live: "",
  partial: "Partly built",
  "engine-only": "Computed on the server, not yet on the map",
  "not-built": "Not built",
  unspecified: "Never specified",
  blocked: "Blocked",
};

export function toolAction(n: number): RailAction | undefined {
  return ACTIONS[n];
}

type Props = {
  group: ToolGroupKey;
  setGroup: (g: ToolGroupKey) => void;
  active: RailAction | null;
  onAction: (action: RailAction) => void;
  measurable: boolean;
  /**
   * True while the server is still being asked what this survey can measure.
   *
   * It matters because "we do not know yet" and "it cannot be done" produce
   * different interfaces. Collapsing a tool into the not-yet list is right once
   * the answer is in, and wrong before: on first paint every measure tool would
   * vanish into a count and then pop back a second later, which is a flash of
   * the wrong interface and reads as the page changing its mind.
   */
  probing?: boolean;
  unavailable?: string;
  hasHydrology: boolean;
  renderable: readonly string[];
  /** Rendered to the right of the tabs: the surface switch and relief toggle. */
  children?: React.ReactNode;
  /** One line under the tools saying what to do next, or what is wrong. */
  hint?: React.ReactNode;
};

function sameAction(a: RailAction | null, b: RailAction): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "measure" && b.kind === "measure") {
    return a.mode === b.mode && (a.op ?? "volume") === (b.op ?? "volume");
  }
  if (a.kind === "hydrology" && b.kind === "hydrology") return a.mode === b.mode;
  if (a.kind === "layer" && b.kind === "layer") return a.layer === b.layer;
  return a.kind === "sinks" && b.kind === "sinks";
}

export function ToolRail({
  group,
  setGroup,
  active,
  onAction,
  measurable,
  probing = false,
  unavailable,
  hasHydrology,
  renderable,
  children,
  hint,
}: Props) {
  const current = TOOL_GROUPS.find((g) => g.key === group) ?? TOOL_GROUPS[0];
  const tools = toolsIn(group);
  const [showPending, setShowPending] = useState(false);
  const pendingRef = useRef<HTMLDivElement>(null);

  // The list closes on the next click anywhere else, which is what a popover
  // that is not a dialog should do.
  useEffect(() => {
    if (!showPending) return;
    const close = (event: MouseEvent) => {
      if (!pendingRef.current?.contains(event.target as Node)) setShowPending(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showPending]);

  useEffect(() => setShowPending(false), [group]);

  /**
   * Whether this button would actually do something if pressed.
   *
   * Not the same question as the tool's status. A tool can be live in the
   * catalogue and unreachable on *this* survey, because the elevation model is
   * not published, or the hydrology was never computed, or the layer it draws is
   * not in this site's manifest. Answering with the survey in hand is the
   * difference between "not available for this survey" and "not built".
   */
  function reasonUnusable(tool: Tool): string | null {
    const action = ACTIONS[tool.n];
    if (!action) {
      // The catalogue's own sentence about what is missing, preferred over the
      // generic status word: "drawn as a grid, not yet as arrows" tells a client
      // something; "partly built" tells them only that we know it is unfinished.
      return tool.gap ?? tool.blocked ?? STATUS_LABEL[tool.status] ?? "Not on the map yet";
    }
    if (action.kind === "measure" && !measurable) {
      return unavailable ?? "Measurements are not available for this survey.";
    }
    if ((action.kind === "hydrology" || action.kind === "sinks") && !hasHydrology) {
      return "Hydrology has not been computed for this survey.";
    }
    if (action.kind === "layer" && !renderable.includes(action.layer)) {
      return "This layer is not available for this survey.";
    }
    return null;
  }

  /*
   * A tool waiting on the terrain probe stays on the bar, disabled, rather than
   * collapsing into the count. It will almost always come back usable, and a
   * control that appears a second after the page does is worse than one that is
   * briefly greyed.
   */
  const waitingOnProbe = (tool: Tool) => {
    const action = ACTIONS[tool.n];
    return probing && action?.kind === "measure";
  };

  const entries = tools.map((tool) => ({
    tool,
    action: ACTIONS[tool.n],
    reason: reasonUnusable(tool),
  }));
  const usable = entries.filter((e) => e.action && (e.reason === null || waitingOnProbe(e.tool)));
  const pending = entries.filter((e) => !e.action || (e.reason !== null && !waitingOnProbe(e.tool)));

  const pill = (on: boolean) =>
    `rounded-full px-3 py-1.5 text-[12px] font-medium transition-all duration-200 ${
      on
        ? "bg-ink-900 text-white shadow-sm"
        : "bg-ink/[0.045] text-ink/75 hover:bg-ink/[0.08] hover:text-ink-900"
    }`;

  return (
    <div className="border-b border-ink/[0.07]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3">
        <nav
          className="flex items-center gap-0.5 overflow-x-auto rounded-full bg-ink/[0.045] p-0.5"
          role="tablist"
          aria-label="Tool groups"
        >
          {TOOL_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={group === g.key}
              onClick={() => setGroup(g.key)}
              className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition-all duration-200 ${
                group === g.key
                  ? "bg-panel text-ink-900 shadow-sm"
                  : "text-ink/55 hover:text-ink-900"
              }`}
            >
              {g.name}
            </button>
          ))}
        </nav>

        {children ? <div className="ml-auto flex items-center gap-3">{children}</div> : null}
      </div>

      {/*
        A toolbar, named. It is the row of controls for the chosen group, and
        saying so gives a screen reader the right landmark and anything driving
        the page a handle that does not move when the layout does.
      */}
      <div
        role="toolbar"
        aria-label="Tools"
        className="flex flex-wrap items-center gap-1.5 px-4 py-2.5"
      >
        {usable.map(({ tool, action, reason }) => {
          const on = sameAction(active, action!);
          return (
            <button
              key={tool.n}
              type="button"
              aria-pressed={on}
              disabled={reason !== null}
              // The number is shown but not spoken: "1 Spot Level" read aloud is
              // a catalogue entry, not a control.
              aria-label={tool.name}
              title={reason ?? tool.spec}
              onClick={() => action && onAction(action)}
              className={`${pill(on)} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <span aria-hidden className="mr-1.5 font-mono text-[10px] opacity-45">
                {tool.n}
              </span>
              {tool.name}
            </button>
          );
        })}

        {group === "hydrology" ? (
          <button
            type="button"
            aria-pressed={sameAction(active, INSPECT_ACTION)}
            aria-label="Inspect"
            disabled={!hasHydrology}
            title="Click anywhere to read elevation, slope, contributing area and where that point drains to"
            onClick={() => onAction(INSPECT_ACTION)}
            className={`${pill(sameAction(active, INSPECT_ACTION))} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Inspect
          </button>
        ) : null}

        {group === "universal" ? (
          <button
            type="button"
            aria-pressed={sameAction(active, AREA_ACTION)}
            aria-label="Area"
            disabled={!measurable}
            title="Draw a polygon: area, perimeter and elevation statistics"
            onClick={() => onAction(AREA_ACTION)}
            className={`${pill(sameAction(active, AREA_ACTION))} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Area
          </button>
        ) : null}

        {/*
          Everything not yet reachable, behind one count. Nothing is hidden: the
          list opens with a reason against each tool, which is the same
          information the eight greyed-out buttons carried and a hundredth of the
          space.
        */}
        {pending.length > 0 ? (
          <div className="relative" ref={pendingRef}>
            <button
              type="button"
              aria-expanded={showPending}
              onClick={() => setShowPending((v) => !v)}
              className="rounded-full border border-dashed border-ink/20 px-3 py-1.5 text-[12px] font-medium text-ink/45 transition-colors hover:border-ink/35 hover:text-ink/70"
            >
              {pending.length} not yet
            </button>

            {showPending ? (
              <div
                role="group"
                aria-label="Not yet available"
                className="absolute left-0 top-full z-30 mt-2 w-[22rem] rounded-xl border border-ink/10 bg-panel/95 p-3 shadow-card backdrop-blur"
              >
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink/45">
                  Specified, not yet on the map
                </p>
                <ul className="space-y-2">
                  {pending.map(({ tool, reason }) => (
                    <li key={tool.n}>
                      <p className="text-[12px] font-medium text-ink-900">
                        <span className="mr-1.5 font-mono text-[10px] text-ink/35">{tool.n}</span>
                        {tool.name}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-snug text-ink/55">{reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {hint ? <div className="ml-1 min-w-0 text-[11px] text-ink/45">{hint}</div> : null}
      </div>

      <p className="sr-only">{current.blurb}</p>
    </div>
  );
}
