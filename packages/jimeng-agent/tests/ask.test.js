import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import { askCommand } from '../ask.js';

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

describe('jimeng-agent/ask command registration', () => {
  it('registers as a persistent cookie-backed browser preparation command', () => {
    expect(askCommand.site).toBe('jimeng-agent');
    expect(askCommand.name).toBe('ask');
    expect(askCommand.strategy).toBe(Strategy.COOKIE);
    expect(askCommand.browser).toBe(true);
    expect(askCommand.siteSession).toBe('persistent');
    expect(askCommand.navigateBefore).toBe(false);
    expect(askCommand.access).toBe('write');
  });

  it('exposes repeatable media flags and a retry flag defaulting to zero', () => {
    const byName = new Map(askCommand.args.map((arg) => [arg.name, arg]));
    for (const name of ['image', 'video', 'audio']) {
      expect(byName.get(name)).toMatchObject({ repeatable: true, valueRequired: true });
    }
    expect(byName.get('retry')).toMatchObject({ type: 'int', default: 0 });
  });

  it('performs pure contract validation before a browser session is used', () => {
    expect(() => askCommand.validateArgs(validArgs())).not.toThrow();
    expect(() => askCommand.validateArgs(validArgs({ retry: -1 }))).toThrow(ArgumentError);
    expect(() => askCommand.validateArgs(validArgs({ ratio: '7:7' }))).toThrow(ArgumentError);
  });

  it('declares checkpoint and submit outcome columns with prepare-first semantics', () => {
    expect(askCommand.columns).toContain('submitted');
    expect(askCommand.columns).toContain('checkpointOk');
    expect(askCommand.description).toMatch(/checkpoint/i);
    const byName = new Map(askCommand.args.map((arg) => [arg.name, arg]));
    expect(byName.get('submit')).toMatchObject({ type: 'int', default: 0 });
  });
});
