// bridge/src/index.ts
import { createServer } from "http";

// packages/protocol/src/constants.ts
var PROTOCOL_VERSION = "1.0.0";
var HEARTBEAT_INTERVAL_MS = 6e4;

// bridge/src/config.ts
function loadConfig() {
  const haUrl = process.env.HA_URL || process.env.SUPERVISOR_URL || "http://supervisor/core";
  const haToken = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN || "";
  const cloudUrl = process.env.CLOUD_URL || "https://helm.replit.app";
  const bridgeId = process.env.BRIDGE_ID || generateBridgeId();
  const credentialPath = process.env.CREDENTIAL_PATH || "/data/credentials.json";
  if (!haToken) {
    console.error("\u274C HA_TOKEN environment variable is required");
    process.exit(1);
  }
  return {
    haUrl: haUrl.replace(/\/$/, ""),
    haToken,
    cloudUrl: cloudUrl.replace(/\/$/, ""),
    bridgeId,
    credentialPath,
    heartbeatInterval: HEARTBEAT_INTERVAL_MS,
    protocolVersion: PROTOCOL_VERSION
  };
}
function generateBridgeId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "helm-bridge-";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// bridge/src/ha-rest-client.ts
var HARestClient = class {
  config;
  haVersion = "unknown";
  constructor(config) {
    this.config = config;
  }
  async request(path2, options = {}) {
    const url = `${this.config.haUrl}${path2}`;
    const headers = {
      "Authorization": `Bearer ${this.config.haToken}`,
      "Content-Type": "application/json",
      ...options.headers
    };
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HA API error: ${response.status} ${response.statusText} - ${text}`);
    }
    return response.json();
  }
  async getConfig() {
    const config = await this.request("/api/config");
    this.haVersion = config.version;
    return config;
  }
  async getVersion() {
    if (this.haVersion === "unknown") {
      const config = await this.getConfig();
      return config.version;
    }
    return this.haVersion;
  }
  async getStates() {
    return this.request("/api/states");
  }
  async getState(entityId) {
    return this.request(`/api/states/${entityId}`);
  }
  async getServices() {
    return this.request("/api/services");
  }
  async callService(domain, service, data) {
    return this.request(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(data)
    });
  }
  async checkConnection() {
    try {
      await this.getConfig();
      return true;
    } catch (error) {
      console.error("HA connection check failed:", error);
      return false;
    }
  }
  mapAreaToProtocol(area) {
    return {
      id: area.area_id,
      name: area.name,
      picture: area.picture ?? void 0
    };
  }
  mapDeviceToProtocol(device) {
    return {
      id: device.id,
      name: device.name_by_user || device.name || null,
      manufacturer: device.manufacturer ?? null,
      model: device.model ?? null,
      areaId: device.area_id ?? null,
      identifiers: device.identifiers ?? [],
      swVersion: device.sw_version ?? null,
      hwVersion: device.hw_version ?? null,
      configurationUrl: device.configuration_url ?? null
    };
  }
  mapStateToProtocol(state, entityRegistry) {
    const domain = state.entity_id.split(".")[0];
    return {
      entityId: state.entity_id,
      domain,
      friendlyName: state.attributes?.friendly_name ?? null,
      deviceId: entityRegistry?.device_id ?? null,
      areaId: entityRegistry?.area_id ?? null,
      state: state.state,
      attributes: state.attributes ?? {},
      lastChanged: state.last_changed ?? (/* @__PURE__ */ new Date()).toISOString(),
      lastUpdated: state.last_updated ?? (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  mapServiceToProtocol(serviceDomain) {
    return {
      domain: serviceDomain.domain,
      services: serviceDomain.services ?? {}
    };
  }
};

// bridge/src/ha-ws-client.ts
import WebSocket from "ws";
import { EventEmitter } from "events";
var HAWebSocketClient = class extends EventEmitter {
  config;
  ws = null;
  messageId = 1;
  reconnectTimer = null;
  authenticated = false;
  eventSubscriptionId = null;
  reconnectAttempts = 0;
  maxReconnectAttempts = 10;
  reconnectDelay = 1e3;
  shouldReconnect = true;
  pendingResponses = /* @__PURE__ */ new Map();
  constructor(config) {
    super();
    this.config = config;
  }
  getWebSocketUrl() {
    const httpUrl = this.config.haUrl;
    const wsUrl = httpUrl.replace(/^http/, "ws");
    if (httpUrl.includes("supervisor/core") || httpUrl.includes("supervisor:80/core")) {
      return `${wsUrl}/websocket`;
    }
    return `${wsUrl}/api/websocket`;
  }
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        const url = this.getWebSocketUrl();
        console.log("\u{1F50C} Connecting to HA WebSocket:", url);
        this.ws = new WebSocket(url);
        this.ws.on("open", () => {
          console.log("\u{1F4E1} HA WebSocket connected");
          this.reconnectAttempts = 0;
        });
        this.ws.on("message", (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message, resolve, reject);
          } catch (error) {
            console.error("Failed to parse HA WebSocket message:", error);
          }
        });
        this.ws.on("close", (code, reason) => {
          console.log(`\u{1F50C} HA WebSocket closed: ${code} - ${reason.toString()}`);
          this.authenticated = false;
          this.eventSubscriptionId = null;
          this.emit("disconnected", code, reason.toString());
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        });
        this.ws.on("error", (error) => {
          console.error("\u274C HA WebSocket error:", error);
          this.emit("error", error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  handleMessage(message, connectResolve, connectReject) {
    switch (message.type) {
      case "auth_required":
        this.sendAuth();
        break;
      case "auth_ok":
        console.log("\u2705 HA WebSocket authenticated");
        this.authenticated = true;
        this.emit("authenticated");
        this.subscribeToEvents();
        if (connectResolve) connectResolve();
        break;
      case "auth_invalid":
        const authError = new Error(`HA auth failed: ${message.message}`);
        console.error("\u274C HA WebSocket auth failed:", message.message);
        this.emit("auth_failed", message.message);
        if (connectReject) connectReject(authError);
        break;
      case "event":
        this.handleEvent(message);
        break;
      case "result":
        this.handleResult(message);
        break;
      default:
        break;
    }
  }
  sendAuth() {
    this.send({
      type: "auth",
      access_token: this.config.haToken
    });
  }
  async subscribeToEvents() {
    const id = this.getNextId();
    this.eventSubscriptionId = id;
    this.send({
      id,
      type: "subscribe_events",
      event_type: "state_changed"
    });
    console.log("\u{1F4ED} Subscribed to state_changed events");
  }
  handleEvent(message) {
    const event = message.event;
    if (event && event.event_type === "state_changed") {
      this.emit("state_changed", event);
    }
  }
  handleResult(message) {
    const id = message.id;
    if (id && this.pendingResponses.has(id)) {
      const { resolve, reject } = this.pendingResponses.get(id);
      this.pendingResponses.delete(id);
      if (message.success) {
        resolve(message.result);
      } else {
        reject(new Error(message.error?.message || "Unknown error"));
      }
    }
  }
  getNextId() {
    return this.messageId++;
  }
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
  async sendCommand(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.authenticated) {
        reject(new Error("Not authenticated"));
        return;
      }
      const id = this.getNextId();
      this.pendingResponses.set(id, {
        resolve,
        reject
      });
      this.send({
        id,
        type,
        ...data
      });
      setTimeout(() => {
        if (this.pendingResponses.has(id)) {
          this.pendingResponses.delete(id);
          reject(new Error("Command timeout"));
        }
      }, 3e4);
    });
  }
  async callService(domain, service, serviceData = {}) {
    return this.sendCommand("call_service", {
      domain,
      service,
      service_data: serviceData
    });
  }
  async getAreas() {
    return this.sendCommand("config/area_registry/list");
  }
  async getDevices() {
    return this.sendCommand("config/device_registry/list");
  }
  async getEntities() {
    return this.sendCommand("config/entity_registry/list");
  }
  async getStates() {
    return this.sendCommand("get_states");
  }
  async getServices() {
    return this.sendCommand("get_services");
  }
  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("\u274C Max reconnect attempts reached");
      return;
    }
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      3e4
    );
    this.reconnectAttempts++;
    console.log(`\u23F3 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error("Reconnect failed:", error);
      }
    }, delay);
  }
  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
    this.pendingResponses.clear();
  }
  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.authenticated;
  }
};

