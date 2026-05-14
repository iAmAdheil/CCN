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
RUN npm ci --ignore-scripts
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
