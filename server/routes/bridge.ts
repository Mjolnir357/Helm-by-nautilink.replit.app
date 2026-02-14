import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken, type AuthenticatedRequest } from "../auth";
import { bridgeStorage } from "../storage/bridge-storage";
import { randomBytes, createHash } from "crypto";
import { z } from "zod";
import { PAIRING_CODE_LENGTH, PAIRING_CODE_EXPIRY_MS, PROTOCOL_VERSION } from "../../packages/protocol/src/constants";
import { parseRequiredInt } from "../utils/validation";

const router = Router();

// Simple in-memory rate limiter for security-sensitive endpoints
// Provides per-IP and per-user limiting to prevent brute-force attacks
interface RateLimitEntry {
  count: number;
  resetAt: number;
  failedAttempts: number; // Track failed attempts for progressive delays
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Rate limit configuration
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // Max requests per window (per IP)
const RATE_LIMIT_MAX_FAILED = 5; // Max failed attempts before longer lockout
const RATE_LIMIT_LOCKOUT_MS = 5 * 60 * 1000; // 5 minute lockout after too many failures

function getRateLimitKey(req: Request, userId?: number): string {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  // Include user ID in key for authenticated routes to provide per-user limiting
  if (userId) {
    return `bridge_pairing_user_${userId}_${ip}`;
  }
  return `bridge_pairing_ip_${ip}`;
}

function checkRateLimit(req: Request, res: Response, next: NextFunction): void {
  // Get user ID if authenticated (from previous middleware)
  const userId = (req as AuthenticatedRequest).user?.id;
  const key = getRateLimitKey(req, userId);
  const now = Date.now();
  
  let entry = rateLimitMap.get(key);
  
  // Clean up expired entries
  if (entry && entry.resetAt < now) {
    // Preserve failed attempt count across windows for progressive delay
    const failedAttempts = entry.failedAttempts;
    rateLimitMap.delete(key);
    entry = undefined;
    
    // If user had many failed attempts, apply longer lockout
    if (failedAttempts >= RATE_LIMIT_MAX_FAILED) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_LOCKOUT_MS, failedAttempts: failedAttempts };
      rateLimitMap.set(key, entry);
    }
  }
  
  if (!entry) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS, failedAttempts: 0 };
    rateLimitMap.set(key, entry);
  }
  
  entry.count++;
  
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    console.warn(`⚠️ Rate limit exceeded for ${key} (failed attempts: ${entry.failedAttempts})`);
    res.status(429).json({ 
      error: "Too many requests. Please try again later.",
      retryAfter: Math.ceil((entry.resetAt - now) / 1000)
    });
    return;
  }
  
  // Store original res.json to track failed responses
  const originalJson = res.json.bind(res);
  res.json = function(body: any) {
    // Track failed pairing attempts
    if (res.statusCode >= 400 && res.statusCode < 500) {
      const currentEntry = rateLimitMap.get(key);
      if (currentEntry) {
        currentEntry.failedAttempts++;
        if (currentEntry.failedAttempts >= RATE_LIMIT_MAX_FAILED) {
          console.warn(`⚠️ Too many failed attempts for ${key}, applying extended lockout`);
          currentEntry.resetAt = Date.now() + RATE_LIMIT_LOCKOUT_MS;
        }
      }
    }
    return originalJson(body);
  };
  
  next();
}

