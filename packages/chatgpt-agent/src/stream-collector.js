/**
 * ChatGPT websocket stream protocol collector.
 * Text recovery follows chatgpt2api conversation.py + web2api chatgpt_v2.debug.js:
 *   1) prefer full assistant message
 *   2) apply /message/content/parts/0 patches
 *   3) sanitize private-use cite/url markers
 */

export const FILE_REF_STATUS_IN_PROGRESS = 'in_progress';
export const FILE_REF_STATUS_READY = ['finished_successfully', 'finished_partial_completion'];

export class StreamCollector {
  constructor() {
    this.rawText = '';
    this.text = '';
    this.conversationId = null;
    this.activeTurnId = null;
    this.activeTopicId = null;
    this.frameCount = 0;
    this.eventCount = 0;
    this.firstProgressAt = null;
    this.lastProgressAt = null;
    this.lastTextChangeAt = null;
    this.toolInvoked = null;

    this.strongLifecycle = {
      doneSeen: false,
      lastTokenSeen: false,
      endTurnSeen: false,
      messageStreamCompleteSeen: false,
      turnCompleteSeen: false,
    };
    this.messageFinishedSeen = false;

    this.fileRefs = [];
    this.imagePointers = [];
    this.sources = []; // { title, url, ref? }
    this.lastToolMessageId = '';
    /** Async image_gen placeholder seen; final assets arrive via conversation-update. */
    this.pendingImageGen = false;
    this.imageGenFinalSeen = false;
  }

