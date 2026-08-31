import { describe, expect, it } from 'vitest';
import { mergeFrameDocuments, orderFrameDocuments } from '../src/frame-collect.js';

describe('frame collection', () => {
  it('keeps same-origin parent/child order like Playwright page.frames()', () => {
    const ordered = orderFrameDocuments([
      {
        id: 'frame-2',
        parentId: 'frame-1',
        url: 'https://example.com/child',
        html: '<p>child</p>',
        depth: 2,
        order: 2,
      },
      {
        id: 'frame-1',
        parentId: null,
        url: 'https://example.com/parent',
        html: '<p>parent</p>',
        depth: 1,
        order: 1,
      },
    ]);
    expect(ordered.map((frame) => frame.id)).toEqual(['frame-1', 'frame-2']);
  });

  it('attaches a cross-origin root to the same-origin parent that embeds it', () => {
    const merged = mergeFrameDocuments(
      {
        html: '<html></html>',
        frames: [
          {
            id: 'frame-1',
            parentId: null,
            url: 'https://example.com/shell',
            html: '<p>shell</p>',
            depth: 1,
            order: 1,
          },
        ],
        inaccessible: [
          { parentId: 'frame-1', url: 'https://editor.example/doc', order: 2, depth: 2 },
        ],
      },
      [
        {
          id: 'xo-0',
          url: 'https://editor.example/doc',
          html: '<html><body><p>editor body with enough text.</p></body></html>',
          frames: [
            {
              id: 'frame-1',
              parentId: null,
              url: 'https://editor.example/inner',
              html: '<p>inner same-origin of editor</p>',
              depth: 1,
              order: 1,
            },
          ],
          inaccessible: [],
          order: 1000,
        },
      ],
    );

    expect(merged.map((frame) => ({ id: frame.id, parentId: frame.parentId, depth: frame.depth }))).toEqual([
      { id: 'frame-1', parentId: null, depth: 1 },
      { id: 'xo-0', parentId: 'frame-1', depth: 2 },
      { id: 'xo-0/frame-1', parentId: 'xo-0', depth: 3 },
    ]);
  });

  it('does not drop a second frame just because the URL already appeared', () => {
    const merged = mergeFrameDocuments(
      { html: '<html></html>', frames: [], inaccessible: [] },
      [
        {
          id: 'xo-0',
          url: 'about:blank',
          html: '<html><body><p>one</p></body></html>',
          frames: [],
          order: 1,
        },
        {
          id: 'xo-1',
          url: 'about:blank',
          html: '<html><body><p>two</p></body></html>',
          frames: [],
          order: 2,
        },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((frame) => frame.id)).toEqual(['xo-0', 'xo-1']);
  });
});
