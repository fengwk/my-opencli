import { describe, expect, it, vi } from 'vitest';
import { extractVideoItem, fetchUserVideosPage } from '../src/user-videos-fetch.js';

const targetSecUid = 'MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU';

function createMockPage(responses = []) {
  let callCount = 0;
  return {
    goto: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      const response = responses[callCount] ?? responses[responses.length - 1];
      callCount += 1;
      return response;
    }),
  };
}

describe('douyin-ext user-videos metadata extraction', () => {
  // Test intent: A normal post payload must expose every requested field as flat
  // metadata without adding a statistics block or an untrustworthy play_count.
  it('extracts complete home-page metadata with raw units and nested author/music objects', () => {
    const desc =
      '2招搞定爆款AI视频剧本 想做爆款AI视频，却卡在了第一步……版本过低，升级后可展示全部信息';
    const rawItem = {
      aweme_id: '7701962254330128228',
      item_title: '2招搞定爆款AI视频剧本',
      desc,
      create_time: 1760000000,
      author: {
        nickname: '李一帆',
        uid: '241510522037368',
        sec_uid: 'MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU',
        unique_id: null,
      },
      music: {
        title: '@李一帆创作的原声',
        author: '李一帆',
      },
      video: {
        duration: 325729,
        width: 1920,
        height: 1080,
        cover: { url_list: ['https://example.com/cover.jpg'] },
        play_addr: { url_list: ['https://example.com/video.mp4'] },
      },
      statistics: {
        digg_count: 123,
        comment_count: 45,
        collect_count: 67,
        share_count: 89,
        play_count: 0,
      },
    };

    expect(extractVideoItem(rawItem)).toEqual({
      aweme_id: '7701962254330128228',
      title: desc,
      item_title: '2招搞定爆款AI视频剧本',
      desc,
      desc_has_truncation_notice: true,
      duration: 326,
      duration_ms: 325729,
      create_time: 1760000000,
      author: {
        nickname: '李一帆',
        uid: '241510522037368',
        sec_uid: 'MS4wLjABAAAAyi85GGeS9GCLBpS4JAJ-r4Kz0cPVz-b0wIiYaeg_icU',
        unique_id: null,
      },
      width: 1920,
      height: 1080,
      cover_url: 'https://example.com/cover.jpg',
      music: {
        title: '@李一帆创作的原声',
        author: '李一帆',
      },
      digg_count: 123,
      comment_count: 45,
      collect_count: 67,
      share_count: 89,
      play_url: 'https://example.com/video.mp4',
      top_comments: [],
      url: 'https://www.douyin.com/video/7701962254330128228',
      is_image: false,
    });
  });

  // Test intent: Missing or malformed optional metadata becomes null while a
  // genuine zero survives, and neither case drops the item or fails extraction.
  it('nulls missing or invalid optional metadata while preserving real zero counts', () => {
    const invalidItem = extractVideoItem({
      aweme_id: '7701962254330128230',
      desc: 'Invalid optional metadata',
      create_time: 1760000000.5,
      author: {
        nickname: 123,
        uid: 99999999999999999,
        sec_uid: false,
        unique_id: {},
      },
      video: {
        duration: '15000',
        width: -1920,
        height: 1080.5,
      },
      statistics: {
        digg_count: 0,
        comment_count: -1,
        collect_count: 1.5,
        share_count: '89',
      },
      music: null,
    });

    expect(invalidItem).toMatchObject({
      aweme_id: '7701962254330128230',
      title: 'Invalid optional metadata',
      desc: 'Invalid optional metadata',
      desc_has_truncation_notice: false,
      duration: null,
      duration_ms: null,
      create_time: null,
      author: {
        nickname: null,
        uid: null,
        sec_uid: null,
        unique_id: null,
      },
      width: null,
      height: null,
      cover_url: null,
      music: null,
      digg_count: 0,
      comment_count: null,
      collect_count: null,
      share_count: null,
      play_url: '',
      top_comments: [],
      url: 'https://www.douyin.com/video/7701962254330128230',
      is_image: false,
    });

    const minimalItem = extractVideoItem({ aweme_id: '7701962254330128231' });
    expect(minimalItem).toMatchObject({
      title: '',
      item_title: null,
      desc: null,
      desc_has_truncation_notice: false,
      duration: null,
      duration_ms: null,
      create_time: null,
      author: null,
      width: null,
      height: null,
      cover_url: null,
      music: null,
      digg_count: null,
      comment_count: null,
      collect_count: null,
      share_count: null,
    });
  });

  // Test intent: UID text precision must survive unchanged, empty short titles
  // stay empty strings, and only the known truncation suffix sets the flag.
  it('preserves UID text, empty item titles, raw descriptions, and the known notice only', () => {
    const desc = '2招搞定爆款AI视频剧本……版本过低，升级后可展示全部信息';
    const item = extractVideoItem({
      aweme_id: '7701962254330128232',
      item_title: '',
      desc,
      author: {
        uid: '241510522037368',
        unique_id: null,
      },
    });

    expect(item.item_title).toBe('');
    expect(item.desc).toBe(desc);
    expect(item.author.uid).toBe('241510522037368');
    expect(item.author.unique_id).toBeNull();
    expect(item.desc_has_truncation_notice).toBe(true);

    const unrelatedItem = extractVideoItem({
      aweme_id: '7701962254330128233',
      item_title: '',
      desc: '普通描述，没有已知的升级提示。',
      author: {
        uid: 99999999999999999,
      },
    });

    expect(unrelatedItem.item_title).toBe('');
    expect(unrelatedItem.desc).toBe('普通描述，没有已知的升级提示。');
    expect(unrelatedItem.author.uid).toBeNull();
    expect(unrelatedItem.desc_has_truncation_notice).toBe(false);
  });

  // Test intent: Enriched metadata must still come from the single post request,
  // preserve all items, and leave cursor/has_more semantics unchanged.
  it('keeps one page fetch, all items, and exact pagination state', async () => {
    const desc = '2招搞定爆款AI视频剧本……版本过低，升级后可展示全部信息';
    const page = createMockPage([
      {
        __kind: 'ok',
        data: {
          status_code: 0,
          has_more: 1,
          max_cursor: '1789453816000',
          aweme_list: [
            {
              aweme_id: '7701962254330128234',
              item_title: '2招搞定爆款AI视频剧本',
              desc,
              create_time: 1760000000,
              author: {
                nickname: '李一帆',
                uid: '241510522037368',
                sec_uid: targetSecUid,
                unique_id: null,
              },
              music: {
                title: '@李一帆创作的原声',
                author: '李一帆',
              },
              video: {
                duration: 325729,
                width: 1920,
                height: 1080,
                cover: { url_list: ['https://example.com/cover.jpg'] },
                play_addr: { url_list: ['https://example.com/video.mp4'] },
              },
              statistics: {
                digg_count: 0,
                comment_count: 1,
                collect_count: 2,
                share_count: 3,
              },
            },
            {
              aweme_id: '7701962254330128235',
            },
          ],
        },
      },
    ]);

    const result = await fetchUserVideosPage(page, {
      secUid: targetSecUid,
      cursor: '1770000000000',
      count: 20,
      commentLimit: 0,
    });

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(result.cursor).toBe('1770000000000');
    expect(result.next_cursor).toBe('1789453816000');
    expect(result.has_more).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      aweme_id: '7701962254330128234',
      item_title: '2招搞定爆款AI视频剧本',
      desc,
      desc_has_truncation_notice: true,
      duration: 326,
      duration_ms: 325729,
      author: {
        nickname: '李一帆',
        uid: '241510522037368',
        sec_uid: targetSecUid,
        unique_id: null,
      },
      music: {
        title: '@李一帆创作的原声',
        author: '李一帆',
      },
      width: 1920,
      height: 1080,
      cover_url: 'https://example.com/cover.jpg',
      digg_count: 0,
      comment_count: 1,
      collect_count: 2,
      share_count: 3,
    });
    expect(result.items[1]).toMatchObject({
      aweme_id: '7701962254330128235',
      item_title: null,
      desc: null,
      author: null,
      music: null,
      digg_count: null,
      comment_count: null,
      collect_count: null,
      share_count: null,
    });
  });
});
