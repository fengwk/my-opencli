/**
 * Directed DOM regression tests for ChatGPT DOM adaptation.
 *
 * Verifies that the generated JavaScript scripts (fileChipSnippet, composerRootSnippet,
 * previewCheckScript, panelScript) execute correctly against:
 * 1. Real new ChatGPT DOM structures (form[data-chatgpt-composer], ProseMirror, 4 React file inputs,
 *    search-unit / conversation-role turns, sandbox <a> links).
 * 2. Legacy ChatGPT DOM structures (#prompt-textarea, behavior-btn buttons, author-role turns).
 * 3. Multi-turn history with user decoy links and historical assistant files (strict boundary).
 * 4. Nested turn attributes and empty wrapper markers (no duplicate turns, no empty wrapper trap).
 * 5. Strict sandbox evidence protection (rejects external arbitrary links).
 * 6. Composer-scoped upload preview (rejects global body decoys and avatars, requires composer scope).
 * 7. Real flyout panel structures inspection, download, and close.
 *
 * All tests execute the actual generated script strings in an isolated VM context against a DOM mock
 * backed by Cheerio, asserting real execution behavior rather than string matching.
 */

import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import * as vm from 'node:vm';
import {
  composerRootSnippet,
  domVisibilitySnippet,
  fileChipSnippet,
  lastAssistantTurnSnippet,
  panelScript,
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
function createDomSandbox(html) {
  const $ = cheerio.load(html);
  const nodeMap = new Map();

  function wrap(node) {
    if (!node || (node.type !== 'tag' && node.type !== 'root')) return null;
    if (nodeMap.has(node)) return nodeMap.get(node);

    const isRoot = node.type === 'root';
    const el = {
      nodeType: 1,
      tagName: isRoot ? 'HTML' : (node.name || '').toUpperCase(),
      name: node.name || '',
      get className() {
        return node.attribs?.class || '';
      },
      getAttribute(name) {
        return node.attribs?.[name] ?? null;
      },
      hasAttribute(name) {
        return name in (node.attribs || {});
      },
      get innerText() {
        return $(node).text();
      },
      get textContent() {
        return $(node).text();
      },
      get parentElement() {
        let p = node.parent;
        while (p && p.type !== 'tag' && p.type !== 'root') p = p.parent;
        return p ? wrap(p) : null;
      },
      get children() {
        return (node.children || []).filter((c) => c.type === 'tag').map(wrap);
      },
      querySelector(sel) {
        const found = $(node).find(sel).first().get(0);
        return found ? wrap(found) : null;
      },
      querySelectorAll(sel) {
        return $(node).find(sel).toArray().map(wrap);
      },
      closest(sel) {
        const found = $(node).closest(sel).get(0);
        return found ? wrap(found) : null;
      },
      contains(other) {
        if (!other) return false;
        let curr = other;
        while (curr) {
          if (curr === el) return true;
          curr = curr.parentElement;
        }
        return false;
      },
      compareDocumentPosition(other) {
        if (el === other) return 0;
        const all = $('*').toArray();
        const iA = all.indexOf(node);
        const otherRaw = [...nodeMap.entries()].find(([_, v]) => v === other)?.[0];
        const iB = all.indexOf(otherRaw);
        return iB > iA ? 4 : 2; // 4: DOCUMENT_POSITION_FOLLOWING
      },
      getBoundingClientRect() {
        // Elements with explicit display:none report 0x0
        const style = node.attribs?.style || '';
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
          return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        }
        const width = Number(node.attribs?.width) || 100;
        const height = Number(node.attribs?.height) || 50;
        return { width, height, top: 0, left: 0, right: width, bottom: height };
      },
      scrollIntoView() {},
      focus() {
        el._focused = true;
      },
      click() {
        el._clicked = true;
      },
    };

    nodeMap.set(node, el);
    return el;
  }

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
      HTMLElement: function HTMLElement() {},
    },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    HTMLElement: function HTMLElement() {},
  };

  function runScript(script) {
    return vm.runInNewContext(script, sandbox);
  }

  return { sandbox, runScript, $ };
}

