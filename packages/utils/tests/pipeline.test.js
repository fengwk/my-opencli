import { describe, expect, it } from 'vitest';
import {
  INLINE_TEXT_MAX_CHARS,
  buildLinksResult,
  buildTextResult,
  buildTruncatedNotice,
  formatScrapeText,
} from '../src/pipeline.js';
import { normalizeScrapeArgs } from '../src/contract.js';

describe('pipeline', () => {
  it('builds focused markdown from a noisy shell plus an article', () => {
    const html = `
      <html><body>
        <header class="header">Site Nav</header>
        <article class="article-content">
          <h1>Doc Title</h1>
          <p>This is the main document paragraph with enough detail to be treated as the primary content block.</p>
          <p>Another paragraph explains the proposal, trade-offs, rollout plan, and acceptance criteria in one place.</p>
        </article>
        <footer class="footer">copyright</footer>
      </body></html>
    `;
    const markdown = buildTextResult({
      title: 'Doc Title',
      url: 'https://example.com/doc',
      html,
      onlyMainContent: true,
    });
    expect(markdown).toContain('Doc Title');
    expect(markdown).toContain('Another paragraph explains the proposal');
    expect(markdown).not.toContain('Site Nav');
    expect(markdown).not.toContain('copyright');
  });

  it('merges iframe markdown when onlyMainContent is false', () => {
    const markdown = buildTextResult({
      title: 'Shell',
      url: 'https://example.com/shell',
      html: '<html><body><p>Outer shell paragraph with enough text to survive cleanup.</p></body></html>',
      frameDocuments: [
        {
          id: 'frame-1',
          parentId: null,
          url: 'https://example.com/frame',
          html: '<html><body><p>Inner frame paragraph with enough text to survive cleanup.</p></body></html>',
          depth: 1,
          order: 1,
        },
      ],
      onlyMainContent: false,
    });
    expect(markdown).toContain('Outer shell paragraph');
    expect(markdown).toContain('## Embedded Frame Contents');
    expect(markdown).toContain('Frame 1: https://example.com/frame');
    expect(markdown).toContain('Inner frame paragraph');
  });

  it('numbers nested frames as 1.1 like my-mcp', () => {
    const markdown = buildTextResult({
      title: 'Shell',
      url: 'https://example.com/shell',
      html: '<html><body><p>Outer shell paragraph with enough text to survive cleanup.</p></body></html>',
      frameDocuments: [
        {
          id: 'frame-1',
          parentId: null,
          url: 'https://example.com/outer-frame',
          html: '<html><body><p>Outer frame paragraph with enough text to survive cleanup.</p></body></html>',
          depth: 1,
          order: 1,
        },
        {
          id: 'frame-1-child',
          parentId: 'frame-1',
          url: 'https://example.com/inner-frame',
          html: '<html><body><p>Inner nested frame paragraph with enough text to survive cleanup.</p></body></html>',
          depth: 2,
          order: 2,
        },
      ],
      onlyMainContent: false,
    });
    expect(markdown).toContain('Frame 1: https://example.com/outer-frame');
    expect(markdown).toContain('Frame 1.1: https://example.com/inner-frame');
    expect(markdown).toMatch(/#### Frame 1\.1:/);
  });

  it('deduplicates links by href and prefers non-empty text', () => {
    const html = `
      <html><body>
        <a href="/a">First</a>
        <a href="https://example.com/a"></a>
        <a href="javascript:void(0)">skip</a>
      </body></html>
    `;
    const links = buildLinksResult({
      url: 'https://example.com/',
      html,
    });
    expect(links).toEqual([{ text: 'First', href: 'https://example.com/a' }]);
  });

  it('formats the my-mcp text envelope', () => {
    expect(formatScrapeText({
      title: 'Example',
      url: 'https://example.com',
      content: 'Hello',
    })).toBe('Title: Example\nURL: https://example.com\n\nHello');
  });

  it('omits the body when content exceeds 10k and only points at the saved file', () => {
    expect(INLINE_TEXT_MAX_CHARS).toBe(10_000);
    const notice = buildTruncatedNotice({
      title: 'Example',
      url: 'https://example.com',
      chars: 18_234,
      files: ['/tmp/opencli-scrape/content-1.md'],
    });
    expect(notice).toBe(
      `Title: Example
URL: https://example.com

Content exceeds 10000 characters (18234 chars) and was saved to:
- /tmp/opencli-scrape/content-1.md`,
    );
    expect(notice).not.toContain('xxxxx');
  });
});

describe('normalizeScrapeArgs', () => {
  it('accepts http(s) urls and scrape kinds', () => {
    const args = normalizeScrapeArgs({
      url: 'https://example.com/x',
      as: 'markdown',
      'only-main-content': 'true',
      timeout: 30,
    });
    expect(args).toMatchObject({
      url: 'https://example.com/x',
      as: 'markdown',
      onlyMainContent: true,
      timeoutSeconds: 30,
    });
  });

  it('rejects non-http urls and invalid kinds', () => {
    expect(() => normalizeScrapeArgs({ url: 'ftp://example.com' })).toThrow(/http\/https/);
    expect(() => normalizeScrapeArgs({ url: 'https://example.com', as: 'pdf' })).toThrow(/unsupported --as/);
    expect(() => normalizeScrapeArgs({ url: 'https://example.com', timeout: 0 })).toThrow(/timeout/);
    expect(() => normalizeScrapeArgs({ url: 'https://example.com', timeout: 181 })).toThrow(/timeout/);
    expect(() => normalizeScrapeArgs({ url: 'https://example.com', 'wait-for': Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(/wait-for/);
  });
});