// Periodic cleanup of old rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(rateLimitMap.entries());
  for (const [key, entry] of entries) {
    if (entry.resetAt < now && entry.failedAttempts < RATE_LIMIT_MAX_FAILED) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

function generateBridgeCredential(): string {
  return `bc_${randomBytes(32).toString('hex')}`;
}

function hashCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

const GeneratePairingCodeSchema = z.object({
  bridgeId: z.string().min(1),
  bridgeVersion: z.string().optional(),
  haVersion: z.string().optional(),
});

const PairBridgeSchema = z.object({
  pairingCode: z.string().length(PAIRING_CODE_LENGTH),
});

// Apply rate limiting to pairing code generation to prevent abuse
router.post("/pairing-codes", checkRateLimit, async (req, res) => {
  try {
    const body = GeneratePairingCodeSchema.parse(req.body);
    
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_EXPIRY_MS);
    
    await bridgeStorage.createPairingCode({
      code,
      bridgeId: body.bridgeId,
      bridgeVersion: body.bridgeVersion || null,
      haVersion: body.haVersion || null,
      isUsed: false,
      usedByUserId: null,
      expiresAt,
    });
    
    console.log(`🔑 Generated pairing code ${code} for bridge ${body.bridgeId}, expires at ${expiresAt.toISOString()}`);
    
    res.json({
      code,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.floor(PAIRING_CODE_EXPIRY_MS / 1000),
    });
  } catch (error) {
    console.error("Error generating pairing code:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    res.status(500).json({ error: "Failed to generate pairing code" });
  }
});

// Apply rate limiting to pairing attempts to prevent brute-force attacks
router.post("/pair", checkRateLimit, authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const body = PairBridgeSchema.parse(req.body);
    const code = body.pairingCode.toUpperCase();
    
    const pairingCode = await bridgeStorage.getPairingCode(code);
    
    if (!pairingCode) {
      console.log(`❌ Pairing code ${code} not found`);
      return res.status(404).json({ error: "Pairing code not found" });
    }
    
    if (pairingCode.isUsed) {
      console.log(`❌ Pairing code ${code} already used`);
      return res.status(400).json({ error: "Pairing code already used" });
    }
    
    if (new Date() > new Date(pairingCode.expiresAt)) {
      console.log(`❌ Pairing code ${code} expired`);
      return res.status(400).json({ error: "Pairing code expired" });
    }
    
    const existingRegistration = await bridgeStorage.getBridgeRegistration(req.user.id);
    if (existingRegistration) {
      console.log(`⚠️ User ${req.user.id} already has a bridge registered, replacing`);
      await bridgeStorage.revokeAllCredentials(existingRegistration.bridgeId);
    }
    
    const bridgeCredential = generateBridgeCredential();
    const credentialHash = hashCredential(bridgeCredential);
    
    await bridgeStorage.markPairingCodeUsed(code, req.user.id);
    
    await bridgeStorage.upsertBridgeRegistration({
      userId: req.user.id,
      bridgeId: pairingCode.bridgeId,
      bridgeVersion: pairingCode.bridgeVersion,
      protocolVersion: PROTOCOL_VERSION,
      haVersion: pairingCode.haVersion,
      status: "connected",
      lastHeartbeat: new Date(),
    });
    
    await bridgeStorage.createBridgeCredential({
      bridgeId: pairingCode.bridgeId,
      userId: req.user.id,
      credentialHash,
      rawCredential: bridgeCredential,
      isClaimed: false,
      isRevoked: false,
      expiresAt: null,
    });
    
    await bridgeStorage.createAuditEntry({
      userId: req.user.id,
      action: "bridge_paired",
      entityType: "bridge",
      entityId: pairingCode.bridgeId,
      details: {
        bridgeVersion: pairingCode.bridgeVersion,
        haVersion: pairingCode.haVersion,
      },
      ipAddress: req.ip || null,
    });
    
    console.log(`✅ Bridge ${pairingCode.bridgeId} paired to user ${req.user.id}`);
    
    res.json({
      success: true,
      bridgeCredential,
      tenantId: String(req.user.id),
      bridgeId: pairingCode.bridgeId,
    });
  } catch (error) {
    console.error("Error pairing bridge:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    res.status(500).json({ error: "Failed to pair bridge" });
  }
});

