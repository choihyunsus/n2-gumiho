// Stable content snapshots bind checks and independent review to the same workspace bytes.
import path from 'node:path';
import { constants, realpathSync } from 'node:fs';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fingerprint, plainJson, positiveInteger, textValue } from './values';

const MAX_SNAPSHOT_BYTES = 524288;
const HASH_BUFFER_BYTES = 65536;
export interface SnapshotOptions {
  excludeDirectories?: string[];
  excludePaths?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}
export interface ArtifactFile {
  path: string;
  kind: 'file' | 'symlink';
  sha256: string;
  bytes: number;
  mode: number;
}
export interface ArtifactSnapshot {
  hash: string;
  files: ArtifactFile[];
}
export interface ArtifactChange {
  path: string;
  before: ArtifactFile | null;
  after: ArtifactFile | null;
}

export async function canonicalWorkspace(value: string): Promise<string> {
  const root = await realpath(textValue(value, 'workspace path', 4096));
  if (!(await lstat(root)).isDirectory())
    throw new Error('Workspace must be an existing directory');
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

export function workspaceRelative(root: string, value: string): string {
  const filename = textValue(value, 'artifact path', 4096);
  if (!filename || (filename.includes(':') && !path.isAbsolute(filename)))
    throw new Error('Invalid artifact path');
  const absolute = path.resolve(root, filename),
    relative = path.relative(root, absolute);
  if (
    !relative ||
    relative.includes(':') ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Artifact path is outside its workspace');
  return relative.split(path.sep).join('/');
}

export class ArtifactScanner {
  readonly root: string;
  private readonly excludes: ReadonlySet<string>;
  private readonly excludedPaths: ReadonlySet<string>;
  readonly limits: Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalBytes: number }>;
  readonly policyHash: string;

  constructor(root: string, options: SnapshotOptions = {}) {
    const canonical = realpathSync(path.resolve(textValue(root, 'workspace path', 4096)));
    this.root = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const excluded = options.excludeDirectories ?? [
      '.git',
      'node_modules',
      'target',
      'dist',
      '.next',
    ];
    if (
      !Array.isArray(excluded) ||
      excluded.length > 64 ||
      excluded.some(
        (name) =>
          !textValue(name, 'excluded directory', 128) ||
          ['.', '..'].includes(name) ||
          /[\\/:]/.test(name),
      )
    )
      throw new Error('Snapshot exclusions must be directory names');
    this.excludes = new Set(excluded.map(pathKey));
    if (!Array.isArray(options.excludePaths ?? []) || (options.excludePaths?.length ?? 0) > 64)
      throw new Error('Too many excluded artifact paths');
    this.excludedPaths = new Set(
      (options.excludePaths ?? []).map((filename) =>
        pathKey(workspaceRelative(this.root, filename)),
      ),
    );
    this.limits = Object.freeze({
      maxFiles: positiveInteger(options.maxFiles ?? 2000, 'snapshot file limit', 10000),
      maxFileBytes: positiveInteger(
        options.maxFileBytes ?? 16777216,
        'snapshot file byte limit',
        67108864,
      ),
      maxTotalBytes: positiveInteger(
        options.maxTotalBytes ?? 268435456,
        'snapshot total byte limit',
        1073741824,
      ),
    });
    this.policyHash = fingerprint({
      excluded: [...this.excludes].sort(),
      excludedPaths: [...this.excludedPaths].sort(),
      ...this.limits,
    });
  }

  async scan(signal: AbortSignal): Promise<ArtifactSnapshot> {
    const queue = [this.root],
      files: ArtifactFile[] = [];
    let bytes = 0,
      entriesSeen = 0;
    while (queue.length) {
      signal.throwIfAborted();
      const directory = queue.pop()!;
      if (!(await lstat(directory)).isDirectory()) throw new Error('Snapshot directory changed');
      for await (const entry of await opendir(directory)) {
        signal.throwIfAborted();
        if (++entriesSeen > this.limits.maxFiles * 4)
          throw new Error('Snapshot directory-entry limit exceeded');
        const absolute = path.join(directory, entry.name);
        if (this.excludedPaths.has(pathKey(workspaceRelative(this.root, absolute)))) continue;
        const stat = await lstat(absolute);
        if (stat.isDirectory()) {
          if (!this.excludes.has(pathKey(entry.name))) queue.push(absolute);
          continue;
        }
        if (!stat.isFile() && !stat.isSymbolicLink())
          throw new Error('Unsupported artifact file type');
        if (files.length >= this.limits.maxFiles) throw new Error('Snapshot file limit exceeded');
        const file = stat.isSymbolicLink()
          ? await this.symbolicLink(absolute)
          : await this.hashFile(absolute, signal);
        bytes += file.bytes;
        if (bytes > this.limits.maxTotalBytes)
          throw new Error('Snapshot total byte limit exceeded');
        files.push(file);
      }
    }
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    plainJson(files, MAX_SNAPSHOT_BYTES, 65536);
    return { hash: fingerprint({ policy: this.policyHash, files }, MAX_SNAPSHOT_BYTES), files };
  }

  assertCovered(filenames: readonly string[]): void {
    for (const filename of filenames) {
      const relative = pathKey(workspaceRelative(this.root, filename)),
        parts = relative.split('/');
      if (
        parts.slice(0, -1).some((part) => this.excludes.has(part)) ||
        parts.some((_part, index) => this.excludedPaths.has(parts.slice(0, index + 1).join('/')))
      )
        throw new Error(
          'A declared file change is excluded from artifact verification; adjust the snapshot policy',
        );
    }
  }

  private async symbolicLink(absolute: string): Promise<ArtifactFile> {
    const target = await readlink(absolute),
      stat = await lstat(absolute);
    if (!stat.isSymbolicLink()) throw new Error('Artifact changed during snapshot');
    return {
      path: workspaceRelative(this.root, absolute),
      kind: 'symlink',
      sha256: createHash('sha256').update(target).digest('hex'),
      bytes: Buffer.byteLength(target),
      mode: stat.mode & 0o777,
    };
  }

  private async hashFile(absolute: string, signal: AbortSignal): Promise<ArtifactFile> {
    const resolved = await realpath(absolute);
    workspaceRelative(this.root, resolved);
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(this.limits.maxFileBytes))
        throw new Error('Unsupported or oversized artifact file');
      const hash = createHash('sha256'),
        buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > this.limits.maxFileBytes) throw new Error('Artifact grew beyond its byte limit');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true }),
        current = await lstat(absolute, { bigint: true });
      if (
        before.size !== BigInt(size) ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        after.ino !== current.ino ||
        after.dev !== current.dev ||
        current.isSymbolicLink() ||
        resolved !== (await realpath(absolute))
      )
        throw new Error('Artifact changed during snapshot');
      return {
        path: workspaceRelative(this.root, absolute),
        kind: 'file',
        sha256: hash.digest('hex'),
        bytes: size,
        mode: Number(after.mode & 0o777n),
      };
    } finally {
      await handle.close();
    }
  }
}

export function artifactChanges(
  before: ArtifactSnapshot,
  after: ArtifactSnapshot,
): ArtifactChange[] {
  const previous = new Map(before.files.map((file) => [file.path, file]));
  const current = new Map(after.files.map((file) => [file.path, file]));
  return [...new Set([...previous.keys(), ...current.keys()])].sort().flatMap((filename) => {
    const left = previous.get(filename) ?? null,
      right = current.get(filename) ?? null;
    return JSON.stringify(left) === JSON.stringify(right)
      ? []
      : [{ path: filename, before: left, after: right }];
  });
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
