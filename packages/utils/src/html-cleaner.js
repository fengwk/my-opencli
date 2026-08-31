import * as cheerio from 'cheerio';
import { isBlank, isNotBlank, normalizedTextLength } from './strings.js';

const MIN_MAIN_TEXT_LENGTH = 120;

const EXCLUDE_NON_MAIN_TAGS = [
  'header', 'footer', 'nav', 'aside',
  '.header', '.top', '.navbar', '#header',
  '.footer', '.bottom', '#footer',
  '.sidebar', '.side', '.aside', '#sidebar',
  '.modal', '.popup', '#modal', '.overlay',
  '.ad', '.ads', '.advert', '#ad',
  '.lang-selector', '.language', '#language-selector',
  '.social', '.social-media', '.social-links', '#social',
  '.menu', '.navigation', '#nav',
  '.breadcrumbs', '#breadcrumbs',
  '.share', '#share',
  '.widget', '#widget',
  '.cookie', '#cookie',
  '.headerlink', '.copybutton',
  '.mw-editsection', '#toc', '.toc',
];

const FORCE_INCLUDE_MAIN_TAGS = [
  '#main', '.swoogo-cols', '.swoogo-text', '.swoogo-table-div',
  '.swoogo-space', '.swoogo-alert', '.swoogo-sponsors',
  '.swoogo-title', '.swoogo-tabs', '.swoogo-logo',
  '.swoogo-image', '.swoogo-button', '.swoogo-agenda',
];

const MAIN_CANDIDATE_SELECTORS = [
  'main', 'article', '[role=main]',
  '#main', '#main-content', '#content',
  '.main-content', '.content', '.article',
  '.article-content', '.post-content', '.entry-content',
  '#mw-content-text', '.mw-parser-output',
];

const REFINABLE_CONTAINER_TAGS = new Set(['main', 'article', 'section', 'div']);
const LAZY_IMAGE_ATTRIBUTES = [
  'data-src', 'data-original', 'data-lazy-src', 'data-lazyload', 'data-url',
  'data-image', 'data-actualsrc', 'data-actual-src', 'data-failover', 'data-ks-lazyload',
];
const LAZY_SRCSET_ATTRIBUTES = ['data-srcset', 'data-lazy-srcset'];

const DOMAIN_RULES = [
  {
    hostSuffix: 'wikipedia.org',
    preferredMainSelectors: ['#mw-content-text', '.mw-parser-output', 'main[role=main]'],
    stripSelectors: [
      '.shortdescription', '.hatnote', '.ambox', '.metadata',
      '#mw-navigation', '.vector-page-toolbar', '.vector-header-container',
      '.vector-sticky-pinned-container', '.mw-jump-link',
      '#p-lang-btn', '#p-search', '#toc', '.toc', '.mw-editsection',
      'sup.reference', '.reflist', '.mw-references-wrap',
      '.navbox', '.vertical-navbox', '.catlinks',
      '.mw-authority-control', '.printfooter',
    ],
  },
  {
    hostSuffix: 'docs.python.org',
    preferredMainSelectors: ['main', 'article', 'div[role=main]', '.body'],
    stripSelectors: ['.sphinxsidebar', '.related', '.headerlink', '.copybutton'],
  },
];

export class HtmlCleaner {
  clean(html, baseUrl = '', onlyMainContent = true) {
    const $ = cheerio.load(html == null ? '' : html);
    $('script, style, noscript, meta, head').remove();
    if (onlyMainContent) {
      this.#removeNonMainElements($);
      this.#removeDomainChromeElements($, baseUrl);
      this.#stripElementAnchorAttributes($);
    }
    this.#normalizeLazyImages($);
    this.#removeEmbeddedImages($);
    this.#normalizeSrcset($);
    this.#normalizeUrls($, baseUrl);

    const body = $('body').get(0);
    if (!body) {
      return '';
    }
    if (onlyMainContent) {
      const mainContentElement = this.#selectMainContentElement($, body, baseUrl);
      if (mainContentElement && mainContentElement !== body) {
        return outerHtml($, mainContentElement);
      }
    }
    return $(body).html() || '';
  }

