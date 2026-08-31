import { describe, expect, it } from 'vitest';
import {
  guessExtension,
  hasMediaLikeFileExtension,
  isDirectMediaResponse,
  isHtmlDocumentBytes,
  resolveSuggestedFileName,
} from '../src/media-utils.js';

describe('media utils', () => {
  it('treats explicit media URLs as media-like, not html pages', () => {
    expect(hasMediaLikeFileExtension('https://cdn.example.com/a.pdf?x=1')).toBe(true);
    expect(hasMediaLikeFileExtension('https://cdn.example.com/a.png')).toBe(true);
    expect(hasMediaLikeFileExtension('https://example.com/article')).toBe(false);
    expect(hasMediaLikeFileExtension('https://example.com/index.html')).toBe(false);
  });

  it('accepts attachment and binary media responses', () => {
    expect(isDirectMediaResponse('application/pdf', '', 'https://x/a.pdf')).toBe(true);
    expect(isDirectMediaResponse('application/octet-stream', 'attachment; filename="a.bin"', 'https://x/a')).toBe(true);
    expect(isDirectMediaResponse('application/zip', '', 'https://x/a.zip')).toBe(true);
    expect(isDirectMediaResponse('application/zip', '', 'https://x/download')).toBe(true);
    expect(isDirectMediaResponse('image/svg+xml; charset=utf-8', '', 'https://x/a.svg')).toBe(true);
    expect(isDirectMediaResponse('application/json', '', 'https://x/a.json')).toBe(false);
    expect(isDirectMediaResponse('application/json', 'attachment; filename="a.json"', 'https://x/a.json')).toBe(true);
    expect(isDirectMediaResponse('text/html', '', 'https://x/a')).toBe(false);
    expect(isDirectMediaResponse('text/html', '', 'https://x/a.zip')).toBe(false);
    expect(isDirectMediaResponse('text/html', 'attachment; filename="a.pdf"', 'https://x/a.pdf')).toBe(false);
  });

  it('prefers filename* from content-disposition', () => {
    expect(resolveSuggestedFileName(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf; filename=\"report.pdf\"",
      'https://x/a.pdf',
    )).toBe('报告.pdf');
    expect(resolveSuggestedFileName(
      "attachment; filename*=ISO-8859-1''caf%E9.pdf",
      'https://x/a.pdf',
    )).toBe('café.pdf');
    expect(resolveSuggestedFileName(
      "attachment; filename*=UTF-8''safe%0Aname.pdf",
      'https://x/a.pdf',
    )).toBe('safename.pdf');
  });

  it('rejects html bodies even when the URL looks like media', () => {
    expect(isHtmlDocumentBytes(Buffer.from('<!DOCTYPE html><html><body>hi</body></html>'))).toBe(true);
    expect(isHtmlDocumentBytes(Buffer.from('<!-- proxy --> <html>failed</html>'))).toBe(true);
    expect(isHtmlDocumentBytes(Buffer.from('%PDF-1.7'))).toBe(false);
  });

  it('preserves known filename extensions for downloaded artifacts', () => {
    expect(guessExtension('application/zip', 'archive.zip')).toBe('.zip');
    expect(guessExtension('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx'))
      .toBe('.docx');
    expect(guessExtension('text/csv', '')).toBe('.csv');
    expect(guessExtension('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '')).toBe('.xlsx');
    expect(guessExtension('video/quicktime; charset=binary', '')).toBe('.mov');
  });
});