// Endpoint for bridge to poll for pairing completion and retrieve credentials
router.get("/pairing-codes/:code/status", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    
    const pairingCode = await bridgeStorage.getPairingCode(code);
    
    if (!pairingCode) {
      return res.status(404).json({ error: "Pairing code not found" });
    }
    
    if (!pairingCode.isUsed) {
      // Not paired yet
      if (new Date() > new Date(pairingCode.expiresAt)) {
        return res.json({ status: "expired" });
      }
      return res.json({ status: "pending" });
    }
    
    // Pairing completed - get the credential for this bridge
    const credential = await bridgeStorage.getUnclaimedCredential(pairingCode.bridgeId);
    
    if (!credential) {
      return res.json({ 
        status: "paired",
        message: "Paired but credential already claimed or not found"
      });
    }
    
    // Mark credential as claimed so it can't be retrieved again
    await bridgeStorage.markCredentialClaimed(credential.id);
    
    console.log(`🔑 Bridge ${pairingCode.bridgeId} retrieved credentials`);
    
    res.json({
      status: "paired",
      bridgeCredential: credential.rawCredential,
      tenantId: String(credential.userId),
      bridgeId: pairingCode.bridgeId,
    });
  } catch (error) {
    console.error("Error checking pairing status:", error);
    res.status(500).json({ error: "Failed to check pairing status" });
  }
});

router.post("/disconnect", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const registration = await bridgeStorage.getBridgeRegistration(req.user.id);
    
    if (!registration) {
      return res.status(404).json({ error: "No bridge registered" });
    }
    
    const bridgeId = registration.bridgeId;
    
    // Send disconnect message to bridge via WebSocket if connected
    const { bridgeWsServer } = await import("../bridge-ws-server");
    bridgeWsServer.disconnectBridgeByUserId(req.user.id, "user_disconnected");
    
    // Fully delete the bridge registration and all associated data
    await bridgeStorage.deleteBridgeRegistration(req.user.id);
    
    await bridgeStorage.createAuditEntry({
      userId: req.user.id,
      action: "bridge_disconnected",
      entityType: "bridge",
      entityId: bridgeId,
      details: { reason: "user_initiated", fullReset: true },
      ipAddress: req.ip || null,
    });
    
    console.log(`🔌 Bridge ${bridgeId} fully disconnected and removed by user ${req.user.id}`);
    
    res.json({ success: true, message: "Bridge fully disconnected and removed. You can now pair a new bridge." });
  } catch (error) {
    console.error("Error disconnecting bridge:", error);
    res.status(500).json({ error: "Failed to disconnect bridge" });
  }
});

router.post("/reset", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    // Send disconnect message to bridge via WebSocket if connected
    const { bridgeWsServer } = await import("../bridge-ws-server");
    bridgeWsServer.disconnectBridgeByUserId(req.user.id, "user_reset");
    
    // Fully delete the bridge registration and all associated data
    const result = await bridgeStorage.deleteBridgeRegistration(req.user.id);
    
    if (result.bridgeId) {
      await bridgeStorage.createAuditEntry({
        userId: req.user.id,
        action: "bridge_reset",
        entityType: "bridge",
        entityId: result.bridgeId,
        details: { reason: "user_initiated_reset" },
        ipAddress: req.ip || null,
      });
      
      console.log(`🔄 Bridge ${result.bridgeId} reset by user ${req.user.id}`);
    }
    
    res.json({ 
      success: true, 
      wasRegistered: result.deleted,
      message: result.deleted 
        ? "Bridge reset complete. All data cleared. You can now pair a new bridge."
        : "No bridge was registered. Ready to pair a new bridge."
    });
  } catch (error) {
    console.error("Error resetting bridge:", error);
    res.status(500).json({ error: "Failed to reset bridge" });
  }
});

