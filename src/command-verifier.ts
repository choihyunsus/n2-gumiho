// Construct a trusted native verifier from fixed executable/argument lists supplied by the host.
import { fingerprint, identity, plainJson } from './values';
import { resolveCommand, runCheck, type CheckCommand, type CheckReceipt } from './check-command';
import type { NativeVerifier, VerificationContext } from './native-verifier';

export function commandVerifier(commands: CheckCommand[], version: string): NativeVerifier {
  identity(version, 'verifier version');
  if (!Array.isArray(commands) || !commands.length || commands.length > 16)
    throw new Error('Expected 1 through 16 native checks');
  const configured = commands.map(resolveCommand);
  if (new Set(configured.map((check) => check.id)).size !== configured.length)
    throw new Error('Duplicate native check ID');
  return Object.freeze({
    version: `native-${fingerprint({ version, commands: configured })}`,
    async verify(context: VerificationContext) {
      const checks: CheckReceipt[] = [];
      for (const command of configured) {
        context.signal.throwIfAborted();
        checks.push(await runCheck(command, context.workspaceRoot, context.signal));
      }
      const success = checks.every((check) => check.success);
      return {
        success,
        summary: success
          ? 'All configured native checks passed'
          : 'One or more configured native checks failed',
        evidence: plainJson({ snapshotHash: context.snapshot.hash, checks }, 524288, 32768),
      };
    },
  });
}
