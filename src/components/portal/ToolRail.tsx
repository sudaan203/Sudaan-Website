"use client";

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
 * Before this the map had a flat row of four measure buttons and a hydrology
 * panel pushed down into the sidebar, which is not the shape of what was asked
 * for. The specification is organised by discipline — a contractor and a mining
 * engineer open the same survey and want different tools — and this is that
 * organisation made visible.
 *
 * Two decisions worth defending:
 *
 * 1. **Groups with nothing live are still shown**, listing their tools and what
 *    is missing. Hiding them would make the dashboard look finished and leave
 *    the client to discover the gaps by asking for something. A row that says
 *    "the engine computes this, nothing calls it yet" is a worse-looking
 *    dashboard and a better-informed client.
 * 2. **A tool number is printed beside every name.** It is the only identifier
 *    Malhar's documents and our code share, so "24 is drawn as a grid, not
 *    arrows" is a sentence both sides can act on.
 */

/** What a group can actually do on the map, keyed by the mode it switches on. */
export type RailAction =
  | {
      kind: "measure";
      mode: "spot" | "distance" | "area" | "volume";
      /**
       * Which question the volume mode is asking. Tools 4 and 15 both draw a
       * polygon and both return a volume, but a stockpile additionally reports
       * base area and height, and the server has a separate op for it. Without
       * this the two tools would be one button wearing two names.
       */
      op?: "volume" | "stockpile";
    }
  | { kind: "hydrology"; mode: "inspect" | "watershed" | "flood" }
  | { kind: "sinks" }
  | { kind: "layer"; layer: string };

/**
 * Which tools are wired to something clickable, and to what.
 *
 * Deliberately a lookup rather than a field on the catalogue: the catalogue
 * describes what was *specified*, and this describes what this particular
 * surface can currently drive. A tool can be live on the server and have no
 * entry here, which is exactly the state tools 2 and 19-21 are in.
 */
