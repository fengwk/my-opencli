/**
 * Shared DOM script helpers for ChatGPT web DOM interaction.
 *
 * Provides robust helper snippets and unwrap utilities for:
 * 1. Locating the visible composer root / form (form[data-chatgpt-composer] or active textarea).
 * 2. Identifying the last assistant message turn (supporting both new data-chatgpt-search-unit-key
 *    / data-conversation-role and legacy data-message-author-role / data-turn, strictly role-based,
 *    preventing duplicate turns from nested attributes and avoiding empty wrapper selections).
 * 3. File chip identification (supporting button.behavior-btn, button[aria-label], and sandbox <a>
 *    links with strict sandbox evidence, never downloading arbitrary external links).
 * 4. Download flyout inspection, click, and close.
 * 5. Image download button identification bounded to the last assistant turn.
 */

/**
 * Unwrap Page.evaluate return payload to handle both direct values and { session, data } envelopes.
 */
export function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

/**
 * Inline snippet defining the DOM visibility predicate isVisible(el).
 */
export function domVisibilitySnippet() {
  return `
    const isVisible = (el) => {
      if (!el) return false;
      if (typeof HTMLElement !== 'undefined' && !(el instanceof HTMLElement)) {
        if (!el.tagName && !el.nodeName) return false;
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        } catch (_) {}
      }
      if (typeof el.getBoundingClientRect === 'function') {
        try {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
        } catch (_) {}
      }
      return true;
    };
  `;
}

/**
 * Inline snippet defining findVisibleComposerRoot().
 * Returns the visible form or top-level container for the ChatGPT composer.
 * Never falls back to document.body.
 */
export function composerRootSnippet() {
  return `
    ${domVisibilitySnippet()}
    const findVisibleComposerRoot = () => {
      // 1. Try form[data-chatgpt-composer]
      const chatgptForms = [...document.querySelectorAll('form[data-chatgpt-composer]')];
      for (const form of chatgptForms) {
        if (isVisible(form)) return form;
      }

      // 2. Locate active/visible composer input, then resolve its containing form / scope
      const inputs = [
        ...document.querySelectorAll(
          'form[data-chatgpt-composer] .ProseMirror[contenteditable="true"], ' +
          '.ProseMirror[contenteditable="true"][role="textbox"], ' +
          '.ProseMirror[contenteditable="true"], ' +
          '#prompt-textarea, [data-testid="prompt-textarea"], ' +
          '[contenteditable="true"][role="textbox"], ' +
          'textarea[placeholder*="Ask"], textarea[placeholder*="ChatGPT"], textarea'
        ),
      ];

      for (const inp of inputs) {
        if (!isVisible(inp)) continue;
        const form = inp.closest('form[data-chatgpt-composer], form');
        if (form && isVisible(form)) return form;
        let curr = inp;
        for (let i = 0; i < 5 && curr && curr.parentElement && curr.parentElement !== document.body && curr.parentElement.tagName !== 'MAIN'; i += 1) {
          curr = curr.parentElement;
        }
        if (curr && isVisible(curr)) return curr;
      }

      // 3. Any visible form containing file inputs, text inputs, or buttons
      const forms = [...document.querySelectorAll('form')];
      for (const form of forms) {
        if (isVisible(form) && form.querySelector('input[type="file"], button, [contenteditable="true"], textarea')) {
          return form;
        }
      }

      return null;
    };
  `;
}

/**
 * Inline snippet defining findLastAssistantTurnRoot().
 *
 * Rules strictly followed:
 * - Never guess roles based on prose text.
 * - Restrict exclusively to the last assistant message; never use user messages or prior history turns.
 * - Prevent nested attributes from treating the same turn as multiple turns or selecting empty wrappers.
 * - Supports both new attributes (data-chatgpt-search-unit-key, data-conversation-role) and legacy ones.
 */
