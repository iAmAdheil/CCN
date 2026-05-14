# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the React frontend.
#   1. build   — node 24 alpine, npm ci, vite build → dist/
#   2. runtime — nginx alpine serving dist/ on port 80, single SPA route
#                fallback so the React Router catches every path.
#
# Build context expected at the frontend/ directory.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# Try `npm ci` first (reproducible); fall back to `npm install` if the
# lockfile can't be applied cleanly (Linux runner vs Windows-generated
# lockfile mismatches on optional platform deps). --ignore-scripts skips
# postinstall binary downloads we don't need at this layer.
RUN npm ci --no-audit --no-fund --ignore-scripts \
 || npm install --no-audit --no-fund --ignore-scripts
COPY . .
# Pass the backend URL at build time — vite inlines it into the bundle.
ARG VITE_SIGNAL_URL
ENV VITE_SIGNAL_URL=$VITE_SIGNAL_URL
RUN npm run build

# --- runtime ---
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
