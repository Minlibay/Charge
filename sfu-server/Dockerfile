FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

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

# Install Mediasoup dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (mediasoup needs dev dependencies for worker)
RUN npm ci

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy source files (for mediasoup worker)
COPY src ./src

# Expose ports
EXPOSE 3000 3001 40000-49999/udp

# Start server
CMD ["node", "dist/index.js"]

