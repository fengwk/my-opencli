import { describe, expect, it } from 'vitest';

import { askCommand } from '../ask.js';


describe('chatgpt-agent/ask command registration', () => {
  it('defaults the remote protocol turn timeout to 1200 seconds', () => {
    // Keep the plugin contract aligned with the wrapper Skill default.
    const timeout = askCommand.args.find((arg) => arg.name === 'timeout');
    expect(timeout).toMatchObject({ type: 'int', default: 1200 });
    expect(timeout.help).toContain('default 1200');
  });

  it('relies on OpenCLI default ephemeral site session (does not opt into persistent)', () => {
    // Without an explicit siteSession declaration, OpenCLI defaults to ephemeral tab leases.
    expect(askCommand.siteSession).toBeUndefined();
  });
});
