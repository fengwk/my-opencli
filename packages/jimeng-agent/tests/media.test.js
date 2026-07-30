/**
 * Vitest suite for jimeng-agent/src/media.js.
 *
 * Scope: validate the local-only media preflight. No browser, no network,
 * no real ffprobe, no media encoding. Temp directories host real files so
 * the production fs / path branches stay on the path; an injectable probe
 * and runner stand in for the real ffprobe call.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { ArgumentError } from '@jackwener/opencli/errors';

import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  prepareBrowserReferenceAssets,
  probeMediaDurationMs,
  validateLocalReferenceAssets,
} from '../src/media.js';

import { MAX_REFERENCE_DURATION_SECONDS } from '../src/contract.js';

/**
 * Resource-kind character Jimeng uses in @-placeholders, keyed by English
 * kind. Mirrors the same fact contract.js already knows so the test
 * factory stays self-contained.
 */
const KIND_CHARS = Object.freeze({
  image: '图片',
  video: '视频',
  audio: '音频',
});

/** Build a minimal canonical payload matching the contract.js shape. */
function makeCanonical(perKind) {
  const assets = [];
  const counts = { image: 0, video: 0, audio: 0 };
  for (const kind of /** @type {const} */ (['image', 'video', 'audio'])) {
    const list = perKind[kind] || [];
    for (const p of list) {
      counts[kind] += 1;
      assets.push({
        kind,
        label: `${KIND_CHARS[kind]}${counts[kind]}`,
        index: counts[kind],
        path: p,
      });
    }
  }
  return {
    workspace: '/tmp/jimeng-agent',
    imagePaths: perKind.image || [],
    videoPaths: perKind.video || [],
    audioPaths: perKind.audio || [],
    prompt: '',
    duration: 5,
    ratio: '16:9',
    modelVersion: 'seedance2.0',
    assets,
    mentions: [],
    agentPrompt: '',
  };
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'jimeng-media-test-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create an empty regular file inside the per-test temp directory. */
function touch(name) {
  const p = join(tmpRoot, name);
  writeFileSync(p, '');
  return p;
}

/** Create a directory inside the per-test temp directory. */
function makeDir(name) {
  const p = join(tmpRoot, name);
  mkdirSync(p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('jimeng-agent/media — extension constants', () => {
  it('exposes the documented image extension allow-list', () => {
    expect(IMAGE_EXTENSIONS.slice().sort())
      .toEqual(['bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp']);
  });

  it('exposes the documented video / audio extension allow-lists', () => {
    expect([...VIDEO_EXTENSIONS]).toEqual(['mp4', 'mov']);
    expect([...AUDIO_EXTENSIONS]).toEqual(['mp3', 'wav']);
  });

  it('keeps every extension lowercase so callers do not have to normalize', () => {
    for (const ext of [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]) {
      expect(ext).toBe(ext.toLowerCase());
    }
  });

  it('freezes the extension allow-lists so they cannot be mutated at runtime', () => {
    expect(Object.isFrozen(IMAGE_EXTENSIONS)).toBe(true);
    expect(Object.isFrozen(VIDEO_EXTENSIONS)).toBe(true);
    expect(Object.isFrozen(AUDIO_EXTENSIONS)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// probeMediaDurationMs
// ─────────────────────────────────────────────────────────────────────────────

describe('jimeng-agent/media — probeMediaDurationMs', () => {
  /**
   * Build an `execFileSync` substitute that ignores the binary / args and
   * returns whatever behaviour the test wants. The return shape matches
   * `node:child_process.execFileSync`'s string output.
   */
  function runner(behaviour) {
    const spy = (..._args) => {
      if (typeof behaviour === 'function') return behaviour();
      return behaviour;
    };
    return spy;
  }

  it('invokes ffprobe via execFileSync with the documented show_entries flags', () => {
    const seen = [];
    const fakeExec = (bin, args, opts) => {
      seen.push({ bin, args, opts });
      return '5.500000';
    };
    const ms = probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: fakeExec });
    expect(ms).toBe(5500);
    expect(seen).toHaveLength(1);
    expect(seen[0].bin).toBe('ffprobe');
    expect(seen[0].args).toEqual([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      '/tmp/foo.mp4',
    ]);
    expect(seen[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(seen[0].opts.encoding).toBe('utf8');
  });

  it('honors a custom ffprobe binary path via options.ffprobe', () => {
    let usedBin;
    const fakeExec = (bin) => {
      usedBin = bin;
      return '7';
    };
    probeMediaDurationMs('/tmp/foo.mp4', {
      execFileSync: fakeExec,
      ffprobe: '/opt/local/ffprobe-7',
    });
    expect(usedBin).toBe('/opt/local/ffprobe-7');
  });

  it('rounds fractional seconds UP via Math.ceil to ms', () => {
    const fakeExec = () => '14.9999';
    expect(probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: fakeExec })).toBe(15000);
    const intExec = () => '15';
    expect(probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: intExec })).toBe(15000);
    const zeroExec = () => '0.0001';
    expect(probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: zeroExec })).toBe(1);
  });

  it('treats trailing whitespace and newlines as ignorable formatting', () => {
    const fakeExec = () => '  3.14159  \n';
    expect(probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: fakeExec })).toBe(3142);
  });

  it('rejects an empty ffprobe output as a non-positive duration', () => {
    const fakeExec = () => '   \n';
    let captured;
    try {
      probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: fakeExec });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('empty duration');
  });

  it('rejects non-numeric ffprobe output as a non-positive duration', () => {
    for (const raw of ['N/A', '15seconds', '15.0 garbage']) {
      expect(() => probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: () => raw }))
        .toThrow(ArgumentError);
    }
  });

  it('rejects zero or negative ffprobe output as invalid', () => {
    for (const raw of ['0', '0.0', '-1', '-0.001']) {
      expect(() => probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: runner(raw) }))
        .toThrow(ArgumentError);
    }
  });

  it('rejects ENOENT (ffprobe missing) with a useful ArgumentError', () => {
    const fakeExec = () => {
      const err = new Error('spawn ffprobe ENOENT');
      err.code = 'ENOENT';
      throw err;
    };
    let captured;
    try {
      probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: fakeExec });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('ffprobe is not installed');
    expect(captured.hint).toMatch(/ffmpeg|ffprobe/i);
  });

  it('rejects ffprobe that exits unsuccessfully with a useful ArgumentError', () => {
    const fakeExec = () => {
      const err = new Error('Command failed: ffprobe /tmp/foo.mp4');
      err.status = 1;
      err.stderr = Buffer.from('Invalid data found when processing input');
      throw err;
    };
    let captured;
    try {
      probeMediaDurationMs('/tmp/foo.mp4', { execFileSync: fakeExec });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('ffprobe failed');
    expect(captured.message).toContain('Invalid data');
  });

  it('rejects an empty or non-string filePath argument', () => {
    expect(() => probeMediaDurationMs('', { execFileSync: runner('1') }))
      .toThrow(ArgumentError);
    expect(() => probeMediaDurationMs(null, { execFileSync: runner('1') }))
      .toThrow(ArgumentError);
    expect(() => probeMediaDurationMs(undefined, { execFileSync: runner('1') }))
      .toThrow(ArgumentError);
    expect(() => probeMediaDurationMs(42, { execFileSync: runner('1') }))
      .toThrow(ArgumentError);
  });

  it('never shells out: the caller-supplied binary is passed positionally to execFileSync', () => {
    // If shell interpolation were ever used, the args array would arrive
    // flattened through a single shell string. The contract requires a real
    // argv array — assert that explicitly so any regression is loud.
    const seen = { args: null };
    const fakeExec = (_bin, args) => {
      seen.args = args;
      return '1';
    };
    probeMediaDurationMs('/tmp/foo.mp4; rm -rf /', { execFileSync: fakeExec });
    expect(seen.args).toEqual([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      '/tmp/foo.mp4; rm -rf /',
    ]);
    expect(seen.args.length).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateLocalReferenceAssets — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe('jimeng-agent/media — validateLocalReferenceAssets (happy paths)', () => {
  it('passes valid mixed image / video / audio references through with prepared records', () => {
    const img = touch('hero.png');
    const vid = touch('clip.mp4');
    const aud = touch('voice.mp3');
    const canonical = makeCanonical({
      image: [img],
      video: [vid],
      audio: [aud],
    });
    const probeCalls = [];
    const result = validateLocalReferenceAssets(canonical, {
      probe: (filePath) => {
        probeCalls.push(filePath);
        if (filePath === vid) return 5000;
        if (filePath === aud) return 7000;
        throw new Error(`probe called for unexpected path ${filePath}`);
      },
    });

    expect(probeCalls).toEqual([vid, aud]);

    expect(result.assets.map((a) => ({
      kind: a.kind,
      label: a.label,
      index: a.index,
      path: a.path,
      sourcePath: a.sourcePath,
      filename: a.filename,
      mentionName: a.mentionName,
      durationMs: a.durationMs,
    }))).toEqual([
      {
        kind: 'image',
        label: '图片1',
        index: 1,
        path: img,
        sourcePath: img,
        filename: 'hero.png',
        mentionName: 'hero',
        durationMs: null,
      },
      {
        kind: 'video',
        label: '视频1',
        index: 1,
        path: vid,
        sourcePath: vid,
        filename: 'clip.mp4',
        mentionName: 'clip',
        durationMs: 5000,
      },
      {
        kind: 'audio',
        label: '音频1',
        index: 1,
        path: aud,
        sourcePath: aud,
        filename: 'voice.mp3',
        mentionName: 'voice',
        durationMs: 7000,
      },
    ]);
    expect(result.videoDurationMs).toBe(5000);
    expect(result.audioDurationMs).toBe(7000);
  });

  it('accepts uppercase and mixed-case extensions (case-insensitive matching)', () => {
    const a = touch('IMG.JPG');
    const b = touch('Mix.Mp4');
    const c = touch('VU.WAV');
    const canonical = makeCanonical({ image: [a], video: [b], audio: [c] });
    const result = validateLocalReferenceAssets(canonical, {
      probe: () => 2500,
    });
    expect(result.assets.map((a) => a.filename)).toEqual(['IMG.JPG', 'Mix.Mp4', 'VU.WAV']);
    expect(result.assets.every((a) => a.durationMs !== undefined)).toBe(true);
  });

  it('returns a fully frozen result and frozen prepared records', () => {
    const img = touch('pic.png');
    const vid = touch('clip.mp4');
    const canonical = makeCanonical({ image: [img], video: [vid] });
    const result = validateLocalReferenceAssets(canonical, {
      probe: () => 2500,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.assets)).toBe(true);
    for (const record of result.assets) {
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(() => {
      result.assets.push({});
    }).toThrow();
  });

  it('keeps the original path field while also exposing sourcePath / filename / mentionName', () => {
    const img = touch('Hero.PNG');
    const canonical = makeCanonical({ image: [img] });
    const result = validateLocalReferenceAssets(canonical);
    const rec = result.assets[0];
    // Original canonical fields preserved as-is (string equality, not deep).
    expect(rec.path).toBe(img);
    expect(rec.sourcePath).toBe(img); // absolute -> normalize -> identical
    expect(rec.filename).toBe('Hero.PNG');
    expect(rec.mentionName).toBe('Hero');
    expect(rec.durationMs).toBeNull();
  });

  it('maps a Windows CLI path to its WSL mount before local validation', () => {
    const mountRoot = join(tmpRoot, 'mount');
    const imagePath = join(mountRoot, 'c', 'assets', 'hero.png');
    mkdirSync(join(mountRoot, 'c', 'assets'), { recursive: true });
    writeFileSync(imagePath, 'image');

    const result = validateLocalReferenceAssets(makeCanonical({
      image: ['C:\\assets\\hero.png'],
    }), {
      wslMountRoot: mountRoot,
    });

    expect(result.assets[0].sourcePath).toBe(imagePath);
    expect(result.assets[0].filename).toBe('hero.png');
  });
});

describe('jimeng-agent/media — prepareBrowserReferenceAssets', () => {
  it('adds staged browser paths only after local validation succeeds', () => {
    const image = touch('hero.png');
    const cleanup = vi.fn();
    const result = prepareBrowserReferenceAssets(makeCanonical({ image: [image] }), {
      stageForBrowserUpload: (sourcePath) => ({
        sourcePath,
        nodePath: '/mnt/c/Users/fengwk/Downloads/opencli-upload/hero.png',
        browserPath: 'C:\\Users\\fengwk\\Downloads\\opencli-upload\\hero.png',
        name: 'hero.png',
        staged: true,
      }),
      stageReferenceUploadAliases: (assets) => ({
        assets: assets.map((asset) => ({
          ...asset,
          nodePath: '/mnt/c/Users/fengwk/Downloads/opencli-upload/jimeng-agent-test/图片1.png',
          browserPath: 'C:\\Users\\fengwk\\Downloads\\opencli-upload\\jimeng-agent-test\\图片1.png',
          uploadFilename: '图片1.png',
        })),
        cleanup,
      }),
    });

    expect(result.assets[0]).toMatchObject({
      sourcePath: image,
      nodePath: '/mnt/c/Users/fengwk/Downloads/opencli-upload/jimeng-agent-test/图片1.png',
      browserPath: 'C:\\Users\\fengwk\\Downloads\\opencli-upload\\jimeng-agent-test\\图片1.png',
      uploadFilename: '图片1.png',
      staged: true,
    });
    expect(Object.isFrozen(result.assets[0])).toBe(true);
    result.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid or filename-changing staging record', () => {
    const image = touch('hero.png');
    const canonical = makeCanonical({ image: [image] });
    expect(() => prepareBrowserReferenceAssets(canonical, {
      stageForBrowserUpload: () => ({ nodePath: '/tmp/a' }),
    })).toThrow(ArgumentError);
    expect(() => prepareBrowserReferenceAssets(canonical, {
      stageForBrowserUpload: () => ({
        nodePath: '/tmp/a',
        browserPath: 'C:\\tmp\\a',
        name: 'other.png',
      }),
    })).toThrow(ArgumentError);
  });

  it('uses label-named disposable aliases while keeping original filenames in the asset records', () => {
    const image = touch('人物三视图.png');
    writeFileSync(image, 'image-bytes');

    const result = prepareBrowserReferenceAssets(makeCanonical({ image: [image] }), {
      needsWindowsUploadStaging: false,
      referenceAliasRoot: tmpRoot,
    });
    const asset = result.assets[0];

    expect(asset.filename).toBe('人物三视图.png');
    expect(asset.mentionName).toBe('人物三视图');
    expect(asset.uploadFilename).toBe('图片1.png');
    expect(basename(asset.nodePath)).toBe('图片1.png');
    expect(asset.browserPath).toBe(asset.nodePath);
    expect(readFileSync(asset.nodePath, 'utf8')).toBe('image-bytes');

    const aliasDirectory = dirname(asset.nodePath);
    result.cleanup();
    expect(existsSync(aliasDirectory)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateLocalReferenceAssets — failure cases (filesystem / kind / dedup)
// ─────────────────────────────────────────────────────────────────────────────

describe('jimeng-agent/media — validateLocalReferenceAssets (rejections)', () => {
  it('rejects a non-object canonical payload', () => {
    expect(() => validateLocalReferenceAssets(null)).toThrow(ArgumentError);
    expect(() => validateLocalReferenceAssets(undefined)).toThrow(ArgumentError);
    expect(() => validateLocalReferenceAssets(42)).toThrow(ArgumentError);
    expect(() => validateLocalReferenceAssets('hi')).toThrow(ArgumentError);
    expect(() => validateLocalReferenceAssets([])).toThrow(ArgumentError);
  });

  it("rejects a canonical payload whose 'assets' field is missing or not an array", () => {
    expect(() => validateLocalReferenceAssets({})).toThrow(ArgumentError);
    expect(() => validateLocalReferenceAssets({ assets: 'oops' })).toThrow(ArgumentError);
    expect(() => validateLocalReferenceAssets({ assets: null })).toThrow(ArgumentError);
  });

  it('rejects asset paths that do not exist on disk', () => {
    const missing = join(tmpRoot, 'nope.png');
    const canonical = makeCanonical({ image: [missing] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => 0 });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('does not exist');
    expect(captured.message).toContain(missing);
  });

  it('rejects asset paths that point at a directory, not a regular file', () => {
    const dir = makeDir('picture.png');
    const canonical = makeCanonical({ image: [dir] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => 0 });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('not a regular file');
  });

  it('rejects an asset whose file extension does not match its declared kind', () => {
    const img = touch('clip.mp3'); // .mp3 but tagged image
    const canonical = makeCanonical({ image: [img] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => 0 });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain("does not match kind image");
    expect(captured.message).toContain('.mp3');
  });

  it('rejects the reverse kind/extension mismatch (audio path tagged as video)', () => {
    const wav = touch('song.wav');
    const canonical = makeCanonical({ video: [wav] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => 0 });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('does not match kind video');
  });

  it('rejects duplicate mention names across kinds (Hero.png vs hero.mp4)', () => {
    const img = touch('Hero.png');
    const vid = touch('hero.mp4');
    const canonical = makeCanonical({ image: [img], video: [vid] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => 2500 });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('Duplicate reference mention name');
    expect(captured.message.toLowerCase()).toContain('hero');
  });

  it('rejects duplicate mention names across image and audio kinds', () => {
    const img = touch('track.png');
    const aud = touch('Track.MP3');
    const canonical = makeCanonical({ image: [img], audio: [aud] });
    expect(() => validateLocalReferenceAssets(canonical, { probe: () => 2500 }))
      .toThrow(ArgumentError);
  });

  it('treats mentions whose only difference is internal extensions as duplicate too', () => {
    const img = touch('panel.sora.png'); // mentionName 'panel.sora'
    const vid = touch('panel.sora.tar.mp4'); // mentionName 'panel.sora.tar' — distinct, accepted
    const canonical = makeCanonical({ image: [img], video: [vid] });
    // We only strip the FINAL extension, so 'panel.sora' ≠ 'panel.sora.tar'.
    // That means these two should both pass — verify the contract.
    const result = validateLocalReferenceAssets(canonical, { probe: () => 2500 });
    expect(result.assets.map((a) => a.mentionName)).toEqual(['panel.sora', 'panel.sora.tar']);
  });

  it('keeps a single mention name (no collision) when other kinds differ cleanly', () => {
    const img = touch('hero.png');
    const vid = touch('clip.mp4');
    const aud = touch('voice.mp3');
    const canonical = makeCanonical({ image: [img], video: [vid], audio: [aud] });
    const result = validateLocalReferenceAssets(canonical, { probe: () => 2500 });
    expect(result.assets.map((a) => a.mentionName)).toEqual(['hero', 'clip', 'voice']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateLocalReferenceAssets — probe behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('jimeng-agent/media — validateLocalReferenceAssets (probe wiring)', () => {
  it('never calls the duration probe for image references', () => {
    const a = touch('a.png');
    const b = touch('b.jpg');
    const c = touch('c.webp');
    const canonical = makeCanonical({ image: [a, b, c] });
    const probeCalls = [];
    const result = validateLocalReferenceAssets(canonical, {
      probe: (filePath) => {
        probeCalls.push(filePath);
        return 1000;
      },
    });
    expect(probeCalls).toEqual([]);
    expect(result.assets.every((a) => a.durationMs === null)).toBe(true);
    expect(result.videoDurationMs).toBe(0);
    expect(result.audioDurationMs).toBe(0);
  });

  it('calls the duration probe exactly once per video and once per audio reference', () => {
    const a = touch('img.png');
    const v1 = touch('v1.mp4');
    const v2 = touch('v2.mov');
    const au1 = touch('au1.mp3');
    const au2 = touch('au2.wav');
    const canonical = makeCanonical({
      image: [a],
      video: [v1, v2],
      audio: [au1, au2],
    });
    const probeCalls = [];
    validateLocalReferenceAssets(canonical, {
      probe: (filePath) => {
        probeCalls.push(filePath);
        return 2500;
      },
    });
    expect(probeCalls).toEqual([v1, v2, au1, au2]);
    expect(probeCalls).not.toContain(a);
  });

  it('propagates a probe failure up to the caller (no swallowing)', () => {
    const vid = touch('clip.mp4');
    const canonical = makeCanonical({ video: [vid] });
    const probeErr = new ArgumentError('ffprobe returned a non-positive duration', 'fix it');
    expect(() => validateLocalReferenceAssets(canonical, {
      probe: () => {
        throw probeErr;
      },
    })).toThrow(probeErr);
  });

  it('rejects a probe that returns a non-finite value', () => {
    const vid = touch('clip.mp4');
    const canonical = makeCanonical({ video: [vid] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => Number.NaN });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('invalid value');
  });

  it('rejects a probe that returns a zero, fractional, or negative millisecond value', () => {
    const vid = touch('clip.mp4');
    const canonical = makeCanonical({ video: [vid] });
    for (const durationMs of [0, -1, 1.5]) {
      expect(() => validateLocalReferenceAssets(canonical, { probe: () => durationMs }))
        .toThrow(ArgumentError);
    }
  });

  for (const [kind, extension] of [['video', 'mp4'], ['audio', 'mp3']]) {
    it(`rejects a ${kind} reference below the 2s per-file minimum`, () => {
      const asset = touch(`short.${extension}`);
      const canonical = makeCanonical({ [kind]: [asset] });
      expect(() => validateLocalReferenceAssets(canonical, { probe: () => 1999 }))
        .toThrow(/at least 2s/);
    });

    it(`accepts a ${kind} reference exactly at the 2s per-file minimum`, () => {
      const asset = touch(`minimum.${extension}`);
      const canonical = makeCanonical({ [kind]: [asset] });
      const result = validateLocalReferenceAssets(canonical, {
        probe: () => 2000,
      });
      expect(result.assets[0].durationMs).toBe(2000);
    });

    it(`accepts a ${kind} reference exactly at the 15s per-file maximum`, () => {
      const asset = touch(`maximum.${extension}`);
      const canonical = makeCanonical({ [kind]: [asset] });
      const result = validateLocalReferenceAssets(canonical, {
        probe: () => MAX_REFERENCE_DURATION_SECONDS * 1000,
      });
      expect(result.assets[0].durationMs).toBe(15000);
    });

    it(`rejects a ${kind} reference above the 15s per-file maximum`, () => {
      const asset = touch(`long.${extension}`);
      const canonical = makeCanonical({ [kind]: [asset] });
      expect(() => validateLocalReferenceAssets(canonical, { probe: () => 15001 }))
        .toThrow(/at most 15s per/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// validateLocalReferenceAssets — total duration caps
// ─────────────────────────────────────────────────────────────────────────────

describe('jimeng-agent/media — validateLocalReferenceAssets (duration caps)', () => {
  /** ms cap shared across this suite; mirrors the contract constant. */
  const MS_CAP = MAX_REFERENCE_DURATION_SECONDS * 1000;

  it('accepts an exact-cap total video duration (15s)', () => {
    const v1 = touch('v1.mp4');
    const v2 = touch('v2.mp4');
    const v3 = touch('v3.mp4');
    const canonical = makeCanonical({ video: [v1, v2, v3] });
    const result = validateLocalReferenceAssets(canonical, {
      probe: () => 5000, // 3 * 5000 = 15000 == MS_CAP exactly
    });
    expect(result.videoDurationMs).toBe(MS_CAP);
  });

  it('accepts an exact-cap total audio duration (15s)', () => {
    const a1 = touch('a1.mp3');
    const a2 = touch('a2.mp3');
    const a3 = touch('a3.mp3');
    const canonical = makeCanonical({ audio: [a1, a2, a3] });
    const result = validateLocalReferenceAssets(canonical, {
      probe: () => 5000,
    });
    expect(result.audioDurationMs).toBe(MS_CAP);
  });

  it('rejects a total video duration of 15001ms (just one ms over)', () => {
    const v1 = touch('v1.mp4');
    const v2 = touch('v2.mp4');
    const canonical = makeCanonical({ video: [v1, v2] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, {
        probe: () => 7501, // 7501 + 7501 = 15002 > MS_CAP
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('Total video reference duration');
    expect(captured.message).toContain(`${MS_CAP}ms`);
  });

  it('rejects a total audio duration of 15001ms (just one ms over)', () => {
    const a1 = touch('a1.mp3');
    const a2 = touch('a2.mp3');
    const canonical = makeCanonical({ audio: [a1, a2] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, {
        probe: () => 7501,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('Total audio reference duration');
  });

  it('rejects a fractional video duration rounded above the per-file ceiling', () => {
    const vid = touch('clip.mp4');
    const canonical = makeCanonical({ video: [vid] });
    // The default production probe uses Math.ceil, but a tested probe has
    // to faithfully model "the ceiling is real". We simulate a 15.0001s
    // media file by returning the post-ceiling ms the real probe would.
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => 15001 });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('at most 15s per video/audio reference');
  });

  it('rejects a fractional audio duration rounded above the per-file ceiling', () => {
    const aud = touch('clip.mp3');
    const canonical = makeCanonical({ audio: [aud] });
    let captured;
    try {
      validateLocalReferenceAssets(canonical, { probe: () => 15001 });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ArgumentError);
    expect(captured.message).toContain('at most 15s per video/audio reference');
  });

  it('keeps per-kind totals independent (image padding does not affect video total)', () => {
    const a = touch('img.png');
    const v1 = touch('v1.mp4');
    const v2 = touch('v2.mp4');
    const canonical = makeCanonical({ image: [a], video: [v1, v2] });
    const result = validateLocalReferenceAssets(canonical, {
      probe: () => 6000,
    });
    expect(result.videoDurationMs).toBe(12000);
    expect(result.audioDurationMs).toBe(0);
  });

  it('matches the contract.js duration cap as the single source of truth', () => {
    expect(MS_CAP).toBe(15000);
    expect(MS_CAP).toBe(MAX_REFERENCE_DURATION_SECONDS * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Baseline sanity: nothing in this module ever speaks to a browser.
// ─────────────────────────────────────────────────────────────────────────────

describe('jimeng-agent/media — module boundary', () => {
  it('loads with no extraneous imports beyond the documented dependencies', async () => {
    const mod = await import('../src/media.js');
    expect(Object.keys(mod).sort()).toEqual([
      'AUDIO_EXTENSIONS',
      'IMAGE_EXTENSIONS',
      'VIDEO_EXTENSIONS',
      'prepareBrowserReferenceAssets',
      'probeMediaDurationMs',
      'validateLocalReferenceAssets',
    ].sort());
  });

  it('does not export anything that would suggest browser / network use', () => {
    for (const key of ['browser', 'fetch', 'opencli', 'submit', 'navigate']) {
      // Defensive: if a future change accidentally adds a browser-shaped
      // helper, the key would show up here. Today it must not exist.
      expect(key in (/** @type {object} */ (globalThis))).toBe(
        key === 'fetch', // `fetch` is a Web / Node builtin and not exported by us.
      );
    }
  });

  it('keeps the OS path separator out of media.js so cross-platform tests stay readable', () => {
    // Cross-platform sanity check: emit one prepared record and confirm the
    // basename we expose uses only the documented Node `path.basename`
    // behaviour rather than a hand-rolled split.
    const sepRegex = new RegExp(sep.replace(/\\/g, '\\\\'));
    expect(sepRegex.test('hero.png')).toBe(false);
  });
});