  #removeNonMainElements($) {
    for (const selector of EXCLUDE_NON_MAIN_TAGS) {
      $(selector).each((_, element) => {
        if (!this.#containsForceInclude($, element)) {
          $(element).remove();
        }
      });
    }
  }

  #removeEmbeddedImages($) {
    $('img[src^="data:image"], img[srcset*="data:image"]').remove();
  }

  #stripElementAnchorAttributes($) {
    $('[id], a[name]').each((_, element) => {
      $(element).removeAttr('id');
      $(element).removeAttr('name');
    });
  }

  #normalizeLazyImages($) {
    $('img').each((_, element) => {
      const src = $(element).attr('src') || '';
      if (this.#isIgnorableImageSource(src)) {
        const normalizedLazySrc = this.#firstUsableImageReference($, element, LAZY_IMAGE_ATTRIBUTES);
        if (isNotBlank(normalizedLazySrc)) {
          $(element).attr('src', normalizedLazySrc);
        }
      }
      if (isBlank($(element).attr('srcset'))) {
        const normalizedLazySrcset = this.#firstUsableImageReference($, element, LAZY_SRCSET_ATTRIBUTES);
        if (isNotBlank(normalizedLazySrcset)) {
          $(element).attr('srcset', normalizedLazySrcset);
        }
      }
    });
  }

  #firstUsableImageReference($, element, attributeNames) {
    for (const attributeName of attributeNames) {
      const value = $(element).attr(attributeName) || '';
      if (this.#looksLikeUsableImageReference(value)) {
        return value;
      }
    }
    return '';
  }

  #isIgnorableImageSource(src) {
    if (isBlank(src)) return true;
    const normalized = src.trim().toLowerCase();
    return normalized.startsWith('data:image')
      || normalized.startsWith('about:blank')
      || normalized.includes('preload.png')
      || normalized.includes('placeholder')
      || normalized.endsWith('/blank.gif')
      || normalized.endsWith('/spacer.gif');
  }

  #looksLikeUsableImageReference(value) {
    if (isBlank(value)) return false;
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith('http://')
      || normalized.startsWith('https://')
      || normalized.startsWith('//')
      || normalized.startsWith('/')
      || normalized.startsWith('./')
      || normalized.startsWith('../');
  }

  #containsForceInclude($, element) {
    for (const selector of FORCE_INCLUDE_MAIN_TAGS) {
      if (matchesOrContains($, element, selector)) {
        return true;
      }
    }
    return false;
  }

  #normalizeSrcset($) {
    $('img[srcset]').each((_, element) => {
      const srcset = $(element).attr('srcset') || '';
      if (isBlank(srcset)) return;
      const candidates = parseSrcsetCandidates(srcset);
      if (candidates.length === 0) return;
      const allX = candidates.every((candidate) => candidate.isX);
      const src = $(element).attr('src') || '';
      if (allX && isNotBlank(src)) {
        candidates.push({ url: src, size: 1, isX: true });
      }
      candidates.sort((a, b) => b.size - a.size);
      const selected = candidates[0]?.url;
      if (isNotBlank(selected)) {
        $(element).attr('src', selected);
      }
    });
  }

  #normalizeUrls($, baseUrl) {
    $('img[src]').each((_, element) => {
      const absolute = absUrl(baseUrl, $(element).attr('src'));
      if (isNotBlank(absolute)) $(element).attr('src', absolute);
    });
    $('a[href]').each((_, element) => {
      const absolute = absUrl(baseUrl, $(element).attr('href'));
      if (isNotBlank(absolute)) $(element).attr('href', absolute);
    });
  }

  #removeDomainChromeElements($, baseUrl) {
    const domainRule = resolveDomainRule(baseUrl);
    if (!domainRule) return;
    for (const selector of domainRule.stripSelectors) {
      $(selector).remove();
    }
  }

  #selectMainContentElement($, body, baseUrl) {
    const domainRule = resolveDomainRule(baseUrl);
    const preferredCandidate = this.#findPreferredCandidate($, domainRule, body);
    if (preferredCandidate) return preferredCandidate;

    const candidates = [];
    const seen = new Set();
    const addAll = (nodes) => {
      for (const node of nodes) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
    };
    if (domainRule) {
      for (const selector of domainRule.preferredMainSelectors) {
        addAll($(selector).toArray());
      }
    }
    for (const selector of MAIN_CANDIDATE_SELECTORS) {
      addAll($(selector).toArray());
    }
    if (candidates.length === 0) {
      addAll($('section, div').toArray());
    }

    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      if (!candidate || isDocumentRoot(candidate) || candidate === body.parent) continue;
      const score = this.#scoreMainCandidate($, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate) return body;
    const bodyTextLength = normalizedTextLength(textOf($, body));
    const candidateTextLength = normalizedTextLength(textOf($, bestCandidate));
    const minimumTextLength = Math.min(MIN_MAIN_TEXT_LENGTH, Math.max(40, Math.trunc(bodyTextLength / 8)));
    if (candidateTextLength < minimumTextLength) return body;
    return this.#preserveArticleContext($, bestCandidate, this.#refineMainContentElement($, bestCandidate));
  }

  #preserveArticleContext($, rootCandidate, focusedCandidate) {
    if (!focusedCandidate || !rootCandidate || !this.#isLikelyArticleElement($, focusedCandidate)) {
      return focusedCandidate;
    }

    let child = focusedCandidate;
    let ancestor = child.parent;
    while (ancestor && ancestor.type === 'tag') {
      const contextualContainer = this.#buildContextualArticleContainer($, ancestor, child);
      if (contextualContainer) {
        return contextualContainer;
      }
      if (ancestor === rootCandidate) {
        break;
      }
      child = ancestor;
      ancestor = ancestor.parent;
    }

    return focusedCandidate;
  }

  #buildContextualArticleContainer($, ancestor, focusedChild) {
    if (!ancestor || !focusedChild || focusedChild.parent !== ancestor) {
      return null;
    }

    const directChildren = $(ancestor).children().toArray();
    const focusedIndex = directChildren.indexOf(focusedChild);
    if (focusedIndex <= 0) {
      return null;
    }

    const metadataBlocks = [];
    for (let i = 0; i < focusedIndex; i += 1) {
      const sibling = directChildren[i];
      if (this.#isLikelyArticleMetadataBlock($, sibling)) {
        metadataBlocks.push(sibling);
      }
    }
    if (metadataBlocks.length === 0) {
      return null;
    }

    const container = $('<div></div>').get(0);
    for (const metadataBlock of metadataBlocks) {
      $(container).append($(metadataBlock).clone());
    }
    $(container).append($(focusedChild).clone());
    return container;
  }

  #refineMainContentElement($, candidate) {
    let current = candidate;
    for (let i = 0; i < 6; i += 1) {
      const refined = this.#selectMoreFocusedChild($, current);
      if (!refined) break;
      current = refined;
    }
    return current;
  }

  #selectMoreFocusedChild($, candidate) {
    const candidateTextLength = normalizedTextLength(textOf($, candidate));
    if (candidateTextLength <= 0) return null;

    let dominantChild = null;
    let dominantChildTextLength = 0;
    const currentScore = this.#scoreMainCandidate($, candidate);
    const currentScoreDensity = currentScore / Math.max(1, candidateTextLength);
    let bestChild = null;
    let bestChildDensity = currentScoreDensity;

    for (const child of $(candidate).children().toArray()) {
      if (!REFINABLE_CONTAINER_TAGS.has(tagName(child))) continue;

      const childTextLength = normalizedTextLength(textOf($, child));
      if (childTextLength < Math.max(80, Math.trunc(candidateTextLength / 5))) continue;

      const coverage = childTextLength / candidateTextLength;
      if (coverage < 0.4) continue;

      if (coverage >= 0.92 && childTextLength > dominantChildTextLength) {
        dominantChild = child;
        dominantChildTextLength = childTextLength;
      }

      const childScore = this.#scoreMainCandidate($, child);
      if (childScore < currentScore * 0.55) continue;

      const childDensity = childScore / Math.max(1, childTextLength);
      if (childDensity > bestChildDensity * 1.12) {
        bestChild = child;
        bestChildDensity = childDensity;
      }
    }

    return dominantChild || bestChild;
  }

  #findPreferredCandidate($, domainRule, body) {
    if (!domainRule) return null;
    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const selector of domainRule.preferredMainSelectors) {
      for (const candidate of $(selector).toArray()) {
        if (!candidate || candidate === body.parent) continue;
        const textLength = normalizedTextLength(textOf($, candidate));
        if (textLength < 80) continue;
        const score = this.#scoreMainCandidate($, candidate);
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }
    }
    return bestCandidate;
  }

  #scoreMainCandidate($, candidate) {
    const textLength = normalizedTextLength(textOf($, candidate));
    if (textLength <= 0) return Number.NEGATIVE_INFINITY;

    let linkTextLength = 0;
    for (const linkElement of selectAll($, candidate, 'a')) {
      linkTextLength += normalizedTextLength(textOf($, linkElement));
    }
    const linkDensity = linkTextLength / Math.max(1, textLength);
    const blockCount = selectAll($, candidate, 'p, h1, h2, h3, h4, li, pre, blockquote, table, tr').length;
    let longBlockCount = 0;
    for (const block of selectAll($, candidate, 'p, li, blockquote, td, th')) {
      if (normalizedTextLength(textOf($, block)) >= 30) {
        longBlockCount += 1;
      }
    }
    const imageCount = selectAll($, candidate, 'img').length;
    const interactiveCount = selectAll(
      $,
      candidate,
      'button, input, textarea, select, option, label, [role=button], [role=tab], [role=dialog], [aria-modal=true], [contenteditable=true]',
    ).length;
    const embeddedFrameCount = selectAll($, candidate, 'iframe, frame').length;
    const chromeDescendantCount = selectAll(
      $,
      candidate,
      '[class*=toolbar], [id*=toolbar], [class*=comment], [id*=comment], [class*=reply], [id*=reply], [class*=sidebar], [id*=sidebar], [class*=catalog], [id*=catalog], [class*=drawer], [id*=drawer], [class*=panel], [id*=panel], [class*=modal], [id*=modal], [class*=dialog], [id*=dialog], [class*=share], [id*=share], [class*=word-count], [id*=word-count]',
    ).length;
    const markupLength = Math.max(1, outerHtml($, candidate).length);
    const markupOverhead = markupLength / Math.max(1, textLength);

    let score = textLength * (1 - Math.min(0.95, linkDensity));
    score += Math.min(80, blockCount) * 12;
    score += Math.min(60, longBlockCount) * 18;
    score += Math.min(20, imageCount) * 6;
    score -= Math.min(240, markupOverhead * 18);
    score -= Math.min(320, interactiveCount * 16);
    score -= Math.min(240, embeddedFrameCount * 90);
    score -= Math.min(300, chromeDescendantCount * 14);

    if (this.#isLikelyPrimaryContainer($, candidate)) score += 120;
    score += this.#specificPrimaryContainerBonus($, candidate);
    if (this.#isLikelyBoilerplateContainer($, candidate)) score *= 0.3;
    return score;
  }

  #isLikelyPrimaryContainer($, candidate) {
    const name = tagName(candidate);
    if (name === 'main' || name === 'article') return true;
    const marker = this.#buildContainerMarker($, candidate);
    return marker.includes('main') || marker.includes('content') || marker.includes('article')
      || marker.includes('post') || marker.includes('entry')
      || marker.includes('mw-content-text') || marker.includes('mw-parser-output');
  }

  #isLikelyBoilerplateContainer($, candidate) {
    const marker = this.#buildContainerMarker($, candidate);
    return marker.includes('nav') || marker.includes('menu') || marker.includes('sidebar')
      || marker.includes('footer') || marker.includes('header') || marker.includes('breadcrumb')
      || marker.includes('social') || marker.includes('share') || marker.includes('comment')
      || marker.includes('related') || marker.includes('cookie') || marker.includes('banner')
      || marker.includes('popup') || marker.includes('modal') || marker.includes('login')
      || marker.includes('search') || marker.includes('toc');
  }

  #specificPrimaryContainerBonus($, candidate) {
    const marker = this.#buildContainerMarker($, candidate);
    if (marker.includes('mw-content-text') || marker.includes('mw-parser-output')) return 220;
    if (marker.includes('article-content') || marker.includes('post-content') || marker.includes('entry-content')) return 180;
    if (marker.includes('main-content')) return 100;
    return 0;
  }

  #isLikelyArticleElement($, candidate) {
    if (!candidate) return false;
    if (tagName(candidate) === 'article') return true;
    const marker = this.#buildContainerMarker($, candidate);
    return marker.includes('article') || marker.includes('post') || marker.includes('entry')
      || marker.includes('story') || marker.includes('mp-editor');
  }

  #isLikelyArticleMetadataBlock($, candidate) {
    if (!candidate) return false;
    const textLength = normalizedTextLength(textOf($, candidate));
    if (textLength <= 0 || textLength > 1200) return false;

    const marker = this.#buildContainerMarker($, candidate);
    if (marker.includes('title') || marker.includes('headline') || marker.includes('article-info')
      || marker.includes('byline') || marker.includes('author')
      || marker.includes('publish') || marker.includes('source')) {
      return true;
    }

    return selectFirst(
      $,
      candidate,
      'h1, h2, h3, time, [datetime], [itemprop=datePublished], [itemprop=dateUpdate], .time, .date, .author, .source, .article-info',
    ) != null;
  }

  #buildContainerMarker($, candidate) {
    const role = $(candidate).attr('role') || '';
    const id = $(candidate).attr('id') || '';
    const className = $(candidate).attr('class') || '';
    return `${role} ${id} ${className}`.toLowerCase();
  }
}

