import { storage } from '../storage';
import { integrationHealthService } from './integration-health-service';

interface RefreshLogEntry {
  userId: number;
  service: string;
  result: 'success' | 'failed' | 'skipped';
  message: string;
  timestamp: Date;
}

interface SchedulerStatus {
  running: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  intervalMs: number;
  lastRunResults: RefreshLogEntry[];
  totalRefreshes: number;
  totalFailures: number;
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_DAYS = 7;

class TokenRefreshScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private status: SchedulerStatus = {
    running: false,
    lastRunAt: null,
    nextRunAt: null,
    intervalMs: REFRESH_INTERVAL_MS,
    lastRunResults: [],
    totalRefreshes: 0,
    totalFailures: 0,
  };

  start(): void {
    if (this.intervalId) {
      console.log('🔄 Token refresh scheduler already running');
      return;
    }

    console.log('🔄 Token refresh scheduler started (interval: every 6 hours)');
    this.status.running = true;
    this.status.nextRunAt = new Date(Date.now() + REFRESH_INTERVAL_MS);

    setTimeout(() => this.runRefreshCycle(), 60000);

    this.intervalId = setInterval(() => this.runRefreshCycle(), REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.status.running = false;
    this.status.nextRunAt = null;
    console.log('🔄 Token refresh scheduler stopped');
  }

  getStatus(): SchedulerStatus {
    return { ...this.status };
  }

  async runRefreshCycle(): Promise<RefreshLogEntry[]> {
    console.log('🔄 Token refresh cycle starting...');
    const results: RefreshLogEntry[] = [];

    try {
      const allUsers = await storage.getAllUsers();
      console.log(`🔄 Checking tokens for ${allUsers.length} users`);

      for (const user of allUsers) {
        try {
          const tokens = await storage.getIntegrationTokens(user.id);
          
          for (const token of tokens) {
            const serviceName = token.service.toLowerCase();
            const now = new Date();
            const tokenExpiry = token.tokenExpiry ? new Date(token.tokenExpiry) : null;

            if (!tokenExpiry) {
              results.push({
                userId: user.id,
                service: serviceName,
                result: 'skipped',
                message: 'No expiry date set',
                timestamp: now,
              });
              continue;
            }

            const daysUntilExpiry = (tokenExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

            if (daysUntilExpiry > TOKEN_REFRESH_BUFFER_DAYS) {
              continue;
            }

            if (!token.refreshToken) {
              results.push({
                userId: user.id,
                service: serviceName,
                result: 'failed',
                message: 'No refresh token available - user must re-authorize',
                timestamp: now,
              });
              this.status.totalFailures++;

              await this.logRefreshAudit(user.id, serviceName, false, 'No refresh token available');
              continue;
            }

            console.log(`🔄 Refreshing ${serviceName} token for user ${user.id} (expires in ${Math.ceil(daysUntilExpiry)} days)`);

            try {
              const refreshed = await integrationHealthService.attemptTokenRefresh(user.id, serviceName, token.refreshToken!);

              if (refreshed) {
                results.push({
                  userId: user.id,
                  service: serviceName,
                  result: 'success',
                  message: `Token refreshed (was expiring in ${Math.ceil(daysUntilExpiry)} days)`,
                  timestamp: now,
                });
                this.status.totalRefreshes++;
                await this.logRefreshAudit(user.id, serviceName, true, `Proactive refresh - was expiring in ${Math.ceil(daysUntilExpiry)} days`);
              } else {
                results.push({
                  userId: user.id,
                  service: serviceName,
                  result: 'failed',
                  message: `Refresh failed - user may need to re-authorize`,
                  timestamp: now,
                });
                this.status.totalFailures++;
                await this.logRefreshAudit(user.id, serviceName, false, 'Auto-refresh failed');
              }
            } catch (refreshError: any) {
              results.push({
                userId: user.id,
                service: serviceName,
                result: 'failed',
                message: `Error: ${refreshError.message}`,
                timestamp: now,
              });
              this.status.totalFailures++;
              await this.logRefreshAudit(user.id, serviceName, false, refreshError.message);
            }
          }
        } catch (userError: any) {
          console.error(`🔄 Error processing tokens for user ${user.id}:`, userError.message);
        }
      }
    } catch (error: any) {
      console.error('🔄 Token refresh cycle error:', error.message);
    }

    this.status.lastRunAt = new Date();
    this.status.nextRunAt = new Date(Date.now() + REFRESH_INTERVAL_MS);
    this.status.lastRunResults = results;

    const successes = results.filter(r => r.result === 'success').length;
    const failures = results.filter(r => r.result === 'failed').length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    console.log(`🔄 Token refresh cycle complete: ${successes} refreshed, ${failures} failed, ${skipped} skipped`);

    return results;
  }

  private async logRefreshAudit(userId: number, service: string, success: boolean, details: string): Promise<void> {
    try {
      await storage.createAuditLogEntry({
        userId,
        action: success ? 'TOKEN_AUTO_REFRESH_SUCCESS' : 'TOKEN_AUTO_REFRESH_FAILED',
        entityType: 'Integration',
        entityId: null,
        description: `[${service}] ${details} (automated)`,
      });
    } catch (error) {
      console.error('Failed to log token refresh audit:', error);
    }
  }
}

export const tokenRefreshScheduler = new TokenRefreshScheduler();
