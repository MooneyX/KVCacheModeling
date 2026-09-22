export type ReplayTiming =
  | { kind: 'origin'; anchorReq: null; offsetMs: number }
  | { kind: 'arrival' | 'completion'; anchorReq: number; offsetMs: number };

export interface ReplayRequest {
  in: number;
  out: number;
  blockRuns: [start: number, count: number][];
  timing: ReplayTiming;
}

export interface ReplaySession {
  req: ReplayRequest[];
}

export interface ReplayBundle {
  version: 1;
  blockSize: 64;
  sessions: ReplaySession[];
}

export interface ReplayLimits {
  maxDecompressedBytes: number;
  maxSessions: number;
  maxRequests: number;
  maxRuns: number;
  maxBlockReferences: number;
}

export interface ReplayRunLimits {
  maxSessions: number;
  maxRequests: number;
  maxEvents: number;
  maxBlockReferences: number;
  maxWallTimeMs: number;
  maxResultBytes: number;
}

export interface ReplayOptions {
  arrivalModel?: 'closed';
  durationSeconds: number;
  warmupSeconds: number;
  superblocks?: boolean;
  limits?: Partial<ReplayRunLimits>;
}

export interface ReplayOverride {
  bundle: ReplayBundle;
  options: ReplayOptions;
}

export interface ReplayBundleStats {
  sessions: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
  blockReferences: number;
  meanRequestsPerSession: number;
  anchors: Record<ReplayTiming['kind'], number>;
}
