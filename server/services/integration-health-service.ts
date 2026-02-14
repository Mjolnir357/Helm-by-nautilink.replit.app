import { storage } from '../storage';
import { bridgeStorage } from '../storage/bridge-storage';

export interface IntegrationIssue {
  integration: string;
  displayName: string;
  issue: 'token_expired' | 'token_expiring_soon' | 'refresh_failed' | 'connection_error' | 'no_devices';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  action: string;
  actionUrl: string;
  canAutoRefresh: boolean;
}

export interface IntegrationHealthStatus {
  integration: string;
  displayName: string;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  tokenExpiry: Date | null;
  tokenStatus: 'valid' | 'expiring_soon' | 'expired' | 'no_token';
  deviceCount: number;
  lastRefreshAttempt: Date | null;
  refreshResult: 'success' | 'failed' | 'not_attempted' | null;
}

export interface IntegrationHealthCheckResult {
  healthStatuses: IntegrationHealthStatus[];
  issues: IntegrationIssue[];
  hasIssuesRequiringAction: boolean;
  criticalIssueCount: number;
  warningCount: number;
}

const INTEGRATION_CONFIG: Record<string, { displayName: string; setupUrl: string }> = {
  hue: { displayName: 'Philips Hue', setupUrl: '/integrations/hue' },
  smartthings: { displayName: 'SmartThings', setupUrl: '/integrations/smartthings' },
  alexa: { displayName: 'Amazon Alexa', setupUrl: '/integrations/alexa-setup' },
  homeassistant: { displayName: 'Home Assistant', setupUrl: '/integrations/homeassistant' },
  google_home: { displayName: 'Google Home', setupUrl: '/setup-wizard' },
};

const TOKEN_EXPIRY_WARNING_DAYS = 7;

