#!/usr/bin/env bash
# Judge stress test: inject a fresh incident mid-demo and watch the
# ranking + recommendations refresh without a restart.
#
#   ./scripts/inject.sh "Ammonia vapor cloud at Industrial Park gate 3, workers down"
#
URL=${URL:-http://127.0.0.1:8000}
TEXT=${1:-"Fire spotting from the University lab block roof, smoke visible from two streets away, evacuation starting"}
python - "$URL" "$TEXT" <<'PY'
import json, sys, urllib.request, urllib.error
url, text = sys.argv[1], sys.argv[2]
req = urllib.request.Request(f"{url}/api/report", data=json.dumps({"text": text, "source": "radio", "confidence": 0.95}).encode(),
                             headers={"Content-Type": "application/json"})
try:
    d = json.load(urllib.request.urlopen(req, timeout=90))
except urllib.error.HTTPError as e:
    err = json.load(e).get("error", {})
    sys.exit(f"✘ {err.get('code')}: {err.get('message')} (ref {err.get('request_id')})")
o = d["outcome"]
print(f"✔ {o['kind']}: {o.get('title') or o.get('message')}" + (f" — {o['tier']} · urgency {o['urgency']}" if o.get("tier") else ""))
print("  injections so far:", d["injections"], "| mode:", d["snapshot"]["metrics"]["mode"])
PY