const ACTIONS: Partial<Record<number, RailAction>> = {
  1: { kind: "measure", mode: "spot" },
  3: { kind: "measure", mode: "distance" },
  4: { kind: "measure", mode: "volume", op: "volume" },
  14: { kind: "layer", layer: "slope_degrees" },
  15: { kind: "measure", mode: "volume", op: "stockpile" },
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
 * Area is item 4 of Important Notes.txt: "polygon, rectangle, polyline, circle
 * -> area and perimeter with avg/max/min elevation".
 *
 * Inspect is the second hydrology prompt's own sentence: "clicking any location
 * on the map should display detailed statistics such as elevation, slope, flow
 * accumulation, watershed area". It is deliberately *not* mapped to tool 24:
 * flow direction is one of the things it reports, but 24 asks for arrows drawn
 * across the terrain, and letting a general point query stand in for that would
 * quietly mark a tool delivered that is not.
 */
const AREA_ACTION: RailAction = { kind: "measure", mode: "area" };
const INSPECT_ACTION: RailAction = { kind: "hydrology", mode: "inspect" };

const STATUS_NOTE: Record<ToolStatus, string> = {
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
  /** The action currently switched on, so the right button reads as pressed. */
  active: RailAction | null;
  onAction: (action: RailAction) => void;
  /** False when the survey has no measurable elevation model behind it. */
  measurable: boolean;
  /** Why measurement is off, shown rather than hidden in a tooltip. */
  unavailable?: string;
  /** False when this survey has no precomputed hydrology grids. */
  hasHydrology: boolean;
  /** Rendered layer keys this survey can actually draw. */
  renderable: readonly string[];
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
  unavailable,
  hasHydrology,
  renderable,
}: Props) {
  const current = TOOL_GROUPS.find((g) => g.key === group) ?? TOOL_GROUPS[0];
  const tools = toolsIn(group);

  /**
   * Whether this button would actually do something if pressed.
   *
   * Not the same question as the tool's status. A tool can be live in the
   * catalogue and still be unreachable on *this* survey, because the elevation
   * model is not published, or the hydrology grids were never computed, or the
   * layer it draws is not in this site's manifest. Answering with the survey in
   * hand is the difference between "not available for this survey" and "not
   * built", which are different things to tell a client.
   */
  function reasonUnusable(tool: Tool): string | null {
    const action = ACTIONS[tool.n];
    // The catalogue's own sentence about what is missing, preferred over the
    // generic status word: "drawn as a grid, not yet as arrows" tells a client
    // something; "partly built" tells them only that we know it is not finished.
    if (!action) {
      // `blocked` for the ones waiting on data or a decision, `gap` for the ones
      // waiting on us. Falling through to the bare status word would tell a
      // client "Blocked" and nothing about by what.
      return tool.gap ?? tool.blocked ?? STATUS_NOTE[tool.status] ?? "Not on the map yet";
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

  return (
    <div className="border-b border-ink/[0.08]">
      {/* Group tabs. Horizontally scrollable rather than wrapping, so the map
          below never jumps by a row height when a longer group is selected. */}
      <div
        className="flex items-stretch gap-1 overflow-x-auto px-3 pt-2"
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
            className={`shrink-0 rounded-t-lg border-b-2 px-3 py-1.5 text-xs font-semibold transition ${
              group === g.key
                ? "border-accent-600 text-accent-700"
                : "border-transparent text-ink/55 hover:text-ink/80"
            }`}
          >
            {g.name}
            <span className="ml-1.5 font-mono text-[10px] font-normal text-ink/35">
              {g.range}
            </span>
          </button>
        ))}
      </div>

      <p className="px-4 pt-1.5 text-[11px] text-ink/50">{current.blurb}</p>

      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        {tools.map((tool) => {
          const action = ACTIONS[tool.n];
          const why = reasonUnusable(tool);
          const disabled = why !== null;
          const on = action ? sameAction(active, action) : false;
          return (
            <button
              key={tool.n}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              /*
               * The number is shown but not spoken. "1 Spot Level" read aloud
               * is a catalogue entry, not a control; the name on its own is what
               * the button does. It also gives anything driving the page a
               * stable handle that does not move when a tool is renumbered.
               */
              aria-label={tool.name}
              title={why ?? tool.spec}
              onClick={() => action && onAction(action)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                on
                  ? "bg-accent-600 text-white"
                  : "border border-ink/15 text-ink/70 hover:border-accent-600 hover:text-accent-700"
              }`}
            >
              <span aria-hidden className="mr-1 font-mono text-[10px] font-normal opacity-55">
                {tool.n}
              </span>
              {tool.name}
            </button>
          );
        })}

        {/*
          Drawing tools are item 4 of Important Notes.txt ("polygon, rectangle,
          polyline, circle -> area and perimeter with avg/max/min elevation") and
          carry no number of their own, so they sit at the end of the universal
          group rather than being smuggled in as one of Malhar's numbered tools.
        */}
        {group === "hydrology" ? (
          <button
            type="button"
            aria-pressed={sameAction(active, INSPECT_ACTION)}
            aria-label="Inspect"
            disabled={!hasHydrology}
            title={
              hasHydrology
                ? "Click anywhere to read elevation, slope, contributing area and where that point drains to"
                : "Hydrology has not been computed for this survey."
            }
            onClick={() => onAction(INSPECT_ACTION)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              sameAction(active, INSPECT_ACTION)
                ? "bg-accent-600 text-white"
                : "border border-ink/15 text-ink/70 hover:border-accent-600 hover:text-accent-700"
            }`}
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
            title={
              measurable
                ? "Draw a polygon: area, perimeter and elevation statistics"
                : (unavailable ?? "Measurements are not available for this survey.")
            }
            onClick={() => onAction(AREA_ACTION)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              sameAction(active, AREA_ACTION)
                ? "bg-accent-600 text-white"
                : "border border-ink/15 text-ink/70 hover:border-accent-600 hover:text-accent-700"
            }`}
          >
            Area
          </button>
        ) : null}
      </div>

      {/*
        What this group cannot do yet, in one line, in the client's words.
        Only for groups where it is most of the group — printing it under
        Universal, where eight of ten do something, would be noise.
      */}
      <GroupGaps group={group} />
    </div>
  );
}

function GroupGaps({ group }: { group: ToolGroupKey }) {
  const tools = toolsIn(group);
  const pending = tools.filter((t) => !ACTIONS[t.n]);
  if (pending.length === 0 || pending.length < tools.length / 2) return null;
  return (
    <p className="px-4 pb-2.5 text-[11px] leading-relaxed text-ink/45">
      {pending.map((t) => `${t.n} ${t.name}`).join(", ")}{" "}
      {pending.length === 1 ? "is" : "are"} specified but not yet on the map.{" "}
      {pending.every((t) => t.status === "engine-only")
        ? "The calculations exist and are tested; they need a way to draw the input."
        : "See docs/tool-catalogue.md for what each one is waiting on."}
    </p>
  );
}
