import { isBlank } from './strings.js';

const ORDERED_LIST_ITEM_PATTERN = /^(\s*)(\d+)\.\s+(.*)$/;
const ORDERED_LIST_MARKER_ONLY_PATTERN = /^(\s*)(\d+)[.)]?$/;
const TABLE_DELIMITER_ROW_PATTERN = /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const BULLET_LIST_ITEM_PATTERN = /^(\s*)[*+-]\s+(.*)$/;
const HTML_COMMENT_FRAGMENT_PATTERN = /\s*<!--(?:.*?)-->\s*/g;
const INLINE_FLATTENED_LIST_MARKER_PATTERN = /(^|\s)(\d+)\s+[*+-]\s+/g;

export class MarkdownPostProcessor {
  process(markdown) {
    if (isBlank(markdown)) {
      return '';
    }
    let normalized = markdown
      .replace(/\r\n/g, '\n')
      .replace(/\uFEFF/g, '')
      .replace(/\u200B/g, '')
      .replace(/\u2060/g, '');
    normalized = this.#removeEmptyLinks(normalized);
    normalized = this.#compactAdjacentImages(normalized);
    normalized = this.#removeStandaloneHtmlComments(normalized);
    normalized = this.#normalizeDetachedOrderedListMarkers(normalized);
    normalized = this.#normalizeTableBlocks(normalized);
    normalized = this.#mergeAdjacentCodeBlocks(normalized);
    normalized = this.#normalizeOrderedListNumbers(normalized);
    let builder = '';
    let previousBlank = true;
    for (const line of splitKeepEmpty(normalized)) {
      const trimmedLine = this.#stripTrailingSpaces(line);
      if (trimmedLine.trim() === '') {
        if (!previousBlank) {
          builder += '\n';
        }
        previousBlank = true;
        continue;
      }
      builder += `${trimmedLine}\n`;
      previousBlank = false;
    }
    return builder.trim();
  }

