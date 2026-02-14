import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { createHash } from 'crypto';
import { bridgeStorage } from './storage/bridge-storage';
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
} from '../packages/protocol/src/constants';
import type {
  BridgeToCloudMessage,
  CloudToBridgeMessage,
  AuthenticateMessage,
  AuthResultMessage,
  HeartbeatMessage,
  FullSyncMessage,
  CommandMessage,
  RequestFullSyncMessage,
  BridgeLogsMessage,
  DiagnosticLogEntry,
  RequestLogsMessage,
} from '../packages/protocol/src/messages';

interface BridgeDiagnostics {
  memoryUsageMB: number;
  uptimeSeconds: number;
  nodeVersion: string;
  haConnected: boolean;
  cloudConnected: boolean;
  webServerListening: boolean;
  webServerPort: number;
  entityCount: number;
  lastError: string | null;
  platform: string;
  supervisorAvailable: boolean;
}

interface StoredBridgeLogs {
  logs: DiagnosticLogEntry[];
  lastDiagnostics: BridgeDiagnostics | null;
  lastReceivedAt: Date;
  totalReceived: number;
}

interface ConnectedBridge {
  ws: WebSocket;
  bridgeId: string;
  tenantId: string;
  authenticated: boolean;
  lastHeartbeat: Date;
  reconnectCount: number;
}

function hashCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

const MAX_STORED_LOGS = 1000;

class BridgeWebSocketServer {
  private wss: WebSocketServer | null = null;
  private connectedBridges = new Map<string, ConnectedBridge>();
  private heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
  private bridgeLogStore = new Map<string, StoredBridgeLogs>();