router.get("/status", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const registration = await bridgeStorage.getBridgeRegistration(req.user.id);
    
    if (!registration) {
      return res.json({
        connected: false,
        bridgeId: null,
        status: null,
      });
    }
    
    res.json({
      connected: registration.status === "connected",
      bridgeId: registration.bridgeId,
      status: registration.status,
      bridgeVersion: registration.bridgeVersion,
      protocolVersion: registration.protocolVersion,
      haVersion: registration.haVersion,
      lastHeartbeat: registration.lastHeartbeat,
      lastFullSync: registration.lastFullSync,
      entityCount: registration.entityCount,
      deviceCount: registration.deviceCount,
      areaCount: registration.areaCount,
    });
  } catch (error) {
    console.error("Error fetching bridge status:", error);
    res.status(500).json({ error: "Failed to fetch bridge status" });
  }
});

router.post("/authenticate", async (req, res) => {
  try {
    const { bridgeId, bridgeCredential, protocolVersion } = req.body;
    
    if (!bridgeId || !bridgeCredential) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing bridgeId or bridgeCredential" 
      });
    }
    
    const credentialHash = hashCredential(bridgeCredential);
    const credential = await bridgeStorage.validateCredential(bridgeId, credentialHash);
    
    if (!credential) {
      console.log(`❌ Invalid credential for bridge ${bridgeId}`);
      return res.status(401).json({ 
        success: false, 
        error: "Invalid or revoked credential" 
      });
    }
    
    await bridgeStorage.updateCredentialLastUsed(credential.id);
    
    await bridgeStorage.updateBridgeStatus(credential.userId, "connected");
    
    console.log(`✅ Bridge ${bridgeId} authenticated for user ${credential.userId}`);
    
    res.json({
      success: true,
      tenantId: String(credential.userId),
      minProtocolVersion: PROTOCOL_VERSION,
    });
  } catch (error) {
    console.error("Error authenticating bridge:", error);
    res.status(500).json({ success: false, error: "Authentication failed" });
  }
});

router.get("/entities", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const domain = req.query.domain as string | undefined;
    const entities = await bridgeStorage.getHAEntities(req.user.id, domain);
    const areas = await bridgeStorage.getHAAreas(req.user.id);
    const devices = await bridgeStorage.getHADevices(req.user.id);
    const importedEntities = await bridgeStorage.getImportedEntities(req.user.id);
    
    const areaMap = new Map(areas.map(a => [a.haAreaId, a]));
    const deviceMap = new Map(devices.map(d => [d.haDeviceId, d]));
    const importedMap = new Map(importedEntities.map(i => [i.entityId, i]));
    
    const enrichedEntities = entities.map(entity => {
      const area = entity.areaId ? areaMap.get(entity.areaId) : null;
      const device = entity.deviceId ? deviceMap.get(entity.deviceId) : null;
      const imported = importedMap.get(entity.entityId);
      
      return {
        ...entity,
        areaName: area?.name || null,
        deviceName: device?.name || null,
        manufacturer: device?.manufacturer || null,
        model: device?.model || null,
        imported: imported ? {
          visible: imported.visible,
          controllable: imported.controllable,
          automatable: imported.automatable,
          riskCategory: imported.riskCategory,
        } : null,
      };
    });
    
    res.json(enrichedEntities);
  } catch (error) {
    console.error("Error fetching entities:", error);
    res.status(500).json({ error: "Failed to fetch entities" });
  }
});

router.get("/areas", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const areas = await bridgeStorage.getHAAreas(req.user.id);
    res.json(areas);
  } catch (error) {
    console.error("Error fetching areas:", error);
    res.status(500).json({ error: "Failed to fetch areas" });
  }
});

const ImportEntitiesSchema = z.object({
  entityIds: z.array(z.string()),
  permissions: z.object({
    visible: z.boolean().optional(),
    controllable: z.boolean().optional(),
    automatable: z.boolean().optional(),
  }),
});

