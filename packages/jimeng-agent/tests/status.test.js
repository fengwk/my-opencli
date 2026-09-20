import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import { statusCommand } from '../status.js';

function validArgs(overrides = {}) {
  return {
    workspace: '11718040705548',
    'search-key': '0123456789abcdef',
    ...overrides,
  };
}

describe('jimeng-agent/status command registration', () => {
  it('registers as an ephemeral cookie-backed browser command', () => {
    expect(statusCommand.site).toBe('jimeng-agent');
    expect(statusCommand.name).toBe('status');
    expect(statusCommand.strategy).toBe(Strategy.COOKIE);
    expect(statusCommand.browser).toBe(true);
    expect(statusCommand.siteSession).toBe('ephemeral');
    expect(statusCommand.defaultWindowMode).toBe('foreground');
    expect(statusCommand.access).toBe('write');
  });

  it('exposes kebab-case args and restricts download to 0 or 1', () => {
    const byName = new Map(statusCommand.args.map((arg) => [arg.name, arg]));
    expect(byName.get('search-key')).toMatchObject({ required: true, valueRequired: true });
    expect(byName.get('max-pages')).toMatchObject({ type: 'int', default: 5 });
    expect(byName.get('download')).toMatchObject({
      type: 'int',
      default: 0,
      choices: [0, 1],
    });
  });

  it('declares every field emitted by status rows', () => {
    for (const column of [
      'status',
      'search-key',
      'data-id',
      'task-type',
      'download-bytes',
      'download-note',
      'download-error',
      'download-warning',
      'download-skipped',
      'match-count',
      'rank',
      'source',
      'media-url',
    ]) {
      expect(statusCommand.columns).toContain(column);
    }
  });

  it('validates through the public kebab-case contract', () => {
    expect(() => statusCommand.validateArgs(validArgs())).not.toThrow();
    expect(() => statusCommand.validateArgs(validArgs({ limit: 0 }))).toThrow(ArgumentError);
    expect(() => statusCommand.validateArgs(validArgs({ 'search-key': '' }))).toThrow(ArgumentError);
  });
});
