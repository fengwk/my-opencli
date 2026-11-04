import { describe, expect, it } from 'vitest';
import { Strategy } from '@jackwener/opencli/registry';

import { scrapeCommand } from '../scrape.js';

describe('utils/scrape command registration', () => {
  it('registers the background scrape command with the expected browser contract', () => {
    // Keep the public CLI contract pinned to utils/scrape.
    expect(scrapeCommand.site).toBe('utils');
    expect(scrapeCommand.name).toBe('scrape');
    expect(scrapeCommand.strategy).toBe(Strategy.COOKIE);
    expect(scrapeCommand.browser).toBe(true);
    expect(scrapeCommand.siteSession).toBe('ephemeral');
    expect(scrapeCommand.navigateBefore).toBe(false);
    expect(scrapeCommand.defaultWindowMode).toBe('background');
    expect(scrapeCommand.defaultFormat).toBe('json');
    expect(scrapeCommand.access).toBe('read');
    expect(scrapeCommand.example).toContain('opencli utils scrape');
  });

  it('exposes an optional output directory that requires a value', () => {
    // The CLI must distinguish an omitted option from a flag without a path.
    const op = scrapeCommand.args.find((arg) => arg.name === 'op');
    expect(op).toMatchObject({ name: 'op', valueRequired: true });
    expect(op.required).not.toBe(true);
    expect(op.default).toBeUndefined();
  });
});