  #removeEmptyLinks(input) {
    const cleaned = input.replace(/[ \t]*(?<!!)\[\s*\]\([^)]*\)[ \t]*/g, ' ');
    return cleaned.replace(/ {2,}/g, ' ');
  }

  #compactAdjacentImages(input) {
    return input.replace(/\)\s+!\[/g, ')![');
  }

  #removeStandaloneHtmlComments(input) {
    const lines = splitKeepEmpty(input);
    const cleaned = [];
    let inCodeBlock = false;
    for (let line of lines) {
      if (isFenceLine(line)) {
        inCodeBlock = !inCodeBlock;
        cleaned.push(line);
        continue;
      }
      const trimmed = line.trim();
      if (!inCodeBlock && trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
        continue;
      }
      if (!inCodeBlock) {
        line = this.#normalizeInlineCommentAndListNoise(line);
      }
      cleaned.push(line);
    }
    return joinLines(cleaned);
  }

  #normalizeInlineCommentAndListNoise(line) {
    const normalized = line.replace(HTML_COMMENT_FRAGMENT_PATTERN, ' / ');
    let itemIndex = 0;
    const replaced = normalized.replace(INLINE_FLATTENED_LIST_MARKER_PATTERN, (match, prefix) => {
      itemIndex += 1;
      return `${prefix}${itemIndex}. `;
    });
    return replaced.replace(/ {2,}/g, ' ');
  }

  #normalizeDetachedOrderedListMarkers(input) {
    const lines = splitKeepEmpty(input);
    const normalized = [];
    let inCodeBlock = false;
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (isFenceLine(line)) {
        inCodeBlock = !inCodeBlock;
        normalized.push(line);
        index += 1;
        continue;
      }
      if (!inCodeBlock) {
        const markerMatcher = ORDERED_LIST_MARKER_ONLY_PATTERN.exec(line);
        if (markerMatcher) {
          let nextIndex = index + 1;
          while (nextIndex < lines.length && lines[nextIndex].trim() === '') {
            nextIndex += 1;
          }
          if (nextIndex < lines.length) {
            const bulletMatcher = BULLET_LIST_ITEM_PATTERN.exec(lines[nextIndex]);
            if (bulletMatcher) {
              const indent = markerMatcher[1] !== '' ? markerMatcher[1] : bulletMatcher[1];
              normalized.push(`${indent}${markerMatcher[2]}. ${bulletMatcher[2]}`);
              index = nextIndex + 1;
              continue;
            }
          }
        }
      }
      normalized.push(line);
      index += 1;
    }
    return joinLines(normalized);
  }

  #mergeAdjacentCodeBlocks(input) {
    const lines = splitKeepEmpty(input);
    let merged = '';
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!isFenceLine(line)) {
        merged += `${line}\n`;
        index += 1;
        continue;
      }
      const closeIndex = findFenceClose(lines, index + 1);
      if (closeIndex < 0) {
        merged += `${line}\n`;
        index += 1;
        continue;
      }
      const fence = line.trim();
      let content = collectCodeBlockContent(lines, index + 1, closeIndex);
      let nextIndex = closeIndex + 1;
      while (true) {
        const blankStart = nextIndex;
        while (nextIndex < lines.length && lines[nextIndex].trim() === '') {
          nextIndex += 1;
        }
        const blankCount = nextIndex - blankStart;
        if (blankCount > 1 || nextIndex >= lines.length || fence !== lines[nextIndex].trim()) {
          nextIndex = blankStart;
          break;
        }
        const nextClose = findFenceClose(lines, nextIndex + 1);
        if (nextClose < 0) {
          nextIndex = blankStart;
          break;
        }
        if (content.length > 0 && !content.endsWith('\n')) {
          content += '\n';
        }
        content += collectCodeBlockContent(lines, nextIndex + 1, nextClose);
        nextIndex = nextClose + 1;
      }
      merged += `${fence}\n`;
      if (content.length > 0) {
        merged += content;
        if (!content.endsWith('\n')) {
          merged += '\n';
        }
      }
      merged += '```\n';
      if (nextIndex === closeIndex + 1) {
        index = closeIndex + 1;
      } else {
        index = nextIndex;
      }
    }
    return merged;
  }

  #normalizeTableBlocks(input) {
    const lines = splitKeepEmpty(input);
    const normalized = [];
    let inCodeBlock = false;
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (isFenceLine(line)) {
        inCodeBlock = !inCodeBlock;
        normalized.push(line);
        index += 1;
        continue;
      }
      if (!inCodeBlock && isTableishLine(line)) {
        let endExclusive = index;
        while (endExclusive < lines.length && isTableishLine(lines[endExclusive])) {
          endExclusive += 1;
        }
        normalized.push(...this.#normalizeTableBlock(lines.slice(index, endExclusive)));
        index = endExclusive;
        continue;
      }
      normalized.push(line);
      index += 1;
    }
    return joinLines(normalized);
  }

  #normalizeTableBlock(lines) {
    if (lines.length < 2) {
      return lines;
    }

    const nonDelimiterRows = lines
      .filter((line) => !isTableDelimiterRow(line))
      .map((line) => parseTableRow(line))
      .filter((row) => row.cells.length > 0);
    if (nonDelimiterRows.length === 0) {
      return lines;
    }

    const columnCount = Math.max(0, ...nonDelimiterRows.map((row) => row.cells.length));
    if (columnCount <= 0) {
      return lines;
    }

    const normalized = [];
    if (isTableDelimiterRow(lines[0])) {
      const firstDataRow = parseTableRow(lines[1]);
      if (looksLikeHeader(firstDataRow)) {
        normalized.push(renderTableRow(firstDataRow.cells, columnCount));
        normalized.push(renderTableDelimiterRow(columnCount));
        for (let i = 2; i < lines.length; i += 1) {
          if (isTableDelimiterRow(lines[i])) continue;
          normalized.push(renderTableRow(parseTableRow(lines[i]).cells, columnCount));
        }
      } else {
        normalized.push(renderSyntheticHeaderRow(columnCount));
        normalized.push(renderTableDelimiterRow(columnCount));
        for (const line of lines) {
          if (isTableDelimiterRow(line)) continue;
          normalized.push(renderTableRow(parseTableRow(line).cells, columnCount));
        }
      }
      return normalized;
    }

    const headerRow = parseTableRow(lines[0]);
    normalized.push(renderTableRow(headerRow.cells, columnCount));
    normalized.push(renderTableDelimiterRow(columnCount));
    const dataStartIndex = lines.length > 1 && isTableDelimiterRow(lines[1]) ? 2 : 1;
    for (let i = dataStartIndex; i < lines.length; i += 1) {
      if (isTableDelimiterRow(lines[i])) continue;
      normalized.push(renderTableRow(parseTableRow(lines[i]).cells, columnCount));
    }
    return normalized;
  }

  #normalizeOrderedListNumbers(input) {
    const normalized = [];
    const countersByIndent = new Map();
    let inCodeBlock = false;
    for (const line of splitKeepEmpty(input)) {
      if (isFenceLine(line)) {
        inCodeBlock = !inCodeBlock;
        normalized.push(line);
        continue;
      }
      if (inCodeBlock) {
        normalized.push(line);
        continue;
      }
      const matcher = ORDERED_LIST_ITEM_PATTERN.exec(line);
      if (matcher) {
        const indent = matcher[1].length;
        for (const key of [...countersByIndent.keys()]) {
          if (key > indent) countersByIndent.delete(key);
        }
        const normalizedIndex = (countersByIndent.get(indent) || 0) + 1;
        countersByIndent.set(indent, normalizedIndex);
        normalized.push(`${matcher[1]}${normalizedIndex}. ${matcher[3]}`);
        continue;
      }
      const trimmed = line.trim();
      if (trimmed !== '' && !line.startsWith('  ')) {
        countersByIndent.clear();
      }
      normalized.push(line);
    }
    return joinLines(normalized);
  }

  #stripTrailingSpaces(line) {
    let end = line.length;
    while (end > 0) {
      const ch = line[end - 1];
      if (ch === '\n') break;
      if (/\s/.test(ch)) {
        end -= 1;
        continue;
      }
      break;
    }
    return line.slice(0, end);
  }
}