router.post("/import", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const body = ImportEntitiesSchema.parse(req.body);
    
    for (const entityId of body.entityIds) {
      await bridgeStorage.upsertImportedEntity(req.user.id, entityId, {
        visible: body.permissions.visible ?? true,
        controllable: body.permissions.controllable ?? true,
        automatable: body.permissions.automatable ?? false,
      });
    }
    
    await bridgeStorage.createAuditEntry({
      userId: req.user.id,
      action: "entities_imported",
      entityType: "import",
      details: {
        entityCount: body.entityIds.length,
        permissions: body.permissions,
      },
      ipAddress: req.ip || null,
    });
    
    console.log(`📥 User ${req.user.id} imported ${body.entityIds.length} entities`);
    
    res.json({ success: true, count: body.entityIds.length });
  } catch (error) {
    console.error("Error importing entities:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    res.status(500).json({ error: "Failed to import entities" });
  }
});

const RemoveImportSchema = z.object({
  entityIds: z.array(z.string()),
});

router.post("/import/remove", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const body = RemoveImportSchema.parse(req.body);
    
    for (const entityId of body.entityIds) {
      await bridgeStorage.removeImportedEntity(req.user.id, entityId);
    }
    
    await bridgeStorage.createAuditEntry({
      userId: req.user.id,
      action: "entities_removed",
      entityType: "import",
      details: { entityCount: body.entityIds.length },
      ipAddress: req.ip || null,
    });
    
    console.log(`🗑️ User ${req.user.id} removed ${body.entityIds.length} entities from import`);
    
    res.json({ success: true, count: body.entityIds.length });
  } catch (error) {
    console.error("Error removing entities:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    res.status(500).json({ error: "Failed to remove entities" });
  }
});

router.get("/services", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const services = await bridgeStorage.getHAServices(req.user.id);
    res.json(services);
  } catch (error) {
    console.error("Error fetching services:", error);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

router.get("/imported", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const importedEntities = await bridgeStorage.getImportedEntities(req.user.id);
    const entities = await bridgeStorage.getHAEntities(req.user.id);
    const areas = await bridgeStorage.getHAAreas(req.user.id);
    const devices = await bridgeStorage.getHADevices(req.user.id);
    
    const entityMap = new Map(entities.map(e => [e.entityId, e]));
    const areaMap = new Map(areas.map(a => [a.haAreaId, a]));
    const deviceMap = new Map(devices.map(d => [d.haDeviceId, d]));
    
    const enrichedImported = importedEntities
      .filter(imp => imp.visible)
      .map(imp => {
        const entity = entityMap.get(imp.entityId);
        if (!entity) return null;
        const area = entity.areaId ? areaMap.get(entity.areaId) : null;
        const device = entity.deviceId ? deviceMap.get(entity.deviceId) : null;
        return {
          ...entity,
          areaName: area?.name || null,
          deviceName: device?.name || null,
          manufacturer: device?.manufacturer || null,
          model: device?.model || null,
          controllable: imp.controllable,
          automatable: imp.automatable,
        };
      })
      .filter(Boolean);
    
    res.json(enrichedImported);
  } catch (error) {
    console.error("Error fetching imported entities:", error);
    res.status(500).json({ error: "Failed to fetch imported entities" });
  }
});

const CallServiceSchema = z.object({
  domain: z.string().min(1),
  service: z.string().min(1),
  entityId: z.string().optional(),
  serviceData: z.record(z.unknown()).optional(),
});

