/**
 * Shared DOM script helpers for ChatGPT web composer & turn scoping.
 *
 * Provides minimal, fail-closed helpers for:
 * 1. Locating the visible composer root strictly (form[data-chatgpt-composer] or active textarea container).
 * 2. Identifying the last assistant message turn strictly (explicit role/search-unit ending with assistant,
 *    never expanding empty markers into unmarked ancestors, never using prose guessing).
 * 3. File chip identification (button and sandbox:/mnt/data/ links, strictly rejecting external URLs).
 * 4. Dedicated resource-row download identification (modern ChatGPT file row with preview + Download file button).
 * 5. Composer-scoped upload preview check.
 * 6. Page.evaluate return unwrap ({ session, data } compatibility).
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
 * Strict DOM visibility predicate.
 * Checks HTMLElement instance, hidden/inert/aria-hidden ancestor markers, and computedStyle/dimensions.
 */
export function domVisibilitySnippet() {
  return `
    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.hidden || el.hasAttribute('hidden')) return false;
      if (el.closest('[inert], [aria-hidden="true"]')) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
  `;
}

/**
 * Resolves the visible composer root scope.
 * Only targets known composer elements and their closest form / unified-composer container.
 * Never falls back to document.body, never guesses random forms with buttons.
 */
export function composerRootSnippet() {
  return `
    ${domVisibilitySnippet()}
    const findVisibleComposerRoot = () => {
      const knownForm = document.querySelector('form[data-chatgpt-composer]');
      if (knownForm && isVisible(knownForm)) return knownForm;

      const inputs = [
        ...document.querySelectorAll(
          '.ProseMirror[contenteditable="true"][role="textbox"], ' +
          '#prompt-textarea, [data-testid="prompt-textarea"], ' +
          'textarea[placeholder*="Ask"], textarea[placeholder*="ChatGPT"]'
        ),
      ];

      for (const inp of inputs) {
        if (!isVisible(inp)) continue;
        const container = inp.closest('form[data-chatgpt-composer], form, [data-chatgpt-composer]');
        if (container && isVisible(container)) return container;
      }

      return null;
    };
  `;
}

/**
 * Locates the last assistant turn root strictly.
 * Rules:
 * - Based strictly on explicit assistant role or search-unit key ending in assistant.
 * - Old article/section only qualify if they enclose an explicit assistant indicator.
 * - Ascending is strictly limited to an enclosing node with explicit assistant role.
 * - Empty markers NEVER expand into broad unmarked parent containers or history.
 * - User turns are strictly rejected.
 */
export function lastAssistantTurnSnippet() {
  return `
    ${domVisibilitySnippet()}
    const classifyTurnRole = (el) => {
      if (!el || !(el instanceof HTMLElement)) return null;
      const auth = (el.getAttribute('data-message-author-role') || '').toLowerCase();
      if (auth === 'user') return 'user';
      if (auth === 'assistant') return 'assistant';

      const conv = (el.getAttribute('data-conversation-role') || '').toLowerCase();
      if (conv === 'user') return 'user';
      if (conv === 'assistant') return 'assistant';

      const turn = (el.getAttribute('data-turn') || '').toLowerCase();
      if (turn === 'user') return 'user';
      if (turn === 'assistant') return 'assistant';

      const key = (el.getAttribute('data-chatgpt-search-unit-key') || '').toLowerCase();
      if (key) {
        if (/(?:^|:)user(?:$|:)/.test(key) || key.endsWith(':user')) return 'user';
        if (/(?:^|:)assistant(?:$|:)/.test(key) || key.endsWith(':assistant')) return 'assistant';
      }
      return null;
    };

    const isUserScope = (el) => {
      return !!el.closest('[data-message-author-role="user"], [data-conversation-role="user"], [data-turn="user"], [data-chatgpt-search-unit-key*=":user"]');
    };

    const findLastAssistantTurnRoot = () => {
      const explicitSelector = [
        '[data-message-author-role="assistant"]',
        '[data-conversation-role="assistant"]',
        'section[data-turn="assistant"]',
        '[data-chatgpt-search-unit-key$=":assistant"]',
        '[data-chatgpt-search-unit-key*=":assistant"]',
      ].join(', ');

      const nodes = [...document.querySelectorAll(explicitSelector)].filter((el) => {
        if (!isVisible(el)) return false;
        if (isUserScope(el)) return false;
        return classifyTurnRole(el) === 'assistant';
      });

      if (!nodes.length) return null;

      // Group to assistant roots: only ascend to an enclosing ancestor that explicitly has assistant role
      const roots = [];
      for (const node of nodes) {
        let root = node;
        let parent = node.parentElement;
        while (parent && parent !== document.body && parent.tagName !== 'MAIN') {
          if (classifyTurnRole(parent) === 'assistant') {
            root = parent;
          }
          parent = parent.parentElement;
        }
        if (!roots.includes(root)) {
          const idx = roots.findIndex((r) => r.contains(root) || root.contains(r));
          if (idx !== -1) {
            if (root.contains(roots[idx])) roots[idx] = root;
          } else {
            roots.push(root);
          }
        }
      }

      if (!roots.length) return null;

      roots.sort((a, b) => {
        if (a === b) return 0;
        return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
      });

      return roots[roots.length - 1];
    };
  `;
}

