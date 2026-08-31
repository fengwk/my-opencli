import * as cheerio from 'cheerio';
import { isBlank, normalizedTextLength } from './strings.js';

export class ContentSourceSelector {
  selectPrimary(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
      return null;
    }

    let bestSource = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const source of sources) {
      if (!source || isBlank(source.html) || isBlank(source.markdown)) {
        continue;
      }
      const score = this.#score(source);
      if (score > bestScore) {
        bestScore = score;
        bestSource = source;
      }
    }
    return bestSource;
  }

  #score(source) {
    const $ = cheerio.load(source.html || '');
    const body = $('body').get(0);
    if (!body) return Number.NEGATIVE_INFINITY;

    const textLength = normalizedTextLength($(body).text());
    if (textLength <= 0) return Number.NEGATIVE_INFINITY;

    let linkTextLength = 0;
    $(body).find('a').addBack('a').each((_, link) => {
      linkTextLength += normalizedTextLength($(link).text());
    });
    const linkDensity = linkTextLength / Math.max(1, textLength);

    const headingCount = $(body).find('h1, h2, h3, h4, h5, h6').length;
    const paragraphCount = $(body).find('p').length;
    const listItemCount = $(body).find('li').length;
    const tableCount = $(body).find('table').length;
    const imageCount = $(body).find('img').length;
    let longBlockCount = 0;
    $(body).find('p, li, blockquote, td, th').each((_, block) => {
      if (normalizedTextLength($(block).text()) >= 30) {
        longBlockCount += 1;
      }
    });

    const interactiveCount = $(body).find(
      'button, input, textarea, select, option, label, [role=button], [role=tab], [role=dialog], [aria-modal=true], [contenteditable=true]',
    ).length;
    const embeddedFrameCount = $(body).find('iframe, frame').length;
    const chromeMarkerCount = $(body).find(
      '[class*=toolbar], [id*=toolbar], [class*=comment], [id*=comment], [class*=reply], [id*=reply], [class*=sidebar], [id*=sidebar], [class*=catalog], [id*=catalog], [class*=drawer], [id*=drawer], [class*=panel], [id*=panel], [class*=modal], [id*=modal], [class*=dialog], [id*=dialog], [class*=share], [id*=share], [class*=word-count], [id*=word-count]',
    ).length;

    let markdownHeadingCount = 0;
    let markdownTableCount = 0;
    for (const line of String(source.markdown || '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) markdownHeadingCount += 1;
      if (/^\|(?:.*\|)+$/.test(trimmed)) markdownTableCount += 1;
    }

    let score = textLength * (1 - Math.min(0.9, linkDensity));
    score += Math.min(24, headingCount) * 80;
    score += Math.min(120, paragraphCount) * 18;
    score += Math.min(200, listItemCount) * 8;
    score += Math.min(30, tableCount) * 90;
    score += Math.min(20, imageCount) * 6;
    score += Math.min(80, longBlockCount) * 24;
    score += Math.min(24, markdownHeadingCount) * 50;
    score += Math.min(80, markdownTableCount) * 10;
    score -= Math.min(360, interactiveCount * 16);
    score -= Math.min(360, embeddedFrameCount * 120);
    score -= Math.min(420, chromeMarkerCount * 18);

    const marker = `${$(body).attr('id') || ''} ${$(body).attr('class') || ''} ${source.url || ''}`.toLowerCase();
    if (marker.includes('article') || marker.includes('content') || marker.includes('doc') || marker.includes('read')) {
      score += 80;
    }
    if (
      marker.includes('comment')
      || marker.includes('toolbar')
      || marker.includes('catalog')
      || marker.includes('sidebar')
      || marker.includes('drawer')
      || marker.includes('panel')
    ) {
      score -= 120;
    }
    if (source.mainDocument) {
      score += 12;
    }
    return score;
  }
}
