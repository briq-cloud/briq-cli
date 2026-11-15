import { readFileSync } from 'node:fs';
import type { RunInput } from '@briq-cloud/sdk';
import type { ExposeMode, FileContent } from '@briq/public';
import { usage } from './errors.js';

export const mode = (v: string | undefined): ExposeMode | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'private' && v !== 'public') throw usage(`expected private or public, got "${v}"`);
  return v;
};
export const kv = (arr?: string[]) =>
  Object.fromEntries(
    (arr ?? []).map((s) => {
      const i = s.indexOf('=');
      if (i < 1) throw usage(`expected key=value, got "${s}"`);
      return [s.slice(0, i), s.slice(i + 1)];
    }),
  );

/** `--file <path>=<local file>`: text as it is, anything else as base64. */
const filesOf = (arr?: string[]): Record<string, FileContent> | undefined => {
  if (!arr?.length) return undefined;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  return Object.fromEntries(
    Object.entries(kv(arr)).map(([path, local]) => {
      const bytes = readFileSync(local);
      try {
        return [path, utf8.decode(bytes)];
      } catch {
        return [path, { base64: bytes.toString('base64') }];
      }
    }),
  );
};
const portsOf = (arr?: string[]): number[] | undefined =>
  arr?.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw usage(`--port ${p}: a port number`);
    return n;
  });
const intOf = (flag: string, v?: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw usage(`${flag} ${v}: a whole number`);
  return n;
};

export interface RunFlags {
  name?: string;
  stack?: string;
  size?: string;
  sleep?: string;
  onExit?: string;
  expose?: string;
  image?: string;
  env?: string[];
  cmd?: string;
  port?: string[];
  file?: string[];
  volume?: string;
  volumeGb?: string;
  checkout?: string;
  ref?: string;
  path?: string;
  token?: string;
  step?: string[];
  wait: boolean;
}

/** `briq run`'s body: an image's spec, or a recipe with the fields beside it (`RecipeFields`). */
export function runInput(target: string, o: RunFlags): RunInput {
  if (o.onExit !== undefined && o.onExit !== 'retain' && o.onExit !== 'destroy')
    throw usage('--on-exit expects retain or destroy');
  const expose = mode(o.expose);
  const env = o.env?.length ? kv(o.env) : undefined;
  const ports = portsOf(o.port);
  const files = filesOf(o.file);
  const gb = intOf('--volume-gb', o.volumeGb);
  const common = {
    ...(o.stack ? { stack: o.stack } : {}),
    ...(expose ? { expose } : {}),
    wait: o.wait,
  };
  if (target.includes(':') || target.includes('/')) {
    for (const [flag, v] of [
      ['--image', o.image],
      ['--checkout', o.checkout],
      ['--step', o.step],
    ] as const)
      if (v !== undefined) throw usage(`${flag} is for a recipe; ${target} is an image`);
    if (gb !== undefined && !o.volume) throw usage('--volume-gb needs --volume <mount path>');
    return {
      spec: {
        name: o.name ?? target.split('/').pop()?.split(':')[0] ?? 'app',
        image: target,
        ...(o.onExit ? { onExit: o.onExit as 'retain' | 'destroy' } : {}),
        ...(env ? { env } : {}),
        ...(o.cmd ? { cmd: o.cmd } : {}),
        ...(ports ? { ports } : {}),
        ...(files ? { files } : {}),
        ...(o.volume ? { volume: { mount: o.volume, ...(gb ? { gb } : {}) } } : {}),
        ...(o.size ? { size: o.size as 'small' } : {}),
        ...(o.sleep ? { sleep: o.sleep } : {}),
      },
      ...common,
    };
  }
  if (o.onExit !== undefined) throw usage('--on-exit is for an image run');
  if (o.volume)
    throw usage('--volume is for an image: a recipe mounts its own, size it with --volume-gb');
  if (!o.checkout)
    for (const [flag, v] of [
      ['--ref', o.ref],
      ['--path', o.path],
      ['--token', o.token],
    ] as const)
      if (v !== undefined) throw usage(`${flag} needs --checkout <repo>`);
  // A repo token travels as a secret's name; its value only from the environment, never a flag.
  const token = o.token
    ? { secret: o.token, ...(process.env[o.token] ? { value: process.env[o.token] } : {}) }
    : undefined;
  return {
    recipe: target,
    ...(o.name ? { name: o.name } : {}),
    ...(o.image ? { image: o.image } : {}),
    ...(env ? { env } : {}),
    ...(o.cmd ? { cmd: o.cmd } : {}),
    ...(o.size ? { size: o.size as 'small' } : {}),
    ...(gb ? { volume: { gb } } : {}),
    ...(files ? { files } : {}),
    ...(ports ? { ports } : {}),
    ...(o.checkout
      ? {
          checkout: {
            repo: o.checkout,
            ...(o.ref ? { ref: o.ref } : {}),
            ...(o.path ? { path: o.path } : {}),
            ...(token ? { token } : {}),
          },
        }
      : {}),
    ...(o.step?.length ? { steps: o.step.map((run) => ({ run })) } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...common,
  };
}
