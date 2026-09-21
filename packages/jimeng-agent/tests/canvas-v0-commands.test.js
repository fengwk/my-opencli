import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import { canvasV0CreateCommand } from '../canvas-v0-create.js';
import { canvasV0VideoCommand } from '../canvas-v0-video.js';

function validAskArgs(overrides = {}) {
  return {
    canvas: 'new',
    ratio: '16:9',
    'model-version': 'seedance2.0',
    duration: 5,
    retry: 0,
    ...overrides,
  };
}

describe('jimeng-agent/canvas-v0-create command registration', () => {
  it('registers as a persistent cookie-backed browser command', () => {
    expect(canvasV0CreateCommand.site).toBe('jimeng-agent');
    expect(canvasV0CreateCommand.name).toBe('canvas-v0-create');
    expect(canvasV0CreateCommand.strategy).toBe(Strategy.COOKIE);
    expect(canvasV0CreateCommand.browser).toBe(true);
    expect(canvasV0CreateCommand.siteSession).toBe('persistent');
    expect(canvasV0CreateCommand.defaultWindowMode).toBe('foreground');
    expect(canvasV0CreateCommand.navigateBefore).toBe(false);
    expect(canvasV0CreateCommand.access).toBe('write');
  });

  it('exposes only the optional title flag', () => {
    const names = canvasV0CreateCommand.args.map((arg) => arg.name);
    expect(names).toEqual(['title']);
    expect(canvasV0CreateCommand.args[0].valueRequired).toBe(true);
  });

  it('declares expected output columns', () => {
    for (const column of ['status', 'project-id', 'draft-id', 'canvas-title', 'canvas-url']) {
      expect(canvasV0CreateCommand.columns).toContain(column);
    }
  });

  it('validates the title through the pure contract', () => {
    expect(() => canvasV0CreateCommand.validateArgs({})).not.toThrow();
    expect(() => canvasV0CreateCommand.validateArgs({ title: '苏州猫咪' })).not.toThrow();
    expect(() => canvasV0CreateCommand.validateArgs({ title: 'x'.repeat(21) })).toThrow(ArgumentError);
    expect(() => canvasV0CreateCommand.validateArgs({ title: '   ' })).toThrow(ArgumentError);
    expect(() => canvasV0CreateCommand.validateArgs({ canvas: 'new' })).toThrow(ArgumentError);
  });
});

describe('jimeng-agent/canvas-v0-video command registration', () => {
  it('registers as a persistent cookie-backed browser command', () => {
    expect(canvasV0VideoCommand.site).toBe('jimeng-agent');
    expect(canvasV0VideoCommand.name).toBe('canvas-v0-video');
    expect(canvasV0VideoCommand.strategy).toBe(Strategy.COOKIE);
    expect(canvasV0VideoCommand.browser).toBe(true);
    expect(canvasV0VideoCommand.siteSession).toBe('persistent');
    expect(canvasV0VideoCommand.defaultWindowMode).toBe('foreground');
    expect(canvasV0VideoCommand.navigateBefore).toBe(false);
    expect(canvasV0VideoCommand.access).toBe('write');
  });

  it('exposes canvas identity arg and repeatable media flags', () => {
    const byName = new Map(canvasV0VideoCommand.args.map((arg) => [arg.name, arg]));
    expect(byName.get('canvas')).toMatchObject({ required: true, valueRequired: true });
    expect(byName.get('title')).toMatchObject({ valueRequired: true });
    for (const name of ['image', 'video', 'audio']) {
      expect(byName.get(name)).toMatchObject({ repeatable: true, valueRequired: true });
    }
    expect(byName.get('ratio')).toMatchObject({ required: true, choices: expect.arrayContaining(['16:9', '9:16']) });
    expect(byName.get('model-version')).toMatchObject({ required: true });
    expect(byName.get('retry')).toMatchObject({ type: 'int', default: 0 });
    // Dry-run stays the default: a real generation costs credits.
    expect(byName.get('submit')).toMatchObject({ type: 'int', default: 0, choices: [0, 1] });
  });

  it('declares expected output columns', () => {
    for (const column of [
      'status',
      'canvas',
      'canvas-mode',
      'project-id',
      'canvas-title',
      'canvas-url',
      'uploaded',
      'references',
      'asset-id',
      'retry-used',
      'submitted',
      'checkpoint-ok',
      'confirmation',
      'session-id',
      'submit-request-count',
    ]) {
      expect(canvasV0VideoCommand.columns).toContain(column);
    }
  });

  it('validates args through pure contract validation', () => {
    expect(() => canvasV0VideoCommand.validateArgs(validAskArgs())).not.toThrow();
    expect(() => canvasV0VideoCommand.validateArgs(validAskArgs({ canvas: '' }))).toThrow(ArgumentError);
    expect(() => canvasV0VideoCommand.validateArgs(validAskArgs({ ratio: 'invalid' }))).toThrow(ArgumentError);
    expect(() => canvasV0VideoCommand.validateArgs(validAskArgs({ duration: 99 }))).toThrow(ArgumentError);
    expect(() => canvasV0VideoCommand.validateArgs(validAskArgs({
      canvas: '22104771569420',
      title: 'unexpected rename',
    }))).toThrow(ArgumentError);
    expect(() => canvasV0VideoCommand.validateArgs(validAskArgs({ typo: 1 }))).toThrow(ArgumentError);
  });
});