describe('DOM Regression: Modern ChatGPT Web Structure', () => {
  it('correctly routes file upload selectors without hitting Take a photo', () => {
    const html = `
      <form data-chatgpt-composer="true">
        <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>
        <input type="file" id="_r_photo" aria-label="Take a photo" accept="image/*" />
        <input type="file" id="_r_both" aria-label="Attach photos or videos" accept="image/*,video/*" multiple />
        <input type="file" id="_r_img" aria-label="Attach photos" accept="image/*" multiple />
        <input type="file" id="_r_files" aria-label="Attach files" multiple />
        <button aria-label="Send"></button>
      </form>
    `;
    const { sandbox } = createDomSandbox(html);

    // 1. General file selectors must match the "Attach files" input first
    let generalMatched = null;
    for (const sel of COMPOSER_GENERAL_FILE_SELECTORS) {
      const el = sandbox.document.querySelector(sel);
      if (el) {
        generalMatched = { selector: sel, aria: el.getAttribute('aria-label') };
        break;
      }
    }
    expect(generalMatched).not.toBeNull();
    expect(generalMatched.aria).toBe('Attach files');
    expect(generalMatched.aria).not.toBe('Take a photo');

    // 2. Image file selectors must match an attach input, never Take a photo
    let imageMatched = null;
    for (const sel of COMPOSER_IMAGE_FILE_SELECTORS) {
      const el = sandbox.document.querySelector(sel);
      if (el) {
        imageMatched = { selector: sel, aria: el.getAttribute('aria-label') };
        break;
      }
    }
    expect(imageMatched).not.toBeNull();
    expect(imageMatched.aria).toMatch(/Attach files|Attach photos/);
    expect(imageMatched.aria).not.toBe('Take a photo');
  });

  it('locates and clicks real sandbox <a> links in the last assistant turn', () => {
    const html = `
      <div data-conversation-role="user" data-chatgpt-search-unit-key="fallback-turn-0:0:user">
        <p>Please analyze this data</p>
      </div>
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <div class="markdown">
          <p>Here is your processed output:</p>
          <a href="sandbox:/mnt/data/summary_result.csv" aria-label="summary_result.csv">Download summary_result.csv</a>
        </div>
      </div>
    `;
    const { runScript, sandbox } = createDomSandbox(html);

    // Execute generated chip identification script
    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('summary_result.csv');
    })()`);

    expect(chip.found).toBe(true);
    expect(chip.scope).toBe('last-assistant');
    expect(chip.tag).toBe('A');
    expect(chip.href).toBe('sandbox:/mnt/data/summary_result.csv');

    // Execute generated chip click script
    const clickRes = runScript(`(() => {
      ${fileChipSnippet()}
      return clickFileChip('summary_result.csv');
    })()`);

    expect(clickRes.ok).toBe(true);
    expect(clickRes.scope).toBe('last-assistant');

    // Verify DOM node received click
    const linkEl = sandbox.document.querySelector('a');
    expect(linkEl._clicked).toBe(true);
  });
});

describe('DOM Regression: Multi-Turn History and User Decoy Defense', () => {
  it('strictly targets the last assistant turn and ignores user decoys and historic assistant files', () => {
    const html = `
      <!-- Turn 0: User uploads a file with the same name -->
      <div data-conversation-role="user" data-chatgpt-search-unit-key="fallback-turn-0:0:user">
        <a href="sandbox:/mnt/data/data.csv">data.csv (user file)</a>
      </div>

      <!-- Turn 1: Assistant old reply with an old file -->
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <a href="sandbox:/mnt/data/old_analysis.json">old_analysis.json</a>
      </div>

      <!-- Turn 2: User prompt with another decoy -->
      <div data-conversation-role="user" data-chatgpt-search-unit-key="fallback-turn-0:2:user">
        <p>Now give me the final target.csv</p>
        <a href="sandbox:/mnt/data/target.csv">decoy_user_target.csv</a>
      </div>

      <!-- Turn 3: Latest assistant turn with genuine target.csv -->
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:3:assistant">
        <div class="markdown">
          <a href="sandbox:/mnt/data/target.csv">target.csv</a>
        </div>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    // 1. Target file must be picked from Turn 3, not Turn 2 user decoy
    const targetChip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('target.csv');
    })()`);
    expect(targetChip.found).toBe(true);
    expect(targetChip.scope).toBe('last-assistant');

    // 2. User-only file 'data.csv' must NOT be found in last assistant turn
    const userDecoyChip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('data.csv');
    })()`);
    expect(userDecoyChip.found).toBe(false);

    // 3. Historic assistant file 'old_analysis.json' must NOT be found in last assistant turn
    const oldAssistantChip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('old_analysis.json');
    })()`);
    expect(oldAssistantChip.found).toBe(false);
  });
});

describe('DOM Regression: Nested Attributes and Empty Wrapper Protection', () => {
  it('does not split a single turn into multiple turns and avoids getting trapped in empty wrappers', () => {
    const html = `
      <div data-conversation-role="assistant">
        <!-- Empty marker that might have search unit key -->
        <div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant"></div>
        <!-- Actual content wrapper -->
        <div class="content">
          <p>Here is your export:</p>
          <a href="sandbox:/mnt/data/nested_export.json">nested_export.json</a>
        </div>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('nested_export.json');
    })()`);

    expect(chip.found).toBe(true);
    expect(chip.scope).toBe('last-assistant');
    expect(chip.tag).toBe('A');
  });
});

describe('DOM Regression: Strict Sandbox Link Evidence Protection', () => {
  it('rejects external arbitrary links without sandbox proof even if filename matches', () => {
    const html = `
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <!-- Malicious external link with matching target filename -->
        <a href="https://evil.com/download/report.json">report.json</a>
        <a href="https://example.org/report.json">report.json</a>
        <!-- Genuine sandbox link -->
        <a href="sandbox:/mnt/data/report.json">Download report.json</a>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('report.json');
    })()`);

    // Must match the sandbox link, not the external ones
    expect(chip.found).toBe(true);
    expect(chip.href).toBe('sandbox:/mnt/data/report.json');

    // If only external links exist:
    const { runScript: runExternalOnly } = createDomSandbox(`
      <div data-conversation-role="assistant" data-chatgpt-search-unit-key="fallback-turn-0:1:assistant">
        <a href="https://evil.com/report.json">report.json</a>
      </div>
    `);
    const externalChip = runExternalOnly(`(() => {
      ${fileChipSnippet()}
      return findFileChip('report.json');
    })()`);
    expect(externalChip.found).toBe(false);
  });
});

describe('DOM Regression: Upload Preview Composer Scope Defense', () => {
  it('returns false when composer does not exist on page', () => {
    const html = `
      <div class="content">No composer on this page</div>
    `;
    const { runScript } = createDomSandbox(html);
    const result = runScript(previewCheckScript(['test.png'], 1));
    expect(result).toBe(false);
  });

  it('rejects false positives from global body text or avatar images', () => {
    const html = `
      <div class="chat-history">
        <p>In previous chat we discussed test.png</p>
        <img src="avatar.png" width="32" height="32" />
      </div>
      <!-- Real composer form without preview -->
      <form data-chatgpt-composer="true">
        <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>
      </form>
    `;
    const { runScript } = createDomSandbox(html);

    // Body contains 'test.png' and an avatar image > 24px, but composer does not!
    const result = runScript(previewCheckScript(['test.png'], 1));
    expect(result).toBe(false);
  });

  it('detects preview when mounted inside composer scope', () => {
    const html = `
      <form data-chatgpt-composer="true">
        <div class="attachment-preview">
          <span>test.png</span>
          <button aria-label="Remove attachment"></button>
        </div>
        <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Ask ChatGPT"></div>
      </form>
    `;
    const { runScript } = createDomSandbox(html);

    const result = runScript(previewCheckScript(['test.png'], 1));
    expect(result).toBe(true);
  });
});

describe('DOM Regression: Legacy DOM Structure Support', () => {
  it('supports legacy author-role assistant turn and behavior-btn buttons', () => {
    const html = `
      <div data-message-author-role="assistant">
        <p>Old ChatGPT format:</p>
        <button class="behavior-btn" aria-label="legacy_file.json">legacy_file.json</button>
      </div>
    `;
    const { runScript } = createDomSandbox(html);

    const chip = runScript(`(() => {
      ${fileChipSnippet()}
      return findFileChip('legacy_file.json');
    })()`);

    expect(chip.found).toBe(true);
    expect(chip.scope).toBe('last-assistant');
    expect(chip.tag).toBe('BUTTON');
  });

  it('supports legacy #prompt-textarea composer root resolution', () => {
    const html = `
      <form id="composer-form">
        <textarea id="prompt-textarea" placeholder="Send a message"></textarea>
      </form>
    `;
    const { runScript } = createDomSandbox(html);

    const rootTag = runScript(`(() => {
      ${composerRootSnippet()}
      const r = findVisibleComposerRoot();
      return r ? r.tagName : null;
    })()`);

    expect(rootTag).toBe('FORM');
  });
});

describe('DOM Regression: Flyout Panel Real Structure', () => {
  it('inspects, clicks download, and closes flyout on real ChatGPT panel structure', () => {
    const html = `
      <div data-testid="stage-thread-flyout">
        <section data-testid="screen-threadFlyOut" aria-label="table_data.csv">
          <header>
            <button aria-label="Download">Download</button>
            <button data-testid="close-button" aria-label="Close"></button>
          </header>
        </section>
      </div>
    `;
    const { runScript, sandbox } = createDomSandbox(html);

    // 1. inspectFlyout
    const inspected = runScript(`(() => {
      ${panelScript()}
      return inspectFlyout('table_data.csv');
    })()`);
    expect(inspected.hasFlyout).toBe(true);
    expect(inspected.hasDownload).toBe(true);

    // 2. clickFlyoutDownload
    const clicked = runScript(`(() => {
      ${panelScript()}
      return clickFlyoutDownload('table_data.csv');
    })()`);
    expect(clicked.ok).toBe(true);
    const dlBtn = sandbox.document.querySelector('button[aria-label="Download"]');
    expect(dlBtn._clicked).toBe(true);

    // 3. closeFlyout
    const closed = runScript(`(() => {
      ${panelScript()}
      return closeFlyout('table_data.csv');
    })()`);
    expect(closed.ok).toBe(true);
    const closeBtn = sandbox.document.querySelector('button[data-testid="close-button"]');
    expect(closeBtn._clicked).toBe(true);
  });
});
