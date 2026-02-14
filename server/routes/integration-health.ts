import { Router, Response } from "express";
import { db } from "../db";
import { integrationHealth, integrationTokens, devices } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { authenticateToken, requireAdmin, AuthenticatedRequest } from "../auth";
import { integrationHealthService } from "../services/integration-health-service";
import { tokenRefreshScheduler } from "../services/token-refresh-scheduler";

const router = Router();

router.get("/api/integration-health", authenticateToken as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const tokens = await db.select()
      .from(integrationTokens)
      .where(eq(integrationTokens.userId, req.user.id));

    const healthRecords = await db.select()
      .from(integrationHealth)
      .where(eq(integrationHealth.userId, req.user.id));

    const deviceCounts = await db.select({
      integration: devices.integration,
      count: sql<number>`count(*)::int`,
    })
      .from(devices)
      .where(eq(devices.userId, req.user.id))
      .groupBy(devices.integration);

    const integrations = tokens.map(token => {
      const health = healthRecords.find(h => h.integration === token.service.toLowerCase());
      const deviceCount = deviceCounts.find(d => d.integration === token.service.toLowerCase())?.count || 0;
      
      const isTokenValid = token.tokenExpiry && new Date(token.tokenExpiry) > new Date();
      let status: string;
      
      if (!isTokenValid) {
        status = "disconnected";
      } else if (health?.status) {
        status = health.status;
      } else {
        status = "healthy";
      }

      return {
        id: token.id,
        integration: token.service.toLowerCase(),
        displayName: getDisplayName(token.service),
        status,
        lastCheck: health?.lastCheck || null,
        lastSuccessful: health?.lastSuccessful || null,
        errorCount: health?.errorCount || 0,
        lastError: health?.lastError || null,
        responseTimeMs: health?.responseTimeMs || null,
        deviceCount,
        tokenExpiry: token.tokenExpiry,
        isTokenValid,
      };
    });

    res.json(integrations);
  } catch (error) {
    console.error("Error fetching integration health:", error);
    res.status(500).json({ error: "Failed to fetch integration health" });
  }
});

router.post("/api/integration-health/check/:integration", authenticateToken as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { integration } = req.params;

    const tokens = await db.select()
      .from(integrationTokens)
      .where(
        and(
          eq(integrationTokens.userId, req.user.id),
          eq(integrationTokens.service, integration.toUpperCase())
        )
      );

    if (tokens.length === 0) {
      return res.status(404).json({ error: "Integration not found" });
    }

    const token = tokens[0];
    const startTime = Date.now();
    let status = "healthy";
    let lastError = null;

    try {
      if (integration.toLowerCase() === "hue") {
        const response = await fetch("https://api.meethue.com/route/api/0/config", {
          headers: { Authorization: `Bearer ${token.accessToken}` },
        });
        if (!response.ok) {
          status = "degraded";
          lastError = `HTTP ${response.status}`;
        }
      }
    } catch (error: any) {
      status = "disconnected";
      lastError = error.message;
    }

    const responseTimeMs = Date.now() - startTime;

    const [existing] = await db.select()
      .from(integrationHealth)
      .where(
        and(
          eq(integrationHealth.userId, req.user.id),
          eq(integrationHealth.integration, integration.toLowerCase())
        )
      );

    const deviceCount = await db.select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(
        and(
          eq(devices.userId, req.user.id),
          eq(devices.integration, integration.toLowerCase())
        )
      );

    const healthData = {
      status,
      lastCheck: new Date(),
      lastSuccessful: status === "healthy" ? new Date() : existing?.lastSuccessful,
      errorCount: status !== "healthy" ? (existing?.errorCount || 0) + 1 : 0,
      lastError,
      responseTimeMs,
      deviceCount: deviceCount[0]?.count || 0,
      updatedAt: new Date(),
    };

    if (existing) {
      await db.update(integrationHealth)
        .set(healthData)
        .where(eq(integrationHealth.id, existing.id));
    } else {
      await db.insert(integrationHealth).values({
        userId: req.user.id,
        integration: integration.toLowerCase(),
        ...healthData,
      });
    }

    res.json({
      integration,
      ...healthData,
    });
  } catch (error) {
    console.error("Error checking integration health:", error);
    res.status(500).json({ error: "Failed to check integration health" });
  }
});

router.post("/api/integration-health/check-all", authenticateToken as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const attemptRefresh = req.body?.attemptRefresh !== false;
    
    console.log(`Integration health check-all for user ${req.user.id}, attemptRefresh: ${attemptRefresh}`);
    
    const result = await integrationHealthService.checkAllIntegrations(req.user.id, attemptRefresh);
    
    res.json(result);
  } catch (error) {
    console.error("Error in integration health check-all:", error);
    res.status(500).json({ error: "Failed to check integration health" });
  }
});

router.post("/api/integration-health/refresh/:integration", authenticateToken as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { integration } = req.params;
    
    console.log(`Manual refresh requested for ${integration} by user ${req.user.id}`);
    
    const result = await integrationHealthService.checkAllIntegrations(req.user.id, true);
    const integrationStatus = result.healthStatuses.find(h => h.integration === integration.toLowerCase());
    
    if (!integrationStatus) {
      return res.status(404).json({ error: "Integration not found" });
    }
    
    res.json({
      success: integrationStatus.refreshResult === 'success',
      status: integrationStatus,
      issues: result.issues.filter(i => i.integration === integration.toLowerCase()),
    });
  } catch (error) {
    console.error("Error in integration refresh:", error);
    res.status(500).json({ error: "Failed to refresh integration" });
  }
});

router.get("/api/integration-health/scheduler-status", authenticateToken as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const status = tokenRefreshScheduler.getStatus();
    res.json({
      running: status.running,
      lastRunAt: status.lastRunAt,
      nextRunAt: status.nextRunAt,
      intervalHours: status.intervalMs / (1000 * 60 * 60),
      totalRefreshes: status.totalRefreshes,
      totalFailures: status.totalFailures,
      lastRunResults: status.lastRunResults.filter(r => r.userId === req.user!.id),
    });
  } catch (error) {
    console.error("Error fetching scheduler status:", error);
    res.status(500).json({ error: "Failed to fetch scheduler status" });
  }
});

router.post("/api/integration-health/force-refresh-all", authenticateToken as any, requireAdmin as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    console.log(`Admin ${req.user.id} triggered manual token refresh cycle`);
    const results = await tokenRefreshScheduler.runRefreshCycle();
    
    res.json({
      success: true,
      results,
      summary: {
        total: results.length,
        refreshed: results.filter(r => r.result === 'success').length,
        failed: results.filter(r => r.result === 'failed').length,
        skipped: results.filter(r => r.result === 'skipped').length,
      },
    });
  } catch (error) {
    console.error("Error in forced refresh cycle:", error);
    res.status(500).json({ error: "Failed to run refresh cycle" });
  }
});

function getDisplayName(service: string): string {
  const names: Record<string, string> = {
    HUE: "Philips Hue",
    HUE_REMOTE: "Philips Hue",
    SMARTTHINGS: "SmartThings",
    GOOGLE_HOME: "Google Home",
    ALEXA: "Amazon Alexa",
    HOMEASSISTANT: "Home Assistant",
  };
  return names[service] || service;
}

export default router;
