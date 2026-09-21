import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import { canvasCreateCommand } from '../canvas-create.js';

describe('jimeng-agent/canvas-create command registration', () => {
  it('registers a browser-backed canvas creation command', () => {
    expect(canvasCreateCommand.site).toBe('jimeng-agent');
    expect(canvasCreateCommand.name).toBe('canvas-create');
    expect(canvasCreateCommand.access).toBe('write');
    expect(canvasCreateCommand.strategy).toBe(Strategy.COOKIE);
    expect(canvasCreateCommand.browser).toBe(true);
    expect(canvasCreateCommand.siteSession).toBe('persistent');
    expect(canvasCreateCommand.defaultWindowMode).toBe('foreground');
    expect(canvasCreateCommand.navigateBefore).toBe(false);
  });

  it('exposes only an optional title and returns the canvas identity', () => {
    const byName = new Map(canvasCreateCommand.args.map((arg) => [arg.name, arg]));
    expect([...byName.keys()]).toEqual(['title']);
    expect(byName.get('title')).toMatchObject({ valueRequired: true });
    for (const column of ['status', 'project-id', 'canvas-title', 'canvas-url']) {
      expect(canvasCreateCommand.columns).toContain(column);
    }
    for (const rejected of ['canvas', 'prompt', 'image', 'submit', 'duration', 'ratio', 'model-version']) {
      expect(byName.has(rejected)).toBe(false);
    }
  });

  it('accepts an optional title and rejects invalid titles', () => {
    expect(() => canvasCreateCommand.validateArgs({})).not.toThrow();
    expect(() => canvasCreateCommand.validateArgs({ title: '苏州猫咪短片' })).not.toThrow();
    expect(() => canvasCreateCommand.validateArgs({ title: '   ' })).toThrow(ArgumentError);
    expect(() => canvasCreateCommand.validateArgs({ title: 'x'.repeat(61) })).toThrow(ArgumentError);
  });
});
