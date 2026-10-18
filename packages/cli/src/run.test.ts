import { describe, expect, it } from 'vitest';
import { runInput } from './program.js';

describe('briq run', () => {
  it('puts a recipe’s fields beside it, as briq_run takes them', () => {
    process.env.GH_TOKEN_TEST = 'ghp_x';
    expect(
      runInput('node', {
        checkout: 'github.com/acme/api',
        ref: 'main',
        token: 'GH_TOKEN_TEST',
        step: ['npm ci', 'npm run build'],
        cmd: 'npm start',
        port: ['3000'],
        env: ['NODE_ENV=production'],
        volumeGb: '5',
        expose: 'private',
        wait: true,
      }),
    ).toEqual({
      recipe: 'node',
      env: { NODE_ENV: 'production' },
      cmd: 'npm start',
      volume: { gb: 5 },
      ports: [3000],
      checkout: {
        repo: 'github.com/acme/api',
        ref: 'main',
        token: { secret: 'GH_TOKEN_TEST', value: 'ghp_x' },
      },
      steps: [{ run: 'npm ci' }, { run: 'npm run build' }],
      expose: 'private',
      wait: true,
    });
    Reflect.deleteProperty(process.env, 'GH_TOKEN_TEST');
  });

  it('makes an image’s spec, and refuses a recipe’s flags on it', () => {
    expect(
      runInput('nginx:1.27', { port: ['80'], volume: '/data', volumeGb: '2', wait: false }),
    ).toEqual({
      spec: { name: 'nginx', image: 'nginx:1.27', ports: [80], volume: { mount: '/data', gb: 2 } },
      wait: false,
    });
    expect(() => runInput('nginx:1.27', { step: ['x'], wait: true })).toThrow(/recipe/);
    expect(() => runInput('redis', { volume: '/x', wait: true })).toThrow(/image/);
    expect(() => runInput('node', { ref: 'main', wait: true })).toThrow(/--checkout/);
  });
});
