FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Transpile only: --noCheck + no declaration emit avoids tsc OOMing while
# inferring/emitting a type for the 67MB src/data/webcam-library.json import.
RUN NODE_OPTIONS=--max-old-space-size=8192 npm run build -- --noCheck --declaration false --declarationMap false
# tsc does not copy .json assets; the runtime imports country-bboxes.json from
# dist/data. (The webcam/ip-camera libraries are no longer imported — cameras are
# served from the public.cameras PostGIS table via src/geo/cameraStore.ts.)
RUN mkdir -p dist/data \
 && cp src/data/country-bboxes.json dist/data/
# Build the operator console (web/) -> web/dist, served statically by the feeder at /.
RUN cd web && npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/web/dist ./web/dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
