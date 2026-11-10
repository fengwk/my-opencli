/**
 * Directed DOM regression tests for ChatGPT DOM adaptation.
 *
 * Verifies that the generated JavaScript scripts (fileChipSnippet, resourceRowSnippet,
 * composerRootSnippet, previewCheckScript) execute correctly against:
 * 1. Real new ChatGPT DOM structures (form[data-chatgpt-composer], ProseMirror, 4 React file inputs,
 *    search-unit / conversation-role turns, sandbox <a> links).
 * 2. Modern resource-row file download path:
 *    - Real DOM from live inspection: .group/resource-row with preview button and hover Download file button.
 *    - Focuses preview button to reveal download button, strictly clicks Download file (never clicks preview).
 *    - Strict turn & row isolation: no row crossing across files, user/history decoys rejected.
 * 3. End-to-end race elimination with fakePage:
 *    - waitForDownload is armed BEFORE clicking download controls.
 *    - No old flyout polling for resource-row path.
 *    - Distinguishes mode: 'resource-row' / 'panel' / 'chip-direct'.
 * 4. Legacy ChatGPT DOM structures (#prompt-textarea, behavior-btn buttons, author-role turns).
 * 5. Strict sandbox evidence protection: external URLs strictly rejected.
 * 6. Composer-scoped upload preview: no fallback to body, random forms with buttons rejected.
 * 7. Strict visibility: rejects hidden, inert, aria-hidden="true", and zero-dimension elements.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import * as vm from 'node:vm';
import {
  composerRootSnippet,
  domVisibilitySnippet,
  fileChipSnippet,
  lastAssistantTurnSnippet,
  modernImageExtractorScript,
  previewCheckScript,
  resourceRowSnippet,
  unwrapEvaluateResult,
} from '../src/dom-helpers.js';
import {
  downloadFilesViaDomClick,
} from '../src/download-dom.js';
import {
  COMPOSER_GENERAL_FILE_SELECTORS,
  COMPOSER_IMAGE_FILE_SELECTORS,
} from '../src/upload-dom.js';
import { imageDialogStateScript, imageTargetsScript, viewerImageStateScript } from '../src/image-export.js';

/**
 * Creates an execution environment exposing standard DOM interfaces to node:vm.
 */
function createDomSandbox(html, { origin = 'https://chatgpt.com', href = 'https://chatgpt.com/c/test-chat' } = {}) {
  const $ = cheerio.load(html);
  const nodeMap = new Map();

  function wrap(node) {
    if (!node || (node.type !== 'tag' && node.type !== 'root')) return null;
    if (nodeMap.has(node)) return nodeMap.get(node);

    const isRoot = node.type === 'root';
    const el = Object.create(HTMLElement.prototype);
    el.nodeType = 1;
    el.tagName = isRoot ? 'HTML' : (node.name || '').toUpperCase();
    el.name = node.name || '';

    Object.defineProperties(el, {
      className: { get() { return node.attribs?.class || ''; } },
      hidden: { get() { return 'hidden' in (node.attribs || {}); } },
      innerText: { get() { return $(node).text(); } },
      textContent: { get() { return $(node).text(); } },
      parentElement: {
        get() {
          let p = node.parent;
          while (p && p.type !== 'tag' && p.type !== 'root') p = p.parent;
          return p ? wrap(p) : null;
        },
      },
      children: {
        get() {
          return (node.children || []).filter((c) => c.type === 'tag').map(wrap);
        },
      },
    });

    el.getAttribute = (name) => node.attribs?.[name] ?? null;
    el.hasAttribute = (name) => name in (node.attribs || {});
    el.querySelector = (sel) => {
      const found = $(node).find(sel).first().get(0);
      return found ? wrap(found) : null;
    };
    el.querySelectorAll = (sel) => {
      return $(node).find(sel).toArray().map(wrap);
    };
    el.closest = (sel) => {
      const found = $(node).closest(sel).get(0);
      return found ? wrap(found) : null;
    };
    el.contains = (other) => {
      if (!other) return false;
      let curr = other;
      while (curr) {
        if (curr === el) return true;
        curr = curr.parentElement;
      }
      return false;
    };
    el.compareDocumentPosition = (other) => {
      if (el === other) return 0;
      const all = $('*').toArray();
      const iA = all.indexOf(node);
      const otherRaw = [...nodeMap.entries()].find(([_, v]) => v === other)?.[0];
      const iB = all.indexOf(otherRaw);
      return iB > iA ? 4 : 2; // 4: DOCUMENT_POSITION_FOLLOWING
    };
    el.getBoundingClientRect = () => {
      const style = node.attribs?.style || '';
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
        return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      }
      const swMatch = style.match(/(?:^|;)\s*width\s*:\s*(\d+)(?:px)?/i);
      const shMatch = style.match(/(?:^|;)\s*height\s*:\s*(\d+)(?:px)?/i);
      const width = swMatch ? Number(swMatch[1]) : (node.attribs?.width !== undefined ? Number(node.attribs.width) : 100);
      const height = shMatch ? Number(shMatch[1]) : (node.attribs?.height !== undefined ? Number(node.attribs.height) : 50);
      return { width, height, top: 0, left: 0, right: width, bottom: height };
    };
    el.scrollIntoView = () => {};
    el.focus = () => { el._focused = true; };
    el.click = () => { el._clicked = true; };

    if (el.tagName === 'IMG') {
      Object.defineProperties(el, {
        naturalWidth: {
          get() {
            if ('natural-width' in (node.attribs || {})) return Number(node.attribs['natural-width']);
            if ('naturalwidth' in (node.attribs || {})) return Number(node.attribs.naturalwidth);
            return Number(node.attribs?.width || 0);
          },
        },
        naturalHeight: {
          get() {
            if ('natural-height' in (node.attribs || {})) return Number(node.attribs['natural-height']);
            if ('naturalheight' in (node.attribs || {})) return Number(node.attribs.naturalheight);
            return Number(node.attribs?.height || 0);
          },
        },
        complete: {
          get() {
            if ('data-complete' in (node.attribs || {})) return node.attribs['data-complete'] === 'true';
            return true;
          },
        },
        currentSrc: {
          get() {
            return node.attribs?.src || '';
          },
        },
        src: {
          get() {
            return node.attribs?.src || '';
          },
        },
      });
    }

    nodeMap.set(node, el);
    return el;
  }

  function HTMLElement() {}

  const doc = {
    body: wrap($('body').get(0) || $.root().get(0)),
    documentElement: wrap($.root().get(0)),
    querySelector(sel) {
      const found = $(sel).first().get(0);
      return found ? wrap(found) : null;
    },
    querySelectorAll(sel) {
      return $(sel).toArray().map(wrap);
    },
    getElementById(id) {
      const found = $(`#${String(id).replace(/([:.])/g, '\\$1')}`).first().get(0);
      return found ? wrap(found) : null;
    },
  };

  const sandbox = {
    document: doc,
    window: {
      location: { origin, href },
      getComputedStyle: (target) => {
        const style = target?.getAttribute?.('style') || '';
        const isNone = /display\s*:\s*none/i.test(style);
        const isHidden = /visibility\s*:\s*hidden/i.test(style);
        return {
          display: isNone ? 'none' : 'block',
          visibility: isHidden ? 'hidden' : 'visible',
          opacity: '1',
        };
      },
      HTMLElement,
    },
    getComputedStyle: (target) => {
      const style = target?.getAttribute?.('style') || '';
      return {
        display: /display\s*:\s*none/i.test(style) ? 'none' : 'block',
        visibility: /visibility\s*:\s*hidden/i.test(style) ? 'hidden' : 'visible',
      };
    },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    HTMLElement,
    URL,
  };

  function runScript(script) {
    return vm.runInNewContext(script, sandbox);
  }

  return { sandbox, runScript, $ };
}

