import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrapeCommand } from '../scrape.js';
import { scrapeWithPage } from '../src/browser-scrape.js';
import { normalizeScrapeArgs } from '../src/contract.js';

const createdFiles = new Set();
const createdDirs = new Set();

afterEach(() => {
  for (const file of createdFiles) {
    fs.rmSync(file, { force: true });
  }
  createdFiles.clear();
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  createdDirs.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function trackResult(result) {
  for (const file of result.files || []) {
    createdFiles.add(file);
  }
  return result;
}

function mockPage({ html, title, url, textLength = 80, initialUrl = 'about:blank' }) {
  return {
    goto: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    screenshot: vi.fn(async ({ path: filePath }) => filePath),
    frames: vi.fn(async () => []),
    getCookies: vi.fn(async () => []),
    evaluate: vi.fn(async (js) => {
      if (String(js) === 'window.location.href') return initialUrl;
      if (String(js).includes('walkText') && String(js).includes('return walkText(document);')) {
        return textLength;
      }
      return {
        html,
        title,
        url,
        textLength,
        frames: [],
      };
    }),
  };
}

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-op-test-'));
  createdDirs.add(dir);
  return dir;
}

function outputPage(url = 'https://example.com/article') {
  return mockPage({
    html: '<html><body><p>Example article content.</p><a href="/one">One</a></body></html>',
    title: 'Example',
    url,
  });
}

describe('scrapeWithPage', () => {
  it('navigates, waits, and returns cleaned markdown without touching extra tabs', async () => {
    const html = `
      <html><body>
        <header class="header">nav</header>
        <article>
          <h1>Hello</h1>
          <p>This paragraph is long enough to be treated as the primary article body during extraction.</p>
        </article>
      </body></html>
    `;
    const page = mockPage({
      html,
      title: 'Hello',
      url: 'https://example.com/hello',
    });
    page.startNetworkCapture = vi.fn(async () => false);

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com/hello',
      as: 'markdown',
      onlyMainContent: true,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(page.goto).toHaveBeenCalledWith('https://example.com/hello', expect.objectContaining({ waitUntil: 'load' }));
    expect(page.startNetworkCapture.mock.invocationCallOrder[0]).toBeLessThan(page.goto.mock.invocationCallOrder[0]);
    expect(result.title).toBe('Hello');
    expect(result.url).toBe('https://example.com/hello');
    expect(result.as).toBe('markdown');
    expect(result.text).toContain('Title: Hello');
    expect(result.content).toContain('Hello');
    expect(result.content).not.toContain('nav');
    expect(result.truncated).toBe(false);
    expect(result.chars).toBeGreaterThan(0);
    expect(result.files[0]).toMatch(/content-.*\.md$/);
    // Omitted --op preserves the original temp directory.
    expect(path.dirname(result.files[0])).toBe(path.join(os.tmpdir(), 'opencli-scrape'));
    expect(fs.readFileSync(result.files[0], 'utf8')).toContain('Title: Hello');
    expect(result.text).toContain('Files saved:');
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.files[0]).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(result.files[0])).mode & 0o777).toBe(0o700);
    }
  });

  it('saves a screenshot file for --as screenshot', async () => {
    const page = mockPage({
      html: '<html><body><p>hi</p></body></html>',
      title: 'Hi',
      url: 'https://example.com',
    });
    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com',
      as: 'screenshot',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: false, format: 'png' }));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(/screenshot-.*\.png$/);
    expect(result.content).toBe('Screenshot saved');
    expect(result.text).not.toContain('Files saved:');
    expect(result.text).not.toContain('/tmp/opencli-scrape/');
    expect(fs.existsSync(result.files[0])).toBe(true);
  });

  it('downloads an explicit media URL before navigation when the cookie-aware probe succeeds', async () => {
    const page = mockPage({
      html: '<html><body>unused viewer</body></html>',
      title: 'secure.pdf',
      url: 'https://secure.example/secure.pdf',
    });
    page.getCookies.mockResolvedValue([{ name: 'session', value: 'host-cookie', path: '/' }]);
    page.evaluate.mockImplementation(async (js) => (
      String(js) === 'navigator.userAgent' ? 'Host Chrome' : 20
    ));
    const fetchMock = vi.fn(async () => new Response(Buffer.from('%PDF-1.7 preflight'), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'inline; filename="secure.pdf"',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://secure.example/secure.pdf',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(page.goto).not.toHaveBeenCalled();
    expect(result.as).toBe('media');
    expect(result.url).toBe('https://secure.example/secure.pdf');
    expect(result.text).not.toContain('Files saved:');
    expect(result.text).not.toContain('/tmp/opencli-scrape/');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://secure.example/secure.pdf',
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: 'session=host-cookie' }),
        redirect: 'manual',
      }),
    );
  });

  it('saves cookie-aware direct media instead of scraping a PDF viewer shell', async () => {
    const page = mockPage({
      html: '<html><body>pdf viewer</body></html>',
      title: 'file.pdf',
      url: 'https://cdn.example.com/file.pdf',
    });
    page.evaluate = vi.fn(async (js) => {
      if (String(js).includes('fetch(')) {
        return {
          mime: 'application/pdf',
          contentDisposition: 'inline; filename="file.pdf"',
          base64: Buffer.from('%PDF-1.7 media').toString('base64'),
        };
      }
      if (String(js).includes('return walkText(document);')) return 20;
      return {
        html: '<html><body>pdf viewer</body></html>',
        title: 'file.pdf',
        url: 'https://cdn.example.com/file.pdf',
        frames: [],
      };
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('pre-navigation fetch unavailable');
    }));

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://cdn.example.com/file.pdf',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));
    expect(result.as).toBe('media');
    expect(result.url).toBe('https://cdn.example.com/file.pdf');
    expect(result.content).toBe('Media file saved');
    expect(result.files[0]).toMatch(/media-.*\.pdf$/);
  });

  it('retries once on a transient navigation error', async () => {
    const html = '<html><body><p>Hello paragraph with enough text for extraction.</p></body></html>';
    const page = mockPage({
      html,
      title: 'Hello',
      url: 'https://example.com/hello',
    });
    page.goto
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockResolvedValueOnce(undefined);
    page.evaluate = vi.fn(async (js) => {
      const source = String(js);
      if (source === 'window.location.href') return 'about:blank';
      if (source.includes('return walkText(document);')) return 80;
      if (page.goto.mock.calls.length === 1) {
        return {
          html: '<html><body></body></html>',
          title: '',
          url: 'about:blank',
          textLength: 0,
          frames: [],
        };
      }
      return {
        html,
        title: 'Hello',
        url: 'https://example.com/hello',
        textLength: 80,
        frames: [],
      };
    });

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com/hello',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Hello paragraph');
  });

  it('continues when navigation reports an error after usable content has loaded', async () => {
    const html = '<html><body><p>Rendered despite a late navigation error.</p></body></html>';
    const page = mockPage({
      html,
      title: 'Late redirect',
      url: 'https://example.com/final',
    });
    let snapshotReads = 0;
    page.evaluate = vi.fn(async (js) => {
      const source = String(js);
      if (source === 'window.location.href') return 'about:blank';
      if (source.includes('return walkText(document);')) return 48;
      snapshotReads += 1;
      return {
        html,
        title: 'Late redirect',
        url: 'https://example.com/final',
        textLength: 48,
        frames: [],
      };
    });
    page.goto.mockRejectedValue(new Error('Inspected target navigated or closed'));

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com/start',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(snapshotReads).toBeGreaterThanOrEqual(2);
    expect(result.url).toBe('https://example.com/final');
    expect(result.content).toContain('Rendered despite a late navigation error.');
  });

  it('omits long markdown from JSON while preserving the full persisted document', async () => {
    const longBody = 'x'.repeat(10_100);
    const page = mockPage({
      html: `<html><body><article><p>${longBody}</p></article></body></html>`,
      title: 'Long',
      url: 'https://example.com/long',
      textLength: longBody.length,
    });

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com/long',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(result.truncated).toBe(true);
    expect(result.chars).toBeGreaterThan(10_000);
    expect(result.content).toBe('');
    expect(result.links).toEqual([]);
    expect(result.text).toContain('Content exceeds 10000 characters');
    expect(result.text).not.toContain('x'.repeat(100));
    expect(fs.readFileSync(result.files[0], 'utf8')).toContain(longBody);
  });

  it('keeps exactly 10000 characters inline and truncates at 10001', async () => {
    const prefix = 'Title: Boundary\nURL: https://example.com/boundary\n\n';
    const atBoundary = 'x'.repeat(10_000 - prefix.length);
    const firstPage = mockPage({
      html: `<html><body><p>${atBoundary}</p></body></html>`,
      title: 'Boundary',
      url: 'https://example.com/boundary',
      textLength: atBoundary.length,
    });
    const first = trackResult(await scrapeWithPage(firstPage, {
      url: 'https://example.com/boundary',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));
    expect(first.chars).toBe(10_000);
    expect(first.truncated).toBe(false);
    expect(first.content).toBe(atBoundary);

    const overBoundary = `${atBoundary}x`;
    const secondPage = mockPage({
      html: `<html><body><p>${overBoundary}</p></body></html>`,
      title: 'Boundary',
      url: 'https://example.com/boundary',
      textLength: overBoundary.length,
    });
    const second = trackResult(await scrapeWithPage(secondPage, {
      url: 'https://example.com/boundary',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));
    expect(second.chars).toBe(10_001);
    expect(second.truncated).toBe(true);
    expect(second.content).toBe('');
  });

  it('persists the full links envelope and returns structured links', async () => {
    const page = mockPage({
      html: '<html><body><a href="/one">One</a><a href="https://other.example/two">Two</a></body></html>',
      title: 'Links',
      url: 'https://example.com/start',
    });

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com/start',
      as: 'links',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(result.truncated).toBe(false);
    expect(result.content).toBe('');
    expect(result.links).toEqual([
      { text: 'One', href: 'https://example.com/one' },
      { text: 'Two', href: 'https://other.example/two' },
    ]);
    expect(result.files[0]).toMatch(/content-.*\.md$/);
    expect(fs.readFileSync(result.files[0], 'utf8')).toContain('- [One](https://example.com/one)');
  });

  it('collects cross-origin frame snapshots through the OpenCLI frame API', async () => {
    const page = mockPage({
      html: '<html><body><p>Main document body.</p><iframe src="https://frame.example/doc"></iframe></body></html>',
      title: 'Frames',
      url: 'https://example.com/frames',
    });
    page.frames.mockResolvedValue([{ index: 0, url: 'https://frame.example/doc' }]);
    page.evaluateInFrame = vi.fn(async (js) => {
      if (String(js).includes('return walkText(document);')) return 28;
      return {
        html: '<html><body><p>Cross-origin frame body.</p></body></html>',
        title: 'Frame',
        url: 'https://frame.example/doc',
        textLength: 28,
        frames: [],
        inaccessible: [],
      };
    });

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com/frames',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(page.evaluateInFrame).toHaveBeenCalled();
    expect(result.content).toContain('## Embedded Frame Contents');
    expect(result.content).toContain('Frame 1: https://frame.example/doc');
    expect(result.content).toContain('Cross-origin frame body.');
  });

  it('falls back to a cookie-aware Node fetch when page fetch is blocked by CORS', async () => {
    const page = mockPage({
      html: '<html><body></body></html>',
      title: '',
      url: 'about:blank',
      textLength: 0,
    });
    page.getCookies.mockImplementation(async ({ url }) => (
      url.startsWith('https://files.example.net/')
        ? [{ name: 'download_token', value: 'final', path: '/' }]
        : [{ name: 'sid', value: 'secret', path: '/' }]
    ));
    page.evaluate = vi.fn(async (js) => {
      const source = String(js);
      if (source.includes('fetch(')) return { error: 'Failed to fetch' };
      if (source === 'navigator.userAgent') return 'Host Chrome';
      if (source.includes('return walkText(document);')) return 0;
      return {
        html: '<html><body></body></html>',
        title: '',
        url: 'about:blank',
        textLength: 0,
        frames: [],
      };
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: {
          location: 'https://files.example.net/report.zip',
        },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from('PK\u0003\u0004archive'), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'inline; filename="report.zip"',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://cdn.example.com/download?id=1',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(result.as).toBe('media');
    expect(result.url).toBe('https://cdn.example.com/download?id=1');
    expect(result.files[0]).toMatch(/media-.*\.zip$/);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://cdn.example.com/download?id=1',
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: 'sid=secret' }),
        redirect: 'manual',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://files.example.net/report.zip',
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: 'download_token=final' }),
        redirect: 'manual',
      }),
    );
    expect(fetchMock.mock.calls[1][1].headers.cookie).not.toContain('sid=secret');
  });

  it('reports oversized direct media instead of scraping a viewer shell', async () => {
    const page = mockPage({
      html: '<html><body>pdf viewer</body></html>',
      title: 'large.pdf',
      url: 'https://cdn.example.com/large.pdf',
    });
    page.evaluate = vi.fn(async (js) => {
      if (String(js).includes('fetch(')) {
        return {
          mime: 'application/pdf',
          contentDisposition: 'inline; filename="large.pdf"',
          tooLarge: true,
          contentLength: 9 * 1024 * 1024,
        };
      }
      return 20;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('pre-navigation fetch unavailable');
    }));

    await expect(scrapeWithPage(page, {
      url: 'https://cdn.example.com/large.pdf',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    })).rejects.toThrow(/8 MiB transfer limit/);
  });

  it('does not save an HTML attachment response as direct media', async () => {
    const page = mockPage({
      html: '<html><body><p>Rendered error document.</p></body></html>',
      title: 'Error',
      url: 'https://example.com/download.pdf',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('x'.repeat(9 * 1024 * 1024)), {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-disposition': 'attachment; filename="download.pdf"',
        'content-length': String(9 * 1024 * 1024),
      },
    })));
    page.evaluate = vi.fn(async (js) => {
      const source = String(js);
      if (source === 'window.location.href') return 'about:blank';
      if (source.includes('fetch(')) {
        return {
          mime: 'text/html',
          contentDisposition: 'attachment; filename="download.pdf"',
        };
      }
      if (source.includes('return walkText(document);')) return 24;
      return {
        html: '<html><body><p>Rendered error document.</p></body></html>',
        title: 'Error',
        url: 'https://example.com/download.pdf',
        textLength: 24,
        frames: [],
      };
    });

    const result = trackResult(await scrapeWithPage(page, {
      url: 'https://example.com/download.pdf',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    }));

    expect(result.as).toBe('markdown');
    expect(result.content).toContain('Rendered error document.');
  });

  it('reports an HTML login/error body returned for an explicit media URL', async () => {
    const page = mockPage({
      html: '<html><body>unused</body></html>',
      title: '',
      url: 'about:blank',
      textLength: 0,
    });
    page.getCookies.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      Buffer.from('<!doctype html><html><body>login required</body></html>'),
      {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      },
    )));

    await expect(scrapeWithPage(page, {
      url: 'https://example.com/private.pdf',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    })).rejects.toThrow(/returned an HTML document/);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('fails rather than returning an empty success when snapshot collection breaks', async () => {
    const page = mockPage({
      html: '<html><body>unused</body></html>',
      title: 'Broken',
      url: 'https://example.com/broken',
    });
    page.evaluate = vi.fn(async (js) => {
      if (String(js).includes('return walkText(document);')) return 20;
      throw new Error('renderer unavailable');
    });

    await expect(scrapeWithPage(page, {
      url: 'https://example.com/broken',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    })).rejects.toThrow(/Failed to collect the rendered page content/);
  });

  it('removes a reserved screenshot artifact when capture fails', async () => {
    const page = mockPage({
      html: '<html><body>hi</body></html>',
      title: 'Hi',
      url: 'https://example.com',
    });
    let reservedPath = '';
    page.screenshot = vi.fn(async ({ path: filePath }) => {
      reservedPath = filePath;
      throw new Error('capture failed');
    });

    await expect(scrapeWithPage(page, {
      url: 'https://example.com',
      as: 'screenshot',
      onlyMainContent: false,
      timeoutSeconds: 15,
      timeoutMs: 15_000,
      waitForMs: 0,
    })).rejects.toThrow(/capture failed/);
    expect(reservedPath).not.toBe('');
    expect(fs.existsSync(reservedPath)).toBe(false);
  });

  it('honors the total scrape deadline after a slow browser operation', async () => {
    const page = mockPage({
      html: '<html><body><p>too late</p></body></html>',
      title: 'Slow',
      url: 'https://example.com/slow',
    });
    page.goto = vi.fn(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    await expect(scrapeWithPage(page, {
      url: 'https://example.com/slow',
      as: 'markdown',
      onlyMainContent: false,
      timeoutSeconds: 1,
      timeoutMs: 1,
      waitForMs: 0,
    })).rejects.toThrow(/timed out after 1s/);
  });
});