  /** Ingest one received WS text payload (array of items or a single envelope). */
  ingestFramePayload(payloadText) {
    if (payloadText == null) return;
    const text = String(payloadText);
    if (!text || text.startsWith('base64:')) return;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    this.frameCount += 1;
    const now = Date.now();
    if (this.firstProgressAt === null) this.firstProgressAt = now;
    this.lastProgressAt = now;

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        try {
          this.ingestEnvelope(item, now);
        } catch {
          // ignore per-item errors
        }
      }
      return;
    }

    if (parsed && typeof parsed === 'object') {
      try {
        this.ingestEnvelope(parsed, now);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Outer WS envelope: { type: message|conversation-update|reply, payload, ... }
   * Stateless — every frame is classified by type only.
   */
  ingestEnvelope(item, now = Date.now()) {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type || '');

    if (type === 'conversation-update') {
      this.ingestConversationUpdate(item.payload || item, now);
      return;
    }

    if (type !== 'message') return;
    const topicId = String(item.topic_id || '');
    const payloadType = String((item.payload && item.payload.type) || '');
    const inner = (item.payload && item.payload.payload) || {};

    if (payloadType === 'conversation-turn-stream') {
      this.ingestStreamFrame(inner, topicId);
    } else if (payloadType === 'conversation-turn-complete') {
      this.ingestTurnComplete(topicId, inner);
    } else if (payloadType === 'server_ste_metadata') {
      const ti = typeof inner?.tool_invoked === 'boolean'
        ? inner.tool_invoked
        : (typeof inner?.metadata?.tool_invoked === 'boolean' ? inner.metadata.tool_invoked : null);
      if (typeof ti === 'boolean') this.toolInvoked = ti;
    }
  }

  /**
   * Live image_gen delivers final sediment:// pointers via conversation-update
   * add-messages (not the first turn-stream placeholder with parts:[]).
   */
  ingestConversationUpdate(payload, now = Date.now()) {
    if (!payload || typeof payload !== 'object') return;
    const updateType = String(payload.update_type || '');
    const content = payload.update_content || {};
    this.lastProgressAt = now;
    if (payload.conversation_id && !this.conversationId) {
      this.conversationId = String(payload.conversation_id);
    }

    if (updateType === 'set-conversation-async-status') {
      // Keep pending while async status is non-zero-ish; final image often lands after.
      const status = content.conversation_async_status;
      if (status != null && Number(status) > 0 && this.pendingImageGen) {
        this.lastProgressAt = now;
      }
      return;
    }

    if (updateType !== 'add-messages') return;
    const messages = Array.isArray(content.messages) ? content.messages : [];
    for (const msg of messages) {
      collectImageFromRawMessage(this, msg);
    }
  }

  ingestStreamFrame(frame, topicId) {
    if (!frame || typeof frame.encoded_item !== 'string') return;
    const turnId = frame.turn_id || extractTurnIdFromTopic(topicId);
    // Bind first turn for bookkeeping only. Do NOT drop later turn_ids:
    // image_gen / async tools often complete on a subsequent turn stream after
    // an early message_stream_complete (see live WS dump).
    if (!this.activeTurnId && turnId) {
      this.activeTurnId = turnId;
      this.activeTopicId = topicId;
    }

    const now = Date.now();
    if (this.firstProgressAt === null) this.firstProgressAt = now;
    this.lastProgressAt = now;

    for (const sseEvent of parseSseFrames(frame.encoded_item)) {
      this.ingestSseEvent(sseEvent, now);
    }
  }

  ingestSseEvent(sseEvent, now) {
    const data = sseEvent.data;
    if (!data) return;
    if (data.trim() === '[DONE]') {
      this.strongLifecycle.doneSeen = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    this.eventCount += 1;

    if (parsed.status === 'finished_successfully' || parsed.status === 'finished_partial_completion') {
      this.messageFinishedSeen = true;
    }
    if (
      parsed.type === 'message_marker'
      && parsed.marker === 'last_token'
      && (parsed.event === 'last' || !parsed.event)
    ) {
      this.strongLifecycle.lastTokenSeen = true;
    }
    if (parsed.type === 'message_stream_complete') {
      this.strongLifecycle.messageStreamCompleteSeen = true;
    }
    if (parsed.end_turn === true) {
      this.strongLifecycle.endTurnSeen = true;
    }

    // tool_invoked often arrives as SSE { type: server_ste_metadata, metadata: {...} }
    // not only as outer WS payloadType server_ste_metadata.
    if (parsed.type === 'server_ste_metadata') {
      const meta = parsed.metadata || {};
      if (typeof meta.tool_invoked === 'boolean') this.toolInvoked = meta.tool_invoked;
      else if (typeof parsed.tool_invoked === 'boolean') this.toolInvoked = parsed.tool_invoked;
    }

    applyProtocolTextState(this, parsed, now);
    collectFileRef(this, parsed);
    collectImagePointer(this, parsed);
    collectSourcesFromEvent(this, parsed);

    if (parsed.conversation_id && !this.conversationId) {
      this.conversationId = String(parsed.conversation_id);
    }
  }

  ingestTurnComplete(topicId, frame) {
    if (!frame) return;
    const turnId = frame.turn_id || extractTurnIdFromTopic(topicId);
    if (!this.activeTurnId || turnId === this.activeTurnId) {
      this.strongLifecycle.turnCompleteSeen = true;
    }
  }

  hasAnyStrongLifecycle() {
    const s = this.strongLifecycle;
    return s.doneSeen
      || s.lastTokenSeen
      || s.endTurnSeen
      || s.messageStreamCompleteSeen
      || s.turnCompleteSeen;
  }

  isTextSettled(quietMs) {
    if (this.lastTextChangeAt === null) return false;
    return Date.now() - this.lastTextChangeAt >= quietMs;
  }

  /**
   * Strong lifecycle + settled content.
   * Image gen: wait for asset pointers (conversation-update) when pending.
   */
  canExit(quietMs) {
    // Still generating more images (multi-gen) — never exit mid-batch.
    if (this.pendingImageGen && !this.imageGenFinalSeen) {
      return false;
    }
    if (!this.hasAnyStrongLifecycle() && this.imagePointers.length === 0) return false;
    if (this.imagePointers.length > 0) {
      // After final (or no pending), require quiet so late siblings can still land.
      if (this.lastProgressAt == null) return false;
      return Date.now() - this.lastProgressAt >= quietMs;
    }
    if (!this.hasAnyStrongLifecycle()) return false;
    if (this.text.length === 0) return false;
    return this.isTextSettled(quietMs);
  }

  needsPostStreamResolve() {
    return this.fileRefs.length > 0
      || this.imagePointers.length > 0
      || this.toolInvoked === true
      || this.pendingImageGen === true
      || this.sources.length > 0;
  }

  snapshot() {
    return {
      text: this.text,
      rawText: this.rawText,
      conversationId: this.conversationId,
      frameCount: this.frameCount,
      eventCount: this.eventCount,
      toolInvoked: this.toolInvoked,
      strongLifecycle: { ...this.strongLifecycle },
      fileRefs: this.fileRefs.map((r) => ({ ...r })),
      imagePointers: this.imagePointers.map((p) => ({ ...p })),
      sources: this.sources.map((s) => ({ ...s })),
    };
  }
}

export function parseSseFrames(encoded) {
  if (!encoded) return [];
  const frames = [];
  const blocks = String(encoded).split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const ev = { event: null, data: null };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const v = line.slice(5).trim();
        ev.data = ev.data === null ? v : `${ev.data}\n${v}`;
      }
    }
    if (ev.data !== null) frames.push(ev);
  }
  return frames;
}

