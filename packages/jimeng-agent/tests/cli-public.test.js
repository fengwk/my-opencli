import { describe, expect, it } from 'vitest';

import {
  cliColumns,
  fromCliArgs,
  kebabCase,
  toCliRow,
  toCliRows,
} from '../src/cli-public.js';

describe('jimeng-agent/cli-public', () => {
  it('converts camelCase and snake_case names to kebab-case', () => {
    expect(kebabCase('assetId')).toBe('asset-id');
    expect(kebabCase('downloadUrl')).toBe('download-url');
    expect(kebabCase('model_version')).toBe('model-version');
    expect(kebabCase('max_pages')).toBe('max-pages');
    expect(kebabCase('status')).toBe('status');
  });

  it('maps kebab CLI kwargs onto the internal snake_case keys', () => {
    expect(fromCliArgs({
      canvas: 'new',
      'model-version': 'seedance2.0fast',
      'asset-id': 'aaaaaaaaaaaaaaaa',
      'search-key': 'aaaaaaaaaaaaaaaa',
      'max-pages': 20,
    })).toMatchObject({
      canvas: 'new',
      model_version: 'seedance2.0fast',
      asset_id: 'aaaaaaaaaaaaaaaa',
      search_key: 'aaaaaaaaaaaaaaaa',
      max_pages: 20,
    });
  });

  it('emits kebab-case row keys for the public CLI surface', () => {
    expect(toCliRow({
      assetId: 'aaaaaaaaaaaaaaaa',
      downloadUrl: 'https://example/video.mp4',
      checkpointOk: true,
      projectId: 'proj',
    })).toEqual({
      'asset-id': 'aaaaaaaaaaaaaaaa',
      'download-url': 'https://example/video.mp4',
      'checkpoint-ok': true,
      'project-id': 'proj',
    });
    expect(cliColumns(['assetId', 'downloadUrl'])).toEqual(['asset-id', 'download-url']);
    expect(toCliRows([{ searchKey: 'abc' }])).toEqual([{ 'search-key': 'abc' }]);
  });
});
