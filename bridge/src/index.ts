import { createServer, IncomingMessage, ServerResponse } from 'http';
import { loadConfig, BridgeConfig } from './config';
import { HARestClient } from './ha-rest-client';
import { HAWebSocketClient, HAStateChangedEvent } from './ha-ws-client';
import { CloudClient } from './cloud-client';
import { CredentialStore } from './credential-store';
import { LocalDatabase } from './local-db';
import { WebServer } from './web-server';
import type { HAArea, HADevice, HAEntity, HAService } from '../../packages/protocol/src/entities';
import type { CommandMessage } from '../../packages/protocol/src/messages';
import type { StateChangedEvent } from '../../packages/protocol/src/sync';

export interface BridgeState {
  config: BridgeConfig;
  haVersion: string;
  haConnected: boolean;
  cloudConnected: boolean;
  isPaired: boolean;
  entityCount: number;
  lastEventAt: Date | null;
  startedAt: Date;
  reconnectCount: number;
}

export interface FullSyncData {
  areas: HAArea[];
  devices: HADevice[];
  entities: HAEntity[];
  services: HAService[];
}

export class HelmBridge {
  private config: BridgeConfig;
  private restClient: HARestClient;
  private wsClient: HAWebSocketClient;
  private cloudClient: CloudClient;
  private credentialStore: CredentialStore;
  private localDb: LocalDatabase;
  private webServer: WebServer | null = null;
  private state: BridgeState;
  private entityRegistry: Map<string, unknown> = new Map();
  private stateChangeQueue: HAStateChangedEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchIntervalMs = 500;
  private historyPruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.config = loadConfig();
    this.restClient = new HARestClient(this.config);
    this.wsClient = new HAWebSocketClient(this.config);
    this.credentialStore = new CredentialStore(this.config.credentialPath);
    this.cloudClient = new CloudClient(this.config, this.credentialStore);
    
    const dataDir = process.env.DATA_DIR || '/data';
    this.localDb = new LocalDatabase(dataDir);
    
    this.state = {
      config: this.config,
      haVersion: 'unknown',
      haConnected: false,
      cloudConnected: false,
      isPaired: this.credentialStore.isPaired(),
      entityCount: 0,
      lastEventAt: null,
      startedAt: new Date(),
      reconnectCount: 0,
    };