describe('scrape output directory', () => {
  it.each(['markdown', 'links'])('writes %s inline and as a full file through the command', async (as) => {
    // Exercise the public kwargs -> normalization -> artifact path, not just the writer.
    const outputDir = path.join(tempRoot(), 'nested', as);
    const url = 'https://example.com/article';
    const result = await scrapeCommand.func(outputPage(url), { url, as, op: outputDir });

    expect(result).toMatchObject({ title: 'Example', url, as, truncated: false });
    expect(result.files).toHaveLength(1);
    expect(path.dirname(result.files[0])).toBe(outputDir);
    expect(path.basename(result.files[0])).toMatch(/^content-.*\.md$/);
    const persisted = fs.readFileSync(result.files[0], 'utf8');
    expect(persisted).toContain('Title: Example');
    expect(result.text).toContain(result.files[0]);
    if (as === 'markdown') {
      expect(result.content).toContain('Example article content.');
      expect(persisted).toContain(result.content);
    } else {
      expect(result.links).toEqual([{ text: 'One', href: 'https://example.com/one' }]);
      expect(persisted).toContain('- [One](https://example.com/one)');
    }
    if (process.platform !== 'win32') {
      expect(fs.statSync(outputDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(result.files[0]).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps long content out of the inline result but complete in the chosen directory', async () => {
    // The explicit directory changes only placement, not the >10k response contract.
    const outputDir = path.join(tempRoot(), 'long');
    const url = 'https://example.com/long';
    const longBody = 'x'.repeat(10_100);
    const page = mockPage({
      html: `<html><body><p>${longBody}</p></body></html>`,
      title: 'Long',
      url,
      textLength: longBody.length,
    });
    const result = await scrapeCommand.func(page, { url, op: outputDir });
    expect(result).toMatchObject({ as: 'markdown', truncated: true, content: '', links: [] });
    expect(result.chars).toBeGreaterThan(10_000);
    expect(path.dirname(result.files[0])).toBe(outputDir);
    expect(result.text).toContain(result.files[0]);
    expect(result.text).not.toContain('x'.repeat(100));
    expect(fs.readFileSync(result.files[0], 'utf8')).toContain(longBody);
  });

  it.each([
    ['screenshot', false],
    ['fullscreenshot', true],
  ])('writes %s bytes and metadata directly in the chosen directory', async (as, fullPage) => {
    // Both screenshot variants must pass the same directory to the browser capture.
    const outputDir = path.join(tempRoot(), 'images');
    const page = outputPage();
    page.screenshot.mockImplementation(async ({ path: file }) => fs.writeFileSync(file, 'png bytes'));
    const result = await scrapeWithPage(page, normalizeScrapeArgs({ url: 'https://example.com/article', as, op: outputDir }));

    expect(result).toMatchObject({ title: 'Example', as, content: 'Screenshot saved', truncated: false });
    expect(result.files).toHaveLength(1);
    expect(path.dirname(result.files[0])).toBe(outputDir);
    expect(path.basename(result.files[0])).toMatch(new RegExp(`^${as}-.*\\.png$`));
    expect(page.screenshot).toHaveBeenCalledWith({ fullPage, path: result.files[0], format: 'png' });
    expect(fs.readFileSync(result.files[0], 'utf8')).toBe('png bytes');
  });

  it.each(['preflight', 'post-navigation', 'download-navigation', 'empty-page'])(
    'writes media from the %s probe to the chosen directory',
    async (route) => {
      // Each probe entry point must carry the per-call directory through to saveBinary.
      const outputDir = path.join(tempRoot(), 'media');
      const url = route === 'preflight' || route === 'post-navigation'
        ? 'https://example.com/file.pdf'
        : 'https://example.com/download';
      const page = outputPage(url);
      const bytes = Buffer.from('%PDF-1.7 chosen output');
      const response = {
        mime: 'application/pdf',
        contentDisposition: 'inline; filename="file.pdf"',
        url,
        base64: bytes.toString('base64'),
      };
      if (route === 'preflight' || route === 'empty-page') {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, {
          headers: { 'content-type': 'application/pdf', 'content-disposition': response.contentDisposition },
        })));
      } else {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('preflight unavailable'); }));
      }
      if (route === 'download-navigation') {
        page.goto.mockRejectedValue(new Error('Download is starting'));
      }
      if (route === 'post-navigation' || route === 'download-navigation') {
        const evaluate = page.evaluate.getMockImplementation();
        page.evaluate.mockImplementation(async (js) => String(js).includes('fetch(') ? response : evaluate(js));
      }
      if (route === 'empty-page') {
        page.evaluate.mockImplementation(async (js) => {
          if (String(js) === 'navigator.userAgent') return 'Host Chrome';
          if (String(js) === 'window.location.href') return 'about:blank';
          if (String(js).includes('return walkText(document);')) return 0;
          return { html: '', title: '', url: 'about:blank', textLength: 0, frames: [] };
        });
      }

      const result = await scrapeWithPage(page, normalizeScrapeArgs({ url, op: outputDir }));
      expect(result).toMatchObject({ as: 'media', title: 'file.pdf', url, content: 'Media file saved' });
      expect(result.files).toHaveLength(1);
      expect(path.dirname(result.files[0])).toBe(outputDir);
      expect(path.basename(result.files[0])).toMatch(/^media-.*\.pdf$/);
      expect(fs.readFileSync(result.files[0])).toEqual(bytes);
      if (route === 'preflight') expect(page.goto).not.toHaveBeenCalled();
      if (route === 'download-navigation') expect(page.goto).toHaveBeenCalledOnce();
    },
  );

  it('keeps concurrent invocations in their respective directories', async () => {
    // Hold both browser writes at a barrier so the calls overlap after reserving their files.
    const root = tempRoot();
    const dirs = [path.join(root, 'first'), path.join(root, 'second')];
    let arrivals = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const calls = dirs.map((outputDir, index) => {
      const page = outputPage();
      page.screenshot.mockImplementation(async ({ path: file }) => {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        fs.writeFileSync(file, `image ${index}`);
      });
      return scrapeWithPage(page, normalizeScrapeArgs({
        url: 'https://example.com/article', as: 'screenshot', op: outputDir,
      }));
    });
    const results = await Promise.all(calls);
    for (const [index, result] of results.entries()) {
      expect(path.dirname(result.files[0])).toBe(dirs[index]);
      expect(fs.readdirSync(dirs[index])).toEqual([path.basename(result.files[0])]);
      expect(fs.readFileSync(result.files[0], 'utf8')).toBe(`image ${index}`);
    }
  });

  it.skipIf(process.platform === 'win32')('keeps existing explicit directory modes, even at the default path', async () => {
    // The same absolute path has different chmod policy when explicitly selected.
    const root = tempRoot();
    vi.spyOn(os, 'tmpdir').mockReturnValue(root);
    const outputDir = path.join(root, 'opencli-scrape');
    fs.mkdirSync(outputDir);
    fs.chmodSync(outputDir, 0o751);
    const url = 'https://example.com/article';

    await scrapeWithPage(outputPage(url), normalizeScrapeArgs({ url, op: outputDir }));
    expect(fs.statSync(outputDir).mode & 0o777).toBe(0o751);
    await scrapeWithPage(outputPage(url), normalizeScrapeArgs({ url }));
    expect(fs.statSync(outputDir).mode & 0o777).toBe(0o700);
  });

  for (const kind of ['file', 'symlink']) {
    it.skipIf(kind === 'symlink' && process.platform === 'win32')(
      `rejects an unsafe ${kind} directory without attempting a fallback write`,
      async () => {
        // An invalid destination must fail before opening any artifact, including in the default directory.
        const root = tempRoot();
        const outputDir = path.join(root, 'destination');
        if (kind === 'file') {
          fs.writeFileSync(outputDir, 'keep');
        } else {
          const target = path.join(root, 'target');
          fs.mkdirSync(target);
          fs.symlinkSync(target, outputDir, 'dir');
        }
        const open = vi.spyOn(fsPromises, 'open');
        await expect(scrapeWithPage(outputPage(), normalizeScrapeArgs({
          url: 'https://example.com/article', op: outputDir,
        }))).rejects.toThrow();
        expect(open).not.toHaveBeenCalled();
        if (kind === 'file') expect(fs.readFileSync(outputDir, 'utf8')).toBe('keep');
        else expect(fs.readdirSync(path.join(root, 'target'))).toEqual([]);
      },
    );
  }

  it('does not create the output directory when navigation fails before a write', async () => {
    // Directory creation is lazy, not a side effect of validating or starting a scrape.
    const outputDir = path.join(tempRoot(), 'not-created');
    const page = outputPage('about:blank');
    page.goto.mockRejectedValue(new Error('navigation failed'));
    await expect(scrapeWithPage(page, normalizeScrapeArgs({
      url: 'https://example.com/article', op: outputDir,
    }))).rejects.toThrow('navigation failed');
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('propagates partial write failures and cleans only its own artifact', async () => {
    // A failed write after exclusive creation must remove the partial file, not neighbors.
    const outputDir = path.join(tempRoot(), 'files');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'keep');
    const originalOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalWrite = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
        await originalWrite('partial');
        throw new Error('disk full');
      });
      return handle;
    });
    await expect(scrapeWithPage(outputPage(), normalizeScrapeArgs({
      url: 'https://example.com/article', op: outputDir,
    }))).rejects.toThrow('disk full');
    expect(fs.readdirSync(outputDir)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it.each(['capture failure', 'timeout'])('cleans a screenshot reservation after %s', async (failure) => {
    // Failed or timed-out captures must leave the directory and unrelated files intact.
    const outputDir = path.join(tempRoot(), 'images');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'keep');
    let now = Date.now();
    if (failure === 'timeout') vi.spyOn(Date, 'now').mockImplementation(() => now);
    const page = outputPage();
    page.screenshot.mockImplementation(async ({ path: file }) => {
      fs.writeFileSync(file, 'partial');
      if (failure === 'capture failure') throw new Error('capture failed');
      now += 1001;
    });
    await expect(scrapeWithPage(page, normalizeScrapeArgs({
      url: 'https://example.com/article', as: 'fullscreenshot', op: outputDir, timeout: 1,
    }))).rejects.toThrow(failure === 'timeout' ? /timed out after 1s/ : /capture failed/);
    expect(fs.readdirSync(outputDir)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('does not delete an existing file when exclusive creation itself fails', async () => {
    // Failure before obtaining a handle provides no evidence that this call created the path.
    const outputDir = path.join(tempRoot(), 'files');
    fs.mkdirSync(outputDir);
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    vi.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('01020304', 'hex'));
    const existing = path.join(outputDir, 'content-123456-01020304.md');
    fs.writeFileSync(existing, 'other caller');
    vi.spyOn(fsPromises, 'open').mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }));
    await expect(scrapeWithPage(outputPage(), normalizeScrapeArgs({
      url: 'https://example.com/article', op: outputDir,
    }))).rejects.toThrow('access denied');
    expect(fs.readFileSync(existing, 'utf8')).toBe('other caller');
  });

  it('retries an exclusive-name collision without overwriting the existing file', async () => {
    // The file-handle writer must retain wx collision behavior and allocate a new name.
    const outputDir = path.join(tempRoot(), 'files');
    fs.mkdirSync(outputDir);
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    vi.spyOn(crypto, 'randomBytes')
      .mockReturnValueOnce(Buffer.from('01020304', 'hex'))
      .mockReturnValueOnce(Buffer.from('05060708', 'hex'));
    const existing = path.join(outputDir, 'content-123456-01020304.md');
    fs.writeFileSync(existing, 'other caller');
    const result = await scrapeWithPage(outputPage(), normalizeScrapeArgs({
      url: 'https://example.com/article', op: outputDir,
    }));
    expect(result.files).toEqual([path.join(outputDir, 'content-123456-05060708.md')]);
    expect(fs.readFileSync(existing, 'utf8')).toBe('other caller');
    expect(fs.readFileSync(result.files[0], 'utf8')).toContain('Example article content.');
  });
});
