import { z } from 'zod';
import { BriqSpec, DnsName, EndpointProtocol, ExposeMode, RecipeFields } from './briq.js';
import { Sleep } from './sleep.js';

/**
 * The stack file, `briq.yaml`: a stack declared in the repo it serves, shaped like GitHub Actions
 * `services:`. Each service is what `briq_run` takes: a recipe and the fields it changes, or an
 * image with its settings. `briq_up` (MCP) and `POST /v1/stacks/up` create the services that do
 * not exist yet and leave the others alone.
 */

/** The file `briq up` looks for, in the current directory and then its parents. */
export const STACK_FILE_NAME = 'briq.yaml';
/** Services a file may declare: a stack is a handful of services, not a fleet. */
export const MAX_STACK_SERVICES = 32;

const Port = z.number().int().min(1).max(65535);

/**
 * Publish the service as `up` creates it: `"private"` (a URL only whoever has it can open) or
 * `"public"` on its front door, or `{ port?, mode?, protocol? }`. A database protocol
 * (`postgres`, `redis`…) gives a TCP endpoint over TLS instead of a URL.
 */
export const ServiceExpose = z
  .union([
    ExposeMode,
    z
      .object({
        port: Port.optional(),
        mode: ExposeMode.optional(),
        protocol: EndpointProtocol.optional(),
      })
      .strict(),
  ])
  .describe(
    'Publish it as it is created: "private" (only whoever has the URL), "public", or { port?, mode?, protocol? }. A database protocol (postgres, mysql, redis…) gives a TCP endpoint over TLS. Without a port: the front door of a recipe, the only port of an image',
  );
export type ServiceExpose = z.infer<typeof ServiceExpose>;

/** `expose` as one shape. */
export function exposeOf(
  e: ServiceExpose | undefined,
): { port?: number; mode: ExposeMode; protocol: EndpointProtocol } | undefined {
  if (e === undefined) return undefined;
  if (typeof e === 'string') return { mode: e, protocol: 'http' };
  return {
    ...(e.port === undefined ? {} : { port: e.port }),
    mode: e.mode ?? 'private',
    protocol: e.protocol ?? 'http',
  };
}

const ServiceSleep = Sleep.optional().describe(
  'When it goes to sleep without use: "30m", "3h", "7d", or "never". Default: the stack\'s `sleep`, then the environment\'s',
);

/** A service made by a recipe, with the fields it changes, as `briq_run` takes them. */
export const RecipeService = RecipeFields.extend({
  recipe: z.string().min(1).max(64).describe('A recipe, e.g. "postgres" (GET /v1/recipes)'),
  sleep: ServiceSleep,
  expose: ServiceExpose.optional(),
}).strict();
export type RecipeService = z.infer<typeof RecipeService>;

/** A service from any OCI image: a `BriqSpec` without its name, which is the service's key. */
export const ImageService = BriqSpec.omit({ name: true, sleep: true, expose: true })
  .extend({ sleep: ServiceSleep, expose: ServiceExpose.optional() })
  .strict();
export type ImageService = z.infer<typeof ImageService>;

export type StackService = RecipeService | ImageService;

/** The file. Parse it with `parseStackFile`, which reads each service as the shape it means. */
export const StackFile = z
  .object({
    stack: DnsName.describe('The stack to bring up; up can name another (a branch, a fork)'),
    sleep: Sleep.optional().describe(
      'When every service goes to sleep without use, unless the service says otherwise',
    ),
    services: z
      .record(DnsName, z.union([RecipeService, ImageService]))
      .describe('Service name → a recipe and the fields it changes, or an image with its settings'),
  })
  .strict();
export type StackFile = z.infer<typeof StackFile>;

/**
 * YAML reads `1025` as a number and `true` as a boolean, where an env value is a string: read
 * them as written, so `SMTP_PORT: 1025` means "1025".
 */
function envAsWritten(service: unknown): unknown {
  if (!service || typeof service !== 'object' || Array.isArray(service)) return service;
  const env = (service as { env?: unknown }).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return service;
  return {
    ...service,
    env: Object.fromEntries(
      Object.entries(env).map(([k, v]) => [
        k,
        typeof v === 'number' || typeof v === 'boolean' ? String(v) : v,
      ]),
    ),
  };
}

const where = (path: (string | number)[]) => (path.length ? `${path.join('.')}: ` : '');

/**
 * Parse a stack file already read into a value (from YAML or JSON). Each service is checked
 * against the shape it means, a recipe when it has `recipe` and an image otherwise, so a mistake
 * is reported against that shape. Returns every problem, by path.
 */
export function parseStackFile(
  input: unknown,
): { ok: true; file: StackFile } | { ok: false; problems: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, problems: ['the file must be a mapping: stack, services'] };
  const { services: declared, ...rest } = input as Record<string, unknown>;
  const problems: string[] = [];
  const top = StackFile.omit({ services: true }).safeParse(rest);
  if (!top.success) problems.push(...top.error.issues.map((i) => `${where(i.path)}${i.message}`));
  const services: Record<string, StackService> = {};
  if (!declared || typeof declared !== 'object' || Array.isArray(declared))
    problems.push('services: declare the services, by name');
  else {
    const entries = Object.entries(declared);
    if (!entries.length) problems.push('services: declare at least one service');
    if (entries.length > MAX_STACK_SERVICES)
      problems.push(`services: at most ${MAX_STACK_SERVICES} services`);
    for (const [name, value] of entries) {
      if (!DnsName.safeParse(name).success) {
        problems.push(
          `services.${name}: a service name must be lowercase letters, digits and single dashes, 32 characters at most`,
        );
        continue;
      }
      const shape =
        value && typeof value === 'object' && 'recipe' in value ? RecipeService : ImageService;
      const r = shape.safeParse(envAsWritten(value));
      if (r.success) services[name] = r.data;
      else
        problems.push(
          ...r.error.issues.map((i) => `${where(['services', name, ...i.path])}${i.message}`),
        );
    }
  }
  if (problems.length || !top.success) return { ok: false, problems };
  return { ok: true, file: { ...top.data, services } };
}
