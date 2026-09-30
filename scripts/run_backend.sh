#!/usr/bin/env bash
# Launch the MissionSync backend (from project root). Copy backend/.env.example to
# backend/.env and add GROQ_API_KEY first, or the agents run rule-based.
cd backend || exit 1
if [ ! -d .venv ]; then
  python -m venv .venv
  ./.venv/Scripts/python -m pip install -r requirements.txt 2>/dev/null \
    || ./.venv/bin/python -m pip install -r requirements.txt
fi
# No --reload: a reload restarts the drill and re-runs the seed pipeline on every save.
./.venv/Scripts/python -m uvicorn missionsync.main:app --port 8000 2>/dev/null \
  || ./.venv/bin/python -m uvicorn missionsync.main:app --port 8000