export function lastAssistantTurnSnippet() {
  return `
    ${domVisibilitySnippet()}
    const classifyTurnRole = (el) => {
      if (!el) return null;
      const getAttr = (name) => {
        try { return el.getAttribute(name) || ''; } catch (_) { return ''; }
      };

      const authRole = getAttr('data-message-author-role').toLowerCase();
      if (authRole === 'user') return 'user';
      if (authRole === 'assistant') return 'assistant';

      const convRole = getAttr('data-conversation-role').toLowerCase();
      if (convRole === 'user') return 'user';
      if (convRole === 'assistant') return 'assistant';

      const turn = getAttr('data-turn').toLowerCase();
      if (turn === 'user') return 'user';
      if (turn === 'assistant') return 'assistant';

      const searchKey = getAttr('data-chatgpt-search-unit-key').toLowerCase();
      if (searchKey) {
        if (/(?:^|:)user(?:$|:)/.test(searchKey) || searchKey.endsWith(':user')) return 'user';
        if (/(?:^|:)assistant(?:$|:)/.test(searchKey) || searchKey.endsWith(':assistant')) return 'assistant';
      }

      return null;
    };

    const isUnderUserNode = (el) => {
      let curr = el;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        if (classifyTurnRole(curr) === 'user') return true;
        curr = curr.parentElement;
      }
      return false;
    };

    const findLastAssistantTurnRoot = () => {
      const selector = [
        '[data-message-author-role="assistant"]',
        '[data-conversation-role="assistant"]',
        'section[data-turn="assistant"]',
        '[data-chatgpt-search-unit-key*=":assistant"]',
        'article[data-testid*="conversation-turn"]',
      ].join(', ');

      const rawCandidates = [...document.querySelectorAll(selector)].filter((el) => {
        if (!isVisible(el)) return false;
        if (isUnderUserNode(el)) return false;
        if (el.getAttribute('data-testid')?.includes('conversation-turn')) {
          const hasUser = el.querySelector(
            '[data-message-author-role="user"], [data-conversation-role="user"], [data-chatgpt-search-unit-key*=":user"]'
          );
          if (hasUser) return false;
        }
        return true;
      });

      if (!rawCandidates.length) return null;

      // Group elements belonging to the same turn and find each turn's top-most boundary
      const turnRoots = [];
      for (const cand of rawCandidates) {
        let top = cand;
        let curr = cand;
        while (curr && curr.parentElement && curr.parentElement !== document.body && curr.parentElement !== document.documentElement && curr.parentElement.tagName !== 'MAIN') {
          const p = curr.parentElement;
          // Stop if parent crosses into user territory
          if (p.querySelector('[data-message-author-role="user"], [data-conversation-role="user"], [data-turn="user"], [data-chatgpt-search-unit-key*=":user"]')) {
            break;
          }
          // Stop if parent spans multiple distinct assistant turn search keys
          const keys = new Set([...p.querySelectorAll('[data-chatgpt-search-unit-key*=":assistant"]')].map((k) => k.getAttribute('data-chatgpt-search-unit-key')).filter(Boolean));
          if (keys.size > 1) {
            break;
          }

          const pRole = classifyTurnRole(p);
          const isTopEmpty = (top.children.length === 0 && !(top.innerText || top.textContent || '').trim());
          if (pRole === 'assistant' || p.tagName === 'ARTICLE' || (p.getAttribute('data-testid') || '').includes('conversation-turn') || isTopEmpty) {
            top = p;
            if (p.tagName === 'ARTICLE' || (p.getAttribute('data-testid') || '').includes('conversation-turn')) {
              break;
            }
          }
          curr = p;
        }

        let merged = false;
        for (let i = 0; i < turnRoots.length; i += 1) {
          const existing = turnRoots[i];
          if (existing === top || existing.contains(top)) {
            merged = true;
            break;
          }
          if (top.contains(existing)) {
            turnRoots[i] = top;
            merged = true;
            break;
          }
        }
        if (!merged) {
          turnRoots.push(top);
        }
      }

      if (!turnRoots.length) return null;

      // Sort by DOM tree appearance order (last in document = latest turn)
      turnRoots.sort((a, b) => {
        if (a === b) return 0;
        if (typeof a.compareDocumentPosition === 'function') {
          const pos = a.compareDocumentPosition(b);
          return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
        }
        return 0;
      });

      return turnRoots[turnRoots.length - 1] || null;
    };
  `;
}

/**
 * Inline snippet defining findFileChip(fileName) and clickFileChip(fileName).
 *
 * Supports:
 * - Buttons: button.behavior-btn, button[aria-label], button, [role="button"]
 * - Sandbox links: a[href] with strict sandbox evidence (sandbox: or /mnt/data/ or data-sandbox),
 *   never matching arbitrary external URLs.
 */
