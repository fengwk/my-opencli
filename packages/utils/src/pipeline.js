import { ContentSourceSelector } from './content-source-selector.js';
import { extractLinks, HtmlCleaner } from './html-cleaner.js';
import { MarkdownPostProcessor } from './markdown-post-processor.js';
import { MarkdownRenderer } from './markdown-renderer.js';
import { isBlank, isNotBlank } from './strings.js';

const htmlCleaner = new HtmlCleaner();
const markdownRenderer = new MarkdownRenderer();
const markdownPostProcessor = new MarkdownPostProcessor();
const contentSourceSelector = new ContentSourceSelector();

export const SCRAPE_FORMATS = Object.freeze(['markdown', 'links', 'screenshot', 'fullscreenshot']);

export function buildTextResult({ title, url, html, frameDocuments = [], onlyMainContent = false }) {
  const { cleanedHtml, fallbackHtml, frameContents } = cleanDocuments(html, frameDocuments, onlyMainContent, url);
  const mainSource = renderContentSource({
    id: 'main',
    parentId: null,
    url,
    cleanedHtml,
    fallbackHtml,
    depth: 0,
    mainDocument: true,
    onlyMainContent,
  });
  const renderedFrameSources = renderFrameSources(frameContents, onlyMainContent);

  if (onlyMainContent) {
    const focusedMarkdown = selectFocusedMarkdown(mainSource, renderedFrameSources);
    if (isNotBlank(focusedMarkdown)) {
      return focusedMarkdown;
    }
  }

  return mergeMarkdown(mainSource, renderedFrameSources);
}

export function buildLinksResult({ url, html, frameDocuments = [], onlyMainContent = false }) {
  const { cleanedHtml, frameContents } = cleanDocuments(html, frameDocuments, onlyMainContent, url);
  const linksByHref = new Map();
  addLinks(linksByHref, extractLinks(cleanedHtml, url));
  for (const frame of frameContents) {
    const frameHtml = isNotBlank(frame.cleanedHtml) ? frame.cleanedHtml : frame.fallbackHtml;
    if (isNotBlank(frameHtml)) {
      addLinks(linksByHref, extractLinks(frameHtml, frame.url));
    }
  }
  return [...linksByHref.values()];
}

export const INLINE_TEXT_MAX_CHARS = 10_000;

export function formatScrapeText({ title, url, content, links, files }) {
  const lines = [];
  if (title != null && title !== '') {
    lines.push(`Title: ${title}`);
  }
  if (url != null && url !== '') {
    lines.push(`URL: ${url}`, '');
  }
  if (isNotBlank(content)) {
    lines.push(content);
  }
  if (Array.isArray(links) && links.length > 0) {
    for (const link of links) {
      lines.push(`- [${link.text || ''}](${link.href || ''})`);
    }
  }
  if (Array.isArray(files) && files.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push('---', 'Files saved:');
    for (const file of files) {
      lines.push(`- ${file}`);
    }
  }
  return lines.join('\n').trim();
}

export function buildTruncatedNotice({ title, url, chars, files, maxChars = INLINE_TEXT_MAX_CHARS }) {
  const lines = [];
  if (title) lines.push(`Title: ${title}`);
  if (url) lines.push(`URL: ${url}`);
  if (lines.length > 0) lines.push('');
  lines.push(`Content exceeds ${maxChars} characters (${chars} chars) and was saved to:`);
  for (const file of files || []) {
    lines.push(`- ${file}`);
  }
  return lines.join('\n').trim();
}

function cleanDocuments(html, frameDocuments, onlyMainContent, requestUrl) {
  const cleanedHtml = htmlCleaner.clean(html, requestUrl, onlyMainContent);
  const fallbackHtml = onlyMainContent ? htmlCleaner.clean(html, requestUrl, false) : cleanedHtml;
  const frameContents = [];
  for (const frame of frameDocuments || []) {
    const frameUrl = isBlank(frame.url) ? requestUrl : frame.url;
    const cleaned = htmlCleaner.clean(frame.html, frameUrl, onlyMainContent);
    const fallback = onlyMainContent ? htmlCleaner.clean(frame.html, frameUrl, false) : cleaned;
    frameContents.push({
      id: frame.id,
      parentId: frame.parentId ?? null,
      url: frameUrl,
      cleanedHtml: cleaned,
      fallbackHtml: fallback,
      depth: frame.depth || 1,
    });
  }
  return { cleanedHtml, fallbackHtml, frameContents };
}

