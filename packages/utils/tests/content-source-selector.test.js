import { describe, expect, it } from 'vitest';
import { ContentSourceSelector } from '../src/content-source-selector.js';

const selector = new ContentSourceSelector();

describe('ContentSourceSelector', () => {
  it('prefers a document-like frame over a shell and a tool frame', () => {
    const shell = {
      id: 'main',
      parentId: null,
      url: 'https://example.com/shell',
      html: "<body><div class='shell'>Read only AI Assistant Share Permission User A User A User A</div></body>",
      markdown: 'Read only AI Assistant Share Permission User A User A User A',
      depth: 0,
      mainDocument: true,
    };

    const documentFrame = {
      id: 'frame-doc',
      parentId: null,
      url: 'https://example.com/doc-editor',
      html: `
        <body>
          <div class='doc-root'>
            <h1>Voice Comment Plan</h1>
            <p>This proposal introduces voice comments in the song discussion area and explains why the format improves authentic expression.</p>
            <p>The rollout is staged, the moderation path is defined, and the measurement framework is captured in the following table.</p>
            <table>
              <tr><th>Stage</th><th>Goal</th></tr>
              <tr><td>MVP</td><td>Validate publishing and listening behavior</td></tr>
            </table>
          </div>
        </body>
      `,
      markdown: '# Voice Comment Plan\n\nThis proposal introduces voice comments...\n\n| Stage | Goal |\n| --- | --- |\n| MVP | Validate publishing and listening behavior |',
      depth: 1,
      mainDocument: false,
    };

    const toolFrame = {
      id: 'frame-tool',
      parentId: null,
      url: 'https://example.com/flow-tool',
      html: `
        <body>
          <div class='toolbar panel'>insert text bold italic font size</div>
          <div class='sidebar catalog drawer'>shape line arrow table box note circle triangle</div>
          <div class='comment-panel'>comment reply share send submit</div>
          <div class='canvas-meta'>drag elements here scratchpad general advanced basic arrows icons layout widgets export import zoom canvas layers</div>
        </body>
      `,
      markdown: 'insert text bold italic font size drag elements here scratchpad general advanced basic arrows icons layout widgets export import zoom canvas layers',
      depth: 1,
      mainDocument: false,
    };

    const selected = selector.selectPrimary([shell, documentFrame, toolFrame]);
    expect(selected).not.toBeNull();
    expect(selected.id).toBe('frame-doc');
  });
});