export function fileChipSnippet() {
  return `
    ${lastAssistantTurnSnippet()}

    const nameMatches = (label, fileName) => {
      if (!label || !fileName) return false;
      const str = String(label).trim();
      const fn = String(fileName).trim();
      if (str === fn || str.includes(fn)) return true;
      try {
        const dec = decodeURIComponent(str);
        if (dec === fn || dec.includes(fn)) return true;
      } catch (_) {}
      try {
        const enc = encodeURIComponent(fn);
        if (str === enc || str.includes(enc)) return true;
      } catch (_) {}
      return false;
    };

    const hasSandboxEvidence = (el) => {
      if (!el) return false;
      const href = (el.getAttribute('href') || '').trim();
      // Must NOT be external HTTP(S) link without explicit sandbox path
      if (/^https?:\\/\\//i.test(href)) {
        if (!href.includes('/mnt/data/') && !href.includes('sandbox')) return false;
      }
      if (/^sandbox:/i.test(href)) return true;
      if (href.includes('/mnt/data/')) return true;
      if (el.hasAttribute('data-sandbox') || el.getAttribute('data-testid')?.includes('sandbox')) return true;
      return false;
    };

    const chipsIn = (root, fileName) => {
      if (!root) return [];
      const out = [];

      // 1. Buttons (button.behavior-btn, button[aria-label], button, [role="button"])
      const buttons = [...root.querySelectorAll('button.behavior-btn, button[aria-label], button, [role="button"]')];
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const text = (btn.innerText || btn.textContent || '').trim();
        if (nameMatches(aria, fileName) || nameMatches(text, fileName)) {
          out.push(btn);
        }
      }

      // 2. Links (a[href]) with strict sandbox evidence
      const links = [...root.querySelectorAll('a[href]')];
      for (const a of links) {
        if (!isVisible(a)) continue;
        // Require restricted sandbox evidence — never match external links
        if (!hasSandboxEvidence(a)) continue;

        const aria = (a.getAttribute('aria-label') || '').trim();
        const text = (a.innerText || a.textContent || '').trim();
        const href = (a.getAttribute('href') || '').trim();
        const download = (a.getAttribute('download') || '').trim();
        const title = (a.getAttribute('title') || '').trim();

        if (
          nameMatches(aria, fileName) ||
          nameMatches(text, fileName) ||
          nameMatches(download, fileName) ||
          nameMatches(title, fileName) ||
          nameMatches(href, fileName)
        ) {
          out.push(a);
        }
      }

      return out;
    };

    const findFileChip = (fileName) => {
      const root = findLastAssistantTurnRoot();
      const chips = chipsIn(root, fileName);
      if (!chips.length) return { found: false, scope: root ? 'last-assistant' : 'none' };
      const best = chips[chips.length - 1];
      return {
        found: true,
        tag: best.tagName,
        aria: (best.getAttribute('aria-label') || '').trim(),
        text: ((best.innerText || best.textContent || '') + '').trim().slice(0, 80),
        href: best.getAttribute('href') || '',
        className: String(best.className || '').slice(0, 60),
        scope: 'last-assistant',
      };
    };

    const clickFileChip = (fileName) => {
      const root = findLastAssistantTurnRoot();
      const chips = chipsIn(root, fileName);
      const best = chips[chips.length - 1];
      if (!best) return { ok: false, reason: 'chip-missing-in-last-assistant', scope: root ? 'last-assistant' : 'none' };
      if (typeof best.scrollIntoView === 'function') {
        best.scrollIntoView({ block: 'center', inline: 'center' });
      }
      best.focus?.();
      best.click();
      return {
        ok: true,
        tag: best.tagName,
        aria: (best.getAttribute('aria-label') || '').trim(),
        href: best.getAttribute('href') || '',
        className: String(best.className || '').slice(0, 60),
        scope: 'last-assistant',
      };
    };
  `;
}

/**
 * Inline snippet defining inspectFlyout, clickFlyoutDownload, and closeFlyout.
 */
