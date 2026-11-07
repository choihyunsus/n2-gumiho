// Host-owned checks run outside model interpretation and return content-addressed evidence.
import type { ArtifactSnapshot } from './artifacts';
import type { JsonValue } from './types';
export interface VerificationContext {
  workspaceRoot: string;
  runId: string;
  snapshot: ArtifactSnapshot;
  modifiedFiles: readonly string[];
  signal: AbortSignal;
}
export interface NativeVerification {
  success: boolean;
  summary: string;
  evidence: JsonValue;
}
export interface NativeVerifier {
  readonly version: string;
  verify(context: VerificationContext): NativeVerification | Promise<NativeVerification>;
}
