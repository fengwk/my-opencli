import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrapeWithPage } from '../src/browser-scrape.js';

const createdFiles = new Set();

afterEach(() => {
  for (const file of createdFiles) {
    fs.rmSync(file, { force: true });
  }
  createdFiles.clear();
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
