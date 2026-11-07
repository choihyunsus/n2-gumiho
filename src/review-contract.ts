// Host parsing makes approval contingent on the exact artifact hash and explicit blocking findings.
import { objectValue, arrayValue } from './model-validation';
import { plainJson, textValue } from './values';
export interface ReviewFinding {
  message: string;
  severity: 'error' | 'warning' | 'info';
  path?: string;
  line?: number;
}
export interface ReviewDecision {
  approved: boolean;
  snapshotHash: string;
  findings: ReviewFinding[];
}
export const REVIEW_TASK =
  'Independently review the original task against the current artifacts and native-check evidence. Return only JSON with approved (boolean), snapshotHash (the supplied SHA-256), and findings (array of objects with message, severity error/warning/info, and optional path and positive line). Inspect relevant source through your read-only tools. An error finding blocks approval.';

export function reviewDecision(output: string, expectedHash: string): ReviewDecision {
  const text = textValue(output, 'review output', 65536).trim();
  const fenced = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(text);
  const value = objectValue(plainJson(JSON.parse(fenced ? fenced[1]! : text)));
  if (
    typeof value.approved !== 'boolean' ||
    value.snapshotHash !== expectedHash ||
    Object.keys(value).some((key) => !['approved', 'snapshotHash', 'findings'].includes(key))
  )
    throw new Error('Review must explicitly approve or reject the exact artifact snapshot');
  const findings = arrayValue(value.findings, 32).map((raw) => {
    const item = objectValue(raw),
      message = textValue(item.message, 'review finding', 2048);
    if (
      !message.trim() ||
      !['error', 'warning', 'info'].includes(String(item.severity)) ||
      Object.keys(item).some((key) => !['message', 'severity', 'path', 'line'].includes(key))
    )
      throw new Error('Invalid review finding');
    const finding: ReviewFinding = {
      message,
      severity: item.severity as ReviewFinding['severity'],
    };
    if (item.path !== undefined) finding.path = textValue(item.path, 'finding path', 4096);
    if (item.line !== undefined) {
      if (typeof item.line !== 'number' || !Number.isSafeInteger(item.line) || item.line < 1)
        throw new Error('Invalid finding line');
      finding.line = item.line;
    }
    return finding;
  });
  return {
    approved: value.approved && !findings.some((finding) => finding.severity === 'error'),
    snapshotHash: expectedHash,
    findings,
  };
}