function tagName(el) {
  return String(el?.name || el?.tagName || '').toLowerCase();
}

function isDocumentRoot(el) {
  const name = tagName(el);
  return name === 'html' || name === 'document' || el?.type === 'root';
}

function textOf($, el) {
  return $(el).text() || '';
}

function outerHtml($, el) {
  if (!el) return '';
  const rendered = $.html(el);
  if (isNotBlank(rendered)) return rendered;
  return $('<div></div>').append($(el).clone()).html() || '';
}

function matchesOrContains($, el, selector) {
  const $el = $(el);
  try {
    if ($el.is(selector)) return true;
  } catch {
    return false;
  }
  return $el.find(selector).length > 0;
}

function selectAll($, el, selector) {
  const $el = $(el);
  const out = $el.find(selector).toArray();
  try {
    if ($el.is(selector)) out.unshift(el);
  } catch {
    // invalid selector for this node
  }
  return out;
}

function selectFirst($, el, selector) {
  const matches = selectAll($, el, selector);
  return matches[0] || null;
}

function parseSrcsetCandidates(srcset) {
  const candidates = [];
  for (const part of srcset.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 0) continue;
    const url = tokens[0];
    const sizeToken = tokens.length > 1 ? tokens[1] : '1x';
    const isX = sizeToken.endsWith('x');
    const size = parseSize(sizeToken);
    if (isBlank(url)) continue;
    candidates.push({ url, size, isX });
  }
  return candidates;
}

