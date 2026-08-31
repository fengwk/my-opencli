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
});
