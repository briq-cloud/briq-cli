import { describe, expect, it } from 'vitest';
import { exposeOf, parseStackFile } from './stack-file.js';

describe('stack file', () => {
  it('reads a recipe with the fields it changes, and an image with its settings', () => {
    const r = parseStackFile({
      stack: 'shop',
      sleep: '3h',
      services: {
        db: { recipe: 'postgres', image: 'pgvector/pgvector:pg16', volume: { gb: 10 } },
        web: {
          image: 'ghcr.io/acme/shop:1',
          cmd: 'npm start',
          ports: [3000],
          env: { PORT: 3000, DEBUG: false, DB: '{{briq:db}}', KEY: { secret: 'KEY' } },
          expose: 'private',
        },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.services.db).toMatchObject({ recipe: 'postgres', volume: { gb: 10 } });
    // As written: a YAML number or boolean in env is its string; a command string runs with sh -c.
    expect(r.file.services.web).toMatchObject({
      cmd: ['sh', '-c', 'npm start'],
      env: { PORT: '3000', DEBUG: 'false', KEY: { secret: 'KEY' } },
    });
  });

  it('says every problem, by path', () => {
    const r = parseStackFile({
      stack: 'Not A Name',
      services: {
        'Bad Name': { image: 'nginx' },
        db: { recipe: 'postgres', params: {} },
        web: { image: 'nginx', expose: 'everyone' },
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join('\n')).toMatch(/^stack: /m);
    expect(r.problems.join('\n')).toMatch(/services\.Bad Name: a service name/);
    expect(r.problems.join('\n')).toMatch(
      /services\.db: Unrecognized key\(s\) in object: 'params'/,
    );
    expect(r.problems.join('\n')).toMatch(/services\.web\.expose/);
    expect(parseStackFile({ stack: 'a', services: {} })).toEqual({
      ok: false,
      problems: ['services: declare at least one service'],
    });
    expect(parseStackFile('nope').ok).toBe(false);
  });

  it('reads expose as one shape', () => {
    expect(exposeOf(undefined)).toBeUndefined();
    expect(exposeOf('public')).toEqual({ mode: 'public', protocol: 'http' });
    expect(exposeOf({ port: 80 })).toEqual({ port: 80, mode: 'private', protocol: 'http' });
    expect(exposeOf({ protocol: 'postgres' })).toEqual({ mode: 'private', protocol: 'postgres' });
  });
});
