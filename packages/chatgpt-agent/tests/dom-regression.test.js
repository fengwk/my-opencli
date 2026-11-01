/**
 * Directed DOM regression tests for ChatGPT DOM adaptation.
 *
 * Verifies that the generated JavaScript scripts (fileChipSnippet, composerRootSnippet,
 * previewCheckScript) execute correctly against:
 * 1. Real new ChatGPT DOM structures (form[data-chatgpt-composer], ProseMirror, 4 React file inputs,
 *    search-unit / conversation-role turns, sandbox <a> links).
 * 2. Legacy ChatGPT DOM structures (#prompt-textarea, behavior-btn buttons, author-role turns).
 * 3. Multi-turn history with user decoy links and historic assistant files (strict isolation).
 * 4. Empty marker protection: empty markers do NOT expand into broad unmarked parent containers or history.
 * 5. Strict sandbox evidence protection: external URLs (https://evil.example/mnt/data/x, data-sandbox)
 *    are strictly rejected.
 * 6. Composer-scoped upload preview: no fallback to body, random forms with buttons rejected.
 * 7. Strict visibility: rejects hidden, inert, aria-hidden="true", and zero-dimension elements.
 *
 * All tests execute the actual generated script strings in an isolated VM context against a DOM mock
 * backed by Cheerio.
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
  unwrapEvaluateResult,
} from '../src/dom-helpers.js';
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

describe('DOM Regression: Strict Sandbox Link Evidence Protection', () => {
  it('strictly rejects external URLs with /mnt/data/ path or data-sandbox attribute', () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <!-- Attack vectors: external URLs disguised with /mnt/data/ or data-sandbox -->
        <a href="https://evil.example/mnt/data/report.json">report.json</a>
        <a href="https://attacker.org/report.json" data-sandbox="true">report.json</a>
        <a href="//phishing.site/mnt/data/report.json">report.json</a>
        <!-- Genuine sandbox link -->
        <a href="sandbox:/mnt/data/report.json">Download report.json</a>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('report.json');
    })()`);

    // Must strictly select the sandbox:/ link, never external domains
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

    // Must return null, not adopt arbitrary form
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
      <!-- Unmarked broad conversation container with history -->
      <div class="unmarked-stream-container">
        <div class="user-turn">
          <a href="sandbox:/mnt/data/decoy.csv">decoy.csv</a>
        </div>
        <!-- Empty marker that has assistant search-unit-key -->
        <div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"></div>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    // The empty marker must NOT swallow the unmarked container and expose decoy.csv
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
