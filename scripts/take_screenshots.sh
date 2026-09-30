#!/usr/bin/env bash
# Regenerate the README screenshots with headless Edge/Chrome.
#
#   1. Start the app first (backend + `npm run dev`, or just `npm run dev` for the demo engine).
#   2. ./scripts/take_screenshots.sh            # uses http://127.0.0.1:5173
#      URL=http://127.0.0.1:5173/?engine=local ./scripts/take_screenshots.sh
#
# For the best README images run the FULL STACK with a working GROQ_API_KEY so the
# header shows "AI · <model>" and there is no degraded-mode banner.
set -euo pipefail
URL=${URL:-http://127.0.0.1:5173/}
OUT=${OUT:-$(dirname "$0")/../screenshots}
WAIT_MS=${WAIT_MS:-30000}     # virtual time: lets a few ticks and the first waves land

for candidate in \
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "$(command -v google-chrome 2>/dev/null || true)" \
  "$(command -v chromium 2>/dev/null || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && BROWSER="$candidate" && break
done
[ -n "${BROWSER:-}" ] || { echo "No Edge/Chrome found"; exit 1; }

mkdir -p "$OUT"
OUT_ABS=$(cd "$OUT" && pwd)
command -v cygpath >/dev/null 2>&1 && OUT_ABS=$(cygpath -w "$OUT_ABS")   # Windows browsers need a native path

shot() {  # name width height querystring
  "$BROWSER" --headless=new --disable-gpu --hide-scrollbars \
    --window-size="$2,$3" --virtual-time-budget="$WAIT_MS" \
    --screenshot="$OUT_ABS/$1.png" "$URL$4" 2>&1 | grep -E "bytes written" || echo "FAILED: $1"
}
sep=$([[ "$URL" == *\?* ]] && echo "&" || echo "?")
shot desktop        1440 900 "${sep}theme=dark"
shot desktop-light  1440 900 "${sep}theme=light"

# Headless Edge/Chrome won't open a window narrower than ~500px; the phone layout
# applies at anything <= 560px, so 500px wide shows the real mobile layout uncropped.
shot mobile          500 1000 "${sep}theme=dark"