/**
 * Modern resource-row download identification and click snippet.
 * Scoped to [class~="group/resource-row"] within last assistant turn.
 */
export function resourceRowSnippet() {
  return `
    ${lastAssistantTurnSnippet()}

    const nameMatches = (str, fileName) => {
      if (!str || !fileName) return false;
      const s = String(str).trim();
      const fn = String(fileName).trim();
      if (s === fn || s.includes(fn)) return true;
      try { if (decodeURIComponent(s).includes(fn)) return true; } catch (_) {}
      try { if (s.includes(encodeURIComponent(fn))) return true; } catch (_) {}
      return false;
    };

    const isDownloadAffordance = (btn) => {
      if (!btn || !(btn instanceof HTMLElement)) return false;
      if (btn.hidden || btn.hasAttribute('hidden')) return false;
      if (btn.closest('[inert], [aria-hidden="true"]')) return false;
      const st = window.getComputedStyle(btn);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const aria = (btn.getAttribute('aria-label') || '').trim();
      const text = (btn.innerText || btn.textContent || '').trim();
      const label = (aria + ' ' + text).toLowerCase();
      if (/preview|预览/i.test(label)) return false;
      return /download\\s*file|下载文件/i.test(label)
        || /^(download|下载)$/i.test(aria)
        || /^(download|下载)$/i.test(text);
    };

    const findResourceRowContext = (fileName) => {
      const root = findLastAssistantTurnRoot();
      if (!root) return null;

      const rows = [...root.querySelectorAll('[class~="group/resource-row"]')];
      for (const row of rows) {
        if (row.querySelectorAll('[class~="group/resource-row"]').length > 0) continue;

        // Exactly one preview button per row
        const previewBtns = [...row.querySelectorAll('button')].filter((b) => {
          const aria = (b.getAttribute('aria-label') || '').trim();
          return /preview|预览/i.test(aria);
        });
        if (previewBtns.length !== 1) continue;
        const previewBtn = previewBtns[0];

        // Filename matches preview affordance itself (aria-label or contained title)
        const previewAria = previewBtn.getAttribute('aria-label') || '';
        const titleEl = row.querySelector('[title]');
        const titleText = titleEl ? (titleEl.getAttribute('title') || '') : '';
        if (!nameMatches(previewAria, fileName) && !nameMatches(titleText, fileName)) {
          continue;
        }

        const dlBtns = [...row.querySelectorAll('button')].filter((b) => b !== previewBtn && isDownloadAffordance(b));
        if (dlBtns.length !== 1) continue;

        return { row, previewBtn, dlBtn: dlBtns[0] };
      }

      return null;
    };

    const findResourceRowDownload = (fileName) => {
      const ctx = findResourceRowContext(fileName);
      if (!ctx) return { found: false, scope: 'last-assistant' };
      return {
        found: true,
        mode: 'resource-row',
        aria: (ctx.dlBtn.getAttribute('aria-label') || '').trim(),
        previewAria: (ctx.previewBtn?.getAttribute('aria-label') || '').trim(),
        scope: 'last-assistant',
      };
    };

    const clickResourceRowDownload = (fileName) => {
      const ctx = findResourceRowContext(fileName);
      if (!ctx) return { ok: false, reason: 'resource-row-download-missing', scope: 'last-assistant' };
      if (ctx.previewBtn && typeof ctx.previewBtn.focus === 'function') {
        ctx.previewBtn.focus();
      }
      if (typeof ctx.dlBtn.scrollIntoView === 'function') {
        ctx.dlBtn.scrollIntoView({ block: 'center', inline: 'center' });
      }
      ctx.dlBtn.focus?.();
      ctx.dlBtn.click();
      return {
        ok: true,
        mode: 'resource-row',
        tag: ctx.dlBtn.tagName,
        aria: (ctx.dlBtn.getAttribute('aria-label') || '').trim(),
        previewAria: (ctx.previewBtn?.getAttribute('aria-label') || '').trim(),
        scope: 'last-assistant',
      };
    };
  `;
}

