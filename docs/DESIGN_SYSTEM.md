# Design system — MissionSync

*Graphite + Teal. "Tactical ops center meets Linear/Vercel": utilitarian, high-contrast, calm under pressure, dense.*
The source of truth is code: tokens in [`frontend/src/index.css`](../frontend/src/index.css), mapped to Tailwind in [`frontend/tailwind.config.js`](../frontend/tailwind.config.js). (The early colour exploration lives on a Canva board linked from the README; nothing here depends on it.)

## Principles

1. **Urgency is the only loud colour.** P1–P4 colours mean life-safety priority and are identical in both themes' hue family; the teal accent is used for interaction and focus, never for priority.
2. **Colour is never the only signal.** Every tier pill carries text (`#1 · P1 CRITICAL · 88/100`), every status has an icon or label, provenance is a word (`AI`, `RULES`, `AI scoring…`).
3. **Zero body scroll.** The app owns the viewport; each panel scrolls on its own.
4. **Agents propose, humans commit.** Proposals are visually distinct from dispatched units and always carry explicit Approve / Reject controls.

## Tokens (CSS variables → Tailwind colours)

| Token | Night | Day | Use |
|---|---|---|---|
| `bg` | `#0E1113` | `#ECF0F1` | page |
| `panel` / `panel-hi` | `#151A1D` / `#1C2226` | `#FFFFFF` / `#F3F6F7` | surfaces |
| `line` | `#262E33` | `#CDD6DA` | borders |
| `ink` / `ink-2` | `#EEF2F3` / `#93A1A8` | `#0E1417` / `#3F4C53` | primary / secondary text |
| `accent` | `#2DD4BF` | `#0D6862` | focus, selection, primary buttons |
| `p1` `p2` `p3` `p4` | `#EF4444` `#F59E0B` `#EAB308` `#64748B` | `#B91C1C` `#B45309` `#854D0E` `#475569` | urgency tiers (≥75 / ≥55 / ≥35 / else) |
| `ok` `route` `scene` `ret` | `#10B981` `#60A5FA` `#A78BFA` `#64748B` | deeper equivalents | unit status |

Both themes are swapped by `data-theme` on `<html>`; no component has theme-specific class names. `npm run audit:contrast` checks every text/background pair in both themes against WCAG AA (≥ 4.5:1) and fails the build otherwise (25 dark + 25 light pairs at the time of writing; the lowest is `p1` text on panel in the dark theme at 4.66:1).

## Typography

Inter Variable (UI) and JetBrains Mono Variable (numbers, IDs, telemetry), self-hosted through `@fontsource-variable/*` — no third-party font requests.

**Every text size is ≥ 16 px (1 rem).** Tailwind's `text-xs` and `text-sm` are remapped to 1 rem in `tailwind.config.js`, so there is no smaller step to reach for; the map's sector labels, Leaflet attribution and tab captions follow. Hierarchy is carried by weight (400 / 600 / 800), colour (`ink` vs `ink-2`), uppercase + tracking (+0.08 em) for section labels, and the mono face for data — never by shrinking type. A test (`src/typography.test.ts`) fails if a smaller size is reintroduced in the config or as an arbitrary `text-[Npx]` class.

Numbers use tabular figures (`.tnum`) so columns don't shimmer as values change.

## Spacing, shape, elevation

4 px grid; panels 12 px padding; radius 6 px (8 px for cards); one shadow (`shadow-panel`) and one focus glow (`shadow-glow`). Touch targets are ≥ 44 px on coarse pointers.

## Components

| Component | Notes |
|---|---|
| Tier pill | filled tier colour, `on-tier` text, rank + tier + urgency |
| Source badge | `AI` / `cached` / `RULES` / `AI scoring…` (provisional) |
| Incident card | selectable (`aria-pressed`), expands to a 4-factor auditable breakdown (`<dl>`) and net-control actions |
| Recommendation card | proposal (Approve / Reject) or dispatched (unit, role, ETA) |
| Pipeline stepper | five agents; the active stage glows, `aria-current="step"` |
| System banners | offline, quota spent, degraded, ended, demo engine — each says what is wrong and what happens next |
| Dialog | admin key: focus trap, Escape, returns focus to the opener |
| Toast | `role="status"`, polite, self-dismissing |
| Skeletons | sized to the real components so nothing jumps when data arrives |

## Motion

Framer Motion layout animation re-orders the feed when ranks change; status pulses on P1/P2 markers and the radar empty state. Every animation is disabled under `prefers-reduced-motion`.

## Responsive behaviour

| Width | Layout |
|---|---|
| ≥ 1024 px | A full-width **telemetry bar** under the header (six equal columns: Rank ρ · P1/P2 cover · Units free · Resolved · Loop · Drill time — label and value on one line from 1280 px, stacked below that) and a 96 px **navigation rail** on the left and one section at a time in the main area: *Situation* = map + ranked feed, *Orders* = recommendations + map, *Report* = intake + live audit log, *Fleet* = unit board + map. Keys `1`–`4` switch; the choice is remembered (`?view=orders` deep-links). |
| < 1024 px | Single panel with a bottom tab bar (Map · Incidents · Orders · Report · Units), badges for P1/P2 and pending approvals; the map stays mounted so it never re-initialises. Drill actions sit in a scrollable strip under the header. |

The rail and the tab bar share one mental model and the same badges (`aria-label`s read "Orders, 9 awaiting approval"); only the active section is rendered, so each panel gets the whole viewport height and there is no page scroll.

## Accessibility

Skip link, landmarks, WAI-ARIA tabs with arrow / Home / End keys and a roving tabindex, `aria-live` regions for new incidents and action results, visible focus ring on every control, automated axe-core checks in the test suite (`src/components/a11y.test.tsx`).