  setup(server: Server): void {
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws/bridge',
    });

    console.log('🔌 Bridge WebSocket server initialized on /ws/bridge');

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('📡 New bridge connection');
      
      const connectionState: Partial<ConnectedBridge> = {
        ws,
        authenticated: false,
        lastHeartbeat: new Date(),
        reconnectCount: 0,
      };

      const authTimeout = setTimeout(() => {
        if (!connectionState.authenticated) {
          console.log('⏰ Bridge auth timeout');
          ws.close(4001, 'Authentication timeout');
        }
      }, 30000);

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as BridgeToCloudMessage;
          await this.handleMessage(ws, message, connectionState, authTimeout);
        } catch (error) {
          console.error('Failed to parse bridge message:', error);
          this.sendError(ws, 'PARSE_ERROR', 'Invalid message format');
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(authTimeout);
        if (connectionState.bridgeId) {
          console.log(`🔌 Bridge ${connectionState.bridgeId} disconnected: ${code} ${reason}`);
          this.connectedBridges.delete(connectionState.bridgeId);
          this.updateBridgeStatus(connectionState.tenantId!, 'disconnected');
          
          // Audit log disconnect
          if (connectionState.tenantId) {
            bridgeStorage.createAuditEntry({
              userId: parseInt(connectionState.tenantId),
              action: 'bridge_disconnected',
              entityType: 'bridge',
              entityId: connectionState.bridgeId,
              details: { code, reason: reason?.toString() },
            }).catch(err => console.error('Audit log error:', err));
          }
        }
      });

      ws.on('error', (error) => {
        console.error('Bridge WebSocket error:', error);
      });
    });

    this.heartbeatCheckInterval = setInterval(() => {
      this.checkStaleConnections();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async handleMessage(
    ws: WebSocket,
    message: BridgeToCloudMessage,
    state: Partial<ConnectedBridge>,
    authTimeout: ReturnType<typeof setTimeout>
  ): Promise<void> {
    switch (message.type) {
      case 'authenticate':
        await this.handleAuth(ws, message as AuthenticateMessage, state, authTimeout);
        break;

      case 'heartbeat':
        if (!state.authenticated) {
          this.sendError(ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
          return;
        }
        await this.handleHeartbeat(message as HeartbeatMessage, state);
        break;

      case 'full_sync':
        if (!state.authenticated) {
          this.sendError(ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
          return;
        }
        await this.handleFullSync(message as FullSyncMessage, state);
        break;

      case 'state_batch':
        if (!state.authenticated) {
          this.sendError(ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
          return;
        }
        await this.handleStateBatch(message, state);
        break;

      case 'command_ack':
        if (!state.authenticated) return;
        await this.handleCommandAck(message, state);
        break;

      case 'command_result':
        if (!state.authenticated) return;
        await this.handleCommandResult(message, state);
        break;

      case 'bridge_logs':
        if (!state.authenticated) return;
        this.handleBridgeLogs(message as BridgeLogsMessage, state);
        break;

      default:
        console.log(`Unknown message type: ${(message as any).type}`);
    }
  }

  private async handleAuth(
    ws: WebSocket,
    message: AuthenticateMessage,
    state: Partial<ConnectedBridge>,
    authTimeout: ReturnType<typeof setTimeout>
  ): Promise<void> {
    const { bridgeId, bridgeCredential, protocolVersion } = message;
    
    console.log(`🔐 Bridge ${bridgeId} authenticating...`);

    const credentialHash = hashCredential(bridgeCredential);
    const credential = await bridgeStorage.validateCredential(bridgeId, credentialHash);

    if (!credential) {
      console.log(`❌ Invalid credential for bridge ${bridgeId}`);
      const response: AuthResultMessage = {
        type: 'auth_result',
        success: false,
        error: 'Invalid or revoked credential',
      };
      ws.send(JSON.stringify(response));
      ws.close(4002, 'Authentication failed');
      
      // Audit log failed auth attempt (no userId since auth failed)
      return;
    }

    clearTimeout(authTimeout);

    state.bridgeId = bridgeId;
    state.tenantId = String(credential.userId);
    state.authenticated = true;
    state.lastHeartbeat = new Date();

    this.connectedBridges.set(bridgeId, state as ConnectedBridge);

    await bridgeStorage.updateCredentialLastUsed(credential.id);
    await this.updateBridgeStatus(state.tenantId, 'connected');

    console.log(`✅ Bridge ${bridgeId} authenticated for tenant ${state.tenantId}`);
    
    // Audit log successful authentication
    bridgeStorage.createAuditEntry({
      userId: credential.userId,
      action: 'bridge_connected',
      entityType: 'bridge',
      entityId: bridgeId,
      details: { protocolVersion },
    }).catch(err => console.error('Audit log error:', err));

    const response: AuthResultMessage = {
      type: 'auth_result',
      success: true,
      tenantId: state.tenantId,
      minProtocolVersion: PROTOCOL_VERSION,
    };
    ws.send(JSON.stringify(response));

    this.requestFullSync(ws, 'initial_connection');
  }

  private async handleHeartbeat(
    message: HeartbeatMessage,
    state: Partial<ConnectedBridge>
  ): Promise<void> {
    state.lastHeartbeat = new Date();

    if (state.tenantId) {
      await bridgeStorage.updateBridgeHeartbeat(parseInt(state.tenantId), {
        haVersion: message.haVersion,
        entityCount: message.entityCount,
        bridgeVersion: message.bridgeVersion,
      });
    }
  }

  private async handleFullSync(
    message: FullSyncMessage,
    state: Partial<ConnectedBridge>
  ): Promise<void> {
    const { areas, devices, entities, services } = message.data;
    const userId = parseInt(state.tenantId!);

    console.log(`📊 Receiving full sync from bridge ${state.bridgeId}:`);
    console.log(`   Areas: ${areas.length}, Devices: ${devices.length}`);
    console.log(`   Entities: ${entities.length}, Services: ${services.length}`);

    await bridgeStorage.storeFullSync(userId, {
      areas,
      devices,
      entities,
      services,
    });

    await bridgeStorage.updateBridgeStatusWithStats(userId, 'connected', {
      entityCount: entities.length,
      deviceCount: devices.length,
      areaCount: areas.length,
      lastFullSync: new Date(),
    });

    console.log(`✅ Full sync stored for tenant ${state.tenantId}`);
    
    // Audit log full sync
    bridgeStorage.createAuditEntry({
      userId,
      action: 'full_sync_received',
      entityType: 'bridge',
      entityId: state.bridgeId,
      details: { 
        areaCount: areas.length, 
        deviceCount: devices.length, 
        entityCount: entities.length,
        serviceCount: services.length,
      },
    }).catch(err => console.error('Audit log error:', err));
  }

  private async handleStateBatch(
    message: any,
    state: Partial<ConnectedBridge>
  ): Promise<void> {
    const userId = parseInt(state.tenantId!);
    const { events } = message.data;

    if (!events || !Array.isArray(events)) {
      console.log(`⚠️ Invalid state batch from bridge ${state.bridgeId}: no events array`);
      return;
    }

    console.log(`📦 State batch from bridge ${state.bridgeId}: ${events.length} events`);

    const changes = events.map((e: any) => ({
      entityId: e.entityId,
      newState: e.newState,
    }));
    await bridgeStorage.updateEntityStates(userId, changes);
  }

  private async handleCommandAck(
    message: any,
    state: Partial<ConnectedBridge>
  ): Promise<void> {
    const { cmdId, receivedAt } = message;
    console.log(`✓ Command ${cmdId} acknowledged by bridge ${state.bridgeId}`);
    await bridgeStorage.updateCommandStatus(cmdId, 'acknowledged', { receivedAt });
  }

  private async handleCommandResult(
    message: any,
    state: Partial<ConnectedBridge>
  ): Promise<void> {
    const { cmdId, status, completedAt, result, error } = message;
    console.log(`📋 Command ${cmdId} completed: ${status}`);
    await bridgeStorage.updateCommandStatus(cmdId, status, { completedAt, result, error });
    
    // Audit log command result
    if (state.tenantId) {
      bridgeStorage.createAuditEntry({
        userId: parseInt(state.tenantId),
        action: 'command_result',
        entityType: 'command',
        entityId: cmdId,
        details: { status, result, error },
      }).catch(err => console.error('Audit log error:', err));
    }
  }

  private handleBridgeLogs(
    message: BridgeLogsMessage,
    state: Partial<ConnectedBridge>
  ): void {
    const tenantId = state.tenantId!;
    
    let stored = this.bridgeLogStore.get(tenantId);
    if (!stored) {
      stored = {
        logs: [],
        lastDiagnostics: null,
        lastReceivedAt: new Date(),
        totalReceived: 0,
      };
      this.bridgeLogStore.set(tenantId, stored);
    }

    stored.logs.push(...message.logs);
    if (stored.logs.length > MAX_STORED_LOGS) {
      stored.logs = stored.logs.slice(-MAX_STORED_LOGS);
    }

    if (message.diagnostics) {
      stored.lastDiagnostics = message.diagnostics;
    }

    stored.lastReceivedAt = new Date();
    stored.totalReceived += message.logs.length;

    const errorCount = message.logs.filter(l => l.level === 'error' || l.level === 'fatal').length;
    if (errorCount > 0) {
      console.log(`📋 Bridge logs from ${state.bridgeId}: ${message.logs.length} entries (${errorCount} errors)`);
    }
  }

  getBridgeLogs(userId: number): StoredBridgeLogs | null {
    return this.bridgeLogStore.get(String(userId)) || null;
  }

  requestBridgeLogs(userId: number, maxEntries: number = 200): boolean {
    const tenantId = String(userId);
    const entries = Array.from(this.connectedBridges.entries());
    for (const [, bridge] of entries) {
      if (bridge.tenantId === tenantId && bridge.authenticated) {
        const message: RequestLogsMessage = {
          type: 'request_logs',
          includeDiagnostics: true,
          maxEntries,
        };
        bridge.ws.send(JSON.stringify(message));
        return true;
      }
    }
    return false;
  }

  clearBridgeLogs(userId: number): void {
    this.bridgeLogStore.delete(String(userId));
  }

  private requestFullSync(ws: WebSocket, reason: string): void {
    const message: RequestFullSyncMessage = {
      type: 'request_full_sync',
      reason,
    };
    ws.send(JSON.stringify(message));
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(JSON.stringify({
      type: 'error',
      code,
      message,
    }));
  }

  private async updateBridgeStatus(tenantId: string, status: string): Promise<void> {
    try {
      await bridgeStorage.updateBridgeStatus(parseInt(tenantId), status);
    } catch (error) {
      console.error('Failed to update bridge status:', error);
    }
  }

  private checkStaleConnections(): void {
    const now = Date.now();
    const staleThreshold = HEARTBEAT_INTERVAL_MS * 3;

    const entries = Array.from(this.connectedBridges.entries());
    for (const [bridgeId, bridge] of entries) {
      const elapsed = now - bridge.lastHeartbeat.getTime();
      if (elapsed > staleThreshold) {
        console.log(`⚠️ Bridge ${bridgeId} stale (${Math.floor(elapsed / 1000)}s), closing`);
        bridge.ws.close(4003, 'Heartbeat timeout');
        this.connectedBridges.delete(bridgeId);
      }
    }
  }

  sendCommand(bridgeId: string, command: CommandMessage, userId?: number): boolean {
    const bridge = this.connectedBridges.get(bridgeId);
    if (!bridge || !bridge.authenticated) {
      console.log(`❌ Bridge ${bridgeId} not connected`);
      return false;
    }

    bridge.ws.send(JSON.stringify(command));
    
    // Audit log command sent
    const logUserId = userId ?? (bridge.tenantId ? parseInt(bridge.tenantId) : null);
    if (logUserId) {
      const payload = command.payload as { domain?: string; service?: string; entityId?: string } | undefined;
      bridgeStorage.createAuditEntry({
        userId: logUserId,
        action: 'command_sent',
        entityType: payload?.domain || 'service',
        entityId: payload?.entityId || null,
        details: { 
          cmdId: command.cmdId,
          domain: payload?.domain,
          service: payload?.service,
          entityId: payload?.entityId,
        },
      }).catch(err => console.error('Audit log error:', err));
    }
    
    return true;
  }

  sendDisconnect(bridgeId: string, reason: string): boolean {
    const bridge = this.connectedBridges.get(bridgeId);
    if (!bridge) {
      return false;
    }

    console.log(`🔌 Sending disconnect to bridge ${bridgeId}: ${reason}`);
    
    const message: CloudToBridgeMessage = {
      type: 'disconnect',
      reason,
    };
    
    try {
      bridge.ws.send(JSON.stringify(message));
      // Close the connection after sending disconnect message
      setTimeout(() => {
        bridge.ws.close(4000, reason);
        this.connectedBridges.delete(bridgeId);
      }, 1000);
      return true;
    } catch (error) {
      console.error(`Failed to send disconnect to bridge ${bridgeId}:`, error);
      return false;
    }
  }

  disconnectBridgeByUserId(userId: number, reason: string): { bridgeId: string | null; disconnected: boolean } {
    // Find bridge by tenant ID (user ID)
    const tenantId = String(userId);
    let foundBridgeId: string | null = null;
    
    const entries = Array.from(this.connectedBridges.entries());
    for (const [bridgeId, bridge] of entries) {
      if (bridge.tenantId === tenantId) {
        foundBridgeId = bridgeId;
        this.sendDisconnect(bridgeId, reason);
        return { bridgeId, disconnected: true };
      }
    }
    
    return { bridgeId: foundBridgeId, disconnected: false };
  }

  isBridgeConnected(bridgeId: string): boolean {
    const bridge = this.connectedBridges.get(bridgeId);
    return !!bridge && bridge.authenticated;
  }

  getConnectedBridges(): string[] {
    return Array.from(this.connectedBridges.keys());
  }

  shutdown(): void {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
    }
    
    const bridges = Array.from(this.connectedBridges.values());
    for (const bridge of bridges) {
      bridge.ws.close(1001, 'Server shutting down');
    }
    
    this.connectedBridges.clear();
    
    if (this.wss) {
      this.wss.close();
    }
  }
}

export const bridgeWsServer = new BridgeWebSocketServer();