router.post("/command", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const body = CallServiceSchema.parse(req.body);
    
    const registration = await bridgeStorage.getBridgeRegistration(req.user.id);
    if (!registration || registration.status !== "connected") {
      return res.status(400).json({ error: "Bridge not connected" });
    }
    
    if (body.entityId) {
      const importedEntities = await bridgeStorage.getImportedEntities(req.user.id);
      const imported = importedEntities.find(e => e.entityId === body.entityId);
      if (!imported || !imported.controllable) {
        return res.status(403).json({ error: "Entity not controllable" });
      }
    }
    
    const cmdId = crypto.randomUUID();
    const { bridgeWsServer } = await import("../bridge-ws-server");
    
    const commandPayload = {
      domain: body.domain,
      service: body.service,
      target: body.entityId ? { entity_id: body.entityId } : undefined,
      service_data: body.serviceData,
    };
    
    const sent = bridgeWsServer.sendCommand(registration.bridgeId, {
      type: "command",
      cmdId,
      tenantId: String(req.user.id),
      issuedAt: new Date().toISOString(),
      commandType: "ha_call_service",
      payload: commandPayload,
      requiresAck: true,
      ttlMs: 30000,
    });
    
    if (!sent) {
      return res.status(503).json({ error: "Failed to send command to bridge" });
    }
    
    await bridgeStorage.createCommand({
      cmdId,
      userId: req.user.id,
      commandType: "ha_call_service",
      payload: commandPayload,
      requiresAck: true,
      ttlMs: 30000,
    });
    
    await bridgeStorage.createAuditEntry({
      userId: req.user.id,
      action: "command_sent",
      entityType: "command",
      entityId: cmdId,
      details: {
        domain: body.domain,
        service: body.service,
        entityId: body.entityId,
      },
      ipAddress: req.ip || null,
    });
    
    console.log(`🎮 User ${req.user.id} sent command: ${body.domain}.${body.service} ${body.entityId || ''}`);
    
    res.json({ success: true, cmdId });
  } catch (error) {
    console.error("Error sending command:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    res.status(500).json({ error: "Failed to send command" });
  }
});

// Automation endpoints
const AutomationSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  triggerType: z.enum(["time", "state", "manual"]),
  triggerConfig: z.object({
    time: z.string().optional(),
    days: z.array(z.number().min(0).max(6)).optional(),
    entityId: z.string().optional(),
    fromState: z.string().optional(),
    toState: z.string().optional(),
  }),
  conditions: z.array(z.object({
    entityId: z.string(),
    state: z.string(),
    operator: z.enum(["equals", "not_equals", "above", "below"]).optional(),
  })).optional(),
  actions: z.array(z.object({
    domain: z.string(),
    service: z.string(),
    entityId: z.string().optional(),
    serviceData: z.record(z.unknown()).optional(),
  })),
  isActive: z.boolean().optional(),
});

router.get("/automations", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const automations = await bridgeStorage.getAutomations(req.user.id);
    res.json(automations);
  } catch (error) {
    console.error("Error fetching automations:", error);
    res.status(500).json({ error: "Failed to fetch automations" });
  }
});

router.get("/automations/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const id = parseRequiredInt(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid automation ID" });
    
    const automation = await bridgeStorage.getAutomation(id, req.user.id);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    res.json(automation);
  } catch (error) {
    console.error("Error fetching automation:", error);
    res.status(500).json({ error: "Failed to fetch automation" });
  }
});

router.post("/automations", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const body = AutomationSchema.parse(req.body);
    
    const automation = await bridgeStorage.createAutomation({
      userId: req.user.id,
      name: body.name,
      description: body.description || null,
      triggerType: body.triggerType,
      triggerConfig: body.triggerConfig,
      conditions: body.conditions || null,
      actions: body.actions,
      isActive: body.isActive ?? true,
    });
    
    console.log(`🤖 User ${req.user.id} created automation: ${automation.name}`);
    res.status(201).json(automation);
  } catch (error) {
    console.error("Error creating automation:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    res.status(500).json({ error: "Failed to create automation" });
  }
});

router.put("/automations/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const id = parseRequiredInt(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid automation ID" });
    
    const body = AutomationSchema.partial().parse(req.body);
    const automation = await bridgeStorage.updateAutomation(id, req.user.id, body as any);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    
    console.log(`🤖 User ${req.user.id} updated automation: ${automation.name}`);
    res.json(automation);
  } catch (error) {
    console.error("Error updating automation:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.errors });
    }
    res.status(500).json({ error: "Failed to update automation" });
  }
});

