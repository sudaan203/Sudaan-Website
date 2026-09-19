---
name: ui-guidelines
description: Sudaan's actual UI conventions — design tokens, reusable CSS classes, component patterns for the marketing site and portal, motion/loading-state conventions, and known frontend traps (MapLibre worker files, hydration determinism, role checks). Load before implementing or modifying UI.
---

# UI guidelines

These are conventions verified in `tailwind.config.ts`, `src/app/globals.css`,
and existing components — not generic advice. See `context.md` §3–4 for the
fuller design narrative if something here is ambiguous.

## Design tokens (warm, light theme — never dark)

- Backgrounds: `paper` (#FAF7F2, primary), `mist` (#E8E8E8, alt bands),
  `panel` (#FFFFFF, cards).
- Text: `ink` (#2E2E2E body — use `text-ink`, `text-ink/70`), `ink-900`
  (#111111 headings).
- Accent: `accent` ramp, DEFAULT #E58E3A (500); `accent-600` #D97706 is the
  CTA/button/link colour; `accent-700` is hover.
- Secondary warm tone: `signal` (#C2410C) — checkmarks, "Outcome:" labels,
  gradient ends.
- `abyss`/`navy` are legacy token names remapped to light values — don't
  assume they mean dark just because of the name.
- Reusable classes in `globals.css`: `.surface`, `.surface-hover`,
  `.btn-primary`, `.btn-secondary`, `.heading-xl/lg/md`, `.lead`, `.eyebrow`,
  `.container-px`, `.section-py`, `.grid-overlay`.
- Signature look: hero headline gradient
  `from-accent-500 via-accent-600 to-signal bg-clip-text text-transparent`.

## Component conventions

- **Marketing components** live flat in `src/components/`; **portal
  components** live in `src/components/portal/`. Don't cross-import portal
  components into marketing pages or vice versa without a reason.
- **Portal tool panels** follow one shape: a `<Thing>Panel.tsx` component
  reading from a matching `<thing>-client.ts` module in `src/lib/portal/`. A
  new dashboard tool's UI should follow this shape, not invent a new one.
- **`SiteChrome.tsx`** receives the navbar/footer as props so they stay
  server components, and suppresses marketing chrome on `/portal` routes.
  Portal pages go through it; don't add chrome directly to a portal page.
- **Procedural visuals** (`src/components/visuals/`) must be deterministic —
  rounded values only. Non-determinism here causes hydration mismatches on
  first paint; this has been a real bug, not a hypothetical.

## Motion and loading state

- `MotionProvider` makes Framer Motion respect `prefers-reduced-motion`
  globally — the CSS `@media` block in `globals.css` only reaches CSS
  transitions, not JS-driven transforms, so don't rely on CSS alone for a
  new animated component.
- Per-route skeletons: `loading.tsx` in each portal route **segment**. A
  nested segment without its own falls back to an ancestor's and redraws the
  whole shell — give each segment its own if it needs one.
- `NavProgress` covers navigations with no skeleton (140ms delay before
  showing, so fast navigations don't flash).
- Control-level pending state: `useLinkStatus`/`useFormStatus` via
  `src/components/Pending.tsx`, not a hand-rolled `useState` — reading from
  the platform means it can't drift from actual navigation state.

## Known traps

- **MapLibre's worker.** Next doesn't emit the `new URL(..., import.meta.url)`
  MapLibre uses to find its worker. Both `maplibre-gl-worker.mjs` *and*
  `maplibre-gl-shared.mjs` must be in `public/vendor/` (copied by
  `postinstall`) and set via `setWorkerUrl`. Missing either one fails
  **silently**: raster layers keep working (main-thread image decode), but
  every GeoJSON/vector source sits at `isSourceLoaded: false` with zero
  features and no console error. If a vector layer vanishes, check the
  worker files before anything else.
- **GeoJSON sources use `setData`, not MapLibre's worker fetch** — the
  worker fetch doesn't carry the session cookie and the route answers 401.
- **Role checks**: use `isOwnerRole()` from `types.ts`. A bare
  `role === "admin"` is the stale Phase 1 name; Google owners are `"owner"`.
- **Basemap is off by default, deliberately** — a tile request to a third
  party reveals a client site's location. Don't "fix" this by turning it on.
- **No download affordance for portal deliverables** — view-only is a
  client-facing decision, not a missing feature.

## Verification

Any UI change needs an actual browser check (see the `qa-browser` agent) —
source review is not verification here. Check at least one narrow viewport
for anything not a trivial copy edit.
