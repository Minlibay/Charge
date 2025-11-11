FROM node:20-alpine AS builder

# Install build dependencies for mediasoup worker
RUN apk update && apk add --no-cache \
    python3 \
    py3-pip \
    make \
    g++ \
    cairo-dev \
    libjpeg-turbo-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    bash

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

# Install runtime dependencies for mediasoup worker
RUN apk update && apk add --no-cache \
    python3 \
    cairo \
    libjpeg-turbo \
    pango \
    giflib \
    pixman

WORKDIR /app

# Copy package files (for reference, but we'll use node_modules from builder)
COPY package*.json ./

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy source files (for mediasoup worker)
COPY src ./src

# Copy node_modules from builder (includes built mediasoup worker)
COPY --from=builder /app/node_modules ./node_modules

# Expose ports
EXPOSE 3000 3001 40000-49999/udp

# Start server
CMD ["node", "dist/index.js"]