router.delete("/automations/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const id = parseRequiredInt(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid automation ID" });
    
    const deleted = await bridgeStorage.deleteAutomation(id, req.user.id);
    if (!deleted) return res.status(404).json({ error: "Automation not found" });
    
    console.log(`🤖 User ${req.user.id} deleted automation ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting automation:", error);
    res.status(500).json({ error: "Failed to delete automation" });
  }
});

router.post("/automations/:id/toggle", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const id = parseRequiredInt(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid automation ID" });
    
    const existing = await bridgeStorage.getAutomation(id, req.user.id);
    if (!existing) return res.status(404).json({ error: "Automation not found" });
    
    const automation = await bridgeStorage.setAutomationActive(id, req.user.id, !existing.isActive);
    console.log(`🤖 User ${req.user.id} toggled automation ${id} to ${automation?.isActive ? 'active' : 'inactive'}`);
    res.json(automation);
  } catch (error) {
    console.error("Error toggling automation:", error);
    res.status(500).json({ error: "Failed to toggle automation" });
  }
});

router.post("/automations/:id/run", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const id = parseRequiredInt(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid automation ID" });
    
    const automation = await bridgeStorage.getAutomation(id, req.user.id);
    if (!automation) return res.status(404).json({ error: "Automation not found" });
    
    const registration = await bridgeStorage.getBridgeRegistration(req.user.id);
    if (!registration || registration.status !== "connected") {
      return res.status(400).json({ error: "Bridge not connected" });
    }
    
    const { bridgeWsServer } = await import("../bridge-ws-server");
    const actions = automation.actions as Array<{ domain: string; service: string; entityId?: string; serviceData?: Record<string, unknown> }>;
    const results: Array<{ cmdId: string; action: unknown }> = [];
    
    for (const action of actions) {
      const cmdId = crypto.randomUUID();
      const commandPayload = {
        domain: action.domain,
        service: action.service,
        target: action.entityId ? { entity_id: action.entityId } : undefined,
        service_data: action.serviceData,
      };
      
      const sent = bridgeWsServer.sendCommand(registration.bridgeId, {
        type: "command",
        cmdId,
        tenantId: String(req.user.id),
        issuedAt: new Date().toISOString(),
        commandType: "ha_call_service",
        payload: commandPayload,
        requiresAck: true,
        ttlMs: 30000,
      });
      
      if (sent) {
        await bridgeStorage.createCommand({
          cmdId,
          userId: req.user.id,
          commandType: "ha_call_service",
          payload: commandPayload,
          requiresAck: true,
          ttlMs: 30000,
          automationId: automation.id,
        });
        results.push({ cmdId, action });
      }
    }
    
    await bridgeStorage.recordAutomationTriggered(automation.id, "manual_run");
    console.log(`🤖 User ${req.user.id} manually ran automation ${automation.name}, executed ${results.length} actions`);
    res.json({ success: true, actionsExecuted: results.length, results });
  } catch (error) {
    console.error("Error running automation:", error);
    res.status(500).json({ error: "Failed to run automation" });
  }
});

// Dashboard stats endpoint
router.get("/dashboard-stats", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    
    const stats = await bridgeStorage.getDashboardStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

// Diagnostics export endpoint
router.get("/diagnostics", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    
    const diagnostics = await bridgeStorage.getDiagnosticsData(req.user.id);
    
    // Set headers for JSON download
    const filename = `helm-bridge-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    res.json({
      exportVersion: "1.0",
      exportedAt: diagnostics.generatedAt,
      bridge: diagnostics.registration ? {
        bridgeId: diagnostics.registration.bridgeId,
        bridgeVersion: diagnostics.registration.bridgeVersion,
        protocolVersion: diagnostics.registration.protocolVersion,
        haVersion: diagnostics.registration.haVersion,
        status: diagnostics.registration.status,
        lastHeartbeat: diagnostics.registration.lastHeartbeat,
        lastFullSync: diagnostics.registration.lastFullSync,
        reconnectCount: diagnostics.registration.reconnectCount,
      } : null,
      counts: {
        entities: diagnostics.entityCount,
        devices: diagnostics.deviceCount,
        areas: diagnostics.areaCount,
        automations: diagnostics.automationCount,
        importedEntities: diagnostics.importedEntityCount,
      },
      commandStats: diagnostics.commandStats,
      recentErrors: diagnostics.recentErrors,
      auditLog: diagnostics.auditLogExcerpt.map(a => ({
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        timestamp: a.createdAt,
        details: a.details,
      })),
      recentCommands: diagnostics.recentCommands.map(c => ({
        cmdId: c.cmdId,
        commandType: c.commandType,
        status: c.status,
        issuedAt: c.issuedAt,
        completedAt: c.completedAt,
        hasError: !!c.error,
      })),
      connectionHistory: diagnostics.connectionHistory,
    });
  } catch (error) {
    console.error("Error generating diagnostics:", error);
    res.status(500).json({ error: "Failed to generate diagnostics" });
  }
});