export class IntegrationHealthService {
  async checkAllIntegrations(userId: number, attemptRefresh: boolean = true): Promise<IntegrationHealthCheckResult> {
    console.log(`IntegrationHealthService: Checking all integrations for user ${userId}, attemptRefresh: ${attemptRefresh}`);
    
    const tokens = await storage.getIntegrationTokens(userId);
    const healthStatuses: IntegrationHealthStatus[] = [];
    const issues: IntegrationIssue[] = [];
    
    // Check Home Assistant Bridge separately (uses bridgeRegistrations, not tokens)
    await this.checkHomeAssistantBridge(userId, healthStatuses, issues);
    
    for (const token of tokens) {
      const serviceName = token.service.toLowerCase();
      const config = INTEGRATION_CONFIG[serviceName] || { 
        displayName: token.service, 
        setupUrl: '/setup-wizard' 
      };
      
      const now = new Date();
      const tokenExpiry = token.tokenExpiry ? new Date(token.tokenExpiry) : null;
      
      let tokenStatus: IntegrationHealthStatus['tokenStatus'] = 'no_token';
      let status: IntegrationHealthStatus['status'] = 'unknown';
      let refreshResult: IntegrationHealthStatus['refreshResult'] = 'not_attempted';
      let lastRefreshAttempt: Date | null = null;
      
      if (tokenExpiry) {
        const daysUntilExpiry = (tokenExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysUntilExpiry < 0) {
          tokenStatus = 'expired';
          status = 'critical';
          
          if (attemptRefresh && token.refreshToken) {
            console.log(`IntegrationHealthService: Attempting to refresh expired ${serviceName} token`);
            lastRefreshAttempt = new Date();
            
            try {
              const refreshed = await this.attemptTokenRefresh(userId, serviceName, token.refreshToken);
              refreshResult = refreshed ? 'success' : 'failed';
              
              if (refreshed) {
                console.log(`IntegrationHealthService: Successfully refreshed ${serviceName} token`);
                tokenStatus = 'valid';
                status = 'healthy';
              } else {
                console.log(`IntegrationHealthService: Failed to refresh ${serviceName} token`);
                issues.push({
                  integration: serviceName,
                  displayName: config.displayName,
                  issue: 'token_expired',
                  severity: 'critical',
                  message: `Your ${config.displayName} connection has expired and could not be automatically renewed.`,
                  action: 'Reconnect your account',
                  actionUrl: config.setupUrl,
                  canAutoRefresh: false,
                });
              }
            } catch (error) {
              console.error(`IntegrationHealthService: Error refreshing ${serviceName} token:`, error);
              refreshResult = 'failed';
              issues.push({
                integration: serviceName,
                displayName: config.displayName,
                issue: 'refresh_failed',
                severity: 'critical',
                message: `Failed to refresh your ${config.displayName} connection automatically.`,
                action: 'Reconnect your account',
                actionUrl: config.setupUrl,
                canAutoRefresh: false,
              });
            }
          } else if (!token.refreshToken) {
            issues.push({
              integration: serviceName,
              displayName: config.displayName,
              issue: 'token_expired',
              severity: 'critical',
              message: `Your ${config.displayName} connection has expired.`,
              action: 'Reconnect your account',
              actionUrl: config.setupUrl,
              canAutoRefresh: false,
            });
          } else {
            issues.push({
              integration: serviceName,
              displayName: config.displayName,
              issue: 'token_expired',
              severity: 'critical',
              message: `Your ${config.displayName} connection has expired.`,
              action: 'Reconnect your account',
              actionUrl: config.setupUrl,
              canAutoRefresh: true,
            });
          }
        } else if (daysUntilExpiry <= TOKEN_EXPIRY_WARNING_DAYS) {
          tokenStatus = 'expiring_soon';
          status = 'warning';
          
          if (attemptRefresh && token.refreshToken) {
            console.log(`IntegrationHealthService: Proactively refreshing ${serviceName} token (expires in ${Math.ceil(daysUntilExpiry)} days)`);
            lastRefreshAttempt = new Date();
            
            try {
              const refreshed = await this.attemptTokenRefresh(userId, serviceName, token.refreshToken);
              refreshResult = refreshed ? 'success' : 'failed';
              
              if (refreshed) {
                console.log(`IntegrationHealthService: Successfully refreshed ${serviceName} token proactively`);
                tokenStatus = 'valid';
                status = 'healthy';
              } else {
                issues.push({
                  integration: serviceName,
                  displayName: config.displayName,
                  issue: 'token_expiring_soon',
                  severity: 'warning',
                  message: `Your ${config.displayName} connection will expire in ${Math.ceil(daysUntilExpiry)} days.`,
                  action: 'Renew connection',
                  actionUrl: config.setupUrl,
                  canAutoRefresh: true,
                });
              }
            } catch (error) {
              console.error(`IntegrationHealthService: Error refreshing ${serviceName} token proactively:`, error);
              refreshResult = 'failed';
              issues.push({
                integration: serviceName,
                displayName: config.displayName,
                issue: 'token_expiring_soon',
                severity: 'warning',
                message: `Your ${config.displayName} connection will expire in ${Math.ceil(daysUntilExpiry)} days.`,
                action: 'Renew connection',
                actionUrl: config.setupUrl,
                canAutoRefresh: true,
              });
            }
          } else {
            issues.push({
              integration: serviceName,
              displayName: config.displayName,
              issue: 'token_expiring_soon',
              severity: 'warning',
              message: `Your ${config.displayName} connection will expire in ${Math.ceil(daysUntilExpiry)} days.`,
              action: 'Renew connection',
              actionUrl: config.setupUrl,
              canAutoRefresh: !!token.refreshToken,
            });
          }
        } else {
          tokenStatus = 'valid';
          status = 'healthy';
        }
      }
      
      const deviceCount = await this.getDeviceCount(userId, serviceName);
      
      healthStatuses.push({
        integration: serviceName,
        displayName: config.displayName,
        status,
        tokenExpiry,
        tokenStatus,
        deviceCount,
        lastRefreshAttempt,
        refreshResult,
      });
    }
    
    const criticalIssueCount = issues.filter(i => i.severity === 'critical').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    
    console.log(`IntegrationHealthService: Check complete. ${criticalIssueCount} critical issues, ${warningCount} warnings`);
    
    return {
      healthStatuses,
      issues,
      hasIssuesRequiringAction: criticalIssueCount > 0,
      criticalIssueCount,
      warningCount,
    };
  }
  
  private async attemptTokenRefresh(userId: number, service: string, refreshToken: string): Promise<boolean> {
    switch (service) {
      case 'hue':
        return await this.refreshHueToken(userId, refreshToken);
      case 'smartthings':
        return await this.refreshSmartThingsToken(userId, refreshToken);
      case 'alexa':
        return await this.refreshAlexaToken(userId, refreshToken);
      default:
        console.log(`IntegrationHealthService: No refresh handler for ${service}`);
        return false;
    }
  }
  
