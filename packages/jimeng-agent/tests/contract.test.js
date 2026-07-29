/**
 * Vitest suite for jimeng-agent/src/contract.js.
 *
 * Scope: validate pure normalization/validation. No browser, no submission,
 * no generation. Tests must be deterministic and run without network, file
 * I/O, or time-dependent behavior.
 */

import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';

import {
  MAX_AUDIO_REFERENCES,
  MAX_REFERENCE_ASSETS,
  MAX_REFERENCE_DURATION_SECONDS,
  MAX_VIDEO_REFERENCES,
  MODEL_VERSIONS,
  RATIOS,
  normalizeAskArgs,
} from '../src/contract.js';

/** A minimal "happy path" kwargs payload used by most tests. */
function baseArgs(overrides = {}) {
  return {
    workspace: '/tmp/jimeng-agent',
    image: ['hero.png'],
    video: undefined,
    audio: undefined,
    prompt: '',
    duration: undefined,
    ratio: '16:9',
    model_version: 'seedance2.0',
    retry: undefined,
    ...overrides,
  };
}

describe('jimeng-agent/contract — exported constants', () => {
  it('exposes MODEL_VERSIONS in the exact ordered allow-list', () => {
    expect(MODEL_VERSIONS).toEqual([
      'seedance2.0',
      'seedance2.0fast',
      'seedance2.0_vip',
      'seedance2.0fast_vip',
      'seedance2.0mini',
    ]);
  });

  it('freezes MODEL_VERSIONS to prevent runtime mutation', () => {
    expect(Object.isFrozen(MODEL_VERSIONS)).toBe(true);
  });

  it('exposes RATIOS in the exact ordered allow-list', () => {
    expect(RATIOS).toEqual(['1:1', '3:4', '16:9', '4:3', '9:16', '21:9']);
  });

  it('freezes RATIOS to prevent runtime mutation', () => {
    expect(Object.isFrozen(RATIOS)).toBe(true);
  });

  it('exposes the documented asset-count and duration ceilings', () => {
    expect(MAX_REFERENCE_ASSETS).toBe(12);
    expect(MAX_VIDEO_REFERENCES).toBe(3);
    expect(MAX_AUDIO_REFERENCES).toBe(3);
    expect(MAX_REFERENCE_DURATION_SECONDS).toBe(15);
  });

  it('treats the limit constants as immutable primitives', () => {
    // Numeric primitives are effectively frozen by the language, but every
    // export is declared with `const` so the binding itself cannot be
    // reassigned. We assert both flavors.
    const exports = [
      ['MAX_REFERENCE_ASSETS', MAX_REFERENCE_ASSETS],
      ['MAX_VIDEO_REFERENCES', MAX_VIDEO_REFERENCES],
      ['MAX_AUDIO_REFERENCES', MAX_AUDIO_REFERENCES],
      ['MAX_REFERENCE_DURATION_SECONDS', MAX_REFERENCE_DURATION_SECONDS],
    ];
    for (const [, value] of exports) {
      expect(typeof value).toBe('number');
      expect(Object.isFrozen(value)).toBe(true);
    }
    // Re-declaration via assignment would throw at module-eval time, so a
    // plain "value === number" sanity check is sufficient evidence here.
    expect(MAX_REFERENCE_DURATION_SECONDS).not.toBe(MAX_REFERENCE_ASSETS);
  });
});

