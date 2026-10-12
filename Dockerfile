# MissionSync — one image, one origin: the React dashboard is built in stage 1 and served by the FastAPI app
# in stage 2, so the session cookie stays SameSite/httpOnly and the WebSocket needs no cross-site tricks.

# ---- stage 1: build the dashboard -------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- stage 2: the API + the built dashboard -----------------------------------------------------
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
COPY --from=web /web/dist ./static
ENV STATIC_DIR=/app/static APP_ENV=production LOG_FORMAT=json
EXPOSE 10000
# Behind Render's proxy: trust X-Forwarded-* so every visitor gets their own rate-limit bucket and https is seen.
CMD ["sh", "-c", "uvicorn missionsync.main:app --host 0.0.0.0 --port ${PORT:-10000} --proxy-headers --forwarded-allow-ips='*'"]