describe('DOM Regression: Modern ChatGPT Resource-Row Download', () => {
  const liveDomHtml = `
    <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
      <span class="group/resource-row relative">
        <button aria-label="Open preview of 番茄鸡蛋意大利面_两人份采购清单.csv" class="absolute inset-0" type="button" aria-busy="false"></button>
        <span class="pointer-events-none relative z-10">
          <span>
            <span class="truncate" title="番茄鸡蛋意大利面_两人份采购清单.csv">番茄鸡蛋意大利面_两人份采购清单.csv</span>
          </span>
          <span class="absolute end-3 top-1/2">
            <span class="pointer-events-none opacity-0 group-focus-within/resource-row:pointer-events-auto group-focus-within/resource-row:opacity-100 group-hover/resource-row:pointer-events-auto group-hover/resource-row:opacity-100">
              <button type="button" aria-label="Download file" id="live-dl-btn">svg icon</button>
            </span>
          </span>
        </span>
      </span>
    </div>
  `;

  it('locates modern resource-row and clicks Download file without clicking preview', () => {
    const { runScript, sandbox } = createDomSandbox(liveDomHtml);

    // 1. Locate resource-row download affordance
    const found = runScript(`(() => {
      ${resourceRowSnippet()}
      return findResourceRowDownload('番茄鸡蛋意大利面_两人份采购清单.csv');
    })()`);

    expect(found.found).toBe(true);
    expect(found.mode).toBe('resource-row');
    expect(found.aria).toBe('Download file');
    expect(found.previewAria).toBe('Open preview of 番茄鸡蛋意大利面_两人份采购清单.csv');

    // 2. Click resource-row download affordance
    const clicked = runScript(`(() => {
      ${resourceRowSnippet()}
      return clickResourceRowDownload('番茄鸡蛋意大利面_两人份采购清单.csv');
    })()`);

    expect(clicked.ok).toBe(true);
    expect(clicked.mode).toBe('resource-row');

    // Verify DOM state: preview focused, download button clicked, preview button NOT clicked!
    const previewBtn = sandbox.document.querySelector('button[aria-label^="Open preview"]');
    const dlBtn = sandbox.document.querySelector('#live-dl-btn');

    expect(previewBtn._focused).toBe(true);
    expect(previewBtn._clicked).toBeUndefined(); // NEVER clicked!
    expect(dlBtn._clicked).toBe(true); // Download clicked!
  });

  it('does not cross rows between multiple different files in the same turn', () => {
    const multiRowHtml = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <!-- Row 1: file_a.csv -->
        <span class="group/resource-row relative" id="row-a">
          <button aria-label="Open preview of file_a.csv" type="button"></button>
          <span>
            <span title="file_a.csv">file_a.csv</span>
            <span><button type="button" aria-label="Download file" id="dl-a"></button></span>
          </span>
        </span>

        <!-- Row 2: file_b.csv -->
        <span class="group/resource-row relative" id="row-b">
          <button aria-label="Open preview of file_b.csv" type="button"></button>
          <span>
            <span title="file_b.csv">file_b.csv</span>
            <span><button type="button" aria-label="Download file" id="dl-b"></button></span>
          </span>
        </span>
      </div>
    `;
    const { runScript, sandbox } = createDomSandbox(multiRowHtml);

    // Click file_b.csv only
    const clickedB = runScript(`(() => {
      ${resourceRowSnippet()}
      return clickResourceRowDownload('file_b.csv');
    })()`);
    expect(clickedB.ok).toBe(true);

    const dlA = sandbox.document.querySelector('#dl-a');
    const dlB = sandbox.document.querySelector('#dl-b');
    expect(dlB._clicked).toBe(true);
    expect(dlA._clicked).toBeUndefined(); // Must NOT touch dlA!
  });

  it('strictly isolates against user decoys and historic assistant turns', () => {
    const decoyHtml = `
      <!-- User turn decoy with same filename -->
      <div data-conversation-role="user" data-chatgpt-search-unit-key="fallback-turn-0:0:user">
        <span class="group/resource-row relative">
          <button aria-label="Open preview of target.csv"></button>
          <span><button type="button" aria-label="Download file" id="user-decoy"></button></span>
        </span>
      </div>

      <!-- Old assistant turn decoy with same filename -->
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <span class="group/resource-row relative">
          <button aria-label="Open preview of target.csv"></button>
          <span><button type="button" aria-label="Download file" id="old-assistant-decoy"></button></span>
        </span>
      </div>

      <!-- Latest assistant turn with a DIFFERENT file -->
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:2:assistant">
        <span class="group/resource-row relative">
          <button aria-label="Open preview of actual_latest.json"></button>
          <span><button type="button" aria-label="Download file" id="latest-btn"></button></span>
        </span>
      </div>
    `;
    const { runScript } = createDomSandbox(decoyHtml);

    // Searching for target.csv must fail because target.csv is not in the latest assistant turn
    const found = runScript(`(() => {
      ${resourceRowSnippet()}
      return findResourceRowDownload('target.csv');
    })()`);
    expect(found.found).toBe(false);

    // Searching for actual_latest.json must succeed
    const foundLatest = runScript(`(() => {
      ${resourceRowSnippet()}
      return findResourceRowDownload('actual_latest.json');
    })()`);
    expect(foundLatest.found).toBe(true);
  });
});

describe('DOM Regression: End-to-End Download Order and Race Elimination (fakePage)', () => {
  it('arms waitForDownload BEFORE clicking download button and never polls flyout for resource-row', async () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <span class="group/resource-row relative">
          <button aria-label="Open preview of 番茄鸡蛋意大利面_两人份采购清单.csv" class="absolute inset-0" type="button"></button>
          <span>
            <span title="番茄鸡蛋意大利面_两人份采购清单.csv">番茄鸡蛋意大利面_两人份采购清单.csv</span>
            <span>
              <button type="button" aria-label="Download file" id="dl-file">svg</button>
            </span>
          </span>
        </span>
      </div>
    `;
    const { runScript, sandbox } = createDomSandbox(html);

    const callTrace = [];
    const fakePage = {
      evaluate: async (script) => {
        const isFind = script.includes('return findResourceRowDownload');
        const isClick = script.includes('return clickResourceRowDownload');
        const isFlyout = script.includes('return inspectFlyout');
        callTrace.push({ type: 'evaluate', isFind, isClick, isFlyout });
        return runScript(script);
      },
      waitForDownload: (name, timeout) => {
        callTrace.push({ type: 'waitForDownload', name, timeout });
        return Promise.resolve({
          downloaded: true,
          filename: '番茄鸡蛋意大利面_两人份采购清单.csv',
          path: '/downloads/番茄鸡蛋意大利面_两人份采购清单.csv',
        });
      },
      sleep: async (sec) => {
        callTrace.push({ type: 'sleep', sec });
      },
    };

    const results = await downloadFilesViaDomClick(fakePage, ['番茄鸡蛋意大利面_两人份采购清单.csv']);

    expect(results).toHaveLength(1);
    expect(results[0].downloaded).toBe(true);
    expect(results[0].clickMeta.mode).toBe('resource-row');

    // Call trace assertions:
    // 1. waitForDownload must occur BEFORE clickResourceRowDownload
    const waitIdx = callTrace.findIndex((c) => c.type === 'waitForDownload');
    const clickIdx = callTrace.findIndex((c) => c.isClick);
    expect(waitIdx).toBeGreaterThan(-1);
    expect(clickIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeLessThan(clickIdx); // Armed BEFORE click!

    // 2. inspectFlyout must NOT have been polled
    const flyoutPolls = callTrace.filter((c) => c.isFlyout);
    expect(flyoutPolls).toHaveLength(0);

    // 3. In the DOM, preview was not clicked
    const previewBtn = sandbox.document.querySelector('button[aria-label^="Open preview"]');
    const dlBtn = sandbox.document.querySelector('#dl-file');
    expect(previewBtn._clicked).toBeUndefined();
    expect(dlBtn._clicked).toBe(true);
  });

  it('falls back to legacy panel when resource-row is absent, arming waiter before clicking', async () => {
    const legacyHtml = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <button class="behavior-btn" aria-label="legacy_doc.pdf">legacy_doc.pdf</button>
      </div>
      <section data-testid="screen-threadFlyOut" aria-label="legacy_doc.pdf">
        <header>
          <button aria-label="Download">Download</button>
          <button data-testid="close-button" aria-label="Close"></button>
        </header>
      </section>
    `;
    const { runScript } = createDomSandbox(legacyHtml);

    const callTrace = [];
    const fakePage = {
      evaluate: async (script) => {
        const isChipClick = script.includes('return clickFileChip');
        callTrace.push({ type: 'evaluate', isChipClick });
        return runScript(script);
      },
      waitForDownload: (name, timeout) => {
        callTrace.push({ type: 'waitForDownload', name });
        return Promise.resolve({
          downloaded: true,
          filename: 'legacy_doc.pdf',
          path: '/downloads/legacy_doc.pdf',
        });
      },
      sleep: async () => {},
    };

    const results = await downloadFilesViaDomClick(fakePage, ['legacy_doc.pdf']);

    expect(results).toHaveLength(1);
    expect(results[0].downloaded).toBe(true);
    expect(results[0].clickMeta.mode).toBe('panel');

    // Waiter must still be armed BEFORE clickFileChip!
    const waitIdx = callTrace.findIndex((c) => c.type === 'waitForDownload');
    const chipClickIdx = callTrace.findIndex((c) => c.isChipClick);
    expect(waitIdx).toBeLessThan(chipClickIdx);
  });

  it('preserves 0.4s gap between files and awaits waiter on click failure', async () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <!-- Row 1: file1.csv -->
        <span class="group/resource-row relative">
          <button aria-label="Open preview of file1.csv" type="button"></button>
          <span><button type="button" aria-label="Download file"></button></span>
        </span>
        <!-- Row 2: file2.csv -->
        <span class="group/resource-row relative">
          <button aria-label="Open preview of file2.csv" type="button"></button>
          <span><button type="button" aria-label="Download file"></button></span>
        </span>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    let waiterResolved = false;
    const sleeps = [];
    let clickCount = 0;

    const fakePage = {
      evaluate: async (script) => {
        if (script.includes('return clickResourceRowDownload')) {
          clickCount += 1;
          if (clickCount === 1) {
            // First file click fails
            return { ok: false, reason: 'forced-failure' };
          }
        }
        return runScript(script);
      },
      waitForDownload: () => {
        return new Promise((resolve) => {
          setTimeout(() => {
            waiterResolved = true;
            resolve({ downloaded: false, error: 'timed out' });
          }, 10);
        });
      },
      sleep: async (sec) => {
        sleeps.push(sec);
      },
    };

    const results = await downloadFilesViaDomClick(fakePage, ['file1.csv', 'file2.csv']);

    expect(results).toHaveLength(2);
    // File 1 failed but waiter was awaited and did not hang
    expect(results[0].clicked).toBe(false);
    expect(waiterResolved).toBe(true);
    // File 2 succeeded
    expect(results[1].clicked).toBe(true);
    // Verified 0.4s gap was executed between file 1 and file 2
    expect(sleeps).toContain(0.4);
  });

  it('rejects row when ancestor text contains filename but preview button belongs to different file', () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <!-- Ancestor container mentions file_x.csv in prose -->
        <div class="prose-wrapper">
          <p>We are discussing file_x.csv</p>
          <!-- The resource-row itself belongs to file_y.csv -->
          <span class="group/resource-row relative">
            <button aria-label="Open preview of file_y.csv" type="button"></button>
            <span><button type="button" aria-label="Download file"></button></span>
          </span>
        </div>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const foundX = runScript(`(() => {
      ${resourceRowSnippet()}
      return findResourceRowDownload('file_x.csv');
    })()`);

    // Must NOT match row of file_y just because parent text mentions file_x!
    expect(foundX.found).toBe(false);
  });
});

describe('DOM Regression: Strict Sandbox Link Evidence Protection', () => {
  it('strictly rejects external URLs with /mnt/data/ path or data-sandbox attribute', () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <a href="https://evil.example/mnt/data/report.json">report.json</a>
        <a href="https://attacker.org/report.json" data-sandbox="true">report.json</a>
        <a href="//phishing.site/mnt/data/report.json">report.json</a>
        <a href="sandbox:/mnt/data/report.json">Download report.json</a>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('report.json');
    })()`);

    expect(chip.found).toBe(true);
    expect(chip.href).toBe('sandbox:/mnt/data/report.json');
  });

  it('rejects completely when only external links exist even if path matches /mnt/data/', () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <a href="https://evil.example/mnt/data/sensitive.csv">sensitive.csv</a>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('sensitive.csv');
    })()`);

    expect(chip.found).toBe(false);
  });
});

describe('DOM Regression: Strict Visibility (hidden, inert, aria-hidden)', () => {
  it('rejects elements hidden via hidden attribute, inert ancestor, or aria-hidden', () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <a href="sandbox:/mnt/data/a.csv" hidden>a.csv</a>
        <div inert>
          <a href="sandbox:/mnt/data/b.csv">b.csv</a>
        </div>
        <div aria-hidden="true">
          <a href="sandbox:/mnt/data/c.csv">c.csv</a>
        </div>
        <a href="sandbox:/mnt/data/valid.csv">valid.csv</a>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    expect(runScript(`(() => { ${fileChipSnippet()} return findFileChip('a.csv').found; })()`)).toBe(false);
    expect(runScript(`(() => { ${fileChipSnippet()} return findFileChip('b.csv').found; })()`)).toBe(false);
    expect(runScript(`(() => { ${fileChipSnippet()} return findFileChip('c.csv').found; })()`)).toBe(false);
    expect(runScript(`(() => { ${fileChipSnippet()} return findFileChip('valid.csv').found; })()`)).toBe(true);
  });
});

describe('DOM Regression: Composer Scope Strict Resolution', () => {
  it('does NOT recognize arbitrary forms with buttons as composers', () => {
    const html = `
      <form id="some-random-settings-form">
        <button type="submit">Save settings</button>
      </form>
    `;
    const { runScript } = createDomSandbox(html);

    const root = runScript(`(() => {
      ${composerRootSnippet()}
      return findVisibleComposerRoot();
    })()`);

    expect(root).toBeNull();
  });

  it('resolves real form[data-chatgpt-composer]', () => {
    const html = `
      <form data-chatgpt-composer="true">
        <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>
        <button aria-label="Send"></button>
      </form>
    `;
    const { runScript } = createDomSandbox(html);

    const tag = runScript(`(() => {
      ${composerRootSnippet()}
      const r = findVisibleComposerRoot();
      return r ? r.tagName : null;
    })()`);

    expect(tag).toBe('FORM');
  });

  it('rejects preview false positives from body text when composer has no preview', () => {
    const html = `
      <div class="history">
        <p>Previously discussed my_file.txt</p>
        <img src="avatar.png" width="32" height="32" />
      </div>
      <form data-chatgpt-composer="true">
        <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>
      </form>
    `;
    const { runScript } = createDomSandbox(html);

    const result = runScript(previewCheckScript(['my_file.txt'], 1));
    expect(result).toBe(false);
  });
});

describe('DOM Regression: Last Assistant Turn Strict Bounding & Empty Marker Protection', () => {
  it('empty marker does NOT expand to unmarked broad parent containers containing history', () => {
    const html = `
      <div class="unmarked-stream-container">
        <div class="user-turn">
          <a href="sandbox:/mnt/data/decoy.csv">decoy.csv</a>
        </div>
        <div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"></div>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('decoy.csv');
    })()`);

    expect(chip.found).toBe(false);
  });

  it('correctly associates content when enclosing ancestor explicitly has assistant role', () => {
    const html = `
      <div data-conversation-role="assistant">
        <div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"></div>
        <div class="message-content">
          <a href="sandbox:/mnt/data/real.csv">real.csv</a>
        </div>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('real.csv');
    })()`);

    expect(chip.found).toBe(true);
    expect(chip.scope).toBe('last-assistant');
  });

  it('generic article without assistant role is never treated as assistant', () => {
    const html = `
      <article data-testid="conversation-turn-5">
        <p>I am a user query</p>
        <a href="sandbox:/mnt/data/user_upload.csv">user_upload.csv</a>
      </article>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('user_upload.csv');
    })()`);

    expect(chip.found).toBe(false);
  });

  it('selects the latest assistant turn in document order', () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <a href="sandbox:/mnt/data/turn1.csv">turn1.csv</a>
      </div>
      <div data-conversation-role="user" data-chatgpt-search-unit-key="fallback-turn-0:2:user">
        <p>Next request</p>
      </div>
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:3:assistant">
        <a href="sandbox:/mnt/data/turn3.csv">turn3.csv</a>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    expect(runScript(`(() => { ${fileChipSnippet()} return findFileChip('turn1.csv').found; })()`)).toBe(false);
    expect(runScript(`(() => { ${fileChipSnippet()} return findFileChip('turn3.csv').found; })()`)).toBe(true);
  });
});

describe('DOM Regression: Modern Composer File Input Routing', () => {
  it('strictly avoids Take a photo for general files and routes to Attach files', () => {
    const html = `
      <form data-chatgpt-composer="true">
        <input type="file" id="r1" aria-label="Take a photo" accept="image/*" />
        <input type="file" id="r2" aria-label="Attach photos or videos" accept="image/*,video/*" multiple />
        <input type="file" id="r3" aria-label="Attach photos" accept="image/*" multiple />
        <input type="file" id="r4" aria-label="Attach files" multiple />
      </form>
    `;
    const { sandbox } = createDomSandbox(html);

    let matched = null;
    for (const sel of COMPOSER_GENERAL_FILE_SELECTORS) {
      const el = sandbox.document.querySelector(sel);
      if (el) {
        matched = el.getAttribute('aria-label');
        break;
      }
    }

    expect(matched).toBe('Attach files');
    expect(matched).not.toBe('Take a photo');
  });
});

describe('DOM Regression: Modern ChatGPT Generated-Image Gallery Extractor', () => {
  const multiImageFixture = readFileSync(
    new URL('./__fixtures__/generated-images.html', import.meta.url),
    'utf8',
  );

  // Real UI mounts only the selected main preview; all full-size sources are in
  // the side rail. Export must include siblings in rail order, without repeats.
  it('extracts all three side-rail images in order even when image 2 is selected', () => {
    const { runScript } = createDomSandbox(`<main>${multiImageFixture}</main>`);
    const result = runScript(modernImageExtractorScript(['msg-current']));
    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([
      'blob:https://chatgpt.com/current-1',
      'blob:https://chatgpt.com/current-2',
      'blob:https://chatgpt.com/current-3',
    ]);
  });

  // Live follow-up turns leave lazy thumbnails at 0x0 even though their full
  // blobs already exist. Export can decode those without scrolling the UI.
  it('collects page-owned lazy rail blobs before thumbnail decode completes', () => {
    const html = multiImageFixture
      .replaceAll(/naturalwidth="\d+"/g, 'naturalwidth="0"')
      .replaceAll(/naturalheight="\d+"/g, 'naturalheight="0"')
      .replaceAll('loading="lazy"', 'loading="lazy" data-complete="false"');
    const { runScript } = createDomSandbox(`<main>${html}</main>`);
    expect(runScript(modernImageExtractorScript(['msg-current'])).urls).toEqual([
      'blob:https://chatgpt.com/current-1',
      'blob:https://chatgpt.com/current-2',
      'blob:https://chatgpt.com/current-3',
    ]);
  });

  // Adding the side rail must not widen export into user uploads or old turns.
  it('keeps side-rail exports isolated from historical and user image groups', () => {
    const history = multiImageFixture.replaceAll('msg-current', 'msg-history')
      .replaceAll('/current-', '/history-');
    const user = multiImageFixture.replace('<section ', '<section data-conversation-role="user" ')
      .replaceAll('/current-', '/user-');
    const { runScript } = createDomSandbox(`<main>${history}${multiImageFixture}${user}</main>`);
    const result = runScript(modernImageExtractorScript(['msg-current']));
    expect(result.urls).toEqual([
      'blob:https://chatgpt.com/current-1',
      'blob:https://chatgpt.com/current-2',
      'blob:https://chatgpt.com/current-3',
    ]);
  });

  // Verifies that a generated image with 0x0 layout rect but loaded 1254x1254 natural size
  // in the current turn is successfully extracted by URL.
  it('extracts loaded 1254x1254 image even when layout width/height is 0x0', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-current-1">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false" style="width:0;height:0">
              <img src="blob:https://chatgpt.com/current-uuid-1" naturalwidth="1254" naturalheight="1254" style="width:0;height:0" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript, sandbox } = createDomSandbox(html);
    const preview = sandbox.document.querySelector('[data-testid="generated-image-preview"]');
    const img = sandbox.document.querySelector('[data-testid="generated-image-preview"] img');
    expect(preview.getBoundingClientRect().width).toBe(0);
    expect(preview.getBoundingClientRect().height).toBe(0);
    expect(img.getBoundingClientRect().width).toBe(0);
    expect(img.getBoundingClientRect().height).toBe(0);
    expect(img.naturalWidth).toBe(1254);
    expect(img.naturalHeight).toBe(1254);

    const result = runScript(modernImageExtractorScript(['msg-current-1']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual(['blob:https://chatgpt.com/current-uuid-1']);
  });

  // Verifies that historical conversation image turns are strictly isolated and rejected
  // when matching against the current turn messageId.
  it('strictly rejects historical turns and only matches the specified current turn messageId', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-history-old">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/history-uuid" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </div>
        <div data-chatgpt-search-message-ids="msg-current-2">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/current-uuid-2" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-current-2']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual(['blob:https://chatgpt.com/current-uuid-2']);
  });

  // Verifies that matching is strictly scoped to the nearest gallery.closest container
  // and does NOT ascend to broader ancestral containers.
  it('strictly rejects when nearest container does not match even if a higher ancestor contains the target id', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-broad-ancestor">
          <div data-chatgpt-search-message-ids="msg-immediate-unmatched">
            <div data-testid="generated-image-gallery">
              <button data-testid="generated-image-preview" aria-hidden="false">
                <img src="blob:https://chatgpt.com/ancestor-leak-img" naturalwidth="1254" naturalheight="1254" />
              </button>
            </div>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-broad-ancestor']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([]);
  });

  // Verifies token matching when data-chatgpt-search-message-ids contains multiple tokens delimited by space/comma.
  it('matches target message ID within multi-token whitespace and comma delimited attribute', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="token-a, token-b token-c">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/multi-token-img" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['token-b']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual(['blob:https://chatgpt.com/multi-token-img']);
  });

  // Verifies that images placed inside user turn scope are strictly excluded from generated image exports.
  it('excludes images within user turn scope even if gallery markers are present', () => {
    const html = `
      <main>
        <div data-message-author-role="user" data-chatgpt-search-message-ids="msg-user">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/user-upload.png" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-user']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([]);
  });

  // Verifies that images inside composer scope (e.g. preview drafts or attachment chips) are excluded.
  it('excludes images inside composer scope', () => {
    const html = `
      <main>
        <form data-chatgpt-composer="true" data-chatgpt-search-message-ids="msg-composer">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/composer-preview.png" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </form>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-composer']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([]);
  });

  // Verifies that hidden/inert/aria-hidden/display:none/visibility:hidden images and ancestors are rejected.
  it('strictly excludes hidden, inert, aria-hidden="true", and styled hidden images', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-hidden-test">
          <!-- Hidden by hidden attribute on gallery -->
          <div data-testid="generated-image-gallery" hidden>
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/hidden-1" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
          <!-- Hidden by inert ancestor -->
          <div inert>
            <div data-testid="generated-image-gallery">
              <button data-testid="generated-image-preview" aria-hidden="false">
                <img src="blob:https://chatgpt.com/hidden-2" naturalwidth="1254" naturalheight="1254" />
              </button>
            </div>
          </div>
          <!-- Hidden by aria-hidden="true" on preview -->
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="true">
              <img src="blob:https://chatgpt.com/hidden-3" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
          <!-- Hidden by display:none ancestor -->
          <div style="display:none">
            <div data-testid="generated-image-gallery">
              <button data-testid="generated-image-preview" aria-hidden="false">
                <img src="blob:https://chatgpt.com/hidden-4" naturalwidth="1254" naturalheight="1254" />
              </button>
            </div>
          </div>
          <!-- Hidden by visibility:hidden ancestor -->
          <div style="visibility:hidden">
            <div data-testid="generated-image-gallery">
              <button data-testid="generated-image-preview" aria-hidden="false">
                <img src="blob:https://chatgpt.com/hidden-5" naturalwidth="1254" naturalheight="1254" />
              </button>
            </div>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-hidden-test']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([]);
  });

  // Verifies that unrendered or tiny placeholders with natural width/height < 128 are rejected.
  it('excludes images whose natural dimensions are < 128 (loading or small icon)', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-unloaded">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/zero-dim" naturalwidth="0" naturalheight="0" />
            </button>
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/small-icon" naturalwidth="64" naturalheight="64" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-unloaded']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([]);
  });

  // Verifies that incomplete images (complete === false) are rejected even if natural dimensions exist.
  it('excludes images whose complete status is false', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-loading">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/loading-img" naturalwidth="1254" naturalheight="1254" data-complete="false" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-loading']));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([]);
  });

  // Verifies that external search thumbnails and canvas elements outside gallery markers are ignored.
  it('ignores search thumbnails and canvas elements that lack gallery preview markers', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-search-results">
          <div class="search-card">
            <img src="https://images.openai.com/static-rsc-4/thumb.jpg" naturalwidth="256" naturalheight="256" />
            <canvas width="512" height="512"></canvas>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-search-results']));

    expect(result.modern).toBe(false);
    expect(result.urls).toEqual([]);
  });

  // Verifies fail-closed behavior: when messageIds is provided as an empty array, returns [] without leak.
  it('fails closed and returns [] when messageIds is provided as an empty array', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-any">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/any-image" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript([]));

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual([]);
  });

  // Verifies that when messageIds is omitted (beforeUrls snapshot mode), all loaded modern gallery images are returned.
  it('collects all loaded modern gallery images when messageIds is omitted (beforeUrls snapshot)', () => {
    const html = `
      <main>
        <div data-chatgpt-search-message-ids="msg-turn-1">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/img-1" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </div>
        <div data-chatgpt-search-message-ids="msg-turn-2">
          <div data-testid="generated-image-gallery">
            <button data-testid="generated-image-preview" aria-hidden="false">
              <img src="blob:https://chatgpt.com/img-2" naturalwidth="1254" naturalheight="1254" />
            </button>
          </div>
        </div>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript());

    expect(result.modern).toBe(true);
    expect(result.urls).toEqual(['blob:https://chatgpt.com/img-1', 'blob:https://chatgpt.com/img-2']);
  });

  // Verifies legacy fallback flag: returns modern: false when no modern gallery markers exist in main.
  it('returns modern: false when main has no modern gallery markers', () => {
    const html = `
      <main>
        <article data-turn="assistant">
          <p>Legacy text response without modern gallery</p>
          <img src="https://chatgpt.com/legacy-img.png" width="200" height="200" />
        </article>
      </main>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(modernImageExtractorScript(['msg-legacy']));

    expect(result.modern).toBe(false);
    expect(result.urls).toEqual([]);
  });
});

describe('DOM Regression: Native generated-image target discovery', () => {
  const multiImageFixture = readFileSync(
    new URL('./__fixtures__/generated-images.html', import.meta.url),
    'utf8',
  );

  // The production discovery script must enumerate all current-turn rail
  // controls in canonical order, independent of which image is selected.
  it('discovers three gallery images in side-rail order', () => {
    const { runScript } = createDomSandbox(`<main>${multiImageFixture}</main>`);
    const result = runScript(imageTargetsScript(['msg-current']));
    expect(result.targets.map(({ kind, order }) => ({ kind, order }))).toEqual([
      { kind: 'rail', order: 1 },
      { kind: 'rail', order: 2 },
      { kind: 'rail', order: 3 },
    ]);
    expect(result.targets.every((target) => target.selector.includes('data-chatgpt-search-message-ids~="msg-current"'))).toBe(true);
    expect(result.targets.map(({ sourceUrl }) => sourceUrl)).toEqual([
      'blob:https://chatgpt.com/current-1',
      'blob:https://chatgpt.com/current-2',
      'blob:https://chatgpt.com/current-3',
    ]);
  });

  // Duplicate/reordered protocol IDs and DOM scope tokens identify the same
  // logical turn; raw attribute spelling must not alter target identity.
  it('normalizes scoped message-id sets independently of token order and duplicates', () => {
    const firstHtml = multiImageFixture.replace(
      'msg-current msg-current msg-current', 'msg-a msg-b msg-a',
    );
    const reorderedHtml = multiImageFixture.replace(
      'msg-current msg-current msg-current', 'msg-b msg-a',
    );
    const first = createDomSandbox(`<main>${firstHtml}</main>`)
      .runScript(imageTargetsScript(['msg-b', 'msg-a', 'msg-a'])).targets;
    const reordered = createDomSandbox(`<main>${reorderedHtml}</main>`)
      .runScript(imageTargetsScript(['msg-a', 'msg-b'])).targets;
    expect(first.map(({ key }) => key)).toEqual(reordered.map(({ key }) => key));
    expect(first[0].key).toBe('msg-a,msg-b:1');
    expect(first[0].selector).toContain('[data-chatgpt-search-message-ids~="msg-a"]');
    expect(first[0].selector).toContain('[data-chatgpt-search-message-ids~="msg-b"]');

    // Reuse the discovered selector after the same scope's raw token spelling
    // changes; it must still resolve without an intervening rediscovery.
    const changedScope = multiImageFixture.replace(
      'msg-current msg-current msg-current', 'msg-current',
    );
    const [currentTarget] = createDomSandbox(`<main>${multiImageFixture}</main>`)
      .runScript(imageTargetsScript(['msg-current'])).targets;
    const selectorMatches = createDomSandbox(`<main>${changedScope}</main>`)
      .runScript(`document.querySelectorAll(${JSON.stringify(currentTarget.previewSelector)}).length`);
    expect(selectorMatches).toBe(1);
  });

  // Main gallery selection can be ahead of the actual viewer. Only the
  // viewer's decoded full image + current thumbnail can authorize a download.
  it('rejects a stale or undecoded viewer and maps only the scoped source', () => {
    const viewer = (src, loading = false) => `<div role="dialog" id="viewer">
      <button aria-label="Download"></button>
      <button data-image-thumbnail="true" aria-label="Generated image 99" aria-current="true">
        <img src="blob:https://chatgpt.com/current-2" naturalwidth="1672" naturalheight="941" />
      </button>
      <img src="${src}" naturalwidth="1672" naturalheight="941" data-complete="${!loading}" />
    </div>`;
    for (const [src, loading, expected] of [
      ['blob:https://chatgpt.com/current-1', false, false],
      ['blob:https://chatgpt.com/current-2', true, false],
      ['blob:https://chatgpt.com/current-2', false, true],
    ]) {
      const { runScript } = createDomSandbox(`<main>${multiImageFixture}</main>${viewer(src, loading)}`);
      const { targets } = runScript(imageTargetsScript(['msg-current']));
      const result = runScript(viewerImageStateScript(['msg-current'], targets[1]));
      expect(result.ready).toBe(expected);
      expect(result.selector).toContain('Generated image 99');
      expect(runScript(viewerImageStateScript(['wrong-message'], targets[1])).ready).toBe(false);
    }
  });

  // A broad ancestor that shares tokens makes the token selector ambiguous;
  // fail closed rather than let it widen scope or rely on raw attribute spelling.
  it('fails closed when a broader decoy scope shares current message tokens', () => {
    const history = multiImageFixture.replaceAll('msg-current', 'msg-history')
      .replaceAll('/current-', '/history-');
    const user = multiImageFixture.replace('<section ', '<section data-conversation-role="user" ')
      .replaceAll('/current-', '/user-').replaceAll('msg-current', 'msg-user');
    const nested = '<div data-chatgpt-search-message-ids="msg-current">'
      + '<div data-chatgpt-search-message-ids="other"><div data-testid="generated-image-gallery">'
      + '<button data-testid="generated-image-preview"></button></div></div></div>';
    const { runScript } = createDomSandbox(`<main>${history}${multiImageFixture}${user}${nested}</main>`);
    expect(runScript(imageTargetsScript(['msg-current']))).toMatchObject({
      targets: [], reason: 'ambiguous-gallery-scope',
    });
  });

  it('allows one scoped preview without a rail and fails closed for missing IDs', () => {
    const html = '<main><div data-chatgpt-search-message-ids="msg-one">'
      + '<div data-testid="generated-image-gallery"><button data-testid="generated-image-preview"></button>'
      + '</div></div></main>';
    expect(createDomSandbox(html).runScript(imageTargetsScript(['msg-one'])).targets)
      .toMatchObject([{ key: 'msg-one:1', kind: 'preview', order: 1 }]);
    expect(createDomSandbox(html).runScript(imageTargetsScript([])).targets).toEqual([]);
    expect(createDomSandbox(html).runScript(imageTargetsScript(['missing'])).targets).toEqual([]);
  });

  // A broad matching scope does not authorize a gallery nested in a user turn.
  it('excludes user galleries nested below a matching message scope', () => {
    const html = '<main><div data-chatgpt-search-message-ids="msg-one">'
      + '<div data-conversation-role="user"><div data-testid="generated-image-gallery">'
      + '<button data-testid="generated-image-preview"></button></div></div></div></main>';
    expect(createDomSandbox(html).runScript(imageTargetsScript(['msg-one'])).targets).toEqual([]);
  });

  // A decoy with equivalent tokens but different raw spelling still collides
  // with the semantic token selector and must stop rather than be selected.
  it('fails closed when another element shares tokens with different raw spelling', () => {
    const user = multiImageFixture
      .replace('<section ', '<section data-conversation-role="user" ')
      .replace('msg-current msg-current msg-current', 'msg-current');
    const { runScript } = createDomSandbox(`<main>${multiImageFixture}${user}</main>`);
    expect(runScript(imageTargetsScript(['msg-current']))).toMatchObject({
      targets: [], reason: 'ambiguous-gallery-scope',
    });
  });

  // Live virtualized galleries report height=0 with real images already loaded.
  // This must not be confused with an explicitly hidden or inert gallery.
  it('keeps zero-layout gallery controls but still excludes explicitly hidden scopes', () => {
    const zeroLayout = multiImageFixture
      .replace('data-testid="generated-image-gallery"', 'data-testid="generated-image-gallery" style="height:0px"')
      .replaceAll('<button ', '<button style="width:0px;height:0px" ');
    expect(createDomSandbox(`<main>${zeroLayout}</main>`)
      .runScript(imageTargetsScript(['msg-current'])).targets).toHaveLength(3);
    const hidden = zeroLayout.replace('<section ', '<section hidden ');
    expect(createDomSandbox(`<main>${hidden}</main>`)
      .runScript(imageTargetsScript(['msg-current'])).targets).toEqual([]);
  });

  // The viewer can detach the proven gallery. Its previously captured exact URL
  // must still map one thumbnail and one decoded full-size image, never history.
  it('maps the captured source after the scoped gallery is unmounted', () => {
    const { targets } = createDomSandbox(`<main>${multiImageFixture}</main>`)
      .runScript(imageTargetsScript(['msg-current']));
    const target = targets[1];
    const viewer = `<div role="dialog" id="viewer">
      <button aria-label="Download"></button>
      <button data-image-thumbnail="true" aria-label="Generated image current" aria-current="true">
        <img src="${target.sourceUrl}" naturalwidth="200" naturalheight="200" />
      </button><img src="${target.sourceUrl}" naturalwidth="200" naturalheight="200" />
    </div>`;
    const state = createDomSandbox(viewer).runScript(viewerImageStateScript(['msg-current'], target));
    expect(state.ready).toBe(true);
  });

  // aria-controls binds a menu explicitly; portal menus without it are accepted
  // only when the activated trigger advertises an expanded menu and one is visible.
  it('recognizes controlled and causally associated portal menus with exact item labels', () => {
    const controlled = `<div role="dialog" id="viewer"><button aria-label="下载" aria-haspopup="menu"
      aria-expanded="true" aria-controls="download-menu"></button></div>
      <div role="menu" id="download-menu"><button role="menuitem">下载图像</button>
      <button role="menuitem">下载全部图像</button></div>`;
    const control = createDomSandbox(controlled).runScript(imageDialogStateScript());
    expect(control.menu).toBe(true);
    expect(control).toMatchObject({ triggerPopup: 'menu', triggerExpanded: true });
    expect(control.items.map(({ text }) => text)).toEqual(['下载图像', '下载全部图像']);

    const portal = `<div role="dialog" id="viewer"><button aria-label="Download" aria-haspopup="menu"
      aria-expanded="true" aria-controls="null"></button></div><div role="menu"><button role="menuitem">Download image</button></div>`;
    const portalState = createDomSandbox(portal).runScript(imageDialogStateScript());
    expect(portalState.menu).toBe(true);
    expect(portalState.items[0].text).toBe('Download image');
  });
});
