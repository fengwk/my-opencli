import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { isBlank } from './strings.js';

/**
 * HTML → Markdown, aligned with my-mcp flexmark settings:
 * SETEXT_HEADINGS, unordered '*', list indent, DIV_AS_PARAGRAPH.
 * Turndown is the JS stand-in for flexmark; MarkdownPostProcessor is the
 * shared cleanup stage that actually defines the "clean content" contract.
 */
export class MarkdownRenderer {
  constructor() {
    this.converter = new TurndownService({
      headingStyle: 'setext',
      codeBlockStyle: 'fenced',
      bulletListMarker: '*',
      emDelimiter: '*',
      strongDelimiter: '**',
      fence: '```',
    });
    this.converter.use(gfm);
    this.converter.addRule('divAsParagraph', {
      filter: 'div',
      replacement(content) {
        const trimmed = content.trim();
        return trimmed ? `\n\n${trimmed}\n\n` : '\n';
      },
    });
  }

  render(html) {
    if (isBlank(html)) return '';
    return this.converter.turndown(html);
  }
}
