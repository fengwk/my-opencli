import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import { videoCommand } from '../video.js';

function validArgs(overrides = {}) {
  return {
    workspace: '11718040705548',
    ratio: '16:9',
    model_version: 'seedance2.0',
    duration: 5,
    retry: 0,
    ...overrides,
  };
}

describe('jimeng-agent/video command registration', () => {
  it('registers as a persistent cookie-backed browser preparation command', () => {
    expect(videoCommand.site).toBe('jimeng-agent');
    expect(videoCommand.name).toBe('video');
    expect(videoCommand.strategy).toBe(Strategy.COOKIE);
    expect(videoCommand.browser).toBe(true);
    expect(videoCommand.siteSession).toBe('persistent');
    expect(videoCommand.navigateBefore).toBe(false);
    expect(videoCommand.access).toBe('write');
  });

  it('exposes repeatable media flags and a retry flag defaulting to zero', () => {
    const byName = new Map(videoCommand.args.map((arg) => [arg.name, arg]));
    for (const name of ['image', 'video', 'audio']) {
      expect(byName.get(name)).toMatchObject({ repeatable: true, valueRequired: true });
    }
    expect(byName.get('retry')).toMatchObject({ type: 'int', default: 0 });
  });

  it('performs pure contract validation before a browser session is used', () => {
    expect(() => videoCommand.validateArgs(validArgs())).not.toThrow();
    expect(() => videoCommand.validateArgs(validArgs({ retry: -1 }))).toThrow(ArgumentError);
    expect(() => videoCommand.validateArgs(validArgs({ ratio: '7:7' }))).toThrow(ArgumentError);
  });

  it('declares checkpoint and submit outcome columns with prepare-first semantics', () => {
    expect(videoCommand.columns).toContain('submitted');
    expect(videoCommand.columns).toContain('checkpointOk');
    expect(videoCommand.description).toMatch(/checkpoint/i);
    const byName = new Map(videoCommand.args.map((arg) => [arg.name, arg]));
    expect(byName.get('submit')).toMatchObject({ type: 'int', default: 0 });
  });
});