// bridge/src/cloud-client.ts
import WebSocket2 from "ws";
import { EventEmitter as EventEmitter2 } from "events";
var CloudClient = class extends EventEmitter2 {
  config;
  credentialStore;
  ws = null;
  authenticated = false;
  tenantId = null;
  reconnectTimer = null;
  heartbeatTimer = null;
  reconnectAttempts = 0;
  maxReconnectAttempts = 10;
  reconnectDelay = 1e3;
  shouldReconnect = true;
  lastEventAt = null;
  haVersion = "unknown";
  entityCount = 0;
  uptime = 0;
  startTime = /* @__PURE__ */ new Date();
  reconnectCount = 0;
  constructor(config, credentialStore) {
    super();
    this.config = config;
    this.credentialStore = credentialStore;
  }
  getWebSocketUrl() {
    const httpUrl = this.config.cloudUrl;
    const wsUrl = httpUrl.replace(/^http/, "ws");
    return `${wsUrl}/ws/bridge`;
  }
  async connect() {
    if (!this.credentialStore.isPaired()) {
      console.log("\u26A0\uFE0F Cannot connect to cloud: not paired");
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        const url = this.getWebSocketUrl();
        console.log("\u2601\uFE0F Connecting to Cloud:", url);
        this.ws = new WebSocket2(url);
        this.ws.on("open", () => {
          console.log("\u{1F4E1} Cloud WebSocket connected");
          this.reconnectAttempts = 0;
          this.emit("connected");
          this.sendAuth();
        });
        this.ws.on("message", (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message, resolve, reject);
          } catch (error) {
            console.error("Failed to parse cloud message:", error);
          }
        });
        this.ws.on("close", (code, reason) => {
          console.log(`\u2601\uFE0F Cloud WebSocket closed: ${code} - ${reason.toString()}`);
          this.authenticated = false;
          this.stopHeartbeat();
          this.emit("disconnected", code, reason.toString());
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        });
        this.ws.on("error", (error) => {
          console.error("\u274C Cloud WebSocket error:", error);
          this.emit("error", error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  handleMessage(message, connectResolve, connectReject) {
    switch (message.type) {
      case "auth_result":
        this.handleAuthResult(message, connectResolve, connectReject);
        break;
      case "command":
        this.handleCommand(message);
        break;
      case "request_full_sync":
        console.log("\u{1F4CA} Cloud requested full sync:", message.reason);
        this.emit("request_full_sync", message.reason);
        break;
      case "request_heartbeat":
        this.sendHeartbeat();
        break;
      case "disconnect":
        console.log("\u{1F50C} Cloud requested disconnect:", message.reason);
        this.shouldReconnect = false;
        this.disconnect();
        break;
      default:
        console.log("Unknown cloud message type:", message.type);
    }
  }
  sendAuth() {
    const credential = this.credentialStore.get();
    if (!credential) {
      console.error("No credentials available");
      return;
    }
    const message = {
      type: "authenticate",
      bridgeId: this.config.bridgeId,
      bridgeCredential: credential.bridgeCredential,
      protocolVersion: this.config.protocolVersion
    };
    this.send(message);
  }
  handleAuthResult(message, connectResolve, connectReject) {
    if (message.success) {
      this.authenticated = true;
      this.tenantId = message.tenantId;
      console.log(`\u2705 Authenticated with cloud, tenant: ${this.tenantId}`);
      this.emit("authenticated", this.tenantId);
      this.startHeartbeat();
      if (connectResolve) connectResolve();
    } else {
      console.error("\u274C Cloud auth failed:", message.error);
      this.emit("auth_failed", message.error || "Unknown error");
      if (connectReject) connectReject(new Error(message.error));
    }
  }
  handleCommand(message) {
    console.log(`\u{1F3AE} Received command: ${message.commandType} (${message.cmdId})`);
    if (message.requiresAck) {
      this.sendCommandAck(message.cmdId);
    }
    this.emit("command", message);
  }
  sendCommandAck(cmdId) {
    const ack = {
      type: "command_ack",
      cmdId,
      status: "acknowledged",
      receivedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.send(ack);
  }
  sendCommandResult(cmdId, status, result, error) {
    const message = {
      type: "command_result",
      cmdId,
      status,
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      result,
      error
    };
    this.send(message);
  }
  sendFullSync(data) {
    const message = {
      type: "full_sync",
      data: {
        syncedAt: (/* @__PURE__ */ new Date()).toISOString(),
        haVersion: this.haVersion,
        ...data
      }
    };
    this.send(message);
    console.log(`\u{1F4E4} Sent full sync: ${data.entities.length} entities`);
  }
  sendStateBatch(changes) {
    if (changes.length === 0) return;
    const message = {
      type: "state_batch",
      data: {
        batchId: crypto.randomUUID(),
        batchedAt: (/* @__PURE__ */ new Date()).toISOString(),
        events: changes,
        isOverflow: false
      }
    };
    this.send(message);
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  sendHeartbeat() {
    if (!this.authenticated) return;
    const message = {
      type: "heartbeat",
      bridgeId: this.config.bridgeId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      bridgeVersion: "1.0.0",
      protocolVersion: this.config.protocolVersion,
      haVersion: this.haVersion,
      haConnected: true,
      cloudConnected: true,
      lastEventAt: this.lastEventAt?.toISOString() ?? null,
      entityCount: this.entityCount,
      reconnectCount: this.reconnectCount,
      uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1e3)
    };
    this.send(message);
  }
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket2.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("\u274C Max cloud reconnect attempts reached");
      return;
    }
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      6e4
    );
    this.reconnectAttempts++;
    this.reconnectCount++;
    console.log(`\u23F3 Reconnecting to cloud in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error("Cloud reconnect failed:", error);
      }
    }, delay);
  }
  updateStats(haVersion, entityCount, lastEventAt) {
    this.haVersion = haVersion;
    this.entityCount = entityCount;
    this.lastEventAt = lastEventAt;
  }
  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
  }
  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket2.OPEN && this.authenticated;
  }
  getTenantId() {
    return this.tenantId;
  }
};

// bridge/src/credential-store.ts
import * as fs from "fs";
import * as path from "path";
var CredentialStore = class {
  filePath;
  credentials = null;
  constructor(filePath) {
    this.filePath = filePath;
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf8");
        this.credentials = JSON.parse(data);
        console.log("\u{1F4C2} Loaded credentials from", this.filePath);
      }
    } catch (error) {
      console.error("Failed to load credentials:", error);
      this.credentials = null;
    }
  }
  save(credentials) {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(credentials, null, 2));
      this.credentials = credentials;
      console.log("\u{1F4BE} Saved credentials to", this.filePath);
    } catch (error) {
      console.error("Failed to save credentials:", error);
      throw error;
    }
  }
  get() {
    return this.credentials;
  }
  isPaired() {
    return this.credentials !== null && !!this.credentials.bridgeCredential;
  }
  clear() {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
      this.credentials = null;
      console.log("\u{1F5D1}\uFE0F Cleared credentials");
    } catch (error) {
      console.error("Failed to clear credentials:", error);
      throw error;
    }
  }
  getTenantId() {
    return this.credentials?.tenantId ?? null;
  }
  getBridgeCredential() {
    return this.credentials?.bridgeCredential ?? null;
  }
};

// bridge/src/index.ts
var HelmBridge = class {
  config;
  restClient;
  wsClient;
  cloudClient;
  credentialStore;
  state;
  entityRegistry = /* @__PURE__ */ new Map();
  stateChangeQueue = [];
  batchTimer = null;
  batchIntervalMs = 500;
  constructor() {
    this.config = loadConfig();
    this.restClient = new HARestClient(this.config);
    this.wsClient = new HAWebSocketClient(this.config);
    this.credentialStore = new CredentialStore(this.config.credentialPath);
    this.cloudClient = new CloudClient(this.config, this.credentialStore);
    this.state = {
      config: this.config,
      haVersion: "unknown",
      haConnected: false,
      cloudConnected: false,
      isPaired: this.credentialStore.isPaired(),
      entityCount: 0,
      lastEventAt: null,
      startedAt: /* @__PURE__ */ new Date(),
      reconnectCount: 0
    };
    this.setupEventHandlers();
    this.setupCloudEventHandlers();
  }
  setupEventHandlers() {
    this.wsClient.on("authenticated", () => {
      console.log("\u{1F3E0} Connected to Home Assistant");
      this.state.haConnected = true;
    });
    this.wsClient.on("disconnected", () => {
      console.log("\u{1F3E0} Disconnected from Home Assistant");
      this.state.haConnected = false;
      this.state.reconnectCount++;
    });
    this.wsClient.on("state_changed", (event) => {
      this.handleStateChange(event);
    });
    this.wsClient.on("error", (error) => {
      console.error("HA WebSocket error:", error);
    });
  }
  setupCloudEventHandlers() {
    this.cloudClient.on("connected", () => {
      console.log("\u2601\uFE0F Cloud WebSocket connected");
    });
    this.cloudClient.on("authenticated", (tenantId) => {
      console.log(`\u2601\uFE0F Authenticated with cloud, tenant: ${tenantId}`);
      this.state.cloudConnected = true;
    });
    this.cloudClient.on("disconnected", (_code, _reason) => {
      this.state.cloudConnected = false;
    });
    this.cloudClient.on("request_full_sync", async (reason) => {
      console.log(`\u{1F4CA} Cloud requested full sync: ${reason || "unknown reason"}`);
      await this.performFullSync();
    });
    this.cloudClient.on("command", async (command) => {
      await this.handleCloudCommand(command);
    });
    this.cloudClient.on("auth_failed", (error) => {
      console.error("\u274C Cloud auth failed:", error);
    });
    this.cloudClient.on("error", (error) => {
      console.error("\u274C Cloud error:", error);
    });
  }
  async performFullSync() {
    try {
      const syncData = await this.collectFullSync();
      this.cloudClient.updateStats(this.state.haVersion, syncData.entities.length, this.state.lastEventAt);
      this.cloudClient.sendFullSync(syncData);
      console.log("\u2705 Full sync sent to cloud");
    } catch (error) {
      console.error("\u274C Failed to perform full sync:", error);
    }
  }
  async handleCloudCommand(command) {
    console.log(`\u{1F3AE} Executing command: ${command.commandType} (${command.cmdId})`);
    try {
      const { domain, service, serviceData } = command.payload;
      const result = await this.wsClient.callService(domain, service, serviceData || {});
      this.cloudClient.sendCommandResult(command.cmdId, "completed", {
        haResponse: result
      });
      console.log(`\u2705 Command ${command.cmdId} completed`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      this.cloudClient.sendCommandResult(command.cmdId, "failed", void 0, {
        code: "EXECUTION_FAILED",
        message: errorMessage
      });
      console.error(`\u274C Command ${command.cmdId} failed:`, errorMessage);
    }
  }
  async start() {
    console.log("\u{1F680} Starting Helm Bridge...");
    console.log(`   Bridge ID: ${this.config.bridgeId}`);
    console.log(`   HA URL: ${this.config.haUrl}`);
    console.log(`   Cloud URL: ${this.config.cloudUrl}`);
    console.log(`   Protocol Version: ${this.config.protocolVersion}`);
    console.log("\u{1F4E1} Checking Home Assistant connection...");
    const haConnected = await this.restClient.checkConnection();
    if (!haConnected) {
      console.error("\u274C Cannot connect to Home Assistant");
      process.exit(1);
    }
    console.log("\u2713 REST API connection verified");
    this.state.haVersion = await this.restClient.getVersion();
    console.log(`   HA Version: ${this.state.haVersion}`);
    console.log("\u{1F50C} Connecting to WebSocket...");
    try {
      await this.wsClient.connect();
      console.log("\u2713 WebSocket connected and authenticated");
    } catch (wsError) {
      console.error("\u274C WebSocket connection failed:", wsError);
      throw wsError;
    }
    console.log("\u{1F4CB} Loading entity registry...");
    try {
      const entities = await this.wsClient.getEntities();
      entities.forEach((e) => this.entityRegistry.set(e.entity_id, e));
      console.log(`\u2713 Loaded ${entities.length} entity registry entries`);
    } catch (entityError) {
      console.error("\u26A0\uFE0F Failed to load entity registry:", entityError);
    }
    console.log("\u{1F50D} Loading entity states...");
    try {
      const states = await this.wsClient.getStates();
      this.state.entityCount = states.length;
      console.log(`\u2713 Found ${states.length} entities`);
    } catch (statesError) {
      console.error("\u26A0\uFE0F Failed to load states:", statesError);
      this.state.entityCount = 0;
    }
    console.log("\u2705 Helm Bridge started successfully");
    if (this.credentialStore.isPaired()) {
      console.log("\u{1F517} Bridge is already paired, connecting to cloud...");
      try {
        await this.cloudClient.connect();
      } catch (error) {
        console.error("\u274C Failed to connect to cloud:", error);
      }
    } else {
      await this.requestAndDisplayPairingCode();
    }
  }
  async requestAndDisplayPairingCode() {
    console.log("\u{1F511} Requesting pairing code from cloud...");
    try {
      const response = await fetch(`${this.config.cloudUrl}/api/bridge/pairing-codes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          bridgeId: this.config.bridgeId,
          bridgeVersion: this.config.protocolVersion,
          haVersion: this.state.haVersion
        })
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get pairing code: ${response.status} ${errorText}`);
      }
      const data = await response.json();
      const pairingCode = data.code;
      const expiresInMinutes = Math.floor(data.expiresInSeconds / 60);
      console.log("");
      console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
      console.log("\u{1F511} PAIRING CODE: " + pairingCode);
      console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
      console.log("");
      console.log("To complete setup:");
      console.log(`1. Go to ${this.config.cloudUrl}`);
      console.log("2. Navigate to Integrations \u2192 Home Assistant");
      console.log('3. Click "Add Bridge" and enter the pairing code above');
      console.log("");
      console.log(`The pairing code expires in ${expiresInMinutes} minutes.`);
      console.log("Restart the add-on to generate a new code if needed.");
      console.log("");
      this.pollForPairing(pairingCode);
    } catch (error) {
      console.error("\u274C Failed to get pairing code:", error);
      console.log("");
      console.log("\u26A0\uFE0F Could not connect to Helm Cloud to generate pairing code.");
      console.log("Please ensure your internet connection is working and try restarting the add-on.");
      console.log("");
    }
  }
  async pollForPairing(pairingCode) {
    console.log("\u{1F440} Waiting for pairing to complete...");
    const pollInterval = 5e3;
    const maxAttempts = 120;
    let attempts = 0;
    const poll = async () => {
      attempts++;
      try {
        if (this.credentialStore.isPaired()) {
          console.log("\u2705 Pairing completed! Connecting to cloud...");
          await this.cloudClient.connect();
          return;
        }
        const response = await fetch(
          `${this.config.cloudUrl}/api/bridge/pairing-codes/${pairingCode}/status`
        );
        if (response.ok) {
          const data = await response.json();
          if (data.status === "paired" && data.bridgeCredential) {
            console.log("\u2705 Pairing completed via cloud!");
            this.credentialStore.save({
              bridgeId: data.bridgeId,
              tenantId: data.tenantId,
              bridgeCredential: data.bridgeCredential
            });
            await this.cloudClient.connect();
            return;
          } else if (data.status === "paired") {
            if (this.credentialStore.isPaired()) {
              console.log("\u2705 Already paired! Connecting to cloud...");
              await this.cloudClient.connect();
              return;
            }
            console.log("\u26A0\uFE0F Pairing completed but credential was already claimed. Restart the add-on.");
            return;
          } else if (data.status === "expired") {
            console.log("\u23F0 Pairing code expired. Restart the add-on to get a new code.");
            return;
          }
        } else if (response.status === 404) {
          if (this.credentialStore.isPaired()) {
            console.log("\u2705 Already paired! Connecting to cloud...");
            await this.cloudClient.connect();
            return;
          }
        }
        if (attempts < maxAttempts) {
          setTimeout(poll, pollInterval);
        } else {
          console.log("\u23F0 Pairing code expired. Restart the add-on to get a new code.");
        }
      } catch (error) {
        console.error("Error checking pairing status:", error);
        if (attempts < maxAttempts) {
          setTimeout(poll, pollInterval);
        }
      }
    };
    setTimeout(poll, pollInterval);
  }
  async connectToCloud() {
    if (!this.credentialStore.isPaired()) {
      throw new Error("Bridge not paired");
    }
    await this.cloudClient.connect();
  }
  handleStateChange(event) {
    this.state.lastEventAt = /* @__PURE__ */ new Date();
    this.stateChangeQueue.push(event);
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.flushStateChanges();
      }, this.batchIntervalMs);
    }
  }
  flushStateChanges() {
    if (this.stateChangeQueue.length === 0) {
      this.batchTimer = null;
      return;
    }
    const batch = [...this.stateChangeQueue];
    this.stateChangeQueue = [];
    this.batchTimer = null;
    console.log(`\u{1F4E6} Batched ${batch.length} state changes`);
    if (this.cloudClient.isConnected()) {
      const events = batch.map((e) => ({
        entityId: e.data.entity_id,
        oldState: e.data.old_state ? {
          state: e.data.old_state.state,
          attributes: e.data.old_state.attributes,
          lastChanged: e.data.old_state.last_changed,
          lastUpdated: e.data.old_state.last_updated
        } : null,
        newState: {
          state: e.data.new_state.state,
          attributes: e.data.new_state.attributes,
          lastChanged: e.data.new_state.last_changed,
          lastUpdated: e.data.new_state.last_updated
        },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }));
      this.cloudClient.sendStateBatch(events);
      this.cloudClient.updateStats(this.state.haVersion, this.state.entityCount, this.state.lastEventAt);
    }
  }
  async collectFullSync() {
    console.log("\u{1F4CA} Collecting full sync data...");
    try {
      const [areasRaw, devicesRaw, statesRaw, servicesRaw, entityRegistryRaw] = await Promise.all([
        this.wsClient.getAreas().catch((err) => {
          console.error("\u274C Failed to fetch areas:", err.message);
          return [];
        }),
        this.wsClient.getDevices().catch((err) => {
          console.error("\u274C Failed to fetch devices:", err.message);
          return [];
        }),
        this.wsClient.getStates().catch((err) => {
          console.error("\u274C Failed to fetch states:", err.message);
          return [];
        }),
        this.wsClient.getServices().catch((err) => {
          console.error("\u274C Failed to fetch services:", err.message);
          return {};
        }),
        this.wsClient.getEntities().catch((err) => {
          console.error("\u274C Failed to fetch entity registry:", err.message);
          return [];
        })
      ]);
      const entityList = Array.isArray(entityRegistryRaw) ? entityRegistryRaw : [];
      entityList.forEach((e) => this.entityRegistry.set(e.entity_id, e));
      const areasList = Array.isArray(areasRaw) ? areasRaw : [];
      const devicesList = Array.isArray(devicesRaw) ? devicesRaw : [];
      const statesList = Array.isArray(statesRaw) ? statesRaw : [];
      const areas = areasList.map((a) => this.restClient.mapAreaToProtocol(a));
      const devices = devicesList.map((d) => this.restClient.mapDeviceToProtocol(d));
      const entities = statesList.map((s) => {
        const registry = this.entityRegistry.get(s.entity_id);
        return this.restClient.mapStateToProtocol(s, registry);
      });
      const servicesDomainArray = Object.entries(servicesRaw).map(
        ([domain, serviceDefs]) => ({ domain, services: serviceDefs })
      );
      const services = servicesDomainArray.map((s) => this.restClient.mapServiceToProtocol(s));
      console.log(`   Areas: ${areas.length}`);
      console.log(`   Devices: ${devices.length}`);
      console.log(`   Entities: ${entities.length}`);
      console.log(`   Service domains: ${services.length}`);
      this.state.entityCount = entities.length;
      return { areas, devices, entities, services };
    } catch (error) {
      console.error("\u274C Full sync collection failed:", error);
      throw error;
    }
  }
  async callService(domain, service, data) {
    console.log(`\u{1F3AE} Calling service: ${domain}.${service}`);
    return this.wsClient.callService(domain, service, data);
  }
  getState() {
    return { ...this.state };
  }
  getCredentialStore() {
    return this.credentialStore;
  }
  getConfig() {
    return this.config;
  }
  async stop() {
    console.log("\u{1F6D1} Stopping Helm Bridge...");
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.flushStateChanges();
    }
    this.cloudClient.disconnect();
    this.wsClient.disconnect();
    console.log("\u2705 Helm Bridge stopped");
  }
  startHealthServer(port = 8099) {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        const health = {
          status: "ok",
          haConnected: this.state.haConnected,
          cloudConnected: this.state.cloudConnected,
          isPaired: this.state.isPaired,
          entityCount: this.state.entityCount,
          uptime: Math.floor((Date.now() - this.state.startedAt.getTime()) / 1e3)
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
      } else if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.getState()));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    server.listen(port, () => {
      console.log(`\u{1F3E5} Health server listening on port ${port}`);
    });
  }
};
var bridge = new HelmBridge();
bridge.startHealthServer(parseInt(process.env.HEALTH_PORT || "8099"));
process.on("SIGINT", async () => {
  await bridge.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await bridge.stop();
  process.exit(0);
});
bridge.start().catch((error) => {
  console.error("\u274C Bridge startup failed:", error);
  process.exit(1);
});
export {
  HelmBridge,
  bridge
};