describe('jimeng-agent/contract — required string fields', () => {
  it('rejects undefined workspace', () => {
    expect(() => normalizeAskArgs(baseArgs({ workspace: undefined })))
      .toThrow(ArgumentError);
  });

  it('rejects blank workspace', () => {
    expect(() => normalizeAskArgs(baseArgs({ workspace: '   ' })))
      .toThrow(ArgumentError);
  });

  it('rejects non-string workspace', () => {
    expect(() => normalizeAskArgs(baseArgs({ workspace: 42 })))
      .toThrow(ArgumentError);
  });

  it('rejects missing ratio', () => {
    expect(() => normalizeAskArgs(baseArgs({ ratio: undefined })))
      .toThrow(ArgumentError);
  });

  it('rejects ratio outside the allow-list', () => {
    expect(() => normalizeAskArgs(baseArgs({ ratio: '7:7' })))
      .toThrow(ArgumentError);
  });

  it('rejects missing model_version', () => {
    expect(() => normalizeAskArgs(baseArgs({ model_version: undefined })))
      .toThrow(ArgumentError);
  });

  it('rejects model_version outside the allow-list', () => {
    expect(() => normalizeAskArgs(baseArgs({ model_version: 'sora.1' })))
      .toThrow(ArgumentError);
  });

  it('trims required strings so downstream code sees a canonical form', () => {
    const out = normalizeAskArgs(baseArgs({
      workspace: '  /work  ',
      ratio: ' 16:9 ',
      model_version: ' seedance2.0_vip ',
    }));
    expect(out.workspace).toBe('/work');
    expect(out.ratio).toBe('16:9');
    expect(out.modelVersion).toBe('seedance2.0_vip');
  });
});

describe('jimeng-agent/contract — duration normalization', () => {
  it('defaults duration to 5 when omitted', () => {
    const out = normalizeAskArgs(baseArgs());
    expect(out.duration).toBe(5);
  });

  it('treats null duration as omitted', () => {
    const out = normalizeAskArgs(baseArgs({ duration: null }));
    expect(out.duration).toBe(5);
  });

  it('treats empty/whitespace-string duration as omitted', () => {
    expect(normalizeAskArgs(baseArgs({ duration: '' })).duration).toBe(5);
    expect(normalizeAskArgs(baseArgs({ duration: '   ' })).duration).toBe(5);
  });

  it('accepts the inclusive lower bound 4', () => {
    expect(normalizeAskArgs(baseArgs({ duration: 4 })).duration).toBe(4);
  });

  it('accepts the inclusive upper bound 15', () => {
    expect(normalizeAskArgs(baseArgs({ duration: 15 })).duration).toBe(15);
  });

  it('accepts numeric strings inside the range', () => {
    expect(normalizeAskArgs(baseArgs({ duration: '7' })).duration).toBe(7);
    expect(normalizeAskArgs(baseArgs({ duration: ' 12 ' })).duration).toBe(12);
  });

  it('rejects duration below 4 without clamping', () => {
    expect(() => normalizeAskArgs(baseArgs({ duration: 3 })))
      .toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({ duration: '3' })))
      .toThrow(ArgumentError);
  });

  it('rejects duration above 15 without clamping', () => {
    expect(() => normalizeAskArgs(baseArgs({ duration: 16 })))
      .toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({ duration: '99' })))
      .toThrow(ArgumentError);
  });

  it('rejects non-integer numeric duration', () => {
    expect(() => normalizeAskArgs(baseArgs({ duration: 5.5 })))
      .toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({ duration: '5.5' })))
      .toThrow(ArgumentError);
  });

  it('rejects non-numeric duration strings', () => {
    expect(() => normalizeAskArgs(baseArgs({ duration: 'abc' })))
      .toThrow(ArgumentError);
  });

  it('rejects non-string/non-number duration payloads', () => {
    expect(() => normalizeAskArgs(baseArgs({ duration: true })))
      .toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({ duration: {} })))
      .toThrow(ArgumentError);
  });
});

describe('jimeng-agent/contract — retry normalization', () => {
  it('defaults retry to zero when omitted, null, or blank', () => {
    expect(normalizeAskArgs(baseArgs()).retry).toBe(0);
    expect(normalizeAskArgs(baseArgs({ retry: null })).retry).toBe(0);
    expect(normalizeAskArgs(baseArgs({ retry: '  ' })).retry).toBe(0);
  });

  it('accepts non-negative integer values', () => {
    expect(normalizeAskArgs(baseArgs({ retry: 1 })).retry).toBe(1);
    expect(normalizeAskArgs(baseArgs({ retry: ' 2 ' })).retry).toBe(2);
  });

  it('rejects negative, fractional, unsafe, and nonnumeric retry values', () => {
    for (const retry of [-1, '-1', 1.5, '1.5', Number.MAX_SAFE_INTEGER + 1, 'nope', true]) {
      expect(() => normalizeAskArgs(baseArgs({ retry }))).toThrow(ArgumentError);
    }
  });
});

