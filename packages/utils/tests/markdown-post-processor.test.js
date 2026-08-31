import { describe, expect, it } from 'vitest';
import { MarkdownPostProcessor } from '../src/markdown-post-processor.js';

const processor = new MarkdownPostProcessor();

describe('MarkdownPostProcessor', () => {
  it('swaps a delimiter-first header table', () => {
    const input = `|------|------|------|
| 变更内容 | 时间 | 提交人 |
| 文档1.0 | 0317 | 用户A |
`;
    expect(processor.process(input)).toBe(
      `| 变更内容 | 时间 | 提交人 |
| --- | --- | --- |
| 文档1.0 | 0317 | 用户A |`,
    );
  });

  it('generates a synthetic header for a delimiter-first key-value table', () => {
    const input = `|-----------|------------------------------|
| 需求POC | PM @用户A |
| 是否需要内审 | |
`;
    expect(processor.process(input)).toBe(
      `| Column 1 | Column 2 |
| --- | --- |
| 需求POC | PM @用户A |
| 是否需要内审 |  |`,
    );
  });

  it('preserves empty cells and normalizes the delimiter', () => {
    const input = `|------|--------|--------------------------------|-------------------------------------------------------------------|
| 用户类型 || 需求 | 可能产生的语音内容 |
| 发布用户 | 普通发布用户 | 更方便发评论 | 听歌感受、歌曲点评等 |
`;
    expect(processor.process(input)).toBe(
      `| 用户类型 |  | 需求 | 可能产生的语音内容 |
| --- | --- | --- | --- |
| 发布用户 | 普通发布用户 | 更方便发评论 | 听歌感受、歌曲点评等 |`,
    );
  });

  it('removes standalone HTML comments and normalizes detached ordered bullets', () => {
    const input = `1

* 第一项

<!-- -->

1

* 第二项
`;
    expect(processor.process(input)).toBe(
      `1. 第一项

2. 第二项`,
    );
  });

  it('normalizes inline flattened list markers and comment fragments', () => {
    const input = `| 需求范围 | 1 * 端：移动端生效 <!-- --> 1 * 版本：仅新版本展示 <!-- --> 1 * 场景：仅歌曲评论区 |
`;
    expect(processor.process(input)).toBe(
      `| 需求范围 | 1. 端：移动端生效 / 2. 版本：仅新版本展示 / 3. 场景：仅歌曲评论区 |`,
    );
  });

  it('keeps both image markers when compacting adjacent images', () => {
    expect(processor.process('![one](a.png)\n\n![two](b.png)'))
      .toBe('![one](a.png)![two](b.png)');
  });
});