function splitKeepEmpty(input) {
  return String(input).split('\n');
}

function joinLines(lines) {
  return `${lines.join('\n')}\n`;
}

function isFenceLine(line) {
  return line != null && line.trim().startsWith('```');
}

function findFenceClose(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    if (isFenceLine(lines[i])) return i;
  }
  return -1;
}

function collectCodeBlockContent(lines, start, endExclusive) {
  const slice = lines.slice(start, endExclusive);
  return slice.join('\n');
}

function isTableishLine(line) {
  if (line == null) return false;
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 2;
}

function isTableDelimiterRow(line) {
  return line != null && TABLE_DELIMITER_ROW_PATTERN.test(line);
}

function parseTableRow(line) {
  let trimmed = line == null ? '' : line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

  const cells = [];
  let cell = '';
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      cell += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      cell += ch;
      escaped = true;
      continue;
    }
    if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return { cells };
}

function looksLikeHeader(row) {
  if (!row || row.cells.length === 0) return false;
  if (row.cells.length <= 2) return false;
  let nonEmptyCount = 0;
  let totalLength = 0;
  for (const cell of row.cells) {
    const value = cell == null ? '' : String(cell).trim();
    if (value !== '') nonEmptyCount += 1;
    totalLength += value.length;
    if (value.includes('![') || value.includes('](') || value.length > 40) {
      return false;
    }
  }
  return nonEmptyCount > 0 && totalLength <= 120;
}

function renderSyntheticHeaderRow(columnCount) {
  const cells = [];
  for (let i = 1; i <= columnCount; i += 1) {
    cells.push(`Column ${i}`);
  }
  return renderTableRow(cells, columnCount);
}

function renderTableDelimiterRow(columnCount) {
  const cells = Array.from({ length: columnCount }, () => '---');
  return `| ${cells.join(' | ')} |`;
}

function renderTableRow(cells, columnCount) {
  const padded = [];
  for (let i = 0; i < columnCount; i += 1) {
    const value = i < cells.length ? cells[i] : '';
    padded.push(value == null ? '' : String(value).trim());
  }
  return `| ${padded.join(' | ')} |`;
}