/** Sanitize ChatGPT private-use cite/url markers (chatgpt2api sanitize_output_text). */
export function sanitizeOutputText(text) {
  text = String(text || '');

  function isInternalAnnotationPart(part) {
    const value = String(part || '').trim();
    if (!value) return true;
    const lower = value.toLowerCase();
    return /^(turn\d+[a-z]*\d*|turn\d+\w*)$/i.test(lower)
      || lower.startsWith('turn')
      || lower.startsWith('source');
  }

  function readableAnnotationPart(parts) {
    for (const part of parts) {
      const value = String(part || '').trim();
      if (value && !isInternalAnnotationPart(value)) return value;
    }
    return '';
  }

  function replaceAnnotation(_match, payload) {
    const parts = String(payload || '').split('\uE202').map((part) => String(part || '').trim());
    const kind = String(parts[0] || '').toLowerCase();
    const data = parts.slice(1);
    if (kind === 'url') {
      const label = String(data[0] || '');
      const url = String(data[1] || '');
      if (label && /^https?:\/\//.test(url)) return `${label} (${url})`;
      return label || url;
    }
    if (kind === 'cite') return readableAnnotationPart(data);
    return readableAnnotationPart(data);
  }

  text = text.replace(/\uE200([^\uE201]*)\uE201/g, replaceAnnotation);
  text = text.replace(/\uE200[^\uE201]*$/g, '');
  text = text.replace(/\s+([.,;:!?])/g, '$1');
  return text;
}

function extractTurnIdFromTopic(topicId) {
  if (typeof topicId !== 'string') return null;
  const m = topicId.match(/^conversation-turn-(.+)$/);
  return m ? m[1] : null;
}

function applyProtocolTextState(collector, event, now) {
  if (!event || typeof event !== 'object') return;
  const nextRaw = assistantRawText(event, collector.rawText || '');
  const nextText = sanitizeOutputText(nextRaw);
  if (nextRaw === collector.rawText && nextText === collector.text) return;
  collector.rawText = nextRaw;
  collector.text = nextText;
  collector.lastTextChangeAt = now;
}

function assistantRawText(event, currentText) {
  for (const candidate of [event, event && event.v]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const message = candidate.message;
    if (!message || typeof message !== 'object') continue;
    const role = String(((message.author || {}).role) || '').trim().toLowerCase();
    if (role !== 'assistant') continue;
    const text = assistantMessageText(message);
    if (text) return text;
  }
  return applyTextPatch(event, currentText || '');
}

function assistantMessageText(message) {
  const content = message.content || {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.map(toDisplayableTextPart).filter(Boolean).join('');
  if (text) return text;
  return toDisplayableTextPart(content.text) || '';
}

function applyTextPatch(event, currentText) {
  if (!event || typeof event !== 'object') return currentText || '';
  if (String(event.p || '') === '/message/content/parts/0') {
    return applyTextPatchOp(event, currentText || '');
  }

  const operations = event.v;
  if (typeof operations === 'string' && currentText && !event.p && !event.o) {
    const textPart = toDisplayableTextPart(operations);
    return textPart ? currentText + textPart : currentText;
  }

  if (event.o === 'patch' && Array.isArray(operations)) {
    let text = currentText || '';
    for (const item of operations) {
      if (item && typeof item === 'object') text = applyTextPatch(item, text);
    }
    return text;
  }

  if (!Array.isArray(operations)) return currentText || '';
  let text = currentText || '';
  for (const item of operations) {
    if (item && typeof item === 'object') text = applyTextPatch(item, text);
  }
  return text;
}

function applyTextPatchOp(operation, currentText) {
  const op = String(operation.o || '');
  const value = toDisplayableTextPart(operation.v);
  if (op === 'append') return currentText + value;
  if (op === 'replace') return value || currentText;
  return currentText;
}

function toDisplayableTextPart(value) {
  if (typeof value !== 'string') return '';
  // Skip structured tool-plan JSON blobs that are not user-visible prose.
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && /"tool"|"search"|"browser"/.test(trimmed) && trimmed.length > 80) {
    try {
      JSON.parse(trimmed);
      return '';
    } catch {
      // keep as text
    }
  }
  return value;
}

function collectFileRef(collector, payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.o === 'patch' && Array.isArray(payload.v)) {
    for (const item of payload.v) collectFileRef(collector, item);
    return;
  }
  if (isMessageAdd(payload)) {
    const msg = payload.v.message;
    const role = String((msg.author && msg.author.role) || '').toLowerCase();
    if (role === 'tool' || role === 'assistant') {
      collector.lastToolMessageId = String(msg.id || '');
      const parts = Array.isArray((msg.content || {}).parts) ? msg.content.parts : [];
      for (const part of parts) {
        if (typeof part === 'string') {
          extractAndAddFileRef(collector, part, collector.lastToolMessageId, role);
        }
      }
    }
  }
  if (
    (payload.o === 'append' || payload.o === 'replace')
    && typeof payload.v === 'string'
    && /sandbox:\/mnt\/data\//.test(payload.v)
  ) {
    extractAndAddFileRef(collector, payload.v, collector.lastToolMessageId, 'tool');
  }
  // Assistant prose often embeds markdown: [name](sandbox:/mnt/data/name)
  if (typeof payload.v === 'string' && /sandbox:\/mnt\/data\//.test(payload.v)) {
    extractAndAddFileRef(collector, payload.v, collector.lastToolMessageId || '', 'assistant');
  }
  if (payload.o === 'add' && payload.v?.message?.author?.role === 'assistant') {
    const parts = Array.isArray(payload.v.message.content?.parts) ? payload.v.message.content.parts : [];
    for (const part of parts) {
      if (typeof part === 'string' && /sandbox:\/mnt\/data\//.test(part)) {
        extractAndAddFileRef(collector, part, String(payload.v.message.id || ''), 'assistant');
      }
    }
  }
  if (payload.p === '/message/status' && typeof payload.v === 'string' && collector.fileRefs.length > 0) {
    collector.fileRefs[collector.fileRefs.length - 1].status = payload.v;
  }
}

