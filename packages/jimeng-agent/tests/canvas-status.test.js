import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import { Strategy } from '@jackwener/opencli/registry';

import { canvasStatusCommand } from '../canvas-status.js';

describe('jimeng-agent/canvas-status command registration', () => {
  it('registers a read-only ephemeral browser command', () => {
    expect(canvasStatusCommand.site).toBe('jimeng-agent');
    expect(canvasStatusCommand.name).toBe('canvas-status');
    expect(canvasStatusCommand.access).toBe('read');
    expect(canvasStatusCommand.strategy).toBe(Strategy.COOKIE);
    expect(canvasStatusCommand.browser).toBe(true);
    expect(canvasStatusCommand.siteSession).toBe('ephemeral');
    expect(canvasStatusCommand.defaultWindowMode).toBe('foreground');
    expect(canvasStatusCommand.navigateBefore).toBe(false);
  });

  it('exposes exact asset filtering and resource identity columns', () => {
    const byName = new Map(canvasStatusCommand.args.map((arg) => [arg.name, arg]));
    expect(byName.get('canvas')).toMatchObject({ required: true, valueRequired: true });
    expect(byName.get('asset_id')).toMatchObject({ valueRequired: true });
    expect(byName.get('max_pages')).toMatchObject({ type: 'int', default: 20 });
    for (const column of [
      'status',
      'projectId',
      'assetId',
      'turnId',
      'resourceId',
      'downloadUrl',
      'resourceCount',
      'scanComplete',
    ]) {
      expect(canvasStatusCommand.columns).toContain(column);
    }
  });

  it('validates an existing canvas and rejects create mode', () => {
    expect(() => canvasStatusCommand.validateArgs({
      canvas: 'project-1',
    })).not.toThrow();
    expect(() => canvasStatusCommand.validateArgs({
      canvas: 'new',
    })).toThrow(ArgumentError);
  });
});
