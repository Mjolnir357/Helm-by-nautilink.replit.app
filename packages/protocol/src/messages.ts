import { z } from 'zod';
import { CommandEnvelopeSchema, CommandAckSchema, CommandResultSchema } from './commands';
import { FullSyncDataSchema, StateBatchSchema, SyncStatusSchema } from './sync';
import { PROTOCOL_VERSION } from './constants';

export const HeartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  bridgeId: z.string(),
  timestamp: z.string().datetime(),
  bridgeVersion: z.string(),
  protocolVersion: z.string(),
  haVersion: z.string(),
  haConnected: z.boolean(),
  cloudConnected: z.boolean(),
  lastEventAt: z.string().datetime().nullable(),
  entityCount: z.number(),
  reconnectCount: z.number(),
  uptime: z.number(),
});

export const PairingRequestSchema = z.object({
  type: z.literal('pairing_request'),
  pairingCode: z.string(),
  bridgeId: z.string(),
  bridgeVersion: z.string(),
  haVersion: z.string(),
});

export const PairingResponseSchema = z.object({
  type: z.literal('pairing_response'),
  success: z.boolean(),
  bridgeCredential: z.string().optional(),
  tenantId: z.string().optional(),
  error: z.string().optional(),
});

export const AuthenticateMessageSchema = z.object({
  type: z.literal('authenticate'),
  bridgeId: z.string(),
  bridgeCredential: z.string(),
  protocolVersion: z.string(),
});

export const AuthResultMessageSchema = z.object({
  type: z.literal('auth_result'),
  success: z.boolean(),
  tenantId: z.string().optional(),
  error: z.string().optional(),
  minProtocolVersion: z.string().optional(),
});

export const FullSyncMessageSchema = z.object({
  type: z.literal('full_sync'),
  data: FullSyncDataSchema,
});

export const StateBatchMessageSchema = z.object({
  type: z.literal('state_batch'),
  data: StateBatchSchema,
});

export const SyncStatusMessageSchema = z.object({
  type: z.literal('sync_status'),
  data: SyncStatusSchema,
});

export const CommandAckMessageSchema = z.object({
  type: z.literal('command_ack'),
  cmdId: z.string().uuid(),
  status: z.literal('acknowledged'),
  receivedAt: z.string().datetime(),
});

export const CommandResultMessageSchema = z.object({
  type: z.literal('command_result'),
  cmdId: z.string().uuid(),
  status: z.enum(['completed', 'failed', 'expired']),
  completedAt: z.string().datetime(),
  result: z.object({
    changedEntities: z.array(z.string()).optional(),
    haResponse: z.record(z.unknown()).optional(),
  }).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }).optional(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export const DiagnosticLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error', 'fatal']),
  category: z.string(),
  message: z.string(),
  data: z.record(z.unknown()).optional(),
});

export const BridgeLogsMessageSchema = z.object({
  type: z.literal('bridge_logs'),
  bridgeId: z.string(),
  sentAt: z.string(),
  logs: z.array(DiagnosticLogEntrySchema),
  diagnostics: z.object({
    memoryUsageMB: z.number(),
    uptimeSeconds: z.number(),
    nodeVersion: z.string(),
    haConnected: z.boolean(),
    cloudConnected: z.boolean(),
    webServerListening: z.boolean(),
    webServerPort: z.number(),
    entityCount: z.number(),
    lastError: z.string().nullable(),
    platform: z.string(),
    supervisorAvailable: z.boolean(),
  }).optional(),
});

export const BridgeToCloudMessageSchema = z.discriminatedUnion('type', [
  HeartbeatMessageSchema,
  AuthenticateMessageSchema,
  FullSyncMessageSchema,
  StateBatchMessageSchema,
  SyncStatusMessageSchema,
  CommandAckMessageSchema,
  CommandResultMessageSchema,
  ErrorMessageSchema,
  BridgeLogsMessageSchema,
]);

export const CommandMessageSchema = z.object({
  type: z.literal('command'),
  cmdId: z.string().uuid(),
  tenantId: z.string(),
  issuedAt: z.string().datetime(),
  commandType: z.enum(['ha_call_service', 'ha_full_resync', 'ha_refresh_entity']),
  payload: z.record(z.unknown()),
  requiresAck: z.boolean().default(true),
  ttlMs: z.number().optional(),
  automationId: z.number().optional(),
});

export const RequestFullSyncMessageSchema = z.object({
  type: z.literal('request_full_sync'),
  reason: z.string().optional(),
});

export const RequestHeartbeatMessageSchema = z.object({
  type: z.literal('request_heartbeat'),
});

export const DisconnectMessageSchema = z.object({
  type: z.literal('disconnect'),
  reason: z.string(),
});

export const RequestLogsMessageSchema = z.object({
  type: z.literal('request_logs'),
  includeDiagnostics: z.boolean().default(true),
  maxEntries: z.number().default(200),
});

export const CloudToBridgeMessageSchema = z.discriminatedUnion('type', [
  AuthResultMessageSchema,
  CommandMessageSchema,
  RequestFullSyncMessageSchema,
  RequestHeartbeatMessageSchema,
  DisconnectMessageSchema,
  RequestLogsMessageSchema,
]);

export const WebSocketEnvelopeSchema = z.object({
  id: z.string().optional(),
  timestamp: z.string().datetime(),
  message: z.union([BridgeToCloudMessageSchema, CloudToBridgeMessageSchema]),
});

export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;
export type PairingRequest = z.infer<typeof PairingRequestSchema>;
export type PairingResponse = z.infer<typeof PairingResponseSchema>;
export type AuthenticateMessage = z.infer<typeof AuthenticateMessageSchema>;
export type AuthResultMessage = z.infer<typeof AuthResultMessageSchema>;
export type FullSyncMessage = z.infer<typeof FullSyncMessageSchema>;
export type StateBatchMessage = z.infer<typeof StateBatchMessageSchema>;
export type SyncStatusMessage = z.infer<typeof SyncStatusMessageSchema>;
export type CommandAckMessage = z.infer<typeof CommandAckMessageSchema>;
export type CommandResultMessage = z.infer<typeof CommandResultMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type CommandMessage = z.infer<typeof CommandMessageSchema>;
export type RequestFullSyncMessage = z.infer<typeof RequestFullSyncMessageSchema>;
export type RequestHeartbeatMessage = z.infer<typeof RequestHeartbeatMessageSchema>;
export type DisconnectMessage = z.infer<typeof DisconnectMessageSchema>;
export type DiagnosticLogEntry = z.infer<typeof DiagnosticLogEntrySchema>;
export type BridgeLogsMessage = z.infer<typeof BridgeLogsMessageSchema>;
export type RequestLogsMessage = z.infer<typeof RequestLogsMessageSchema>;
export type BridgeToCloudMessage = z.infer<typeof BridgeToCloudMessageSchema>;
export type CloudToBridgeMessage = z.infer<typeof CloudToBridgeMessageSchema>;
export type WebSocketEnvelope = z.infer<typeof WebSocketEnvelopeSchema>;
