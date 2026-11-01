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
import * as cheerio from 'cheerio';
import * as vm from 'node:vm';
import {
  composerRootSnippet,
  domVisibilitySnippet,
  fileChipSnippet,
  lastAssistantTurnSnippet,
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
      const width = Number(node.attribs?.width) || 100;
      const height = Number(node.attribs?.height) || 50;
      return { width, height, top: 0, left: 0, right: width, bottom: height };
    };
    el.scrollIntoView = () => {};
    el.focus = () => { el._focused = true; };
    el.click = () => { el._clicked = true; };

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