/**
 * File chip detection in the last assistant turn (legacy button / sandbox link fallback).
 * - Supports button.behavior-btn, button[aria-label], button
 * - Supports sandbox <a> links strictly: rejects any external URL regardless of path or data-sandbox;
 *   only accepts sandbox:/mnt/data/... or same-origin download URLs with sandbox proof.
 */
export function fileChipSnippet() {
  return `
    ${lastAssistantTurnSnippet()}

    const nameMatches = (str, fileName) => {
      if (!str || !fileName) return false;
      const s = String(str).trim();
      const fn = String(fileName).trim();
      if (s === fn || s.includes(fn)) return true;
      try { if (decodeURIComponent(s).includes(fn)) return true; } catch (_) {}
      try { if (s.includes(encodeURIComponent(fn))) return true; } catch (_) {}
      return false;
    };

    const isRestrictedSandboxLink = (a) => {
      if (!a || a.tagName !== 'A') return false;
      const href = (a.getAttribute('href') || '').trim();
      if (!href) return false;

      // Reject all external URLs regardless of path or data-sandbox attribute
      if (/^(?:https?:)?\\/\\//i.test(href)) {
        try {
          const u = new URL(href, window.location.href);
          if (u.origin !== window.location.origin) return false;
          return u.pathname.includes('/mnt/data/') || a.hasAttribute('data-sandbox');
        } catch (_) {
          return false;
        }
      }

      // sandbox: protocol must target /mnt/data/
      if (/^sandbox:\\/(?:mnt\\/data\\/)?/i.test(href)) return true;

      // Same-origin relative path evidence
      if (href.startsWith('/') && href.includes('/mnt/data/')) return true;

      return false;
    };

    const chipsIn = (root, fileName) => {
      if (!root) return [];
      const out = [];

      for (const btn of root.querySelectorAll('button.behavior-btn, button[aria-label], button')) {
        if (!isVisible(btn)) continue;
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const text = (btn.innerText || btn.textContent || '').trim();
        if (nameMatches(aria, fileName) || nameMatches(text, fileName)) {
          out.push(btn);
        }
      }

      for (const a of root.querySelectorAll('a[href]')) {
        if (!isVisible(a)) continue;
        if (!isRestrictedSandboxLink(a)) continue;
        const aria = (a.getAttribute('aria-label') || '').trim();
        const text = (a.innerText || a.textContent || '').trim();
        const href = (a.getAttribute('href') || '').trim();
        const dl = (a.getAttribute('download') || '').trim();
        if (nameMatches(aria, fileName) || nameMatches(text, fileName) || nameMatches(href, fileName) || nameMatches(dl, fileName)) {
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
        scope: 'last-assistant',
      };
    };

    const clickFileChip = (fileName) => {
      const root = findLastAssistantTurnRoot();
      const chips = chipsIn(root, fileName);
      const best = chips[chips.length - 1];
      if (!best) return { ok: false, reason: 'chip-missing-in-last-assistant', scope: root ? 'last-assistant' : 'none' };
      best.scrollIntoView({ block: 'center', inline: 'center' });
      best.focus?.();
      best.click();
      return {
        ok: true,
        tag: best.tagName,
        aria: (best.getAttribute('aria-label') || '').trim(),
        href: best.getAttribute('href') || '',
        scope: 'last-assistant',
      };
    };
  `;
}

/**
 * Verifies upload preview in visible composer scope only.
 */
export function previewCheckScript(basenames, minCount) {
  return `
    ${composerRootSnippet()}
    (() => {
      const names = ${JSON.stringify(basenames)};
      const minCount = ${minCount};
      const scope = findVisibleComposerRoot();
      if (!scope) return false;

      const text = (scope.innerText || scope.textContent || '');
      const hasAllNames = names.length > 0 && names.every((n) => {
        if (text.includes(n)) return true;
        return [...scope.querySelectorAll('*')].some((el) => {
          const a = el.getAttribute('aria-label') || '';
          const t = el.getAttribute('title') || '';
          return a.includes(n) || t.includes(n);
        });
      });
      if (hasAllNames) return true;

      const isVisibleMedia = (node) => {
        if (!node || !(node instanceof HTMLElement)) return false;
        if (node.hidden || node.hasAttribute('hidden')) return false;
        const st = window.getComputedStyle(node);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = node.getBoundingClientRect();
        const w = node.naturalWidth || node.videoWidth || r.width || 0;
        const h = node.naturalHeight || node.videoHeight || r.height || 0;
        return w > 24 && h > 24;
      };

      const previews = Array.from(scope.querySelectorAll('img[src], canvas, video')).filter(isVisibleMedia);
      const removeBtns = Array.from(scope.querySelectorAll('button')).filter((b) => {
        if (!(b instanceof HTMLElement)) return false;
        const a = (b.getAttribute('aria-label') || '') + (b.innerText || '');
        return /remove|删除|dismiss|close file|移除/i.test(a);
      });

      return previews.length >= minCount || removeBtns.length >= minCount;
    })()
  `;
}