    this.setupEventHandlers();
    this.setupCloudEventHandlers();
    this.setupHistoryPruning();
  }
  
  private setupHistoryPruning(): void {
    this.historyPruneTimer = setInterval(() => {
      const pruned = this.localDb.pruneOldHistory(30);
      if (pruned > 0) {
        console.log(`🧹 Pruned ${pruned} old state history entries`);
      }
    }, 24 * 60 * 60 * 1000);
  }

  private setupEventHandlers(): void {
    this.wsClient.on('authenticated', () => {
      console.log('🏠 Connected to Home Assistant');
      this.state.haConnected = true;
    });

    this.wsClient.on('disconnected', () => {
      console.log('🏠 Disconnected from Home Assistant');
      this.state.haConnected = false;
      this.state.reconnectCount++;
    });

    this.wsClient.on('state_changed', (event: HAStateChangedEvent) => {
      this.handleStateChange(event);
    });

    this.wsClient.on('error', (error: Error) => {
      console.error('HA WebSocket error:', error);
    });
  }

  private setupCloudEventHandlers(): void {
    this.cloudClient.on('connected', () => {
      console.log('☁️ Cloud WebSocket connected');
    });

    this.cloudClient.on('authenticated', (tenantId: string) => {
      console.log(`☁️ Authenticated with cloud, tenant: ${tenantId}`);
      this.state.cloudConnected = true;
    });

    this.cloudClient.on('disconnected', (_code: number, _reason: string) => {
      this.state.cloudConnected = false;
    });

    this.cloudClient.on('request_full_sync', async (reason?: string) => {
      console.log(`📊 Cloud requested full sync: ${reason || 'unknown reason'}`);
      await this.performFullSync();
    });

    this.cloudClient.on('command', async (command: CommandMessage) => {
      await this.handleCloudCommand(command);
    });

    this.cloudClient.on('auth_failed', (error: string) => {
      console.error('❌ Cloud auth failed:', error);
    });

    this.cloudClient.on('error', (error: Error) => {
      console.error('❌ Cloud error:', error);
    });
  }

  private async performFullSync(): Promise<void> {
    try {
      const syncData = await this.collectFullSync();
      this.cloudClient.updateStats(this.state.haVersion, syncData.entities.length, this.state.lastEventAt);
      this.cloudClient.sendFullSync(syncData);
      console.log('✅ Full sync sent to cloud');
    } catch (error) {
      console.error('❌ Failed to perform full sync:', error);
    }
  }

  private async handleCloudCommand(command: CommandMessage): Promise<void> {
    console.log(`🎮 Executing command: ${command.commandType} (${command.cmdId})`);
    
    try {
      const { domain, service, serviceData } = command.payload as {
        domain: string;
        service: string;
        serviceData?: Record<string, unknown>;
      };

      const result = await this.wsClient.callService(domain, service, serviceData || {});
      
      this.cloudClient.sendCommandResult(command.cmdId, 'completed', {
        haResponse: result as Record<string, unknown>,
      });
      
      console.log(`✅ Command ${command.cmdId} completed`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.cloudClient.sendCommandResult(command.cmdId, 'failed', undefined, {
        code: 'EXECUTION_FAILED',
        message: errorMessage,
      });
      
      console.error(`❌ Command ${command.cmdId} failed:`, errorMessage);
    }
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Helm Bridge...');
    console.log(`   Bridge ID: ${this.config.bridgeId}`);
    console.log(`   HA URL: ${this.config.haUrl}`);
    console.log(`   Cloud URL: ${this.config.cloudUrl}`);
    console.log(`   Protocol Version: ${this.config.protocolVersion}`);

    // Validate cloud URL configuration
    console.log('☁️ Validating cloud URL...');
    try {
      const cloudCheck = await fetch(`${this.config.cloudUrl}/api/bridge/pairing-codes`, {
        method: 'OPTIONS',
      }).catch(() => null);
      
      // Also try a simple GET to a known endpoint
      const statusCheck = await fetch(`${this.config.cloudUrl}/api/bridge/pairing-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bridgeId: 'test-validation', bridgeVersion: '1.0.0' }),
      }).catch(() => null);
      
      // Check if we got HTML instead of JSON (common misconfiguration)
      if (statusCheck) {
        const contentType = statusCheck.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          console.error('❌ Cloud URL appears to be misconfigured!');
          console.error(`   Expected JSON response but got: ${contentType}`);
          console.error(`   Please verify CLOUD_URL is set correctly.`);
          console.error(`   Current value: ${this.config.cloudUrl}`);
          console.log('');
          console.log('   Continuing anyway, but pairing may fail...');
          console.log('');
        } else {
          console.log('✓ Cloud URL validated');
        }
      }
    } catch (error) {
      console.warn('⚠️ Could not validate cloud URL:', error);
    }

    // Check HA connection via REST first
    console.log('📡 Checking Home Assistant connection...');
    const haConnected = await this.restClient.checkConnection();
    if (!haConnected) {
      console.error('❌ Cannot connect to Home Assistant');
      process.exit(1);
    }
    console.log('✓ REST API connection verified');

    // Get HA version
    this.state.haVersion = await this.restClient.getVersion();
    console.log(`   HA Version: ${this.state.haVersion}`);

    // Connect WebSocket for real-time updates and registry access
    console.log('🔌 Connecting to WebSocket...');
    try {
      await this.wsClient.connect();
      console.log('✓ WebSocket connected and authenticated');
    } catch (wsError) {
      console.error('❌ WebSocket connection failed:', wsError);
      throw wsError;
    }

    // Load entity registry for mapping via WebSocket
    console.log('📋 Loading entity registry...');
    try {
      const entities = await this.wsClient.getEntities() as Array<{ entity_id: string }>;
      entities.forEach(e => this.entityRegistry.set(e.entity_id, e));
      console.log(`✓ Loaded ${entities.length} entity registry entries`);
    } catch (entityError) {
      console.error('⚠️ Failed to load entity registry:', entityError);
      // Continue anyway - entity registry is optional
    }

    // Initial entity count via WebSocket
    console.log('🔍 Loading entity states...');
    try {
      const states = await this.wsClient.getStates() as unknown[];
      this.state.entityCount = states.length;
      console.log(`✓ Found ${states.length} entities`);
    } catch (statesError) {
      console.error('⚠️ Failed to load states:', statesError);
      this.state.entityCount = 0;
    }

    console.log('✅ Helm Bridge started successfully');

    // Check if already paired and connect to cloud
    if (this.credentialStore.isPaired()) {
      console.log('🔗 Bridge is already paired, connecting to cloud...');
      try {
        await this.cloudClient.connect();
      } catch (error) {
        console.error('❌ Failed to connect to cloud:', error);
      }
    } else {
      // Register pairing code with cloud and display it
      await this.requestAndDisplayPairingCode();
    }
  }

  private async requestAndDisplayPairingCode(): Promise<void> {
    console.log('🔑 Requesting pairing code from cloud...');
    
    try {
      const response = await fetch(`${this.config.cloudUrl}/api/bridge/pairing-codes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bridgeId: this.config.bridgeId,
          bridgeVersion: this.config.protocolVersion,
          haVersion: this.state.haVersion,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get pairing code: ${response.status} ${errorText}`);
      }

      const data = await response.json() as { code: string; expiresAt: string; expiresInSeconds: number };
      const pairingCode = data.code;
      const expiresInMinutes = Math.floor(data.expiresInSeconds / 60);

      console.log('');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('🔑 PAIRING CODE: ' + pairingCode);
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');
      console.log('To complete setup:');
      console.log(`1. Go to ${this.config.cloudUrl}`);
      console.log('2. Navigate to Integrations → Home Assistant');
      console.log('3. Click "Add Bridge" and enter the pairing code above');
      console.log('');
      console.log(`The pairing code expires in ${expiresInMinutes} minutes.`);
      console.log('Restart the add-on to generate a new code if needed.');
      console.log('');

      // Start polling for pairing completion
      this.pollForPairing(pairingCode);
    } catch (error) {
      console.error('❌ Failed to get pairing code:', error);
      console.log('');
      console.log('⚠️ Could not connect to Helm Cloud to generate pairing code.');
      console.log('Please ensure your internet connection is working and try restarting the add-on.');
      console.log('');
    }
  }

  private async pollForPairing(pairingCode: string): Promise<void> {
    console.log('👀 Waiting for pairing to complete...');
    
    const pollInterval = 5000; // Check every 5 seconds
    const maxAttempts = 120; // 10 minutes max
    let attempts = 0;

    const poll = async (): Promise<void> => {
      attempts++;
      
      try {
        // Check if credentials were saved locally
        if (this.credentialStore.isPaired()) {
          console.log('✅ Pairing completed! Connecting to cloud...');
          await this.cloudClient.connect();
          return;
        }

        // Poll cloud API to check if pairing code was used
        const response = await fetch(
          `${this.config.cloudUrl}/api/bridge/pairing-codes/${pairingCode}/status`
        );

        // Check content-type to ensure we got JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          console.error(`⚠️ Received non-JSON response from cloud (${contentType}). Check cloud URL configuration.`);
          if (attempts < maxAttempts) {
            setTimeout(poll, pollInterval);
          }
          return;
        }

        if (response.ok) {
          const data = await response.json() as {
            status: string;
            bridgeCredential?: string;
            tenantId?: string;
            bridgeId?: string;
            message?: string;
          };

          if (data.status === 'paired' && data.bridgeCredential) {
            console.log('✅ Pairing completed via cloud!');
            
            // Save credentials locally
            this.credentialStore.save({
              bridgeId: data.bridgeId!,
              tenantId: data.tenantId!,
              bridgeCredential: data.bridgeCredential,
            });

            // Connect to cloud
            await this.cloudClient.connect();
            return;
          } else if (data.status === 'paired') {
            // Credential already claimed - check if we're already paired locally
            if (this.credentialStore.isPaired()) {
              console.log('✅ Already paired! Connecting to cloud...');
              await this.cloudClient.connect();
              return;
            }
            // Paired but no credential available - stop polling
            console.log('⚠️ Pairing completed but credential was already claimed. Restart the add-on.');
            return;
          } else if (data.status === 'expired') {
            console.log('⏰ Pairing code expired. Restart the add-on to get a new code.');
            return;
          }
        } else if (response.status === 404) {
          // Pairing code not found - might already be used, check local credentials
          if (this.credentialStore.isPaired()) {
            console.log('✅ Already paired! Connecting to cloud...');
            await this.cloudClient.connect();
            return;
          }
        }

        if (attempts < maxAttempts) {
          setTimeout(poll, pollInterval);
        } else {
          console.log('⏰ Pairing code expired. Restart the add-on to get a new code.');
        }
      } catch (error) {
        console.error('Error checking pairing status:', error);
        if (attempts < maxAttempts) {
          setTimeout(poll, pollInterval);
        }
      }
    };

    setTimeout(poll, pollInterval);
  }

  async connectToCloud(): Promise<void> {
    if (!this.credentialStore.isPaired()) {
      throw new Error('Bridge not paired');
    }
    await this.cloudClient.connect();
  }

  private handleStateChange(event: HAStateChangedEvent): void {
    this.state.lastEventAt = new Date();
    this.stateChangeQueue.push(event);

    if (event.data.new_state) {
      this.localDb.recordStateChange(
        event.data.entity_id,
        event.data.new_state.state,
        event.data.new_state.attributes || {},
        event.context?.id || null
      );
      
      if (this.webServer) {
        this.webServer.updateCachedEntity(
          event.data.entity_id,
          event.data.new_state.state,
          event.data.new_state.attributes || {}
        );
      }
    }

    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.flushStateChanges();
      }, this.batchIntervalMs);
    }
  }

  private flushStateChanges(): void {
    if (this.stateChangeQueue.length === 0) {
      this.batchTimer = null;
      return;
    }

    const batch = [...this.stateChangeQueue];
    this.stateChangeQueue = [];
    this.batchTimer = null;

    console.log(`📦 Batched ${batch.length} state changes`);

    if (this.cloudClient.isConnected()) {
      const events: StateChangedEvent[] = batch.map(e => ({
        entityId: e.data.entity_id,
        oldState: e.data.old_state ? {
          state: e.data.old_state.state,
          attributes: e.data.old_state.attributes,
          lastChanged: e.data.old_state.last_changed,
          lastUpdated: e.data.old_state.last_updated,
        } : null,
        newState: {
          state: e.data.new_state!.state,
          attributes: e.data.new_state!.attributes,
          lastChanged: e.data.new_state!.last_changed,
          lastUpdated: e.data.new_state!.last_updated,
        },
        timestamp: new Date().toISOString(),
      }));
      
      this.cloudClient.sendStateBatch(events);
      this.cloudClient.updateStats(this.state.haVersion, this.state.entityCount, this.state.lastEventAt);
    }
  }

  async collectFullSync(): Promise<FullSyncData> {
    console.log('📊 Collecting full sync data...');

    try {
      const [areasRaw, devicesRaw, statesRaw, servicesRaw, entityRegistryRaw] = await Promise.all([
        this.wsClient.getAreas().catch(err => {
          console.error('❌ Failed to fetch areas:', err.message);
          return [];
        }),
        this.wsClient.getDevices().catch(err => {
          console.error('❌ Failed to fetch devices:', err.message);
          return [];
        }),
        this.wsClient.getStates().catch(err => {
          console.error('❌ Failed to fetch states:', err.message);
          return [];
        }),
        this.wsClient.getServices().catch(err => {
          console.error('❌ Failed to fetch services:', err.message);
          return {};
        }),
        this.wsClient.getEntities().catch(err => {
          console.error('❌ Failed to fetch entity registry:', err.message);
          return [];
        }),
      ]);

      // Update entity registry
      const entityList = Array.isArray(entityRegistryRaw) ? entityRegistryRaw : [];
      (entityList as Array<{ entity_id: string }>).forEach(e => this.entityRegistry.set(e.entity_id, e));

      // Map areas and devices (arrays from WebSocket)
      const areasList = Array.isArray(areasRaw) ? areasRaw : [];
      const devicesList = Array.isArray(devicesRaw) ? devicesRaw : [];
      const statesList = Array.isArray(statesRaw) ? statesRaw : [];

      const areas = areasList.map((a: any) => this.restClient.mapAreaToProtocol(a));
      const devices = devicesList.map((d: any) => this.restClient.mapDeviceToProtocol(d));
      const entities = statesList.map((s: any) => {
        const registry = this.entityRegistry.get(s.entity_id) as any;
        return this.restClient.mapStateToProtocol(s, registry);
      });

      // Services come as { domain: { service: def } } from WebSocket, convert to array
      const servicesDomainArray = Object.entries(servicesRaw as Record<string, unknown>).map(
        ([domain, serviceDefs]) => ({ domain, services: serviceDefs })
      );
      const services = servicesDomainArray.map(s => this.restClient.mapServiceToProtocol(s));

      console.log(`   Areas: ${areas.length}`);
      console.log(`   Devices: ${devices.length}`);
      console.log(`   Entities: ${entities.length}`);
      console.log(`   Service domains: ${services.length}`);

      this.state.entityCount = entities.length;

      return { areas, devices, entities, services };
    } catch (error) {
      console.error('❌ Full sync collection failed:', error);
      throw error;
    }
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    console.log(`🎮 Calling service: ${domain}.${service}`);
    return this.wsClient.callService(domain, service, data);
  }

  getState(): BridgeState {
    return { ...this.state };
  }

  getCredentialStore(): CredentialStore {
    return this.credentialStore;
  }

  getConfig(): BridgeConfig {
    return this.config;
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping Helm Bridge...');
    
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.flushStateChanges();
    }
    
    if (this.historyPruneTimer) {
      clearInterval(this.historyPruneTimer);
    }

    this.cloudClient.disconnect();
    this.wsClient.disconnect();
    this.localDb.close();
    console.log('✅ Helm Bridge stopped');
  }

  startWebServer(port: number = 8098): void {
    this.webServer = new WebServer({
      port,
      db: this.localDb,
      wsClient: this.wsClient,
    });
    this.webServer.start();
  }

  startHealthServer(port: number = 8099): void {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/health') {
        const health = {
          status: 'ok',
          haConnected: this.state.haConnected,
          cloudConnected: this.state.cloudConnected,
          isPaired: this.state.isPaired,
          entityCount: this.state.entityCount,
          uptime: Math.floor((Date.now() - this.state.startedAt.getTime()) / 1000),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      } else if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getState()));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    
    server.listen(port, () => {
      console.log(`🏥 Health server listening on port ${port}`);
    });
  }
}

// Main entry point
const bridge = new HelmBridge();

// Start health check server for Docker/container environments
bridge.startHealthServer(parseInt(process.env.HEALTH_PORT || '8099'));

// Start the web UI server for device management
bridge.startWebServer(parseInt(process.env.WEB_PORT || '8098'));

process.on('SIGINT', async () => {
  await bridge.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bridge.stop();
  process.exit(0);
});

bridge.start().catch((error) => {
  console.error('❌ Bridge startup failed:', error);
  process.exit(1);
});

export { bridge };
