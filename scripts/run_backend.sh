#!/usr/bin/env bash
# Launch the MissionSync backend (from project root)
cd backend || exit 1
if [ ! -d .venv ]; then
  python -m venv .venv
  ./.venv/Scripts/python -m pip install -r requirements.txt 2>/dev/null \
    || ./.venv/bin/python -m pip install -r requirements.txt
fi
./.venv/Scripts/python -m uvicorn missionsync.main:app --reload --port 8000 2>/dev/null \
  || ./.venv/bin/python -m uvicorn missionsync.main:app --reload --port 8000
