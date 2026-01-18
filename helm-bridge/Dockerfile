ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js 20 for better fetch support
RUN apk add --no-cache nodejs npm

# Set working directory
WORKDIR /usr/share/helm-bridge

# Copy package.json first for layer caching
COPY rootfs/usr/share/helm-bridge/package.json ./

# Install production dependencies
RUN npm install --only=production

# Copy bundled bridge code (single file created by build.sh)
COPY rootfs/usr/share/helm-bridge/dist/index.js ./dist/

# Copy run script
COPY run.sh /
RUN chmod a+x /run.sh

# Set environment
ENV NODE_ENV=production

CMD [ "/run.sh" ]
