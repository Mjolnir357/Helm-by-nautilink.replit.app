ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js 20 and build dependencies for better-sqlite3
# python3-dev and linux-headers needed for node-gyp native module compilation
RUN apk add --no-cache \
  nodejs \
  npm \
  python3 \
  make \
  g++ \
  linux-headers \
  && ln -sf /usr/bin/python3 /usr/bin/python

# Set working directory
WORKDIR /usr/share/helm-bridge

# Copy package.json first for layer caching
COPY rootfs/usr/share/helm-bridge/package.json ./

# Install production dependencies (including native modules)
# Use --build-from-source to ensure better-sqlite3 compiles for this arch
RUN npm install --only=production --build-from-source 2>&1 \
  && npm cache clean --force

# Copy bundled bridge code (single file created by build.sh)
COPY rootfs/usr/share/helm-bridge/dist/index.js ./dist/

# Copy public directory for web UI
COPY rootfs/usr/share/helm-bridge/public ./public/

# Copy run script
COPY run.sh /
RUN chmod a+x /run.sh

# Set environment
ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD [ "/run.sh" ]
