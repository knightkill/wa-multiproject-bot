FROM node:22-alpine

# ffmpeg + ffprobe are used by src/transcode.js to shrink oversized
# (>16 MB) videos under WhatsApp's inline-video cap before sending.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js db.js ./
COPY routes ./routes
COPY src ./src
COPY public ./public

EXPOSE 8080
CMD ["node", "--experimental-sqlite", "index.js"]
