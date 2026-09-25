#!/usr/bin/env bash
# Judge stress test: inject a fresh incident mid-demo and watch the
# ranking + recommendations refresh without a restart.
#
#   ./scripts/inject.sh "Ammonia vapor cloud at Industrial Park gate 3, workers down"
#
URL=${URL:-http://127.0.0.1:8000}
TEXT=${1:-"Drone D1 spots new fire front near University campus lab block, smoke visible from two streets away, evacuation starting"}
curl -s -X POST "$URL/api/report" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$TEXT\", \"source\": \"radio\", \"confidence\": 0.95}" \
  | python -c "import json,sys; d=json.load(sys.stdin); print('✅ processed. Injections so far:', d.get('injections'))"