export function panelScript() {
  return `
    ${domVisibilitySnippet()}
    // Known real DOM structure from ChatGPT flyout:
    // div[data-testid="stage-thread-flyout"] > section[data-testid="screen-threadFlyOut"][aria-label=name]
    // header button[aria-label="Download"] + button[data-testid="close-button"]
    const findFlyout = (fileName) => {
      const byTestId = document.querySelector('section[data-testid="screen-threadFlyOut"]');
      if (byTestId) {
        const aria = (byTestId.getAttribute('aria-label') || '').trim();
        if (!fileName || !aria || aria === fileName || aria.includes(fileName) || (byTestId.innerText || '').includes(fileName)) {
          return byTestId;
        }
      }
      const stage = document.querySelector('[data-testid="stage-thread-flyout"], [data-stage-thread-flyout="true"]');
      if (stage) {
        const sec = stage.querySelector('section[data-testid="screen-threadFlyOut"], section[aria-label]');
        if (sec) return sec;
      }
      const flyouts = [...document.querySelectorAll('section[aria-label]')];
      return flyouts.find((s) => (s.getAttribute('aria-label') || '') === fileName)
        || flyouts.find((s) => (s.getAttribute('aria-label') || '').includes(fileName))
        || null;
    };

    const findDownloadButton = (root) => {
      if (!root) return null;
      const preferred = root.querySelector(
        'header button[aria-label="Download"], header button[aria-label="下载"], button[aria-label="Download"], button[aria-label="下载"]'
      );
      if (preferred) return preferred;
      return [...root.querySelectorAll('button')].find((b) => {
        const aria = (b.getAttribute('aria-label') || '').trim();
        const text = (b.innerText || b.textContent || '').trim();
        return aria === 'Download' || aria === '下载' || text === 'Download' || text === '下载';
      }) || null;
    };

    const inspectFlyout = (fileName) => {
      const root = findFlyout(fileName);
      if (!root) return { hasFlyout: false, hasDownload: false };
      const btn = findDownloadButton(root);
      return {
        hasFlyout: true,
        hasDownload: !!btn,
        flyoutAria: (root.getAttribute('aria-label') || '').slice(0, 60),
        downloadAria: btn ? (btn.getAttribute('aria-label') || '').trim() : '',
      };
    };

    const hasFlyoutDownload = (fileName) => {
      const info = inspectFlyout(fileName);
      return !!info.hasDownload;
    };

    const clickFlyoutDownload = (fileName) => {
      const root = findFlyout(fileName);
      if (!root) return { ok: false, reason: 'no-flyout' };
      const btn = findDownloadButton(root);
      if (!btn) return { ok: false, reason: 'no-download-button-in-flyout' };

      if (typeof btn.scrollIntoView === 'function') {
        btn.scrollIntoView({ block: 'center', inline: 'center' });
      }
      btn.focus?.();
      btn.click();
      return {
        ok: true,
        aria: (btn.getAttribute('aria-label') || '').trim(),
        tag: btn.tagName,
        flyout: (root.getAttribute('aria-label') || root.getAttribute('data-testid') || '').slice(0, 60),
      };
    };

    const closeFlyout = (fileName) => {
      const root = findFlyout(fileName)
        || document.querySelector('section[data-testid="screen-threadFlyOut"]');
      if (!root || !isVisible(root)) return { ok: false, reason: 'no-flyout-to-close' };

      let btn = root.querySelector('button[data-testid="close-button"], button[aria-label="Close"], button[aria-label="关闭"]');
      if (!btn || !isVisible(btn)) {
        btn = [...root.querySelectorAll('button')].find((b) => {
          if (!isVisible(b)) return false;
          const aria = (b.getAttribute('aria-label') || '').trim();
          const testid = b.getAttribute('data-testid') || '';
          return aria === 'Close' || aria === '关闭' || testid === 'close-button';
        }) || null;
      }
      if (!btn) return { ok: false, reason: 'no-close-button' };
      btn.click();
      return {
        ok: true,
        aria: (btn.getAttribute('aria-label') || '').trim(),
        testid: btn.getAttribute('data-testid') || '',
      };
    };
  `;
}

/**
 * Inline snippet defining listImageDownloadButtons() and clickNextImageDownload().
 * Restricted to the last assistant turn to prevent selecting historic images or avatars.
 */
