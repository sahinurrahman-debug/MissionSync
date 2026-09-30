# Sketch — MissionSync

The planned screens and the report-to-screen flow live in `sketch.excalidraw`, a real Excalidraw scene (open it at [excalidraw.com](https://excalidraw.com) via **File → Open**, or drag the file onto the canvas).

`sketch.png` is the static export backup required by Level 1 and is embedded in the root README.

> **Status:** this sketch is the Level 1 *planning* artifact and is kept as submitted. The shipped dashboard follows the same structure (map, ranked feed, recommendations, units, audit log, single intake box) with a redesigned visual language — see the screenshots in the README and the design-system section there. The responder phone view and the after-action view were not built as separate screens: the dashboard is responsive down to a phone, and the after-action record is the CSV export.

## What the sketch shows

1. **Net control main board** — header metrics strip, live incident map, ranked feed with tier chips and rationales, command recommendations, units panel, audit event log, and the single report-intake box.
2. **Responder view (phone browser)** — top-5 ranking, personal assignment card with ETA and role, one-line field report box.
3. **After-action view** (dashed = auth-gated, real at Samurai) — drill timeline, merged-report provenance, CSV export.
4. **Report → screen flow** — the 8-step path from typed report to re-rendered screen on every device, with the p95 < 3 s target from REQUIREMENTS.md.

## The live board

- **Live board URL:** <https://excalidraw.com/#room=dc45f75888800794e0e6,kvfdLtfMVJnRXNi0TIiYJw>

  Excalidraw's encrypted collaboration session — it opens in the browser with no account, no login and no access request for viewers.

- **Static backup:** [`sketch.png`](./sketch.png) — 3880 × 2540, generated from the scene file

Both are linked from the root README.

### Republishing after editing the scene

1. Open excalidraw.com and load `docs/sketch.excalidraw` (or open the live board above).
2. Confirm it looks right, then **File → Save to live collaboration session**. Copy the shared URL.
3. Paste the new URL into the README's sketch section and into the line above.
4. Refresh the static backup — either **Menu → Export image → PNG** (2× scale) → overwrite `docs/sketch.png`, or just rerun the generator (below).

## Regenerating `sketch.png`

```bash
python scripts/render_sketch.py          # 2x export → docs/sketch.png
python scripts/render_sketch.py --scale 3
```

`scripts/render_sketch.py` draws the scene's own rectangles, ellipses, arrows and text with Pillow, so the backup is reproducible from `sketch.excalidraw` alone — no browser and no manual export step required. Excalidraw's **Export image** produces the hand-drawn stroke rendering; the generator produces a clean flat rendering of the same layout. Either file satisfies the static-backup requirement — step 4 above simply overwrites this one in place.

> Why the scene file matters: the room is persisted server-side in encrypted form (the decryption key lives in the URL fragment, which is why no login is needed), so the link keeps working. But it is still the one artifact that lives on someone else's servers rather than in this repo, and a link that 404s — or demands an access request — is an explicit failure mode in the rubric. Keeping `sketch.excalidraw` in the repo means the board can be re-opened, re-shared and re-exported at any time.
