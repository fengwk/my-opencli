import { describe, expect, it } from 'vitest';
import { HtmlCleaner } from '../src/html-cleaner.js';
import { MarkdownRenderer } from '../src/markdown-renderer.js';

const cleaner = new HtmlCleaner();
const renderer = new MarkdownRenderer();

describe('HtmlCleaner', () => {
  it('prefers a focused descendant when onlyMainContent is enabled', () => {
    const html = `
      <html><body>
        <div class='page-shell'>
          <div class='toolbar'>insert text default font 16</div>
          <div class='document-wrapper'>
            <div class='document-meta'>Create 0words</div>
            <div class='article-content'>
              <h1>Doc Title</h1>
              <p>This is the main document paragraph with enough detail to be treated as the primary content block.</p>
              <p>Another paragraph explains the proposal, trade-offs, rollout plan, and acceptance criteria in one place.</p>
              <table>
                <tr><th>Field</th><th>Value</th></tr>
                <tr><td>Owner</td><td>User A</td></tr>
              </table>
            </div>
            <div class='comment-list'>comment (5)</div>
          </div>
        </div>
      </body></html>
    `;

    const cleaned = cleaner.clean(html, 'https://example.com/doc', true);

    expect(cleaned).toContain('Doc Title');
    expect(cleaned).toContain('Another paragraph explains the proposal');
    expect(cleaned).not.toContain('insert text default font 16');
    expect(cleaned).not.toContain('comment (5)');
    expect(cleaned).not.toContain('Create 0words');
  });

  it('preserves article metadata when focusing the article body', () => {
    const html = `
      <html><body>
        <div class='text'>
          <div class='text-title'>
            <h1>Article Title</h1>
            <div class='article-info'>
              <span class='time'>2024-02-01 14:00</span>
              <span class='source'>发布于：江苏省</span>
            </div>
          </div>
          <article class='article' id='mp-editor'>
            <p>The article body starts here with enough detail to be selected as the focused content element.</p>
            <p>Another paragraph keeps the body long enough for the cleaner to refine into the article block.</p>
          </article>
          <div class='statement'>平台声明：示例声明</div>
        </div>
      </body></html>
    `;

    const cleaned = cleaner.clean(html, 'https://example.com/news', true);

    expect(cleaned).toContain('Article Title');
    expect(cleaned).toContain('2024-02-01 14:00');
    expect(cleaned).toContain('发布于：江苏省');
    expect(cleaned).toContain('The article body starts here');
    expect(cleaned).not.toContain('平台声明：示例声明');
  });

  it('promotes lazy-loaded image attributes to src and absolutizes them', () => {
    const html = `
      <html><body>
        <article>
          <p>Intro paragraph with enough detail to preserve the article block during extraction.</p>
          <img src="https://statics.example.com/preload.png" data-src="//cdn.example.com/real-image.jpg" />
          <img src="data:image/gif;base64,AAAA" data-original="/images/cover.png" />
        </article>
      </body></html>
    `;

    const cleaned = cleaner.clean(html, 'https://example.com/story', true);

    expect(cleaned).toContain('https://cdn.example.com/real-image.jpg');
    expect(cleaned).toContain('https://example.com/images/cover.png');
    expect(cleaned).not.toContain('preload.png');
    expect(cleaned).not.toContain('data:image/gif');
  });

  it('strips heading ids before markdown rendering in onlyMainContent mode', () => {
    const html = `
      <html><body>
        <article>
          <h2 id="📹-视频教程"><a href="#📹-视频教程" class="headerlink"></a>📹 视频教程</h2>
          <h3 id="SEAGM（推荐！）"><a href="#SEAGM（推荐！）" class="headerlink"></a>SEAGM（推荐！）</h3>
          <p>正文段落</p>
          <blockquote id="quote">引用内容</blockquote>
        </article>
      </body></html>
    `;

    const cleaned = cleaner.clean(html, 'https://example.com/post', true);
    const markdown = renderer.render(cleaned);

    expect(markdown).toContain('📹 视频教程');
    expect(markdown).toContain('SEAGM（推荐！）');
    expect(markdown).toContain('引用内容');
    expect(markdown).not.toContain('{#');
    expect(cleaned).not.toContain('id=');
    expect(cleaned).not.toContain('name=');
  });
});
