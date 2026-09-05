import {
  decodeCaptureBody,
  isStreamGenerateUrl,
  summarizeStreamBody,
} from './protocol.js';
import { protocolConversationIdToSession } from './session.js';

export class StreamCollector {
  constructor() {
    this.bodies = [];
    this.entries = [];
    this.text = '';
    this.conversationId = '';
    this.sessionId = '';
    this.images = [];
    this.files = [];
    this.sources = [];
    this.toolFlags = [];
    this.finished = false;
    this.frameCount = 0;
    this.requestCount = 0;
    this.completeCount = 0;
    this.firstProgressAt = null;
    this.lastProgressAt = null;
    this.lastTextChangeAt = null;
    this.truncated = false;
  }

  ingestCaptureEntries(entries) {
    if (!Array.isArray(entries)) return 0;
    let n = 0;
    for (const entry of entries) {
      if (this.ingestCaptureEntry(entry)) n += 1;
    }
    return n;
  }

  ingestCaptureEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const url = String(entry.url || '');
    if (!isStreamGenerateUrl(url)) return false;

    const now = Date.now();
    if (this.firstProgressAt === null) this.firstProgressAt = now;
    this.lastProgressAt = now;
    this.requestCount += 1;
    this.frameCount += 1;

    const body = decodeCaptureBody(entry);
    // Status alone is not completion: draining a 200 response before
    // loadingFinished wipes the in-flight entry and the body never arrives.
    if (!body) return true;

    this.completeCount += 1;
    if (entry.responseBodyTruncated) this.truncated = true;
    this.bodies.push(body);
    this.entries.push(entry);
    this.applySummary(summarizeStreamBody(body), now);
    return true;
  }

  applySummary(summary, now = Date.now()) {
    if (summary.text && summary.text.length >= this.text.length) {
      if (summary.text !== this.text) this.lastTextChangeAt = now;
      this.text = summary.text;
    }
    if (summary.conversationId && !this.conversationId) {
      this.conversationId = summary.conversationId;
      this.sessionId = protocolConversationIdToSession(summary.conversationId);
    }
    if (summary.finished) this.finished = true;
    for (const image of summary.images || []) {
      if (!this.images.some((item) => item.url === image.url)) this.images.push(image);
    }
    for (const source of summary.sources || []) {
      if (!this.sources.some((item) => item.url === source.url)) this.sources.push(source);
    }
    for (const flag of summary.toolFlags || []) {
      if (!this.toolFlags.includes(flag)) this.toolFlags.push(flag);
    }
  }

  hasStarted() {
    return this.requestCount > 0 || this.firstProgressAt !== null;
  }

  hasCompleteBody() {
    return this.completeCount > 0 && this.bodies.length > 0;
  }

  hasReturnableOutput() {
    return Boolean(String(this.text || '').trim())
      || this.images.length > 0;
  }

  canExit(settleMs = 1500) {
    if (!this.hasCompleteBody()) return false;
    if (!this.hasReturnableOutput() && !this.finished) return false;
    const last = this.lastProgressAt || this.firstProgressAt || 0;
    return Date.now() - last >= settleMs;
  }
}