  private async refreshHueToken(userId: number, refreshToken: string): Promise<boolean> {
    try {
      const HUE_CLIENT_ID = 'c1a18450-0a1d-47e5-812b-90a2f5e2f5e5';
      const HUE_CLIENT_SECRET = process.env.HUE_CLIENT_SECRET;
      
      if (!HUE_CLIENT_SECRET) {
        console.error('IntegrationHealthService: HUE_CLIENT_SECRET not configured');
        return false;
      }
      
      const response = await fetch('https://api.meethue.com/v2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: HUE_CLIENT_ID,
          client_secret: HUE_CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
      });
      
      console.log(`IntegrationHealthService: Hue refresh response status: ${response.status}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`IntegrationHealthService: Hue refresh failed: ${errorText}`);
        return false;
      }
      
      const data = await response.json();
      
      if (!data.access_token) {
        console.error('IntegrationHealthService: No access_token in Hue refresh response');
        return false;
      }
      
      await storage.upsertIntegrationToken({
        userId,
        service: 'hue',
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        tokenExpiry: new Date(Date.now() + (data.expires_in * 1000)),
        scope: data.scope || 'entertainment',
      });
      
      console.log('IntegrationHealthService: Hue token refreshed successfully');
      return true;
    } catch (error) {
      console.error('IntegrationHealthService: Hue token refresh error:', error);
      return false;
    }
  }
  
  private async refreshSmartThingsToken(userId: number, refreshToken: string): Promise<boolean> {
    try {
      const SMARTTHINGS_CLIENT_ID = process.env.SMARTTHINGS_CLIENT_ID;
      const SMARTTHINGS_CLIENT_SECRET = process.env.SMARTTHINGS_CLIENT_SECRET;
      
      if (!SMARTTHINGS_CLIENT_ID || !SMARTTHINGS_CLIENT_SECRET) {
        console.error('IntegrationHealthService: SmartThings credentials not configured');
        return false;
      }
      
      console.log('IntegrationHealthService: Attempting SmartThings token refresh');
      
      const response = await fetch('https://api.smartthings.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${SMARTTHINGS_CLIENT_ID}:${SMARTTHINGS_CLIENT_SECRET}`).toString('base64')}`
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      
      console.log(`IntegrationHealthService: SmartThings refresh response status: ${response.status}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`IntegrationHealthService: SmartThings refresh failed: ${errorText}`);
        return false;
      }
      
      const data = await response.json();
      
      if (!data.access_token) {
        console.error('IntegrationHealthService: No access_token in SmartThings refresh response');
        return false;
      }
      
      const tokenExpiry = new Date(Date.now() + (data.expires_in * 1000));
      
      await storage.upsertIntegrationToken({
        userId,
        service: 'smartthings',
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        tokenExpiry,
        scope: data.scope,
      });
      
      console.log('IntegrationHealthService: SmartThings token refreshed successfully');
      return true;
    } catch (error) {
      console.error('IntegrationHealthService: SmartThings token refresh error:', error);
      return false;
    }
  }
  
  private async refreshAlexaToken(userId: number, refreshToken: string): Promise<boolean> {
    try {
      const ALEXA_CLIENT_ID = process.env.ALEXA_CLIENT_ID;
      const ALEXA_CLIENT_SECRET = process.env.ALEXA_CLIENT_SECRET;
      
      if (!ALEXA_CLIENT_ID || !ALEXA_CLIENT_SECRET) {
        console.error('IntegrationHealthService: Alexa credentials not configured');
        return false;
      }
      
      console.log('IntegrationHealthService: Attempting Alexa token refresh');
      
      const response = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: ALEXA_CLIENT_ID,
          client_secret: ALEXA_CLIENT_SECRET,
        }),
      });
      
      console.log(`IntegrationHealthService: Alexa refresh response status: ${response.status}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`IntegrationHealthService: Alexa refresh failed: ${errorText}`);
        return false;
      }
      
      const data = await response.json();
      
      if (!data.access_token) {
        console.error('IntegrationHealthService: No access_token in Alexa refresh response');
        return false;
      }
      
      const tokenExpiry = new Date(Date.now() + (data.expires_in * 1000));
      
      await storage.upsertIntegrationToken({
        userId,
        service: 'alexa',
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        tokenExpiry,
        scope: data.scope,
      });
      
      console.log('IntegrationHealthService: Alexa token refreshed successfully');
      return true;
    } catch (error) {
      console.error('IntegrationHealthService: Alexa token refresh error:', error);
      return false;
    }
  }
  
  private async getDeviceCount(userId: number, integration: string): Promise<number> {
    try {
      const allDevices = await storage.getDevices(userId);
      const integrationDevices = allDevices.filter(d => d.integration?.toLowerCase() === integration.toLowerCase());
      return integrationDevices.length;
    } catch (error) {
      console.error(`IntegrationHealthService: Error getting device count for ${integration}:`, error);
      return 0;
    }
  }
  
  private async checkHomeAssistantBridge(
    userId: number,
    healthStatuses: IntegrationHealthStatus[],
    issues: IntegrationIssue[]
  ): Promise<void> {
    try {
      const registration = await bridgeStorage.getBridgeRegistration(userId);
      
      if (!registration) {
        // No HA Bridge registered - don't show it as an issue unless they have HA devices
        const haDevices = await this.getDeviceCount(userId, 'homeassistant');
        if (haDevices > 0) {
          healthStatuses.push({
            integration: 'homeassistant',
            displayName: 'Home Assistant',
            status: 'critical',
            tokenExpiry: null,
            tokenStatus: 'no_token',
            deviceCount: haDevices,
            lastRefreshAttempt: null,
            refreshResult: null,
          });
          issues.push({
            integration: 'homeassistant',
            displayName: 'Home Assistant',
            issue: 'connection_error',
            severity: 'critical',
            message: 'Home Assistant Bridge is not connected. Your HA devices may be out of sync.',
            action: 'Connect Home Assistant',
            actionUrl: '/integrations/homeassistant',
            canAutoRefresh: false,
          });
        }
        return;
      }
      
      // Check bridge connection status
      const now = new Date();
      const lastHeartbeat = registration.lastHeartbeat ? new Date(registration.lastHeartbeat) : null;
      const status = registration.status || 'disconnected';
      
      // Check if bridge is connected and recent heartbeat
      let bridgeStatus: IntegrationHealthStatus['status'] = 'unknown';
      let tokenStatus: IntegrationHealthStatus['tokenStatus'] = 'valid';
      
      const hoursSinceHeartbeat = lastHeartbeat 
        ? (now.getTime() - lastHeartbeat.getTime()) / (1000 * 60 * 60)
        : null;
      
      if (status === 'connected' && hoursSinceHeartbeat !== null && hoursSinceHeartbeat < 1) {
        bridgeStatus = 'healthy';
      } else if (status === 'connected' && hoursSinceHeartbeat !== null && hoursSinceHeartbeat < 24) {
        bridgeStatus = 'warning';
        tokenStatus = 'expiring_soon';
        issues.push({
          integration: 'homeassistant',
          displayName: 'Home Assistant',
          issue: 'connection_error',
          severity: 'warning',
          message: `Home Assistant Bridge last connected ${Math.round(hoursSinceHeartbeat)} hours ago.`,
          action: 'Check HA Bridge addon',
          actionUrl: '/integrations/homeassistant',
          canAutoRefresh: false,
        });
      } else if (status === 'disconnected' || (hoursSinceHeartbeat !== null && hoursSinceHeartbeat >= 24)) {
        bridgeStatus = 'critical';
        tokenStatus = 'expired';
        issues.push({
          integration: 'homeassistant',
          displayName: 'Home Assistant',
          issue: 'connection_error',
          severity: 'critical',
          message: `Home Assistant Bridge is disconnected${lastHeartbeat ? ` (last seen ${Math.round(hoursSinceHeartbeat || 0)} hours ago)` : ''}.`,
          action: 'Reconnect HA Bridge',
          actionUrl: '/integrations/homeassistant',
          canAutoRefresh: false,
        });
      }
      
      healthStatuses.push({
        integration: 'homeassistant',
        displayName: 'Home Assistant',
        status: bridgeStatus,
        tokenExpiry: lastHeartbeat,
        tokenStatus,
        deviceCount: registration.deviceCount || 0,
        lastRefreshAttempt: null,
        refreshResult: null,
      });
    } catch (error) {
      console.error('IntegrationHealthService: Error checking Home Assistant Bridge:', error);
    }
  }
}

export const integrationHealthService = new IntegrationHealthService();
