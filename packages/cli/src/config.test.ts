import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiUrlOf, environmentOf, loadConfig, resolveCredential, saveConfig } from './config.js';

describe('cli config', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'briq-cli-')), 'briq');
    vi.stubEnv('BRIQ_CONFIG_DIR', dir);
    vi.stubEnv('BRIQ_API_URL', '');
    vi.stubEnv('BRIQ_API_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('starts empty on production, saves with 600 in a 700 directory, and reloads', () => {
    expect(loadConfig()).toEqual({});
    expect(apiUrlOf({})).toBe('https://api.briq.cloud');
    const file = saveConfig({
      apiUrl: 'http://localhost:3001',
      credential: { kind: 'key', key: 'bq_live_x' },
    });
    expect(file).toBe(join(dir, 'config.json'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const cfg = loadConfig();
    expect(apiUrlOf(cfg)).toBe('http://localhost:3001');
    expect(resolveCredential(cfg)).toEqual({
      source: 'file',
      credential: { kind: 'key', key: 'bq_live_x' },
    });
  });

  it('puts a wider file back to 600 when it saves', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}', { mode: 0o644 });
    saveConfig(loadConfig());
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('BRIQ_API_KEY wins; a credential is used only for the API it was made for', () => {
    const cfg = { apiUrl: 'http://a', credential: { kind: 'key' as const, key: 'saved' } };
    vi.stubEnv('BRIQ_API_URL', 'http://b/');
    expect(apiUrlOf(cfg)).toBe('http://b');
    expect(resolveCredential(cfg).source).toBe('none');
    vi.stubEnv('BRIQ_API_URL', 'http://a/');
    expect(resolveCredential(cfg).source).toBe('file');
    vi.stubEnv('BRIQ_API_KEY', 'from-env');
    expect(resolveCredential(cfg)).toEqual({
      source: 'env',
      credential: { kind: 'key', key: 'from-env' },
    });
    expect(resolveCredential(cfg, { env: false }).source).toBe('file');
  });

  it('says plainly when the file is broken', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{nope');
    expect(() => loadConfig()).toThrow(/not valid JSON/);
  });

  it('names environments as the dashboard does', () => {
    expect(environmentOf('https://api.briq.cloud')).toBe('production');
    expect(environmentOf('https://api.stg.briq.cloud')).toBe('staging');
    expect(environmentOf('http://localhost:3001')).toBe('local');
  });
});
