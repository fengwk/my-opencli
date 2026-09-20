import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import { canvasVideoCommand } from '../canvas-video.js';

function validArgs(overrides = {}) {
  return {
    canvas: 'new',
    ratio: '16:9',
    model_version: 'seedance2.0',
    duration: 5,
    retry: 0,
    ...overrides,
  };
}

describe('jimeng-agent/canvas-video command registration', () => {
  it('registers as a persistent cookie-backed browser command', () => {
    expect(canvasVideoCommand.site).toBe('jimeng-agent');
    expect(canvasVideoCommand.name).toBe('canvas-video');
    expect(canvasVideoCommand.strategy).toBe(Strategy.COOKIE);
    expect(canvasVideoCommand.browser).toBe(true);
    expect(canvasVideoCommand.siteSession).toBe('persistent');
    expect(canvasVideoCommand.defaultWindowMode).toBe('foreground');
    expect(canvasVideoCommand.navigateBefore).toBe(false);
    expect(canvasVideoCommand.access).toBe('write');
  });

  it('exposes canvas identity arg and repeatable media flags', () => {
    const byName = new Map(canvasVideoCommand.args.map((arg) => [arg.name, arg]));
    expect(byName.get('canvas')).toMatchObject({ required: true, valueRequired: true });
    expect(byName.get('title')).toMatchObject({ valueRequired: true });
    for (const name of ['image', 'video', 'audio']) {
      expect(byName.get(name)).toMatchObject({ repeatable: true, valueRequired: true });
    }
    expect(byName.get('retry')).toMatchObject({ type: 'int', default: 0 });
    expect(byName.get('submit')).toMatchObject({ type: 'int', default: 0 });
  });

  it('declares expected output columns', () => {
    expect(canvasVideoCommand.columns).toContain('canvas');
    expect(canvasVideoCommand.columns).toContain('canvasMode');
    expect(canvasVideoCommand.columns).toContain('projectId');
    expect(canvasVideoCommand.columns).toContain('canvasTitle');
    expect(canvasVideoCommand.columns).toContain('canvasUrl');
    expect(canvasVideoCommand.columns).toContain('submitted');
    expect(canvasVideoCommand.columns).toContain('checkpointOk');
    expect(canvasVideoCommand.columns).toContain('confirmation');
    expect(canvasVideoCommand.columns).toContain('sessionId');
    expect(canvasVideoCommand.columns).toContain('submitRequestCount');
  });

  it('validates args through pure contract validation', () => {
    expect(() => canvasVideoCommand.validateArgs(validArgs())).not.toThrow();
    expect(() => canvasVideoCommand.validateArgs(validArgs({ canvas: '' }))).toThrow(ArgumentError);
    expect(() => canvasVideoCommand.validateArgs(validArgs({ ratio: 'invalid' }))).toThrow(ArgumentError);
    expect(() => canvasVideoCommand.validateArgs(validArgs({ duration: 99 }))).toThrow(ArgumentError);
    expect(() => canvasVideoCommand.validateArgs(validArgs({
      canvas: 'existing-project',
      title: 'unexpected rename',
    }))).toThrow(ArgumentError);
  });
});
