import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import NavigationHeader from "@/components/navigation-header";
import Sidebar from "@/components/sidebar";
import MobileNavigation from "@/components/mobile-navigation";
import { getAuthState } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { 
  Activity, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle,
  RefreshCw,
  Clock,
  Wifi,
  WifiOff,
  Loader2,
  Shield,
  Zap,
  ScrollText,
  Cpu,
  HardDrive,
  ChevronDown,
  ChevronUp,
  Trash2,
  Download
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface IntegrationHealth {
  id: number;
  integration: string;
  displayName: string;
  status: string;
  lastCheck: string | null;
  lastSuccessful: string | null;
  errorCount: number;
  lastError: string | null;
  responseTimeMs: number | null;
  deviceCount: number;
  tokenExpiry: string | null;
  isTokenValid: boolean;
}

interface BridgeLogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

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

interface BridgeLogsResponse {
  logs: BridgeLogEntry[];
  diagnostics: BridgeDiagnostics | null;
  lastReceivedAt: string | null;
  totalReceived: number;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function BridgeLogsSection() {
  const { toast } = useToast();
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState(true);

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery<BridgeLogsResponse>({
    queryKey: ["/api/bridge/logs"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/bridge/logs?limit=500");
      return response.json();
    },
    refetchInterval: 15000,
  });

  const requestLogsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/bridge/logs/request");
      return response.json();
    },
    onSuccess: (data: { bridgeConnected: boolean; message: string }) => {
      toast({ title: data.message });
      setTimeout(() => refetchLogs(), 3000);
    },
    onError: () => {
      toast({ title: "Failed to request logs", variant: "destructive" });
    },
  });

  const clearLogsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("DELETE", "/api/bridge/logs");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bridge/logs"] });
      toast({ title: "Logs cleared" });
    },
  });

  const logs = logsData?.logs || [];
  const diagnostics = logsData?.diagnostics;

  const filteredLogs = logs.filter(log => {
    if (levelFilter !== "all" && log.level !== levelFilter) return false;
    if (categoryFilter !== "all" && log.category !== categoryFilter) return false;
    return true;
  });

  const categories = Array.from(new Set(logs.map(l => l.category))).sort();
  const errorCount = logs.filter(l => l.level === 'error' || l.level === 'fatal').length;
  const warnCount = logs.filter(l => l.level === 'warn').length;

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': case 'fatal': return 'text-red-600 bg-red-50';
      case 'warn': return 'text-yellow-700 bg-yellow-50';
      case 'info': return 'text-blue-600 bg-blue-50';
      case 'debug': return 'text-gray-500 bg-gray-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  };

  const getLevelBadge = (level: string) => {
    switch (level) {
      case 'error': case 'fatal': return 'bg-red-100 text-red-700 border-red-200';
      case 'warn': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'info': return 'bg-blue-100 text-blue-700 border-blue-200';
      default: return 'bg-gray-100 text-gray-600 border-gray-200';
    }
  };

  return (
    <Card className="bg-white border-gray-200 shadow-sm mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold text-[#1a365d] flex items-center gap-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
            <ScrollText className="h-5 w-5 text-[#4fd1c7]" />
            Bridge Diagnostic Logs
            {errorCount > 0 && (
              <Badge variant="outline" className="bg-red-100 text-red-700 border-red-200 ml-2">
                {errorCount} error{errorCount > 1 ? 's' : ''}
              </Badge>
            )}
            {warnCount > 0 && (
              <Badge variant="outline" className="bg-yellow-100 text-yellow-700 border-yellow-200">
                {warnCount} warning{warnCount > 1 ? 's' : ''}
              </Badge>
            )}
            {expanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-gray-300 text-gray-700 hover:bg-gray-100"
              onClick={() => requestLogsMutation.mutate()}
              disabled={requestLogsMutation.isPending}
            >
              {requestLogsMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Download className="h-4 w-4 mr-1" />
                  Fetch Latest
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-gray-300 text-gray-700 hover:bg-gray-100"
              onClick={() => clearLogsMutation.mutate()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0">
          {diagnostics && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-100">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500">Memory</p>
                  <p className="text-sm font-medium text-[#1a365d]">{diagnostics.memoryUsageMB} MB</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500">Uptime</p>
                  <p className="text-sm font-medium text-[#1a365d]">{formatUptime(diagnostics.uptimeSeconds)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500">Web Server</p>
                  <p className={`text-sm font-medium ${diagnostics.webServerListening ? 'text-green-600' : 'text-red-600'}`}>
                    {diagnostics.webServerListening ? `Listening :${diagnostics.webServerPort}` : 'Not Listening'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500">HA Connected</p>
                  <p className={`text-sm font-medium ${diagnostics.haConnected ? 'text-green-600' : 'text-red-600'}`}>
                    {diagnostics.haConnected ? 'Yes' : 'No'}
                  </p>
                </div>
              </div>
              {diagnostics.lastError && (
                <div className="col-span-2 md:col-span-4 p-2 bg-red-50 rounded border border-red-200">
                  <p className="text-xs text-red-500 font-medium">Last Error</p>
                  <p className="text-sm text-red-700 font-mono truncate">{diagnostics.lastError}</p>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 mb-3">
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger className="w-[130px] h-8 text-xs">
                <SelectValue placeholder="All Levels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                <SelectItem value="error">Errors</SelectItem>
                <SelectItem value="warn">Warnings</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="debug">Debug</SelectItem>
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[150px] h-8 text-xs">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map(cat => (
                  <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-gray-500 ml-auto">
              {filteredLogs.length} of {logs.length} entries
              {logsData?.lastReceivedAt && (
                <> · Updated {formatDistanceToNow(new Date(logsData.lastReceivedAt), { addSuffix: true })}</>
              )}
            </span>
          </div>

          {logsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-[#4fd1c7]" />
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <ScrollText className="h-10 w-10 mx-auto mb-2 text-gray-300" />
              <p className="text-sm">No bridge logs received yet.</p>
              <p className="text-xs mt-1">Click "Fetch Latest" to request logs from your bridge.</p>
            </div>
          ) : (
            <div className="max-h-[500px] overflow-y-auto border border-gray-200 rounded-lg bg-gray-900">
              <div className="font-mono text-xs divide-y divide-gray-800">
                {filteredLogs.map((log, i) => {
                  const time = new Date(log.timestamp);
                  const timeStr = time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  return (
                    <div key={i} className={`px-3 py-1.5 hover:bg-gray-800 flex items-start gap-2 ${
                      log.level === 'error' || log.level === 'fatal' ? 'bg-red-950/30' :
                      log.level === 'warn' ? 'bg-yellow-950/20' : ''
                    }`}>
                      <span className="text-gray-500 flex-shrink-0 w-[60px]">{timeStr}</span>
                      <span className={`flex-shrink-0 w-[45px] uppercase font-bold ${
                        log.level === 'error' || log.level === 'fatal' ? 'text-red-400' :
                        log.level === 'warn' ? 'text-yellow-400' :
                        log.level === 'info' ? 'text-blue-400' :
                        'text-gray-500'
                      }`}>{log.level}</span>
                      <span className="text-teal-400 flex-shrink-0 w-[90px] truncate">[{log.category}]</span>
                      <span className={`break-all ${
                        log.level === 'error' || log.level === 'fatal' ? 'text-red-300' :
                        log.level === 'warn' ? 'text-yellow-300' :
                        'text-gray-300'
                      }`}>{log.message}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function IntegrationHealthPage() {
  const { user } = getAuthState();
  const { toast } = useToast();

  const { data: integrations = [], isLoading, refetch } = useQuery<IntegrationHealth[]>({
    queryKey: ["/api/integration-health"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/integration-health");
      return response.json();
    },
    refetchInterval: 30000,
  });

  const { data: schedulerStatus } = useQuery<{
    running: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
    intervalHours: number;
    totalRefreshes: number;
    totalFailures: number;
  }>({
    queryKey: ["/api/integration-health/scheduler-status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/integration-health/scheduler-status");
      return response.json();
    },
    refetchInterval: 60000,
  });

  const checkHealthMutation = useMutation({
    mutationFn: async (integration: string) => {
      const response = await apiRequest("POST", `/api/integration-health/check/${integration}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/integration-health"] });
      toast({ title: "Health check completed" });
    },
    onError: () => {
      toast({ title: "Health check failed", variant: "destructive" });
    },
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "healthy":
        return <CheckCircle2 className="h-5 w-5 text-green-400" />;
      case "degraded":
        return <AlertTriangle className="h-5 w-5 text-yellow-400" />;
      case "disconnected":
        return <XCircle className="h-5 w-5 text-red-400" />;
      default:
        return <Activity className="h-5 w-5 text-gray-400" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "healthy":
        return "bg-green-500/20 text-green-400 border-green-400/30";
      case "degraded":
        return "bg-yellow-500/20 text-yellow-400 border-yellow-400/30";
      case "disconnected":
        return "bg-red-500/20 text-red-400 border-red-400/30";
      default:
        return "bg-gray-500/20 text-gray-400 border-gray-400/30";
    }
  };

  const getResponseTimeColor = (ms: number | null) => {
    if (ms === null) return "text-gray-400";
    if (ms < 500) return "text-green-400";
    if (ms < 1500) return "text-yellow-400";
    return "text-red-400";
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <NavigationHeader />
      <div className="flex">
        <Sidebar user={user as any} />
        <main className="flex-1 p-4 md:p-6 pb-24 md:pb-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-[#1a365d] flex items-center gap-3">
                  <Activity className="h-8 w-8 text-[#4fd1c7]" />
                  Integration Health
                </h1>
                <p className="text-gray-600 mt-1">
                  Monitor the status of your connected services
                </p>
              </div>
              <Button 
                variant="outline" 
                onClick={() => refetch()}
                className="border-gray-300 text-gray-700 hover:bg-gray-100"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>

            {schedulerStatus && (
              <Card className="bg-white border-gray-200 shadow-sm mb-6">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-teal-100 flex items-center justify-center">
                        <Shield className="h-5 w-5 text-teal-600" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-[#1a365d] flex items-center gap-2">
                          Auto-Renewal
                          <Badge variant="outline" className={schedulerStatus.running ? "bg-green-100 text-green-700 border-green-200" : "bg-gray-100 text-gray-600 border-gray-200"}>
                            {schedulerStatus.running ? "Active" : "Inactive"}
                          </Badge>
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Connections are automatically renewed every {schedulerStatus.intervalHours} hours
                          {schedulerStatus.lastRunAt && (
                            <> · Last check {formatDistanceToNow(new Date(schedulerStatus.lastRunAt), { addSuffix: true })}</>
                          )}
                          {schedulerStatus.nextRunAt && (
                            <> · Next check {formatDistanceToNow(new Date(schedulerStatus.nextRunAt), { addSuffix: true })}</>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      {schedulerStatus.totalRefreshes > 0 && (
                        <span className="flex items-center gap-1">
                          <Zap className="h-3 w-3 text-green-500" />
                          {schedulerStatus.totalRefreshes} renewed
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {!isLoading && integrations.some(i => !i.isTokenValid) && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-start gap-3">
                  <XCircle className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-red-800">Action Required</h3>
                    <p className="text-red-700 mt-1">
                      {integrations.filter(i => !i.isTokenValid).length} integration{integrations.filter(i => !i.isTokenValid).length > 1 ? 's have' : ' has'} expired tokens and need{integrations.filter(i => !i.isTokenValid).length > 1 ? '' : 's'} to be reconnected to restore control of your devices.
                    </p>
                    <div className="flex flex-wrap gap-2 mt-3">
                      {integrations.filter(i => !i.isTokenValid).map(i => (
                        <Button
                          key={i.id}
                          size="sm"
                          className="bg-red-600 hover:bg-red-700 text-white"
                          onClick={() => window.location.href = `/integrations/${i.integration}`}
                        >
                          Reconnect {i.displayName}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {isLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-[#4fd1c7]" />
              </div>
            ) : integrations.length === 0 ? (
              <Card className="bg-white border-gray-200">
                <CardContent className="py-12 text-center">
                  <WifiOff className="h-16 w-16 text-gray-400 mx-auto mb-4" />
                  <h2 className="text-xl font-semibold text-[#1a365d] mb-2">
                    No Integrations Connected
                  </h2>
                  <p className="text-gray-600 mb-6">
                    Connect your smart home services to monitor their health status.
                  </p>
                  <Button 
                    className="bg-[#4fd1c7] hover:bg-[#38b2ac] text-white"
                    onClick={() => window.location.href = '/setup'}
                  >
                    Connect Services
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {integrations.map((integration) => (
                  <Card key={integration.id} className="bg-white border-gray-200 shadow-sm">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-4">
                          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                            integration.status === 'healthy' ? 'bg-green-100' :
                            integration.status === 'degraded' ? 'bg-yellow-100' :
                            'bg-red-100'
                          }`}>
                            {integration.isTokenValid ? (
                              <Wifi className={`h-6 w-6 ${
                                integration.status === 'healthy' ? 'text-green-600' :
                                integration.status === 'degraded' ? 'text-yellow-600' :
                                'text-red-600'
                              }`} />
                            ) : (
                              <WifiOff className="h-6 w-6 text-red-600" />
                            )}
                          </div>
                          <div>
                            <h3 className="text-lg font-semibold text-[#1a365d] flex items-center gap-2">
                              {integration.displayName}
                              <Badge variant="outline" className={`${
                                integration.status === 'healthy' ? 'bg-green-100 text-green-700 border-green-200' :
                                integration.status === 'degraded' ? 'bg-yellow-100 text-yellow-700 border-yellow-200' :
                                'bg-red-100 text-red-700 border-red-200'
                              }`}>
                                {integration.status}
                              </Badge>
                            </h3>
                            <div className="mt-2 space-y-1 text-sm text-gray-600">
                              <p className="flex items-center gap-2">
                                <span>{integration.deviceCount} devices connected</span>
                              </p>
                              {integration.tokenExpiry && (
                                <p className={`flex items-center gap-2 ${
                                  !integration.isTokenValid ? 'text-red-600 font-medium' : 
                                  new Date(integration.tokenExpiry).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000 ? 'text-yellow-600' :
                                  'text-gray-600'
                                }`}>
                                  <Clock className="h-3 w-3" />
                                  {!integration.isTokenValid ? (
                                    <>Token expired {formatDistanceToNow(new Date(integration.tokenExpiry), { addSuffix: true })}</>
                                  ) : (
                                    <>Token expires {formatDistanceToNow(new Date(integration.tokenExpiry), { addSuffix: true })}</>
                                  )}
                                </p>
                              )}
                              {integration.lastCheck && (
                                <p className="flex items-center gap-2">
                                  <Clock className="h-3 w-3" />
                                  Last checked {formatDistanceToNow(new Date(integration.lastCheck), { addSuffix: true })}
                                </p>
                              )}
                              {integration.responseTimeMs !== null && (
                                <p className={`flex items-center gap-2 ${
                                  integration.responseTimeMs < 500 ? 'text-green-600' :
                                  integration.responseTimeMs < 1500 ? 'text-yellow-600' :
                                  'text-red-600'
                                }`}>
                                  Response time: {integration.responseTimeMs}ms
                                </p>
                              )}
                              {integration.lastError && (
                                <p className="text-red-600 flex items-center gap-2">
                                  <AlertTriangle className="h-3 w-3" />
                                  {integration.lastError}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-gray-300 text-gray-700 hover:bg-gray-100"
                            onClick={() => checkHealthMutation.mutate(integration.integration)}
                            disabled={checkHealthMutation.isPending}
                          >
                            {checkHealthMutation.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Check Now
                              </>
                            )}
                          </Button>
                          {!integration.isTokenValid && (
                            <Button
                              size="sm"
                              className="bg-[#4fd1c7] hover:bg-[#38b2ac] text-white"
                              onClick={() => window.location.href = `/integrations/${integration.integration}`}
                            >
                              Reconnect
                            </Button>
                          )}
                        </div>
                      </div>

                      {integration.errorCount > 0 && (
                        <div className="mt-4 p-3 bg-red-50 rounded-lg border border-red-200">
                          <p className="text-sm text-red-700">
                            {integration.errorCount} error{integration.errorCount > 1 ? 's' : ''} in the last 24 hours
                          </p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <BridgeLogsSection />
          </div>
        </main>
      </div>
      <MobileNavigation />
    </div>
  );
}