function parseSize(token) {
  if (isBlank(token)) return 1;
  const number = String(token).replace(/[^0-9]/g, '');
  if (isBlank(number)) return 1;
  const parsed = Number.parseInt(number, 10);
  return Number.isNaN(parsed) ? 1 : parsed;
}

function resolveDomainRule(baseUrl) {
  const host = extractHost(baseUrl);
  if (isBlank(host)) return null;
  for (const domainRule of DOMAIN_RULES) {
    if (host === domainRule.hostSuffix || host.endsWith(`.${domainRule.hostSuffix}`)) {
      return domainRule;
    }
  }
  return null;
}

function extractHost(baseUrl) {
  if (isBlank(baseUrl)) return '';
  try {
    const host = new URL(baseUrl.trim()).host;
    return host ? host.toLowerCase() : '';
  } catch {
    return '';
  }
}

export function absUrl(baseUrl, value) {
  if (isBlank(value)) return '';
  const trimmed = String(value).trim();
  if (isBlank(baseUrl)) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

export function extractLinks(html, baseUrl) {
  const links = [];
  if (isBlank(html)) return links;
  const $ = cheerio.load(html);
  $('a[href]').each((_, element) => {
    const href = absUrl(baseUrl, $(element).attr('href'));
    const text = ($(element).text() || '').trim();
    if (isNotBlank(href) && !href.toLowerCase().startsWith('javascript:')) {
      links.push({ text, href });
    }
  });
  return links;
}