export function imageDownloadScript() {
  return `
    ${lastAssistantTurnSnippet()}

    const listImageDownloadButtons = () => {
      const root = findLastAssistantTurnRoot();
      if (!root) return [];
      const btns = [...root.querySelectorAll('button, a[download], [role="button"]')];
      const scored = [];
      for (const el of btns) {
        if (!isVisible(el)) continue;
        const aria = (el.getAttribute('aria-label') || '').trim();
        const text = ((el.innerText || el.textContent || '') + '').trim();
        const label = (aria + ' ' + text).replace(/\\s+/g, ' ').trim();
        const lower = label.toLowerCase();
        if (/生成下载|create file|download file|导出文件|sandbox|copy link|复制链接|share|分享|edit|编辑|regenerate|重新生成/i.test(lower)) {
          continue;
        }
        const isDl = /^(download|下载)$/i.test(label)
          || /\\bdownload\\b|下载图片|save image|保存图片|download image|download this image/i.test(lower)
          || el.hasAttribute('download');
        if (!isDl) continue;
        const nearImg = !!(
          el.closest('figure, picture, [class*="image"], [class*="Image"], [data-testid*="image"]')
          || el.parentElement?.querySelector('img')
          || el.closest('div')?.querySelector('img')
        );
        const imgSibling = el.closest('div, section, article')?.querySelector('img');
        const imgBig = imgSibling && (imgSibling.naturalWidth || imgSibling.width || 0) > 64;
        scored.push({
          el,
          nearImg: nearImg || !!imgBig,
          aria,
          text: text.slice(0, 40),
          score: (nearImg || imgBig ? 10 : 0) + (/^(download|下载)$/i.test(label) ? 5 : 0),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored.some((s) => s.nearImg)) {
        return scored.filter((s) => s.nearImg);
      }
      return scored;
    };

    const clickNextImageDownload = (index) => {
      const list = listImageDownloadButtons();
      if (!list.length) return { ok: false, reason: 'no-image-download-button', count: 0 };
      if (index >= list.length) return { ok: false, reason: 'no-more-image-download-buttons', count: list.length };
      const item = list[index];
      item.el.click();
      return {
        ok: true,
        index,
        count: list.length,
        aria: item.aria || '',
        nearImg: item.nearImg,
      };
    };
  `;
}

/**
 * Inline snippet evaluating whether uploaded files have visible previews in composer scope.
 * Bounded strictly to composer scope; never checks document.body text.
 */
export function previewCheckScript(basenames, minCount) {
  return `
    ${composerRootSnippet()}
    (() => {
      const names = ${JSON.stringify(basenames)};
      const minCount = ${minCount};

      // 1. Must find a visible composer scope — NEVER fallback to document.body!
      const scope = findVisibleComposerRoot();
      if (!scope) return false;

      // 2. Check if all filenames appear inside composer scope (text or attribute)
      const text = (scope.innerText || scope.textContent || '');
      const hasAllNames = names.length > 0 && names.every((n) => {
        if (text.includes(n)) return true;
        const inAttr = [...scope.querySelectorAll('*')].some((el) => {
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          return aria.includes(n) || title.includes(n);
        });
        return inAttr;
      });
      if (hasAllNames) return true;

      // 3. Check visible media thumbnails within composer scope
      const isVisibleMedia = (node) => {
        if (!node) return false;
        if (typeof HTMLElement !== 'undefined' && !(node instanceof HTMLElement)) {
          if (!node.tagName && !node.nodeName) return false;
        }
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          try {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
          } catch (_) {}
        }
        const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : { width: 0, height: 0 };
        const width = node.naturalWidth || node.videoWidth || rect.width || 0;
        const height = node.naturalHeight || node.videoHeight || rect.height || 0;
        return width > 24 && height > 24;
      };

      const previews = Array.from(scope.querySelectorAll('img[src], canvas, video')).filter(isVisibleMedia);
      const removeBtns = Array.from(scope.querySelectorAll('button')).filter((b) => {
        const a = (b.getAttribute('aria-label') || '') + (b.innerText || b.textContent || '');
        return /remove|删除|dismiss|close file|移除/i.test(a);
      });

      return previews.length >= minCount || removeBtns.length >= minCount;
    })()
  `;
}