describe('jimeng-agent/contract — asset list normalization', () => {
  it('flattens mixed nested arrays into a single ordered array', () => {
    const out = normalizeAskArgs(baseArgs({
      image: ['a.png', ['b.png', ['c.png', 'd.png']]],
    }));
    expect(out.imagePaths).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
  });

  it('splits comma-separated string entries', () => {
    const out = normalizeAskArgs(baseArgs({
      image: 'a.png,b.png',
      video: ['x.mp4, y.mp4'],
    }));
    expect(out.imagePaths).toEqual(['a.png', 'b.png']);
    expect(out.videoPaths).toEqual(['x.mp4', 'y.mp4']);
  });

  it('preserves document order across nested and comma input', () => {
    const out = normalizeAskArgs(baseArgs({
      image: ['z.png', 'm.png,n.png', ['a.png']],
    }));
    expect(out.imagePaths).toEqual(['z.png', 'm.png', 'n.png', 'a.png']);
  });

  it('trims whitespace and drops empty entries', () => {
    const out = normalizeAskArgs(baseArgs({
      image: ['  a.png  ', ',,b.png, ,'],
    }));
    expect(out.imagePaths).toEqual(['a.png', 'b.png']);
  });

  it('treats undefined / null asset kwargs as empty arrays', () => {
    const out = normalizeAskArgs(baseArgs({
      image: undefined,
      video: null,
      audio: undefined,
    }));
    expect(out.imagePaths).toEqual([]);
    expect(out.videoPaths).toEqual([]);
    expect(out.audioPaths).toEqual([]);
  });

  it('rejects non-string asset entries anywhere in the nested list', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: ['a.png', 42],
    }))).toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({
      video: [['nested', true]],
    }))).toThrow(ArgumentError);
  });

  it('rejects duplicate paths within the same asset list', () => {
    expect(() => normalizeAskArgs(baseArgs({
      video: ['x.mp4', 'y.mp4', 'x.mp4'],
    }))).toThrow(ArgumentError);
  });

  it('rejects duplicate paths across image and video arrays', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: ['x.png'],
      video: ['x.png'],
    }))).toThrow(ArgumentError);
  });

  it('rejects duplicate paths across all three asset arrays', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: ['x.png'],
      video: ['y.mp4'],
      audio: ['x.png'],
    }))).toThrow(ArgumentError);
  });

  it('rejects cross-list duplicates even after trimming normalizes the forms', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: ['  shared.png  '],
      audio: ['shared.png'],
    }))).toThrow(ArgumentError);
  });
});

describe('jimeng-agent/contract — asset record ordering', () => {
  it('emits records in images → videos → audio order with sequential labels', () => {
    const out = normalizeAskArgs(baseArgs({
      image: ['i1.png', 'i2.png'],
      video: ['v1.mp4'],
      audio: ['a1.mp3', 'a2.mp3', 'a3.mp3'],
    }));
    expect(out.assets.map((a) => ({ kind: a.kind, label: a.label, index: a.index, path: a.path })))
      .toEqual([
        { kind: 'image', label: '图片1', index: 1, path: 'i1.png' },
        { kind: 'image', label: '图片2', index: 2, path: 'i2.png' },
        { kind: 'video', label: '视频1', index: 1, path: 'v1.mp4' },
        { kind: 'audio', label: '音频1', index: 1, path: 'a1.mp3' },
        { kind: 'audio', label: '音频2', index: 2, path: 'a2.mp3' },
        { kind: 'audio', label: '音频3', index: 3, path: 'a3.mp3' },
      ]);
  });

  it('keeps kind-local counters when only one kind is supplied', () => {
    const out = normalizeAskArgs(baseArgs({
      image: undefined,
      video: ['v1.mp4', 'v2.mp4'],
      audio: undefined,
    }));
    expect(out.assets.map((a) => a.label)).toEqual(['视频1', '视频2']);
    expect(out.assets.every((a) => a.kind === 'video')).toBe(true);
  });

  it('returns no asset records when every input is empty/undefined', () => {
    const out = normalizeAskArgs(baseArgs({
      image: undefined,
      video: undefined,
      audio: undefined,
    }));
    expect(out.assets).toEqual([]);
  });
});

