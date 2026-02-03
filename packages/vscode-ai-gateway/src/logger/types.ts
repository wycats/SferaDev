export interface LogEntry {
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  sessionId: string;
  startedAt: string;
  vscodeVersion: string;
  extensionVersion: string;
  machineId?: string;
}
