import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, authenticateToken, requireAdmin, generateSSEToken, type AuthenticatedRequest } from "./auth";
import { insertDeviceSchema, insertRoutineSchema, insertFeedbackSchema } from "@shared/schema";
import { Server as SocketIOServer } from "socket.io";
import { hueIntegration } from "./integrations/hue";
import { alexaIntegration } from "./integrations/alexa";
import { smartThingsIntegration } from "./integrations/smartthings";
import { databaseAdminRoutes } from "./routes/database-admin";
import { deviceDeduplicationRoutes } from "./routes/device-deduplication";
import { roomDeduplicationRoutes } from "./routes/room-deduplication";
import { workSessionRoutes, closeStaleWorkSessions } from "./routes/work-sessions";
import { bridgeRoutes } from "./routes/bridge";
import deviceLinksRoutes from "./routes/device-links";
import { bridgeWsServer } from "./bridge-ws-server";
import { automationScheduler } from "./automation-scheduler";
import { routineScheduler } from "./routine-scheduler";
import { tokenRefreshScheduler } from "./services/token-refresh-scheduler";
import { registerAIAssistantRoutes } from "./routes/ai-assistant";
import activityRoutes from "./routes/activity";
import energyRoutes from "./routes/energy";
import householdRoutes from "./routes/household";
import notificationsRoutes from "./routes/notifications";
import geofencingRoutes from "./routes/geofencing";
import sceneSchedulingRoutes from "./routes/scene-scheduling";
import dashboardWidgetsRoutes from "./routes/dashboard-widgets";
import integrationHealthRoutes from "./routes/integration-health";
import { safeParseInt, safeParseIntBounded, parseRequiredInt } from "./utils/validation";

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication (email/password + Google OAuth)
  setupAuth(app);

  // Test endpoint to verify routing works
  app.get('/api/integrations/alexa/test', (req, res) => {
    console.log('🧪 ALEXA TEST ENDPOINT HIT!');
    res.json({ 
      message: 'Alexa routing works!', 
      timestamp: new Date().toISOString(),
      url: req.url 
    });
  });

  // SSE Token endpoint - exchanges JWT for short-lived SSE-specific token
  // This mitigates the security risk of long-lived tokens in query parameters
  app.post('/api/auth/sse-token', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      
      const sseToken = generateSSEToken(req.user.id, req.user.email, req.user.name);
      res.json({ token: sseToken, expiresIn: 60 });
    } catch (error) {
      console.error('Error generating SSE token:', error);
      res.status(500).json({ error: 'Failed to generate SSE token' });
    }
  });

  // Alexa OAuth endpoints - MUST BE FIRST to avoid auth middleware conflicts
  app.get('/api/integrations/alexa/auth', async (req, res) => {
    console.log('🔥 ALEXA AUTH ENDPOINT HIT!', { 
      url: req.url, 
      method: req.method, 
      query: req.query,
      timestamp: new Date().toISOString()
    });
    
    try {
      const { client_id, redirect_uri, state, response_type, scope } = req.query;
      
      console.log('Alexa OAuth authorization request:', { client_id, redirect_uri, state, response_type, scope });
      
      // Validate required parameters
      if (!client_id || !redirect_uri || !state || response_type !== 'code') {
        console.log('❌ Missing required parameters');
        return res.status(400).json({ 
          error: 'invalid_request',
          error_description: 'Missing or invalid required parameters'
        });
      }
      
      // Generate authorization code and redirect back to Alexa
      const authCode = `helm_auth_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const callbackUrl = new URL(redirect_uri as string);
      callbackUrl.searchParams.set('code', authCode);
      callbackUrl.searchParams.set('state', state as string);
      
      console.log('✅ Redirecting back to Alexa with auth code:', authCode);
      res.redirect(callbackUrl.toString());
    } catch (error) {
      console.error('❌ Error in Alexa OAuth auth endpoint:', error);
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.post('/api/integrations/alexa/token', async (req, res) => {
    console.log('🔥 ALEXA TOKEN ENDPOINT HIT!', { 
      method: req.method, 
      grant_type: req.body?.grant_type,
      timestamp: new Date().toISOString()
    });
    
    try {
      const { grant_type, code, client_id, client_secret, redirect_uri } = req.body;
      
      // Validate client credentials  
      const expectedClientId = process.env.ALEXA_CLIENT_ID || 'alexa-helm-client-2025';
      if (client_id !== expectedClientId) {
        console.log('❌ Invalid client ID');
        return res.status(401).json({ error: 'invalid_client' });
      }
      
      if (grant_type === 'authorization_code') {
        const accessToken = `helm_alexa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const refreshToken = `helm_refresh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        console.log('✅ Alexa token issued successfully');
        
        res.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: refreshToken,
          scope: 'alexa::all'
        });
      } else if (grant_type === 'refresh_token') {
        const newAccessToken = `helm_alexa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        res.json({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'alexa::all'
        });
      } else {
        console.log('❌ Unsupported grant type:', grant_type);
        res.status(400).json({ error: 'unsupported_grant_type' });
      }
    } catch (error) {
      console.error('❌ Error in Alexa token endpoint:', error);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // Admin routes (require admin role)
  app.get("/api/admin/users", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.put("/api/admin/users/:id/role", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = parseRequiredInt(req.params.id);
      if (userId === null) {
        return res.status(400).json({ error: "Invalid user ID" });
      }
      const { role } = req.body;
      
      if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      
      const user = await storage.updateUser(userId, { role });
      
      // Log role change
      await storage.createAuditLogEntry({
        userId: req.user!.id,
        action: 'ROLE_CHANGED',
        entityType: 'User',
        entityId: userId,
        description: `User role changed to ${role}`,
      });
      
      res.json(user);
    } catch (error) {
      console.error("Error updating user role:", error);
      res.status(500).json({ error: "Failed to update user role" });
    }
  });

  app.get("/api/admin/audit-log", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const limit = safeParseIntBounded(req.query.limit as string, 100, 1, 1000);
      const auditLog = await storage.getAuditLog(limit);
      res.json(auditLog);
    } catch (error) {
      console.error("Error fetching audit log:", error);
      res.status(500).json({ error: "Failed to fetch audit log" });
    }
  });

  app.get("/api/admin/feedback", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const feedback = await storage.getFeedback();
      console.log('Admin feedback query result:', feedback.length > 0 ? `${feedback.length} items found` : 'No feedback found');
      console.log('Sample feedback item:', feedback[0] ? {
        id: feedback[0].id,
        message: feedback[0].message?.substring(0, 50) + '...',
        hasMessage: !!feedback[0].message
      } : 'none');
      res.json(feedback);
    } catch (error) {
      console.error("Error fetching feedback:", error);
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.put("/api/admin/feedback/:id", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const feedbackId = parseRequiredInt(req.params.id);
      if (feedbackId === null) {
        return res.status(400).json({ error: "Invalid feedback ID" });
      }
      const { status, adminResponse } = req.body;
      
      const feedback = await storage.updateFeedback(feedbackId, {
        status,
        adminResponse,
        updatedAt: new Date(),
      });
      
      // Log feedback update
      await storage.createAuditLogEntry({
        userId: req.user!.id,
        action: 'FEEDBACK_UPDATED',
        entityType: 'Feedback',
        entityId: feedbackId,
        description: `Feedback marked as ${status}`,
      });
      
      res.json(feedback);
    } catch (error) {
      console.error("Error updating feedback:", error);
      res.status(500).json({ error: "Failed to update feedback" });
    }
  });

  // Cost tracking routes (admin only)
  app.get("/api/admin/costs", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const { days = 30, userId, service } = req.query;
      const costs = await storage.getCostTracking(
        userId ? parseInt(userId as string) : undefined,
        service as string,
        parseInt(days as string)
      );
      res.json(costs);
    } catch (error) {
      console.error("Error fetching costs:", error);
      res.status(500).json({ error: "Failed to fetch cost data" });
    }
  });

  app.get("/api/admin/costs/users", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const { days = 30 } = req.query;
      const userCosts = await storage.getAllUsersCosts(parseInt(days as string));
      res.json(userCosts);
    } catch (error) {
      console.error("Error fetching user costs:", error);
      res.status(500).json({ error: "Failed to fetch user cost data" });
    }
  });

  app.get("/api/admin/costs/monthly/:userId", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = parseRequiredInt(req.params.userId);
      if (userId === null) {
        return res.status(400).json({ error: "Invalid user ID" });
      }
      const months = safeParseIntBounded(req.query.months as string, 6, 1, 24);
      const monthlyCosts = await storage.getUserMonthlyCosts(userId, months);
      res.json(monthlyCosts);
    } catch (error) {
      console.error("Error fetching monthly costs:", error);
      res.status(500).json({ error: "Failed to fetch monthly cost data" });
    }
  });

  // Apply Hue scene to devices in a room
  app.post('/api/scenes/apply/:routineId', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const routineId = parseRequiredInt(req.params.routineId);
      if (routineId === null) {
        return res.status(400).json({ error: 'Invalid routine ID' });
      }
      const { room, deviceId } = req.body;

      // Get the routine (scene)
      const routine = await storage.getRoutine(routineId);
      if (!routine || routine.userId !== req.user.id) {
        return res.status(404).json({ error: 'Scene not found' });
      }

      // Apply scene to room devices or specific device
      let devicesUpdated = 0;
      if (room) {
        // Apply to all lights in the room
        const roomDevices = await storage.getDevices(req.user!.id);
        const roomLights = roomDevices.filter((d: any) => 
          d.room?.toLowerCase() === room.toLowerCase() && d.type === 'lights'
        );
        
        for (const device of roomLights) {
          await storage.updateDevice(device.id, {
            stateJson: {
              ...(device.stateJson as any),
              on: true,
              brightness: 80, // Default scene brightness
            },
            lastUpdated: new Date()
          });
          devicesUpdated++;
        }
      } else if (deviceId) {
        // Apply to specific device
        const device = await storage.getDevice(deviceId);
        if (device && device.userId === req.user.id) {
          await storage.updateDevice(device.id, {
            stateJson: {
              ...(device.stateJson as any),
              on: true,
              brightness: 80,
            },
            lastUpdated: new Date()
          });
          devicesUpdated = 1;
        }
      }

      // Create audit log
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'SCENE_APPLIED',
        entityType: 'Routine',
        entityId: routine.id,
        description: `Applied scene "${routine.name}" ${room ? `to room "${room}"` : deviceId ? 'to device' : ''}`,
      });

      res.json({ 
        success: true, 
        message: `Scene "${routine.name}" applied successfully`,
        routine: routine.name,
        devicesUpdated
      });

    } catch (error) {
      console.error('Apply scene error:', error);
      res.status(500).json({ error: 'Failed to apply scene' });
    }
  });

  // Device routes
  app.get("/api/devices", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const devices = await storage.getDevices(req.user.id);
      res.json(devices);
    } catch (error) {
      console.error("Error fetching devices:", error);
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  });

  app.get("/api/devices/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const deviceId = parseRequiredInt(req.params.id);
      if (deviceId === null) {
        return res.status(400).json({ error: "Invalid device ID" });
      }
      const device = await storage.getDevice(deviceId);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Check if user owns this device
      if (device.userId !== req.user?.id && req.user?.role !== 'admin') {
        return res.status(403).json({ error: "Access denied" });
      }
      
      res.json(device);
    } catch (error) {
      console.error("Error fetching device:", error);
      res.status(500).json({ error: "Failed to fetch device" });
    }
  });

  app.post("/api/devices", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const validatedData = insertDeviceSchema.parse({
        ...req.body,
        userId: req.user.id,
      });

      const device = await storage.createDevice(validatedData);
      
      // Log device creation
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'DEVICE_CREATED',
        entityType: 'Device',
        entityId: device.id,
        description: `Created device: ${device.name}`,
      });

      res.json(device);
    } catch (error) {
      console.error("Error creating device:", error);
      res.status(500).json({ error: "Failed to create device" });
    }
  });

  app.put("/api/devices/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const deviceId = parseRequiredInt(req.params.id);
      if (deviceId === null) {
        return res.status(400).json({ error: "Invalid device ID" });
      }
      const existingDevice = await storage.getDevice(deviceId);
      
      if (!existingDevice) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Check if user owns this device
      if (existingDevice.userId !== req.user?.id && req.user?.role !== 'admin') {
        return res.status(403).json({ error: "Access denied" });
      }

      const updateData = req.body;
      console.log('Device update request:', { deviceId, updateData, userId: req.user!.id });

      // If it's a Hue device, send commands to Hue API
      if (existingDevice.integration === 'hue' && existingDevice.type === 'lights') {
        console.log('Updating Hue device via API');
        
        // Send state change to Hue
        const result = await hueIntegration.setLightState(req.user!.id, existingDevice.externalId!, updateData);
        if (result && result.error) {
          return res.status(500).json({ error: result.error });
        }
      }

      // If it's a SmartThings device, send commands to SmartThings API
      if (existingDevice.integration === 'smartthings') {
        console.log('Updating SmartThings device via API');
        
        // Send state change to SmartThings
        const result = await smartThingsIntegration.controlDevice(req.user!.id, existingDevice.externalId!, updateData);
        if (result && result.error) {
          return res.status(500).json({ error: result.error });
        }
      }

      // Update local database - ensure proper date handling
      const sanitizedUpdate = {
        ...updateData,
        lastUpdated: new Date()
      };

      const device = await storage.updateDevice(deviceId, sanitizedUpdate);
      console.log('Device updated successfully:', device.id);
      
      // Log device update
      await storage.createAuditLogEntry({
        userId: req.user?.id || null,
        action: 'DEVICE_UPDATED',
        entityType: 'Device',
        entityId: device.id,
        description: `Updated device: ${device.name}`,
      });

      res.json(device);
    } catch (error) {
      console.error("Error updating device:", error);
      res.status(500).json({ error: "Failed to update device" });
    }
  });

  app.delete("/api/devices/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const deviceId = parseRequiredInt(req.params.id);
      if (deviceId === null) {
        return res.status(400).json({ error: "Invalid device ID" });
      }
      const existingDevice = await storage.getDevice(deviceId);
      
      if (!existingDevice) {
        return res.status(404).json({ error: "Device not found" });
      }
      
      // Check if user owns this device
      if (existingDevice.userId !== req.user?.id && req.user?.role !== 'admin') {
        return res.status(403).json({ error: "Access denied" });
      }

      await storage.deleteDevice(deviceId);
      
      // Log device deletion
      await storage.createAuditLogEntry({
        userId: req.user?.id || null,
        action: 'DEVICE_DELETED',
        entityType: 'Device',
        entityId: deviceId,
        description: `Deleted device: ${existingDevice.name}`,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting device:", error);
      res.status(500).json({ error: "Failed to delete device" });
    }
  });

  // Device deduplication routes
  app.post("/api/devices/analyze-duplicates", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      console.log('Analyzing duplicates for user:', req.user.id);
      
      // Import the deduplication service dynamically
      const { DeviceDeduplicationService } = await import('./device-deduplication');
      const deduplicationService = new DeviceDeduplicationService();
      
      // Get all user devices
      const devices = await storage.getDevices(req.user.id);
      console.log('Found devices for analysis:', devices.length);
      
      // Group devices by potential duplicates
      const duplicateGroups = [];
      const processedDevices = new Set();
      
      for (const device of devices) {
        if (processedDevices.has(device.id)) continue;
        
        const duplicates = [];
        for (const otherDevice of devices) {
          if (device.id === otherDevice.id || processedDevices.has(otherDevice.id)) continue;
          
          // Find potential matches using the deduplication service
          const deviceForAnalysis = {
            userId: req.user.id,
            name: otherDevice.name,
            type: otherDevice.type,
            integration: otherDevice.integration,
            externalId: otherDevice.externalId,
            brand: otherDevice.brand,
            model: otherDevice.model,
            room: otherDevice.room,
            status: otherDevice.status,
            value: otherDevice.value,
            subtype: otherDevice.subtype,
            category: otherDevice.category,
            isActive: otherDevice.isActive,
            isFavorite: otherDevice.isFavorite,
            capabilities: otherDevice.capabilities as any,
            metadata: otherDevice.metadata as any,
            stateJson: otherDevice.stateJson as any,
            lastUpdated: otherDevice.lastUpdated,
            lastSeen: otherDevice.lastSeen,
            healthScore: otherDevice.healthScore
          };
          const match = await deduplicationService.findExistingDevice(deviceForAnalysis, req.user.id);
          
          if (match && match.existingDevice.id === device.id) {
            duplicates.push(otherDevice);
            processedDevices.add(otherDevice.id);
          }
        }
        
        if (duplicates.length > 0) {
          // Create device object for analysis to get confidence and matchedBy
          const deviceForGroupAnalysis = {
            userId: req.user.id,
            name: device.name,
            type: device.type,
            integration: device.integration,
            externalId: device.externalId,
            brand: device.brand,
            model: device.model,
            room: device.room,
            status: device.status,
            value: device.value,
            subtype: device.subtype,
            category: device.category,
            isActive: device.isActive,
            isFavorite: device.isFavorite,
            capabilities: device.capabilities as any,
            metadata: device.metadata as any,
            stateJson: device.stateJson as any,
            lastUpdated: device.lastUpdated,
            lastSeen: device.lastSeen,
            healthScore: device.healthScore
          };
          
          // Use the first match's confidence and attributes for the group
          const firstMatch = await deduplicationService.findExistingDevice(deviceForGroupAnalysis, req.user.id);
          duplicateGroups.push({
            confidence: firstMatch?.confidence || 'medium',
            devices: [device, ...duplicates],
            matchedBy: firstMatch?.matchedBy || ['name', 'type']
          });
          processedDevices.add(device.id);
        }
      }
      
      console.log('Found duplicate groups:', duplicateGroups.length);
      
      res.json({ 
        duplicateGroups,
        totalDevices: devices.length,
        analysisComplete: true 
      });
      
    } catch (error) {
      console.error("Error analyzing device duplicates:", error);
      res.status(500).json({ error: "Failed to analyze device duplicates" });
    }
  });

  app.post("/api/devices/merge-duplicates", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { groups } = req.body;
      
      // Validate input
      if (!Array.isArray(groups)) {
        return res.status(400).json({ error: "Groups must be an array" });
      }
      
      console.log('Merging duplicate groups for user:', req.user.id, 'Groups:', groups.length);
      
      let mergedDevices = 0;
      
      for (const group of groups) {
        if (!group.selectedPrimary || !Array.isArray(group.devices)) continue;
        
        // Verify all devices belong to the current user
        for (const device of group.devices) {
          const dbDevice = await storage.getDevice(device.id);
          if (!dbDevice || dbDevice.userId !== req.user.id) {
            return res.status(403).json({ error: "Access denied to device" });
          }
        }
        
        const primaryDevice = group.devices.find((d: any) => d.id === group.selectedPrimary);
        const duplicateDevices = group.devices.filter((d: any) => d.id !== group.selectedPrimary);
        
        if (!primaryDevice || duplicateDevices.length === 0) continue;
        
        // Merge capabilities and metadata from duplicate devices into primary
        const mergedCapabilities = new Set(primaryDevice.capabilities || []);
        let mergedMetadata = { ...primaryDevice.metadata };
        
        for (const duplicate of duplicateDevices) {
          // Add capabilities from duplicate
          if (duplicate.capabilities) {
            duplicate.capabilities.forEach((cap: string) => mergedCapabilities.add(cap));
          }
          
          // Merge metadata
          if (duplicate.metadata) {
            mergedMetadata = { ...mergedMetadata, ...duplicate.metadata };
          }
          
          // Delete the duplicate device
          await storage.deleteDevice(duplicate.id);
          mergedDevices++;
          
          // Log the merge
          await storage.createAuditLogEntry({
            userId: req.user.id,
            action: 'DEVICE_MERGED',
            entityType: 'Device',
            entityId: duplicate.id,
            description: `Merged device "${duplicate.name}" into "${primaryDevice.name}"`,
          });
        }
        
        // Update primary device with merged data
        await storage.updateDevice(primaryDevice.id, {
          capabilities: Array.from(mergedCapabilities),
          metadata: mergedMetadata,
          lastUpdated: new Date()
        });
        
        console.log(`Merged ${duplicateDevices.length} devices into primary device ${primaryDevice.id}`);
      }
      
      console.log('Total merged devices:', mergedDevices);
      
      res.json({ 
        success: true,
        mergedDevices,
        groupsProcessed: groups.length
      });
      
    } catch (error) {
      console.error("Error merging device duplicates:", error);
      res.status(500).json({ error: "Failed to merge device duplicates" });
    }
  });

  // Routine routes
  app.get("/api/routines", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const routines = await storage.getRoutines(req.user.id);
      res.json(routines);
    } catch (error) {
      console.error("Error fetching routines:", error);
      res.status(500).json({ error: "Failed to fetch routines" });
    }
  });

  app.post("/api/routines", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const validatedData = insertRoutineSchema.parse({
        ...req.body,
        userId: req.user.id,
      });

      const routine = await storage.createRoutine(validatedData);
      
      // Log routine creation
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'ROUTINE_CREATED',
        entityType: 'Routine',
        entityId: routine.id,
        description: `Created routine: ${routine.name}`,
      });

      res.json(routine);
    } catch (error) {
      console.error("Error creating routine:", error);
      res.status(500).json({ error: "Failed to create routine" });
    }
  });

  app.put("/api/routines/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const routineId = parseRequiredInt(req.params.id);
      if (routineId === null) {
        return res.status(400).json({ error: "Invalid routine ID" });
      }
      const existingRoutine = await storage.getRoutine(routineId);
      
      if (!existingRoutine) {
        return res.status(404).json({ error: "Routine not found" });
      }
      
      // Check if user owns this routine
      if (existingRoutine.userId !== req.user?.id && req.user?.role !== 'admin') {
        return res.status(403).json({ error: "Access denied" });
      }

      const routine = await storage.updateRoutine(routineId, req.body);
      
      // Log routine update
      await storage.createAuditLogEntry({
        userId: req.user?.id || null,
        action: 'ROUTINE_UPDATED',
        entityType: 'Routine',
        entityId: routine.id,
        description: `Updated routine: ${routine.name}`,
      });

      res.json(routine);
    } catch (error) {
      console.error("Error updating routine:", error);
      res.status(500).json({ error: "Failed to update routine" });
    }
  });

  app.delete("/api/routines/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const routineId = parseRequiredInt(req.params.id);
      if (routineId === null) {
        return res.status(400).json({ error: "Invalid routine ID" });
      }
      const existingRoutine = await storage.getRoutine(routineId);
      
      if (!existingRoutine) {
        return res.status(404).json({ error: "Routine not found" });
      }
      
      // Check if user owns this routine
      if (existingRoutine.userId !== req.user?.id && req.user?.role !== 'admin') {
        return res.status(403).json({ error: "Access denied" });
      }

      await storage.deleteRoutine(routineId);
      
      // Log routine deletion
      await storage.createAuditLogEntry({
        userId: req.user?.id || null,
        action: 'ROUTINE_DELETED',
        entityType: 'Routine',
        entityId: routineId,
        description: `Deleted routine: ${existingRoutine.name}`,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting routine:", error);
      res.status(500).json({ error: "Failed to delete routine" });
    }
  });

  // Hue Integration Routes
  app.get('/api/integrations/hue/discover', async (req, res) => {
    try {
      console.log('Hue discover endpoint hit');
      // Local network bridge discovery
      const discoveryResponse = await fetch('https://discovery.meethue.com/');
      const bridges = await discoveryResponse.json();
      console.log('Discovered bridges:', bridges);
      res.setHeader('Content-Type', 'application/json');
      res.json(bridges);
    } catch (error) {
      console.error('Error discovering Hue bridges:', error);
      res.status(500).json({ error: 'Failed to discover bridges' });
    }
  });

  app.get('/api/integrations/hue/auth', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    await hueIntegration.initiateOAuth(req, res);
  });

  app.get('/api/integrations/hue/callback', async (req, res) => {
    console.log('=============== HUE OAUTH CALLBACK STARTED ===============');
    console.log('Hue callback route hit with params:', req.query);
    console.log('Callback URL being used:', req.get('host') + req.originalUrl);
    console.log('Request headers:', {
      host: req.get('host'),
      userAgent: req.get('user-agent'),
      referer: req.get('referer'),
      protocol: req.protocol
    });
    
    try {
      await hueIntegration.handleOAuthCallback(req, res);
      console.log('=============== HUE OAUTH CALLBACK COMPLETED ===============');
    } catch (error) {
      console.error('=============== HUE OAUTH CALLBACK FAILED ===============');
      console.error('Callback error:', error);
      throw error;
    }
  });

  app.post('/api/integrations/hue/import-devices', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        console.error('Import devices - No authenticated user');
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('=============== HUE DEVICE IMPORT STARTED (STAGING) ===============');
      console.log('Manual device import requested for user:', req.user.id);
      
      const batchId = `hue-all-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Stage lights, rooms, and scenes
      const lightsResult = await hueIntegration.stageLights(req.user.id, batchId);
      const roomsResult = await hueIntegration.stageRooms(req.user.id, batchId);
      const scenesResult = await hueIntegration.stageScenes(req.user.id, batchId);

      const totalStaged = lightsResult.stagedCount + roomsResult.stagedCount + scenesResult.stagedCount;
      const errors = [
        lightsResult.error,
        roomsResult.error,
        scenesResult.error
      ].filter(Boolean);
      
      console.log(`Hue device import staged: ${totalStaged} items (${lightsResult.stagedCount} lights, ${roomsResult.stagedCount} rooms, ${scenesResult.stagedCount} scenes)`);
      console.log('=============== HUE DEVICE IMPORT STAGING COMPLETED ===============');
      
      res.json({ 
        success: errors.length === 0, 
        stagedCount: totalStaged,
        batchId,
        error: errors.length > 0 ? errors.join('; ') : undefined
      });
      
    } catch (error) {
      console.error('=============== HUE DEVICE IMPORT FAILED ===============');
      console.error("Error importing Hue devices:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to import devices", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/hue/import-rooms', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        console.error('Import rooms - No authenticated user');
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('=============== HUE ROOM IMPORT STARTED ===============');
      console.log('Manual room import requested for user:', req.user.id);
      
      const result = await hueIntegration.importRooms(req.user.id);
      
      console.log('Hue room import completed, rooms added:', result);
      console.log('=============== HUE ROOM IMPORT COMPLETED ===============');
      
      res.json({ success: true, roomsAdded: result || 0 });
      
    } catch (error) {
      console.error('=============== HUE ROOM IMPORT FAILED ===============');
      console.error("Error importing Hue rooms:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to import rooms", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/hue/import-scenes', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        console.error('Import scenes - No authenticated user');
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('=============== HUE SCENE IMPORT STARTED ===============');
      console.log('Manual scene import requested for user:', req.user.id);
      
      const result = await hueIntegration.importScenes(req.user.id);
      
      console.log('Hue scene import completed, scenes added:', result);
      console.log('=============== HUE SCENE IMPORT COMPLETED ===============');
      
      res.json({ success: true, scenesAdded: result || 0 });
      
    } catch (error) {
      console.error('=============== HUE SCENE IMPORT FAILED ===============');
      console.error("Error importing Hue scenes:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to import scenes", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.delete('/api/integrations/hue/devices', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        console.error('Delete all Hue devices - No authenticated user');
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('=============== HUE DELETE ALL DEVICES STARTED ===============');
      console.log('Delete all Hue devices requested for user:', req.user.id);
      
      const result = await hueIntegration.deleteAllDevices(req.user.id);
      
      console.log('Hue delete all devices completed:', result);
      console.log('=============== HUE DELETE ALL DEVICES COMPLETED ===============');
      
      res.json(result);
      
    } catch (error) {
      console.error('=============== HUE DELETE ALL DEVICES FAILED ===============');
      console.error("Error deleting all Hue devices:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to delete devices", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Hue granular import routes
  app.post('/api/integrations/hue/sync-lights', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('Hue lights sync requested for user:', req.user.id);
      const result = await hueIntegration.syncLights(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error syncing Hue lights:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync lights", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/hue/sync-rooms', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('Hue rooms sync requested for user:', req.user.id);
      const result = await hueIntegration.syncRooms(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error syncing Hue rooms:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync rooms", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/hue/sync-scenes', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('Hue scenes sync requested for user:', req.user.id);
      const result = await hueIntegration.syncScenes(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error syncing Hue scenes:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync scenes", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Hue staged import routes (for selective import with security review)
  app.post('/api/integrations/hue/stage-lights', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `hue-lights-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('Hue staged lights import requested for user:', req.user.id, 'batchId:', batchId);
      const result = await hueIntegration.stageLights(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error staging Hue lights:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to stage lights", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/hue/stage-rooms', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `hue-rooms-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('Hue staged rooms import requested for user:', req.user.id, 'batchId:', batchId);
      const result = await hueIntegration.stageRooms(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error staging Hue rooms:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to stage rooms", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/hue/stage-scenes', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `hue-scenes-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('Hue staged scenes import requested for user:', req.user.id, 'batchId:', batchId);
      const result = await hueIntegration.stageScenes(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error staging Hue scenes:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to stage scenes", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/hue/stage-all', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `hue-all-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('Hue staged import all requested for user:', req.user.id, 'batchId:', batchId);
      const result = await hueIntegration.stageAll(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error staging all Hue items:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to stage all items", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Staged import management routes
  app.get('/api/staged-imports/:batchId', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { batchId } = req.params;
      const stagedDevices = await storage.getStagedDevices(req.user.id, batchId);
      res.json({ stagedDevices });
      
    } catch (error) {
      console.error("Error getting staged imports:", error);
      res.status(500).json({ error: "Failed to get staged imports" });
    }
  });

  app.patch('/api/staged-imports/:batchId/toggle/:id', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { id } = req.params;
      const { selected } = req.body;
      
      const updated = await storage.updateStagedDevice(parseInt(id), req.user.id, { selected });
      
      if (!updated) {
        return res.status(404).json({ error: "Staged device not found or not owned by user" });
      }
      
      res.json({ success: true, stagedDevice: updated });
      
    } catch (error) {
      console.error("Error toggling staged device:", error);
      res.status(500).json({ error: "Failed to toggle selection" });
    }
  });

  app.post('/api/staged-imports/:batchId/confirm', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { batchId } = req.params;
      const result = await storage.confirmStagedImport(req.user.id, batchId);
      
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'STAGED_IMPORT_CONFIRMED',
        entityType: 'Integration',
        entityId: null,
        description: `Confirmed staged import: ${result.devicesImported} devices, ${result.routinesImported} routines`
      });
      
      res.json({ success: true, ...result });
      
    } catch (error) {
      console.error("Error confirming staged import:", error);
      res.status(500).json({ error: "Failed to confirm import" });
    }
  });

  app.delete('/api/staged-imports/:batchId', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { batchId } = req.params;
      const deleted = await storage.deleteStagedDevicesBatch(req.user.id, batchId);
      
      res.json({ success: true, deletedCount: deleted });
      
    } catch (error) {
      console.error("Error canceling staged import:", error);
      res.status(500).json({ error: "Failed to cancel import" });
    }
  });

  // Health check for Hue callback
  app.get('/api/integrations/hue/callback-test', async (req, res) => {
    res.json({ 
      message: 'Hue callback endpoint is reachable',
      timestamp: new Date().toISOString(),
      url: `${req.protocol}://${req.get('host')}${req.originalUrl.replace('-test', '')}`,
      query: req.query 
    });
  });

  // SmartThings Integration Routes
  app.get('/api/integrations/smartthings/authorize', async (req, res) => {
    try {
      const { client_id, redirect_uri, state, response_type, scope } = req.query;
      
      console.log('SmartThings OAuth authorization request:', { client_id, redirect_uri, state, response_type, scope });
      
      // Validate required parameters
      if (!client_id || !redirect_uri || !state || response_type !== 'code') {
        console.log('❌ Missing required parameters');
        return res.status(400).json({ 
          error: 'invalid_request',
          error_description: 'Missing or invalid required parameters'
        });
      }
      
      // Generate authorization code and redirect back to SmartThings
      const authCode = `helm_st_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const callbackUrl = new URL(redirect_uri as string);
      callbackUrl.searchParams.set('code', authCode);
      callbackUrl.searchParams.set('state', state as string);
      
      console.log('✅ Redirecting back to SmartThings with auth code:', authCode);
      res.redirect(callbackUrl.toString());
    } catch (error) {
      console.error('❌ Error in SmartThings OAuth auth endpoint:', error);
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.post('/api/integrations/smartthings/token', async (req, res) => {
    try {
      const { grant_type, code, client_id, client_secret, redirect_uri, refresh_token } = req.body;
      
      // Validate client credentials
      const expectedClientId = process.env.SMARTTHINGS_CLIENT_ID || 'helm-smartthings-client-2025';
      
      console.log('🔧 SmartThings token exchange request:', { 
        grant_type, 
        hasCode: !!code, 
        hasRefreshToken: !!refresh_token,
        timestamp: new Date().toISOString()
      });
      if (client_id !== expectedClientId) {
        console.log('❌ Invalid SmartThings client ID');
        return res.status(401).json({ error: 'invalid_client' });
      }
      
      if (grant_type === 'authorization_code') {
        const accessToken = `helm_st_${Date.now()}_${Math.random().toString(36).substr(2, 20)}`;
        const refreshToken = `helm_st_refresh_${Date.now()}_${Math.random().toString(36).substr(2, 20)}`;
        
        console.log('✅ SmartThings token issued successfully');
        
        res.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 86400, // 24 hours
          refresh_token: refreshToken,
          scope: 'r:devices:* x:devices:* r:locations:*'
        });
      } else if (grant_type === 'refresh_token') {
        const newAccessToken = `helm_st_${Date.now()}_${Math.random().toString(36).substr(2, 20)}`;
        
        res.json({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: 86400,
          scope: 'r:devices:* x:devices:* r:locations:*'
        });
      } else {
        console.log('❌ Unsupported grant type:', grant_type);
        res.status(400).json({ error: 'unsupported_grant_type' });
      }
    } catch (error) {
      console.error('❌ Error in SmartThings token endpoint:', error);
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.post('/api/integrations/smartthings/webhook', async (req, res) => {
    await smartThingsIntegration.handleWebhook(req, res);
  });

  app.get('/api/integrations/smartthings/auth', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    await smartThingsIntegration.initiateOAuth(req, res);
  });

  app.get('/api/integrations/smartthings/callback', async (req, res) => {
    console.log('=============== SMARTTHINGS OAUTH CALLBACK STARTED ===============');
    console.log('SmartThings callback route hit with params:', req.query);
    
    try {
      await smartThingsIntegration.handleOAuthCallback(req, res);
      console.log('=============== SMARTTHINGS OAUTH CALLBACK COMPLETED ===============');
    } catch (error) {
      console.error('=============== SMARTTHINGS OAUTH CALLBACK FAILED ===============');
      console.error('Callback error:', error);
      throw error;
    }
  });

  app.post('/api/integrations/smartthings/sync', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        console.error('SmartThings sync - No authenticated user');
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('=============== SMARTTHINGS MANUAL SYNC STARTED ===============');
      console.log('SmartThings manual sync requested for user:', req.user.id);
      
      const result = await smartThingsIntegration.syncDevices(req.user.id);
      
      console.log('SmartThings manual sync completed:', result);
      console.log('=============== SMARTTHINGS MANUAL SYNC COMPLETED ===============');
      
      res.json(result);
      
    } catch (error) {
      console.error('=============== SMARTTHINGS MANUAL SYNC FAILED ===============');
      console.error("Error syncing SmartThings devices:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync devices", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // SmartThings granular import routes
  app.post('/api/integrations/smartthings/sync-lights', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('SmartThings lights sync requested for user:', req.user.id);
      const result = await smartThingsIntegration.syncLights(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error syncing SmartThings lights:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync lights", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/smartthings/sync-rooms', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('SmartThings rooms sync requested for user:', req.user.id);
      const result = await smartThingsIntegration.syncRooms(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error syncing SmartThings rooms:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync rooms", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/smartthings/sync-scenes', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('SmartThings scenes sync requested for user:', req.user.id);
      const result = await smartThingsIntegration.syncScenes(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error syncing SmartThings scenes:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync scenes", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/smartthings/sync-rules', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('SmartThings rules sync requested for user:', req.user.id);
      const result = await smartThingsIntegration.syncRules(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error syncing SmartThings rules:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to sync rules", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // SmartThings delete all devices route
  app.post('/api/integrations/smartthings/delete-all', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      console.log('SmartThings delete all devices requested for user:', req.user.id);
      const result = await smartThingsIntegration.deleteAllDevices(req.user.id);
      res.json(result);
      
    } catch (error) {
      console.error("Error deleting all SmartThings devices:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to delete devices", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // SmartThings staged import routes (for selective import with security review)
  app.post('/api/integrations/smartthings/stage-lights', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `smartthings-lights-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('SmartThings staged lights import requested for user:', req.user.id, 'batchId:', batchId);
      const result = await smartThingsIntegration.stageLights(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error staging SmartThings lights:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to stage lights", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/smartthings/stage-rooms', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `smartthings-rooms-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('SmartThings staged rooms import requested for user:', req.user.id, 'batchId:', batchId);
      const result = await smartThingsIntegration.stageRooms(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error staging SmartThings rooms:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to stage rooms", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/smartthings/stage-scenes', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `smartthings-scenes-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('SmartThings staged scenes import requested for user:', req.user.id, 'batchId:', batchId);
      const result = await smartThingsIntegration.stageScenes(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error staging SmartThings scenes:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to stage scenes", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/api/integrations/smartthings/import-devices', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const batchId = `smartthings-all-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log('SmartThings import devices requested for user:', req.user.id, 'batchId:', batchId);
      const result = await smartThingsIntegration.stageAllDevices(req.user.id, batchId);
      res.json(result);
      
    } catch (error) {
      console.error("Error importing SmartThings devices:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to import devices", 
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Alexa Integration Routes
  app.get('/api/integrations/alexa/status', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const status = alexaIntegration.getIntegrationStatus();
      res.json(status);
    } catch (error) {
      console.error('Error getting Alexa status:', error);
      res.status(500).json({ error: 'Failed to get integration status' });
    }
  });

  // Alexa device discovery endpoint for Lambda
  app.get('/api/integrations/alexa/devices/:userId', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = parseRequiredInt(req.params.userId);
      if (userId === null) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      
      // Only allow users to access their own devices or admins to access any
      if (req.user!.id !== userId && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const { discoverDevicesForUser } = await import('./integrations/alexa-discovery');
      const endpoints = await discoverDevicesForUser(userId);
      
      res.json({
        success: true,
        deviceCount: endpoints.length,
        endpoints: endpoints
      });
    } catch (error) {
      console.error('Error discovering devices:', error);
      res.status(500).json({ 
        error: 'Failed to discover devices',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Alexa device state endpoint for Lambda
  app.get('/api/integrations/alexa/devices/:userId/:deviceId/state', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = parseRequiredInt(req.params.userId);
      if (userId === null) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      const deviceId = req.params.deviceId;
      
      // Only allow users to access their own devices or admins to access any
      if (req.user!.id !== userId && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const { getDeviceState } = await import('./integrations/alexa-discovery');
      const deviceState = await getDeviceState(userId, deviceId);
      
      res.json({
        success: true,
        ...deviceState
      });
    } catch (error) {
      console.error('Error getting device state:', error);
      res.status(500).json({ 
        error: 'Failed to get device state',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Alexa testing endpoint
  app.get('/api/integrations/alexa/test/:userId', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = parseRequiredInt(req.params.userId);
      if (userId === null) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      
      // Only allow users to test their own devices or admins to test any
      if (req.user!.id !== userId && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const { testAlexaDiscovery } = await import('./integrations/alexa-test');
      const testResults = await testAlexaDiscovery(userId);
      
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        ...testResults
      });
    } catch (error) {
      console.error('Error testing Alexa discovery:', error);
      res.status(500).json({ 
        error: 'Failed to test Alexa discovery',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Alexa OAuth endpoints moved to top of file to avoid conflicts

  app.get('/api/integrations/alexa/userinfo', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      // This would be called by Alexa to get user information during Account Linking
      res.json({
        user_id: req.user!.id.toString(),
        email: req.user!.email,
        name: req.user!.name || req.user!.email
      });
    } catch (error) {
      console.error('Error in Alexa userinfo endpoint:', error);
      res.status(500).json({ error: 'Failed to get user info' });
    }
  });

  // Test endpoint to create sample feedback for debugging admin dashboard
  app.post('/api/test/create-sample-feedback', async (req, res) => {
    try {
      const sampleFeedback = await storage.createFeedback({
        userId: 2, // Admin user ID
        message: 'This is a test feedback message for debugging the admin dashboard. The Hue integration is not working as expected and needs investigation.',
        status: 'NEW'
      });
      res.json({ message: 'Sample feedback created', feedback: sampleFeedback });
    } catch (error) {
      console.error('Error creating sample feedback:', error);
      res.status(500).json({ error: 'Failed to create sample feedback' });
    }
  });

  app.get('/api/integrations/hue/bridges', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const bridges = await hueIntegration.getBridges(req.user!.id);
      res.json(bridges);
    } catch (error) {
      console.error('Error fetching bridges:', error);
      res.status(500).json({ error: 'Failed to fetch bridges' });
    }
  });

  app.get('/api/integrations/hue/lights', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const lights = await hueIntegration.getLights(req.user!.id);
      res.json(lights);
    } catch (error) {
      console.error('Error fetching lights:', error);
      res.status(500).json({ error: 'Failed to fetch lights' });
    }
  });

  app.put('/api/integrations/hue/lights/:lightId', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const { lightId } = req.params;
      const command = req.body;
      const result = await hueIntegration.controlLight(req.user!.id, lightId, command);
      res.json(result);
    } catch (error) {
      console.error('Error controlling light:', error);
      res.status(500).json({ error: 'Failed to control light' });
    }
  });

  app.post('/api/integrations/hue/sync', authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await hueIntegration.syncDevices(req.user!.id);
      res.json(result);
    } catch (error) {
      console.error('Error syncing devices:', error);
      res.status(500).json({ error: 'Failed to sync devices' });
    }
  });

  // Password update route
  app.put("/api/auth/password", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Current password and new password are required" });
      }

      // Import auth functions dynamically to avoid circular imports
      const authModule = await import("./auth");
      
      // Validate password strength using the same function as registration
      const passwordValidation = authModule.validatePasswordStrength(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }

      // Get current user
      const user = await storage.getUser(req.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Verify current password
      if (!(await authModule.comparePasswords(currentPassword, user.passwordHash || ''))) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      // Hash new password
      const newPasswordHash = await authModule.hashPassword(newPassword);

      // Update password
      await storage.updateUser(req.user.id, { passwordHash: newPasswordHash });

      // Log password change
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'PASSWORD_CHANGED',
        entityType: 'User',
        entityId: req.user.id,
        description: 'User changed password',
      });

      res.json({ message: "Password updated successfully" });
    } catch (error) {
      console.error("Password update error:", error);
      res.status(500).json({ error: "Failed to update password" });
    }
  });

  // Integration token routes
  app.get("/api/integrations", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const tokens = await storage.getIntegrationTokens(req.user.id);
      const devices = await storage.getDevices(req.user.id);
      
      // Transform tokens into integration status with device counts
      const integrations = tokens.map(token => {
        const deviceCount = devices.filter(d => d.integration === token.service).length;
        
        return {
          id: token.id,
          platform: token.service,
          status: token.tokenExpiry && token.tokenExpiry > new Date() ? 'connected' : 'error',
          deviceCount,
          scope: token.scope,
          tokenExpiry: token.tokenExpiry,
          createdAt: token.createdAt,
          updatedAt: token.updatedAt,
        };
      });
      
      res.json(integrations);
    } catch (error) {
      console.error("Error fetching integration tokens:", error);
      res.status(500).json({ error: "Failed to fetch integration tokens" });
    }
  });

  // Clear integration data (devices, routines) while keeping connection
  app.post("/api/integrations/:service/clear-data", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { service } = req.params;
      
      if (!service) {
        return res.status(400).json({ error: "Service parameter is required" });
      }
      
      console.log(`Clearing data for service: ${service}, user: ${req.user.id}`);
      
      // Get devices before deletion to track which ones we're removing
      const devicesToDelete = await storage.getDevices(req.user.id);
      const deviceIds = devicesToDelete
        .filter(d => d.integration === service)
        .map(d => d.id);
      
      // Delete devices for this integration
      const devicesDeleted = await storage.deleteDevicesByIntegration(req.user.id, service);
      
      // Delete routines that reference the deleted devices
      const routinesDeleted = await storage.deleteRoutinesByDeviceIds(req.user.id, deviceIds);
      
      // Log the clear action
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'INTEGRATION_DATA_CLEARED',
        entityType: 'Integration',
        entityId: null,
        description: `Cleared ${devicesDeleted} devices and ${routinesDeleted} routines for ${service} integration`,
      });
      
      console.log(`Successfully cleared ${devicesDeleted} devices and ${routinesDeleted} routines for ${service}`);
      
      res.json({
        success: true,
        devicesDeleted,
        routinesDeleted,
        message: `Successfully cleared ${devicesDeleted} devices and ${routinesDeleted} routines. Your ${service} connection is still active and ready for a fresh import.`
      });
    } catch (error) {
      console.error("Error clearing integration data:", error);
      res.status(500).json({ error: "Failed to clear integration data" });
    }
  });

  // Feedback routes
  app.get("/api/feedback", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const feedback = await storage.getUserFeedback(req.user.id);
      res.json(feedback);
    } catch (error) {
      console.error("Error fetching feedback:", error);
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.post("/api/feedback", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      const validatedData = insertFeedbackSchema.parse({
        ...req.body,
        userId: req.user?.id || null,
      });

      const feedback = await storage.createFeedback(validatedData);
      
      // Log feedback creation
      await storage.createAuditLogEntry({
        userId: req.user?.id || null,
        action: 'FEEDBACK_CREATED',
        entityType: 'Feedback',
        entityId: feedback.id,
        description: `Feedback submitted`,
      });

      res.json(feedback);
    } catch (error) {
      console.error("Error creating feedback:", error);
      res.status(500).json({ error: "Failed to create feedback" });
    }
  });

  // Admin routes
  app.get("/api/admin/users", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.get("/api/admin/feedback", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const feedback = await storage.getFeedback();
      console.log('Admin feedback query (second route):', feedback.length > 0 ? `${feedback.length} items found` : 'No feedback found');
      res.json(feedback);
    } catch (error) {
      console.error("Error fetching feedback:", error);
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.put("/api/admin/feedback/:id", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const feedbackId = parseRequiredInt(req.params.id);
      if (feedbackId === null) {
        return res.status(400).json({ error: "Invalid feedback ID" });
      }
      const feedback = await storage.updateFeedback(feedbackId, req.body);
      
      // Log admin action
      await storage.createAuditLogEntry({
        userId: req.user?.id || null,
        action: 'FEEDBACK_UPDATED',
        entityType: 'Feedback',
        entityId: feedback.id,
        description: `Admin updated feedback`,
      });

      res.json(feedback);
    } catch (error) {
      console.error("Error updating feedback:", error);
      res.status(500).json({ error: "Failed to update feedback" });
    }
  });

  app.get("/api/admin/audit", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const limit = safeParseIntBounded(req.query.limit as string, 100, 1, 1000);
      const userId = req.query.userId ? parseRequiredInt(req.query.userId as string) ?? undefined : undefined;
      
      const auditEntries = await storage.getAuditLog(limit, userId);
      res.json(auditEntries);
    } catch (error) {
      console.error("Error fetching audit log:", error);
      res.status(500).json({ error: "Failed to fetch audit log" });
    }
  });

  // Invitation Routes
  app.get("/api/invitations", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const invitationsData = await storage.getInvitationsByUser(req.user.id);
      res.json(invitationsData);
    } catch (error) {
      console.error("Error fetching invitations:", error);
      res.status(500).json({ error: "Failed to fetch invitations" });
    }
  });

  app.post("/api/invitations", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { environment, inviteeEmail, expiresInDays } = req.body;
      
      // Validate environment
      if (!['development', 'production'].includes(environment)) {
        return res.status(400).json({ error: "Environment must be 'development' or 'production'" });
      }
      
      // Generate unique invite code
      const inviteCode = `${environment.slice(0, 3)}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
      
      // Calculate expiration (default 7 days)
      const daysToExpire = expiresInDays || 7;
      const expiresAt = new Date(Date.now() + daysToExpire * 24 * 60 * 60 * 1000);
      
      const invitation = await storage.createInvitation({
        inviterId: req.user.id,
        inviteCode,
        environment,
        inviteeEmail: inviteeEmail || null,
        status: 'pending',
        expiresAt,
      });
      
      // Log invitation creation
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'INVITATION_CREATED',
        entityType: 'Invitation',
        entityId: invitation.id,
        description: `Created ${environment} invitation${inviteeEmail ? ` for ${inviteeEmail}` : ''}`,
      });
      
      res.json(invitation);
    } catch (error) {
      console.error("Error creating invitation:", error);
      res.status(500).json({ error: "Failed to create invitation" });
    }
  });

  app.get("/api/invitations/validate/:code", async (req, res) => {
    try {
      const { code } = req.params;
      
      const invitation = await storage.getInvitation(code);
      
      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found", valid: false });
      }
      
      // Check if expired
      if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
        return res.json({ 
          valid: false, 
          error: "Invitation has expired",
          environment: invitation.environment 
        });
      }
      
      // Check if already used
      if (invitation.status === 'accepted') {
        return res.json({ 
          valid: false, 
          error: "Invitation has already been used",
          environment: invitation.environment 
        });
      }
      
      res.json({ 
        valid: true, 
        environment: invitation.environment,
        inviteeEmail: invitation.inviteeEmail 
      });
    } catch (error) {
      console.error("Error validating invitation:", error);
      res.status(500).json({ error: "Failed to validate invitation", valid: false });
    }
  });

  app.post("/api/invitations/:code/accept", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { code } = req.params;
      
      const invitation = await storage.getInvitation(code);
      
      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found" });
      }
      
      // Check if already used
      if (invitation.status === 'accepted') {
        return res.status(400).json({ error: "Invitation has already been used" });
      }
      
      // Check if expired
      if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
        return res.status(400).json({ error: "Invitation has expired" });
      }
      
      // Check if inviteeEmail is set and matches the authenticated user
      if (invitation.inviteeEmail && invitation.inviteeEmail.toLowerCase() !== req.user.email.toLowerCase()) {
        return res.status(403).json({ error: "This invitation was sent to a different email address" });
      }
      
      // Mark invitation as accepted
      const updatedInvitation = await storage.updateInvitation(invitation.id, {
        status: 'accepted',
        inviteeUserId: req.user.id,
        usedAt: new Date(),
      });
      
      // Log invitation acceptance
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'INVITATION_ACCEPTED',
        entityType: 'Invitation',
        entityId: invitation.id,
        description: `Accepted invitation from user ${invitation.inviterId}`,
      });
      
      res.json({ success: true, invitation: updatedInvitation });
    } catch (error) {
      console.error("Error accepting invitation:", error);
      res.status(500).json({ error: "Failed to accept invitation" });
    }
  });

  app.delete("/api/invitations/:id", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const invitationId = parseRequiredInt(req.params.id);
      if (invitationId === null) {
        return res.status(400).json({ error: "Invalid invitation ID" });
      }
      
      // Get the invitation to verify ownership
      const existingInvitations = await storage.getInvitationsByUser(req.user.id);
      const invitation = existingInvitations.find(inv => inv.id === invitationId);
      
      if (!invitation) {
        return res.status(404).json({ error: "Invitation not found or not owned by user" });
      }
      
      await storage.deleteInvitation(invitationId);
      
      // Log invitation deletion
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'INVITATION_DELETED',
        entityType: 'Invitation',
        entityId: invitationId,
        description: `Deleted invitation`,
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting invitation:", error);
      res.status(500).json({ error: "Failed to delete invitation" });
    }
  });

  // WiFi Credentials Routes
  app.get("/api/wifi-credentials/active", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const credential = await storage.getActiveWifiCredential(req.user.id);
      res.json(credential);
    } catch (error) {
      console.error("Error fetching WiFi credentials:", error);
      res.status(500).json({ error: "Failed to fetch WiFi credentials" });
    }
  });

  app.post("/api/wifi-credentials", authenticateToken as any, async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const { networkName, password } = req.body;
      const credential = await storage.saveWifiCredential(req.user.id, networkName, password);
      
      // Log WiFi credential save
      await storage.createAuditLogEntry({
        userId: req.user.id,
        action: 'WIFI_CREDENTIAL_SAVED',
        entityType: 'WiFiCredential',
        entityId: credential.id,
        description: `WiFi credential saved for network: ${networkName}`,
      });
      
      res.json(credential);
    } catch (error) {
      console.error("Error saving WiFi credentials:", error);
      res.status(500).json({ error: "Failed to save WiFi credentials" });
    }
  });

  const httpServer = createServer(app);
  
  // Setup WebSocket for real-time updates
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-user-room', (userId: number) => {
      socket.join(`user-${userId}`);
      console.log(`User ${userId} joined their room`);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  // Store io instance for use in other parts of the app
  (app as any).io = io;

  // Setup Bridge WebSocket server for Home Assistant bridge connections
  bridgeWsServer.setup(httpServer);

  // Start automation scheduler
  automationScheduler.start();
  
  // Start routine scheduler for AI-created automations
  routineScheduler.start();

  // Start token refresh scheduler for automatic integration renewal
  tokenRefreshScheduler.start();

  // Device deduplication admin route
  app.get('/api/admin/device-deduplication/stats', authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const stats = {
        totalUsers: allUsers.length,
        userStats: [] as any[],
        globalStats: {
          totalDevices: 0,
          byIntegration: {} as Record<string, number>
        }
      };

      for (const user of allUsers) {
        const devices = await storage.getDevices(user.id);
        stats.globalStats.totalDevices += devices.length;

        devices.forEach(device => {
          stats.globalStats.byIntegration[device.integration] = 
            (stats.globalStats.byIntegration[device.integration] || 0) + 1;
        });

        stats.userStats.push({
          userId: user.id,
          email: user.email,
          deviceCount: devices.length,
          integrations: Array.from(new Set(devices.map(d => d.integration)))
        });
      }

      res.json(stats);
    } catch (error) {
      console.error('Device deduplication stats error:', error);
      res.status(500).json({ error: 'Failed to analyze device duplicates' });
    }
  });

  // Register database admin routes
  app.use(databaseAdminRoutes);
  
  // Register device deduplication routes
  app.use(deviceDeduplicationRoutes);
  
  // Register room deduplication routes
  app.use(roomDeduplicationRoutes);
  
  // Register work session routes for IRS-safe time tracking
  app.use(workSessionRoutes);
  
  // Register Home Assistant Bridge routes
  app.use("/api/bridge", bridgeRoutes);
  
  // Register device links routes (for merging devices with HA entities)
  app.use("/api/device-links", deviceLinksRoutes);
  
  // Register AI assistant routes
  registerAIAssistantRoutes(app);
  
  // Register new enhancement routes
  app.use(activityRoutes);
  app.use(energyRoutes);
  app.use(householdRoutes);
  app.use(notificationsRoutes);
  app.use(geofencingRoutes);
  app.use(sceneSchedulingRoutes);
  app.use(dashboardWidgetsRoutes);
  app.use(integrationHealthRoutes);
  
  // Start stale session cleanup interval (every minute)
  setInterval(async () => {
    try {
      const closed = await closeStaleWorkSessions();
      if (closed > 0) {
        console.log(`Closed ${closed} stale work sessions`);
      }
    } catch (error) {
      console.error('Error in stale session cleanup:', error);
    }
  }, 60000);

  return httpServer;
}