/**
 * Modern ChatGPT generated-image gallery extractor script.
 *
 * Targets:
 *   main [data-testid="generated-image-gallery"] [data-testid="generated-image-preview"] img
 *
 * Rules:
 * 1. Checks strictly for presence of modern gallery within main / transcript scope.
 *    If none exists, returns { modern: false, urls: [] } to trigger explicit legacy fallback.
 * 2. When messageIds are provided (array, even if empty):
 *    Strictly matches the nearest gallery.closest('[data-chatgpt-search-message-ids]') container.
 *    Does not ascend further to broader ancestral containers.
 *    If messageIds array is provided but contains no valid IDs, fails closed: returns { modern: true, urls: [] }.
 *    If messageIds are omitted (null/undefined), collects all loaded modern gallery images (e.g. beforeUrls snapshot).
 * 3. Does NOT require bounding rect dimensions > 0 (preview / img layout can be 0x0).
 * 4. Strictly requires loaded, reasonable natural dimensions (naturalWidth >= 128 && naturalHeight >= 128).
 * 5. Single upward traversal on img to body checks hidden, inert, aria-hidden="true", display:none, visibility:hidden.
 * 6. Strictly excludes composer and user turn scopes.
 */
export function modernImageExtractorScript(messageIds = null) {
  const idsJson = Array.isArray(messageIds)
    ? JSON.stringify(messageIds.map((id) => String(id || '').trim()).filter(Boolean))
    : 'null';
  const hasFilter = Array.isArray(messageIds);

  return `
    (() => {
      const main = document.querySelector('main') || document.querySelector('[role="main"]');
      if (!main) return { modern: false, urls: [] };

      const galleries = Array.from(main.querySelectorAll('[data-testid="generated-image-gallery"]'));
      if (galleries.length === 0) return { modern: false, urls: [] };

      const matchRequired = ${hasFilter};
      const targetIds = ${idsJson};
      if (matchRequired && (!targetIds || targetIds.length === 0)) {
        return { modern: true, urls: [] };
      }
      const targetSet = targetIds ? new Set(targetIds) : null;

      const isExcluded = (node) => {
        let curr = node;
        while (curr && curr !== document.body && curr !== document.documentElement) {
          if (curr.hidden || curr.hasAttribute('hidden')) return true;
          if (curr.hasAttribute('inert')) return true;
          if (curr.getAttribute('aria-hidden') === 'true') return true;
          const st = window.getComputedStyle(curr);
          if (st.display === 'none' || st.visibility === 'hidden') return true;
          curr = curr.parentElement;
        }
        return false;
      };

      const isComposerOrUserScope = (node) => {
        if (node.closest('form[data-chatgpt-composer], [data-chatgpt-composer], #prompt-textarea, [data-testid="prompt-textarea"]')) {
          return true;
        }
        if (node.closest('[data-message-author-role="user"], [data-conversation-role="user"], [data-turn="user"], [data-chatgpt-search-unit-key*=":user"]')) {
          return true;
        }
        return false;
      };

      const urls = [];
      const seen = new Set();

      for (const gallery of galleries) {
        if (matchRequired) {
          const container = gallery.closest('[data-chatgpt-search-message-ids]');
          if (!container) continue;
          const raw = container.getAttribute('data-chatgpt-search-message-ids') || '';
          const tokens = raw.trim().split(/[\\s,]+/);
          if (!tokens.some((t) => t && targetSet.has(t))) continue;
        }

        const imgs = Array.from(gallery.querySelectorAll('[data-testid="generated-image-preview"] img'));
        for (const img of imgs) {
          if (img.complete === false) continue;
          const nw = img.naturalWidth || 0;
          const nh = img.naturalHeight || 0;
          if (nw < 128 || nh < 128) continue;
          if (isExcluded(img) || isComposerOrUserScope(img)) continue;

          const src = (img.currentSrc || img.src || '').trim();
          if (!src || seen.has(src)) continue;
          seen.add(src);
          urls.push(src);
        }
      }

      return { modern: true, urls };
    })()
  `;
}