// Audit Log endpoint
router.get("/audit-log", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    
    const { action, entityType, startDate, endDate, limit } = req.query;
    
    const options: {
      limit?: number;
      action?: string;
      entityType?: string;
      startDate?: Date;
      endDate?: Date;
    } = {};
    
    if (limit) options.limit = Math.min(parseInt(limit as string) || 100, 500);
    if (action) options.action = action as string;
    if (entityType) options.entityType = entityType as string;
    if (startDate) options.startDate = new Date(startDate as string);
    if (endDate) options.endDate = new Date(endDate as string);
    
    const auditLog = await bridgeStorage.getAuditLog(req.user.id, options);
    
    res.json({ auditLog });
  } catch (error) {
    console.error("Error fetching audit log:", error);
    res.status(500).json({ error: "Failed to fetch audit log" });
  }
});

router.get("/logs", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    
    const { bridgeWsServer } = await import("../bridge-ws-server");
    const stored = bridgeWsServer.getBridgeLogs(req.user.id);
    
    if (!stored) {
      return res.json({
        logs: [],
        diagnostics: null,
        lastReceivedAt: null,
        totalReceived: 0,
      });
    }

    const level = req.query.level as string | undefined;
    const category = req.query.category as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 1000);
    
    let filteredLogs = stored.logs;
    if (level) {
      filteredLogs = filteredLogs.filter(l => l.level === level);
    }
    if (category) {
      filteredLogs = filteredLogs.filter(l => l.category === category);
    }
    
    filteredLogs = filteredLogs.slice(-limit);
    
    res.json({
      logs: filteredLogs,
      diagnostics: stored.lastDiagnostics,
      lastReceivedAt: stored.lastReceivedAt,
      totalReceived: stored.totalReceived,
    });
  } catch (error) {
    console.error("Error fetching bridge logs:", error);
    res.status(500).json({ error: "Failed to fetch bridge logs" });
  }
});

router.post("/logs/request", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    
    const { bridgeWsServer } = await import("../bridge-ws-server");
    const requested = bridgeWsServer.requestBridgeLogs(req.user.id, 200);
    
    res.json({
      success: true,
      bridgeConnected: requested,
      message: requested 
        ? "Log request sent to bridge. Logs will arrive shortly."
        : "Bridge is not currently connected. Cannot request logs.",
    });
  } catch (error) {
    console.error("Error requesting bridge logs:", error);
    res.status(500).json({ error: "Failed to request bridge logs" });
  }
});

router.delete("/logs", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    
    const { bridgeWsServer } = await import("../bridge-ws-server");
    bridgeWsServer.clearBridgeLogs(req.user.id);
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error clearing bridge logs:", error);
    res.status(500).json({ error: "Failed to clear bridge logs" });
  }
});

export const bridgeRoutes = router;
