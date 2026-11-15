import { posix } from 'node:path';
import type { Briq } from './index.js';
import { BriqOperationError, fail, safe } from './native-errors.js';
import type { Command, CommandResult } from './native-exec.js';
export interface FileInfo {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: number;
}
export interface NativeFiles {
  transfer: 'files';
  listOrder: 'name';
  writeSupportsMode: true;
  stat(id: string, path: string): Promise<FileInfo>;
  list(id: string, path: string): Promise<FileInfo[]>;
  read(id: string, path: string): Promise<Uint8Array>;
  write(id: string, path: string, data: Uint8Array, opts?: { mode?: number }): Promise<void>;
  mkdir(id: string, path: string): Promise<void>;
  remove(id: string, path: string, opts?: { recursive?: boolean }): Promise<void>;
}
const METADATA_LIMIT = 4 * 1024 * 1024;
// Ordinary one-shot stdlib filesystem commands, with data only on finite JSON stdin.
// No installed guest helper, service, state files, or command interpolation.
const OP = String.raw`
import json,sys,os,stat,shutil
r=json.load(sys.stdin)
def info(p):
 s=os.lstat(p)
 t='symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else None
 if t is None: raise NotImplementedError()
 p.encode('utf-8',errors='strict')
 return dict(path=p,type=t,size=s.st_size,modifiedAt=int(s.st_mtime*1000))
try:
 p=r['path'];op=r['op'];v=None
 if op=='stat': v=info(p)
 elif op=='list': v=[info(os.path.join(p,n)) for n in sorted(os.listdir(p),key=os.fsencode)]
 elif op=='mkdir': os.makedirs(p,exist_ok=True)
 elif op=='mode': os.chmod(p,r['mode'])
 elif op=='remove':
  if os.path.isdir(p) and not os.path.islink(p):
   if r['recursive']: shutil.rmtree(p)
   else: os.rmdir(p)
  else: os.unlink(p)
 print(json.dumps(dict(value=v),ensure_ascii=True))
except FileNotFoundError: print(json.dumps(dict(error='file_not_found')))
except (NotImplementedError,UnicodeError): print(json.dumps(dict(error='unsupported')))
except (OSError,ValueError,KeyError): print(json.dumps(dict(error='provider')))
`;
const pathOf = (path: string) => {
  if (!posix.isAbsolute(path) || path.includes('\0'))
    throw fail('invalid_argument', 'File paths must be absolute POSIX paths');
  return posix.normalize(path);
};
export function files(
  client: Briq,
  managed: (id: string) => Promise<unknown>,
  run: (id: string, input: Command) => Promise<CommandResult>,
): NativeFiles {
  async function operation(
    id: string,
    op: string,
    path: string,
    extra: object = {},
  ): Promise<unknown> {
    await managed(id);
    let output = '';
    let excess = false;
    let result: CommandResult;
    try {
      result = await run(id, {
        cmd: ['python3', '-c', OP],
        cwd: '/',
        env: {},
        stdin: JSON.stringify({ op, path: pathOf(path), ...extra }),
        timeoutMs: 30000,
        live: false,
        onChunk: (chunk) => {
          if (chunk.stream === 'stdout') {
            if (Buffer.byteLength(output) + Buffer.byteLength(chunk.text) > METADATA_LIMIT) {
              excess = true;
              throw new Error('metadata bound');
            }
            output += chunk.text;
          }
        },
      });
    } catch (error) {
      if (excess && error instanceof BriqOperationError && error.code === 'provider')
        throw fail('quota', 'File metadata exceeds the adapter limit');
      throw error;
    }
    if (excess) throw fail('quota', 'File metadata exceeds the adapter limit');
    if (result.exitCode !== 0 || result.timedOut)
      throw fail('provider', 'Briq filesystem command failed');
    let answer: unknown;
    try {
      answer = JSON.parse(output);
    } catch {
      throw fail('provider', 'Invalid filesystem metadata');
    }
    if (!answer || typeof answer !== 'object')
      throw fail('provider', 'Invalid filesystem metadata');
    if ('error' in answer)
      throw fail(
        answer.error === 'file_not_found'
          ? 'file_not_found'
          : answer.error === 'unsupported'
            ? 'unsupported'
            : 'provider',
        'Briq filesystem operation failed',
      );
    if (!('value' in answer)) throw fail('provider', 'Invalid filesystem metadata');
    return answer.value;
  }
  const info = (value: unknown): FileInfo => {
    if (!value || typeof value !== 'object') throw fail('provider', 'Invalid file information');
    const v = value as FileInfo;
    if (
      typeof v.path !== 'string' ||
      !posix.isAbsolute(v.path) ||
      !['file', 'directory', 'symlink'].includes(v.type) ||
      !Number.isSafeInteger(v.size) ||
      v.size < 0 ||
      !Number.isFinite(v.modifiedAt)
    )
      throw fail('provider', 'Invalid file information');
    return { path: v.path, type: v.type, size: v.size, modifiedAt: v.modifiedAt };
  };
  const stat = async (id: string, path: string) => info(await operation(id, 'stat', path));
  return {
    transfer: 'files',
    listOrder: 'name',
    writeSupportsMode: true,
    stat,
    async list(id, path) {
      const answer = await operation(id, 'list', path);
      if (!Array.isArray(answer) || answer.length > 10000)
        throw fail('quota', 'Directory metadata exceeds the adapter limit');
      return answer.map(info);
    },
    async read(id, path) {
      await managed(id);
      return safe(() => client.getFileBytes(id, pathOf(path)), true);
    },
    async write(id, path, data, opts) {
      if (
        opts?.mode !== undefined &&
        (!Number.isInteger(opts.mode) || opts.mode < 0 || opts.mode > 0o7777)
      )
        throw fail('invalid_argument', 'Invalid file mode');
      await managed(id);
      await safe(() => client.putFileBytes(id, pathOf(path), data), true);
      if (opts?.mode !== undefined) {
        await operation(id, 'mode', path, { mode: opts.mode });
      }
    },
    async mkdir(id, path) {
      await operation(id, 'mkdir', path);
    },
    async remove(id, path, opts) {
      await operation(id, 'remove', path, { recursive: opts?.recursive ?? false });
    },
  };
}