function extractAndAddFileRef(collector, text, messageId, role) {
  if (!text || typeof text !== 'string') return;
  const matches = text.matchAll(/sandbox:\/mnt\/data\/([^\s"'\\)\]<>]+)/gi);
  for (const m of matches) {
    const fileName = m[1];
    if (!collector.fileRefs.some((r) => r.messageId === messageId && r.fileName === fileName)) {
      collector.fileRefs.push({
        messageId: messageId || '',
        sandboxPath: `/mnt/data/${fileName}`,
        fileName,
        status: FILE_REF_STATUS_IN_PROGRESS,
        role: role || 'tool',
      });
    }
  }
}

function collectImagePointer(collector, payload) {
  if (!payload || typeof payload !== 'object') return;

  // Batch patch may nest message adds.
  if (payload.o === 'patch' && Array.isArray(payload.v)) {
    for (const item of payload.v) collectImagePointer(collector, item);
    return;
  }

  if (!isMessageAdd(payload)) return;
  const msg = payload.v.message;
  const role = String((msg.author && msg.author.role) || '').toLowerCase();
  if (role !== 'tool') return;
  const meta = msg.metadata || {};
  const content = msg.content || {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const asyncType = String(meta.async_task_type || meta.task_type || '');
  const toolName = String((msg.author && msg.author.name) || meta.tool_name || '');
  // Live streams sometimes omit async_task_type; still accept tool parts that
  // carry image asset pointers (or the known image-gen tool name hash).
  const looksLikeImageTool = asyncType === 'image_gen'
    || /image_gen|image_generation|t2uay3k/i.test(toolName)
    || parts.some((p) => partLooksLikeImageAsset(p));
  if (!looksLikeImageTool) {
    if (process.env.OPENCLI_VERBOSE && parts.length) {
      console.error(
        `[chatgpt-agent] skip-tool-msg async=${asyncType} name=${toolName} `
        + `parts=${summarizeParts(parts)}`,
      );
    }
    return;
  }

  if (process.env.OPENCLI_VERBOSE) {
    console.error(
      `[chatgpt-agent] image-tool-msg id=${msg.id || ''} async=${asyncType} name=${toolName} `
      + `parts=${summarizeParts(parts)}`,
    );
  }

  noteImageGenLifecycle(collector, msg);
  for (const part of parts) {
    addImagePointerFromPart(collector, part, String(msg.id || ''));
  }
}

/** conversation-update / raw message object (not SSE patch envelope). */
function collectImageFromRawMessage(collector, msg) {
  if (!msg || typeof msg !== 'object') return;
  const role = String((msg.author && msg.author.role) || '').toLowerCase();
  if (role !== 'tool') return;
  const meta = msg.metadata || {};
  const content = msg.content || {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const asyncType = String(meta.async_task_type || meta.task_type || '');
  const toolName = String((msg.author && msg.author.name) || meta.tool_name || '');
  const looksLikeImageTool = asyncType === 'image_gen'
    || /image_gen|image_generation|t2uay3k/i.test(toolName)
    || parts.some((p) => partLooksLikeImageAsset(p))
    || hasImageGenPermission(meta);
  if (!looksLikeImageTool) return;

  noteImageGenLifecycle(collector, msg);
  for (const part of parts) {
    addImagePointerFromPart(collector, part, String(msg.id || ''));
  }
}

function hasImageGenPermission(meta) {
  const perms = Array.isArray(meta?.permissions) ? meta.permissions : [];
  return perms.some((p) => /image_gen/i.test(String(p?.notification_channel_id || p?.notification_channel_name || '')));
}

function noteImageGenLifecycle(collector, msg) {
  const meta = msg?.metadata || {};
  const gh = String(meta?.ghostrider?.status || '').toLowerCase();
  const parts = Array.isArray(msg?.content?.parts) ? msg.content.parts : [];
  const hasAssets = parts.some((p) => partLooksLikeImageAsset(p));
  // Multi-image turns stream assets one-by-one; stay pending until ghostrider
  // final (or long quiet handled by wait-stream). Do NOT clear pending on the
  // first hasAssets — that caused early exit after 1–2 of N images.
  if (
    gh === 'intermediate'
    || (parts.length === 0 && hasImageGenPermission(meta))
    || (hasAssets && gh !== 'final')
  ) {
    collector.pendingImageGen = true;
  }
  if (gh === 'final') {
    collector.pendingImageGen = false;
    collector.imageGenFinalSeen = true;
  }
}

function partLooksLikeImageAsset(part) {
  if (typeof part === 'string') {
    return /^(file-service|sediment):\/\//.test(part) || /^https?:\/\//.test(part);
  }
  if (!part || typeof part !== 'object') return false;
  const ct = String(part.content_type || '');
  if (ct === 'image_asset_pointer' || ct.includes('image')) return true;
  const pointer = String(part.asset_pointer || part.pointer || '');
  return /^(file-service|sediment):\/\//.test(pointer);
}

function summarizeParts(parts) {
  try {
    return JSON.stringify(parts).slice(0, 400);
  } catch {
    return String(parts?.length || 0);
  }
}

/** Message add: explicit o=add, or implicit { v: { message } } (live image/text streams). */
function isMessageAdd(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!payload.v || !payload.v.message) return false;
  const o = String(payload.o || '');
  return o === 'add' || o === '';
}

/** Stateless: accept string pointer or { asset_pointer / content_type:image_asset_pointer }. */
function addImagePointerFromPart(collector, part, messageId) {
  let pointer = '';
  if (typeof part === 'string') {
    pointer = part;
  } else if (part && typeof part === 'object') {
    pointer = String(part.asset_pointer || part.pointer || '');
    if (!pointer && String(part.content_type || '') === 'image_asset_pointer') {
      pointer = String(part.asset_pointer || '');
    }
  }
  if (!pointer) return;

  // file-service://id | sediment://id
  let m = pointer.match(/^(file-service|sediment):\/\/([A-Za-z0-9_-]+)$/);
  if (m) {
    pushImagePointer(collector, m[1], m[2], messageId);
    return;
  }
  // Direct https URL (some tool payloads)
  if (/^https?:\/\//i.test(pointer)) {
    pushImagePointer(collector, 'url', pointer, messageId);
  }
}

function pushImagePointer(collector, type, id, messageId) {
  if (!collector.imagePointers.some((p) => p.type === type && p.id === id)) {
    collector.imagePointers.push({ type, id, messageId: messageId || '' });
  }
}

function collectSourcesFromEvent(collector, event) {
  const messages = [];
  if (event?.v?.message) messages.push(event.v.message);
  if (event?.message) messages.push(event.message);
  for (const message of messages) {
    collectSourcesFromMessage(collector, message);
  }
}

export function collectSourcesFromMessage(collector, message) {
  if (!message || typeof message !== 'object') return;
  const meta = message.metadata || {};
  const refs = meta.content_references || meta.citations || meta.sources || [];
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      addSource(collector, ref);
    }
  }
  // Nested search result items
  walkSources(message, (node) => addSource(collector, node));
}

function walkSources(node, visit, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) walkSources(item, visit, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  if (node.url || node.title || node.link || node.citation) visit(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walkSources(value, visit, depth + 1);
  }
}

function addSource(collector, ref) {
  if (!ref || typeof ref !== 'object') return;
  const url = String(ref.url || ref.link || ref.href || '').trim();
  const title = String(ref.title || ref.name || ref.label || ref.attribution || '').trim();
  if (!url && !title) return;
  if (url && !/^https?:\/\//i.test(url) && !url.includes('.')) return;
  const key = `${title}||${url}`;
  if (collector.sources.some((s) => `${s.title}||${s.url}` === key)) return;
  collector.sources.push({
    title: title || url,
    url,
    ref: String(ref.matched_text || ref.cite || ref.id || ''),
  });
}