function renderContentSource({
  id,
  parentId,
  url,
  cleanedHtml,
  fallbackHtml,
  depth,
  mainDocument,
  onlyMainContent,
}) {
  let html = isNotBlank(cleanedHtml) ? cleanedHtml : fallbackHtml;
  if (isBlank(html)) return null;

  let rawMarkdown = markdownRenderer.render(html);
  let markdown = markdownPostProcessor.process(rawMarkdown);
  if (onlyMainContent && isBlank(markdown) && isNotBlank(fallbackHtml) && fallbackHtml !== html) {
    rawMarkdown = markdownRenderer.render(fallbackHtml);
    markdown = markdownPostProcessor.process(rawMarkdown);
    html = fallbackHtml;
  }
  if (isBlank(markdown)) return null;
  return {
    id,
    parentId,
    url,
    html,
    markdown: markdown.trim(),
    depth,
    mainDocument,
  };
}

function renderFrameSources(frameContents, onlyMainContent) {
  const rendered = [];
  for (const frame of frameContents || []) {
    const source = renderContentSource({
      id: frame.id,
      parentId: frame.parentId,
      url: frame.url,
      cleanedHtml: frame.cleanedHtml,
      fallbackHtml: frame.fallbackHtml,
      depth: frame.depth,
      mainDocument: false,
      onlyMainContent,
    });
    if (source) rendered.push(source);
  }
  return rendered;
}

function selectFocusedMarkdown(mainSource, frameSources) {
  const sources = [];
  if (mainSource) sources.push(mainSource);
  if (frameSources) sources.push(...frameSources);
  const primary = contentSourceSelector.selectPrimary(sources);
  return primary ? primary.markdown : '';
}

function mergeMarkdown(mainSource, frameSources) {
  const mainMarkdown = mainSource ? mainSource.markdown : '';
  if (!frameSources || frameSources.length === 0) {
    return isBlank(mainMarkdown) ? '' : mainMarkdown.trim();
  }

  let merged = '';
  if (isNotBlank(mainMarkdown)) {
    merged += mainMarkdown.trim();
  }
  if (merged) merged += '\n\n';
  merged += '## Embedded Frame Contents';

  const sectionByFrameId = new Map();
  const siblingCounters = new Map();

  for (let i = 0; i < frameSources.length; i += 1) {
    const source = frameSources[i];
    const sectionNumber = buildFrameSectionNumber(source, sectionByFrameId, siblingCounters);
    const headingLevel = Math.min(6, 2 + Math.max(1, source.depth || 1));
    merged += `\n\n${'#'.repeat(headingLevel)} Frame ${sectionNumber}: ${source.url || 'unknown'}\n\n${source.markdown}`;
  }

  return merged.trim();
}

function buildFrameSectionNumber(source, sectionByFrameId, siblingCounters) {
  const parentId = source.parentId;
  const counterKey = isBlank(parentId) ? 'root' : parentId;
  const siblingIndex = (siblingCounters.get(counterKey) || 0) + 1;
  siblingCounters.set(counterKey, siblingIndex);
  const parentSection = isBlank(parentId) ? null : sectionByFrameId.get(parentId);
  const sectionNumber = isBlank(parentSection) ? String(siblingIndex) : `${parentSection}.${siblingIndex}`;
  sectionByFrameId.set(source.id, sectionNumber);
  return sectionNumber;
}

function addLinks(linksByHref, links) {
  for (const link of links) {
    const existing = linksByHref.get(link.href);
    if (!existing) {
      linksByHref.set(link.href, link);
      continue;
    }
    if (isBlank(existing.text) && isNotBlank(link.text)) {
      linksByHref.set(link.href, link);
    }
  }
}
