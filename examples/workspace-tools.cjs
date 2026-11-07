// Small host-owned UTF-8 tools for the Ollama example. The host supplies the workspace directory.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const MAX_FILE_BYTES = 32768;

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(':')
  )
    throw new Error('The example tool requires a file inside the workspace');
}
function targetPath(root, filename) {
  const canonicalRoot = fs.realpathSync.native(root),
    requested = path.resolve(root, filename);
  const parent = fs.realpathSync.native(path.dirname(requested)),
    candidate = path.join(parent, path.basename(requested));
  contained(canonicalRoot, candidate);
  if (parent !== canonicalRoot) contained(canonicalRoot, parent);
  if (fs.existsSync(candidate)) {
    const info = fs.lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('The example tools require a regular file');
  }
  return candidate;
}
function readBytes(filename) {
  const handle = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(handle);
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error('Example files must fit within 32 KiB');
    const data = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < data.length) {
      const count = fs.readSync(handle, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES) throw new Error('The example file grew beyond 32 KiB');
    return data.subarray(0, length);
  } finally {
    fs.closeSync(handle);
  }
}
function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}
function writeText(args, context) {
  context.signal.throwIfAborted();
  let target;
  try {
    target = targetPath(context.workspaceRoot, args.path);
  } catch (error) {
    return readFailure(error);
  }
  const data = Buffer.from(args.content, 'utf8');
  if (data.length > MAX_FILE_BYTES) throw new Error('Example writes must fit within 32 KiB');
  const exists = fs.existsSync(target);
  let previous;
  try {
    previous = exists ? hash(readBytes(target)) : 'new';
  } catch (error) {
    return readFailure(error);
  }
  if (previous === hash(data))
    return { success: true, output: 'File already has the requested content' };
  if (previous !== args.expectedSha256)
    return {
      success: false,
      output: 'File changed since it was read. Read it again before editing.',
    };
  const temporary = path.join(path.dirname(target), `.gumiho-${randomUUID()}.tmp`);
  const canonicalRoot = fs.realpathSync.native(context.workspaceRoot);
  try {
    fs.writeFileSync(temporary, data, {
      flag: 'wx',
      mode: exists ? fs.statSync(target).mode & 0o777 : 0o600,
    });
    targetPath(context.workspaceRoot, args.path);
    if ((fs.existsSync(target) ? hash(readBytes(target)) : 'new') !== previous)
      return {
        success: false,
        output: 'File changed before commit. Read it again before editing.',
      };
    context.signal.throwIfAborted();
    fs.renameSync(temporary, target);
    return {
      success: true,
      output: 'File updated',
      data: { sha256: hash(data) },
      modifiedFiles: [path.relative(canonicalRoot, target).split(path.sep).join('/')],
    };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = [
  {
    name: 'read_text',
    version: '1',
    readOnly: true,
    description: 'Read a UTF-8 workspace file up to 32 KiB and return its SHA-256',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
      required: ['path'],
      additionalProperties: false,
    },
    execute(args, context) {
      context.signal.throwIfAborted();
      try {
        const data = readBytes(targetPath(context.workspaceRoot, args.path));
        return {
          success: true,
          output: new TextDecoder('utf-8', { fatal: true }).decode(data),
          data: { sha256: hash(data) },
        };
      } catch (error) {
        return readFailure(error);
      }
    },
  },
  {
    name: 'write_text',
    version: '1',
    idempotent: true,
    description:
      'Replace a workspace UTF-8 file using its previously read hash, or create one with expectedSha256 set to new. The parent directory must already exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1024 },
        content: { type: 'string', maxLength: 8192 },
        expectedSha256: { type: 'string', pattern: '^(new|[a-f0-9]{64})$' },
      },
      required: ['path', 'content', 'expectedSha256'],
      additionalProperties: false,
    },
    execute: writeText,
  },
];

function readFailure(error) {
  return {
    success: false,
    output: error.code ? `Workspace file operation failed (${error.code})` : error.message,
  };
}
