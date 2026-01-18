#!/usr/bin/with-contenv bashio

# Helm Bridge Add-on Startup Script

set -e

CONFIG_PATH=/data/options.json
BRIDGE_DIR=/usr/share/helm-bridge

# Read configuration from Home Assistant add-on options
CLOUD_URL=$(bashio::config 'cloud_url')
LOG_LEVEL=$(bashio::config 'log_level')

# Get Supervisor token for Home Assistant API access
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HA_URL="http://supervisor/core"
export CLOUD_URL="${CLOUD_URL}"
export CREDENTIAL_PATH="/data/credentials.json"
export BRIDGE_ID=$(bashio::addon.hostname)
export LOG_LEVEL="${LOG_LEVEL}"

bashio::log.info "Starting Helm Bridge..."
bashio::log.info "  Cloud URL: ${CLOUD_URL}"
bashio::log.info "  Bridge ID: ${BRIDGE_ID}"
bashio::log.info "  Log Level: ${LOG_LEVEL}"

# Change to bridge directory and start
cd ${BRIDGE_DIR}
exec node dist/index.js