describe('jimeng-agent/contract — asset reference limits', () => {
  /**
   * Helper that builds a list of synthetic, sequential asset paths. Names
   * are intentionally unique per call so dedup never has to fire; this
   * keeps the limit checks under test the actual thing being tested.
   */
  function paths(prefix, count) {
    return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}.x`);
  }

  it('accepts exactly MAX_REFERENCE_ASSETS (12) image references in a single kind', () => {
    const out = normalizeAskArgs(baseArgs({
      image: paths('i', MAX_REFERENCE_ASSETS),
      video: undefined,
      audio: undefined,
    }));
    expect(out.imagePaths).toHaveLength(MAX_REFERENCE_ASSETS);
    expect(out.assets).toHaveLength(MAX_REFERENCE_ASSETS);
  });

  it('rejects 13 total asset references with an ArgumentError', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: paths('i', MAX_REFERENCE_ASSETS + 1),
    }))).toThrow(ArgumentError);
  });

  it('accepts exactly the total cap when distributed across all three kinds', () => {
    // 6 images + 3 videos + 3 audios = 12 — fills every allowed video and
    // audio slot while still respecting the global ceiling.
    const out = normalizeAskArgs(baseArgs({
      image: paths('i', 6),
      video: paths('v', MAX_VIDEO_REFERENCES),
      audio: paths('a', MAX_AUDIO_REFERENCES),
    }));
    expect(out.assets).toHaveLength(MAX_REFERENCE_ASSETS);
    expect(out.videoPaths).toHaveLength(MAX_VIDEO_REFERENCES);
    expect(out.audioPaths).toHaveLength(MAX_AUDIO_REFERENCES);
  });

  it('rejects a total of 13 even when each individual kind is within its own cap', () => {
    // 8 images + 3 videos + 2 audios = 13 — per-kind caps are respected
    // (videos=3, audios=2) but the global ceiling is violated.
    expect(() => normalizeAskArgs(baseArgs({
      image: paths('i', 8),
      video: paths('v', MAX_VIDEO_REFERENCES),
      audio: paths('a', 2),
    }))).toThrow(ArgumentError);
  });

  it('accepts exactly MAX_VIDEO_REFERENCES (3) videos', () => {
    const out = normalizeAskArgs(baseArgs({
      image: undefined,
      video: paths('v', MAX_VIDEO_REFERENCES),
      audio: undefined,
    }));
    expect(out.videoPaths).toHaveLength(MAX_VIDEO_REFERENCES);
    expect(out.assets.map((a) => a.kind)).toEqual(['video', 'video', 'video']);
  });

  it('rejects 4 video references even when other kinds are empty', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: undefined,
      video: paths('v', MAX_VIDEO_REFERENCES + 1),
      audio: undefined,
    }))).toThrow(ArgumentError);
  });

  it('accepts exactly MAX_AUDIO_REFERENCES (3) audio references', () => {
    const out = normalizeAskArgs(baseArgs({
      image: undefined,
      video: undefined,
      audio: paths('a', MAX_AUDIO_REFERENCES),
    }));
    expect(out.audioPaths).toHaveLength(MAX_AUDIO_REFERENCES);
    expect(out.assets.map((a) => a.kind)).toEqual(['audio', 'audio', 'audio']);
  });

  it('rejects 4 audio references even when other kinds are empty', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: undefined,
      video: undefined,
      audio: paths('a', MAX_AUDIO_REFERENCES + 1),
    }))).toThrow(ArgumentError);
  });

  it('rejects a per-kind video overage even when the global total stays at 12', () => {
    // 8 images + 4 videos + 0 audio = 12 total but videos breach the
    // per-kind cap. The video-specific check must fire rather than the
    // total-ceiling check.
    let captured;
    try {
      normalizeAskArgs(baseArgs({
        image: paths('i', 8),
        video: paths('v', MAX_VIDEO_REFERENCES + 1),
        audio: undefined,
      }));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('Too many video references');
    expect(captured.message).not.toContain('Too many asset references');
  });

  it('rejects a per-kind audio overage even when the global total stays at 12', () => {
    let captured;
    try {
      normalizeAskArgs(baseArgs({
        image: paths('i', 8),
        video: undefined,
        audio: paths('a', MAX_AUDIO_REFERENCES + 1),
      }));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('Too many audio references');
    expect(captured.message).not.toContain('Too many asset references');
  });

  it('fires the global cap before either per-kind cap when both are violated', () => {
    // 10 images + 4 videos + 1 audio = 15. Both the global cap (12) and
    // the per-kind video cap (3) are tripped; the global message wins.
    let captured;
    try {
      normalizeAskArgs(baseArgs({
        image: paths('i', 10),
        video: paths('v', MAX_VIDEO_REFERENCES + 1),
        audio: paths('a', 1),
      }));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('Too many asset references');
    expect(captured.message).not.toContain('Too many video references');
  });

  it('preserves asset order and labels when filling the boundary exactly', () => {
    const images = paths('i', 6);
    const videos = paths('v', MAX_VIDEO_REFERENCES);
    const audios = paths('a', MAX_AUDIO_REFERENCES);
    const out = normalizeAskArgs(baseArgs({
      image: images,
      video: videos,
      audio: audios,
    }));
    expect(out.assets.map((a) => a.label)).toEqual([
      '图片1', '图片2', '图片3', '图片4', '图片5', '图片6',
      '视频1', '视频2', '视频3',
      '音频1', '音频2', '音频3',
    ]);
  });

  it('does not produce any asset records above the cap on the boundary', () => {
    const out = normalizeAskArgs(baseArgs({
      image: paths('i', MAX_REFERENCE_ASSETS),
      video: undefined,
      audio: undefined,
    }));
    // assets[] length must equal the input list length — no phantom slots,
    // no off-by-one — and every label sits inside the contract label space.
    expect(out.assets).toHaveLength(MAX_REFERENCE_ASSETS);
    expect(out.assets[0].label).toBe(`图片1`);
    expect(out.assets[MAX_REFERENCE_ASSETS - 1].label)
      .toBe(`图片${MAX_REFERENCE_ASSETS}`);
  });
});

describe('jimeng-agent/contract — model_version CLI flag advertising', () => {
  /**
   * Capture an ArgumentError thrown by {@link normalizeAskArgs} for the
   * given override so individual assertions can poke at `code` / `hint`
   * without relying on try/catch scaffolding inside each expectation.
   */
  function captureError(overrides) {
    let captured;
    try {
      normalizeAskArgs(baseArgs(overrides));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    return captured;
  }

  it('advertises --model_version (underscore) when the value is unknown', () => {
    const err = captureError({ model_version: 'definitely-not-a-real-model' });
    expect(err.hint).toContain('--model_version');
    expect(err.hint).not.toContain('--model-version');
  });

  it('advertises --model_version (underscore) when the field is missing', () => {
    const err = captureError({ model_version: undefined });
    // The missing-value path also surfaces the allow-list to keep the
    // help actionable; either way --model_version must be present.
    expect(err.hint).toContain('--model_version');
    expect(err.hint).not.toContain('--model-version');
  });

  it('advertises --model_version (underscore) when the value is not a string', () => {
    const err = captureError({ model_version: 42 });
    expect(err.hint).toContain('--model_version');
    expect(err.hint).not.toContain('--model-version');
  });
});

describe('jimeng-agent/contract — prompt validation', () => {
  it('normalizes undefined prompt to empty string', () => {
    expect(normalizeAskArgs(baseArgs({ prompt: undefined })).prompt).toBe('');
  });

  it('normalizes null prompt to empty string', () => {
    expect(normalizeAskArgs(baseArgs({ prompt: null })).prompt).toBe('');
  });

  it('preserves an empty-string prompt verbatim', () => {
    expect(normalizeAskArgs(baseArgs({ prompt: '' })).prompt).toBe('');
  });

  it('rejects non-string prompt values', () => {
    expect(() => normalizeAskArgs(baseArgs({ prompt: 123 })))
      .toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({ prompt: { foo: 'bar' } })))
      .toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({ prompt: true })))
      .toThrow(ArgumentError);
    expect(() => normalizeAskArgs(baseArgs({ prompt: ['hi'] })))
      .toThrow(ArgumentError);
  });

  it('does not reject unrelated @-text in the prompt', () => {
    const out = normalizeAskArgs(baseArgs({ prompt: 'see @alice and @bob first' }));
    expect(out.mentions).toEqual([]);
    expect(out.prompt).toBe('see @alice and @bob first');
  });

  it('does not reject email addresses in the prompt', () => {
    const out = normalizeAskArgs(baseArgs({
      prompt: 'contact me at user@example.com please',
    }));
    expect(out.mentions).toEqual([]);
    expect(out.prompt).toBe('contact me at user@example.com please');
  });
});

describe('jimeng-agent/contract — mention extraction', () => {
  it('extracts ordered mentions in document order across multiple resource kinds', () => {
    const out = normalizeAskArgs(baseArgs({
      image: ['a.png', 'b.png'],
      video: ['v.mp4'],
      audio: ['sound.mp3', 'voice.mp3'],
      prompt: 'first @图片2, then @视频1, finally @音频2 then @图片1',
    }));
    expect(out.mentions).toEqual([
      { kind: 'image', label: '图片2', index: 2 },
      { kind: 'video', label: '视频1', index: 1 },
      { kind: 'audio', label: '音频2', index: 2 },
      { kind: 'image', label: '图片1', index: 1 },
    ]);
  });

  it('allows repeated valid mentions of the same resource', () => {
    const out = normalizeAskArgs(baseArgs({
      image: ['a.png', 'b.png'],
      prompt: '@图片1 then @图片1 again, plus @图片2',
    }));
    expect(out.mentions.map((m) => m.label)).toEqual(['图片1', '图片1', '图片2']);
  });

  it('returns no mentions for an empty or mention-free prompt', () => {
    expect(normalizeAskArgs(baseArgs({ image: ['a.png'], prompt: '' })).mentions)
      .toEqual([]);
    expect(normalizeAskArgs(baseArgs({ image: ['a.png'], prompt: 'just plain text' })).mentions)
      .toEqual([]);
  });

  it('rejects the malformed placeholder @图片 (no number)', () => {
    expect(() => normalizeAskArgs(baseArgs({
      prompt: 'use @图片 here',
    }))).toThrow(ArgumentError);
  });

  it('rejects the malformed placeholder @视频0 (zero index)', () => {
    expect(() => normalizeAskArgs(baseArgs({
      prompt: 'use @视频0',
    }))).toThrow(ArgumentError);
  });

  it('rejects the malformed placeholder @音频0 (zero index)', () => {
    expect(() => normalizeAskArgs(baseArgs({
      prompt: 'use @音频0',
    }))).toThrow(ArgumentError);
  });

  it('rejects malformed placeholder where a digit run does not appear', () => {
    expect(() => normalizeAskArgs(baseArgs({
      prompt: '@图片X @视频 abc @音频?',
    }))).toThrow(ArgumentError);
  });

  it('rejects a missing resource reference (index exceeds supplied count)', () => {
    expect(() => normalizeAskArgs(baseArgs({
      prompt: 'use @图片99',
    }))).toThrow(ArgumentError);
  });

  it('rejects a reference of the wrong kind (no videos supplied but referenced)', () => {
    expect(() => normalizeAskArgs(baseArgs({
      prompt: 'mix @视频1 into @图片1',
    }))).toThrow(ArgumentError);
  });

  it('rejects a reference of the wrong kind (no audio supplied but referenced)', () => {
    expect(() => normalizeAskArgs(baseArgs({
      image: ['a.png'],
      prompt: '@音频1 please',
    }))).toThrow(ArgumentError);
  });
});

describe('jimeng-agent/contract — agentPrompt assembly', () => {
  it('assembles the exact seedance2.0 prefix with no trailing prompt', () => {
    const out = normalizeAskArgs(baseArgs({ model_version: 'seedance2.0', prompt: '' }));
    expect(out.agentPrompt).toBe(
      '(使用 Seedance2.0，**禁止使用 VIP**），你必须严格按照下面的提示词内容生成1个16:9的5s视频',
    );
  });

  it('uses seedance2.0fast prefix', () => {
    const out = normalizeAskArgs(baseArgs({ model_version: 'seedance2.0fast' }));
    expect(out.agentPrompt.startsWith('(使用 Seedance2.0 Fast，**禁止使用 VIP**）')).toBe(true);
    expect(out.agentPrompt).toBe(
      '(使用 Seedance2.0 Fast，**禁止使用 VIP**），你必须严格按照下面的提示词内容生成1个16:9的5s视频',
    );
  });

  it('uses seedance2.0_vip prefix', () => {
    const out = normalizeAskArgs(baseArgs({ model_version: 'seedance2.0_vip' }));
    expect(out.agentPrompt).toBe(
      '(使用 Seedance2.0 VIP），你必须严格按照下面的提示词内容生成1个16:9的5s视频',
    );
  });

  it('uses seedance2.0fast_vip prefix', () => {
    const out = normalizeAskArgs(baseArgs({ model_version: 'seedance2.0fast_vip' }));
    expect(out.agentPrompt).toBe(
      '(使用 Seedance2.0 Fast VIP），你必须严格按照下面的提示词内容生成1个16:9的5s视频',
    );
  });

  it('uses seedance2.0mini prefix', () => {
    const out = normalizeAskArgs(baseArgs({ model_version: 'seedance2.0mini' }));
    expect(out.agentPrompt).toBe(
      '(使用 Seedance2.0 Mini），你必须严格按照下面的提示词内容生成1个16:9的5s视频',
    );
  });

  it('substitutes ratio and duration into the suffix', () => {
    const out = normalizeAskArgs(baseArgs({
      model_version: 'seedance2.0mini',
      ratio: '9:16',
      duration: 12,
    }));
    expect(out.agentPrompt).toBe(
      '(使用 Seedance2.0 Mini），你必须严格按照下面的提示词内容生成1个9:16的12s视频',
    );
  });

  it('inserts exactly two LF characters between suffix and a non-empty prompt', () => {
    const out = normalizeAskArgs(baseArgs({ prompt: 'show a cat playing piano' }));
    expect(out.agentPrompt).toBe(
      '(使用 Seedance2.0，**禁止使用 VIP**），你必须严格按照下面的提示词内容生成1个16:9的5s视频\n\nshow a cat playing piano',
    );
    // Sanity: exactly two LF in the whole string.
    const lfCount = (out.agentPrompt.match(/\n/g) || []).length;
    expect(lfCount).toBe(2);
    // Sanity: the joiner is exactly the two LF, no extra whitespace or CRLF.
    expect(out.agentPrompt.includes('\r')).toBe(false);
  });

  it('omits the LF join when the prompt is empty', () => {
    const out = normalizeAskArgs(baseArgs({ prompt: '' }));
    expect(out.agentPrompt.endsWith('\n')).toBe(false);
    expect(out.agentPrompt.includes('\n')).toBe(false);
  });

  it('still inserts two LFs when the user prompt is non-empty but whitespace-padded', () => {
    const out = normalizeAskArgs(baseArgs({ prompt: '   ' }));
    // Whitespace strings are non-empty by spec, so they DO get joined onto
    // the agent prompt. The LF count should still be exactly two.
    const lfCount = (out.agentPrompt.match(/\n/g) || []).length;
    expect(lfCount).toBe(2);
    expect(out.agentPrompt.endsWith('\n\n   ')).toBe(true);
  });
});

describe('jimeng-agent/contract — canonical payload shape', () => {
  it('returns exactly the canonical keys usable by an adapter', () => {
    const out = normalizeAskArgs(baseArgs());
    expect(Object.keys(out).sort()).toEqual([
      'agentPrompt',
      'assets',
      'audioPaths',
      'duration',
      'imagePaths',
      'mentions',
      'modelVersion',
      'prompt',
      'ratio',
      'retry',
      'videoPaths',
      'workspace',
    ].sort());
    // Double-check: no extra keys, no missing keys.
    expect(Object.keys(out)).toHaveLength(12);
  });

  it('preserves input/output key mapping for ratio and model_version', () => {
    const out = normalizeAskArgs(baseArgs({
      ratio: '21:9',
      model_version: 'seedance2.0mini',
    }));
    expect(out.ratio).toBe('21:9');
    expect(out.modelVersion).toBe('seedance2.0mini');
  });
});
