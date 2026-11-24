import type { Briq } from '@briq-cloud/sdk';
import { CliError, usage } from './errors.js';

/**
 * The id of the briq a command names: an id (`bq_…`) as it is, or the name of one of the team's
 * live briqs. A name is unique only within its stack, so one that two stacks share is refused
 * with their ids instead of picking one.
 */
export async function resolveBriq(client: Pick<Briq, 'list'>, ref: string): Promise<string> {
  if (ref.startsWith('bq_')) return ref;
  const { briqs } = await client.list();
  const named = briqs.filter((b) => b.name === ref);
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1)
    throw usage(
      `${named.length} briqs are named ${ref} (in different stacks): use an id, ${named.map((b) => b.id).join(' or ')}`,
    );
  throw new CliError(
    `no briq named ${ref} in the team of this credential: \`briq list\` shows its briqs`,
  );
}
