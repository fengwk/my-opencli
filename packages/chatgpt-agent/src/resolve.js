/**
 * Post-stream packaging from protocol collector only.
 *
 * No extra backend fetch / conversation API / page.evaluate network calls.
 * Like a real user: stream delivers content; DOM is only for send/click/download.
 */

/** Returnable protocol output for success/timeout decisions (sources alone are metadata). */
export function hasReturnableArtifacts(artifacts) {
  return Boolean(String(artifacts?.text || '').trim())
    || (Array.isArray(artifacts?.files) && artifacts.files.length > 0)
    || (Array.isArray(artifacts?.images) && artifacts.images.length > 0);
}

/**
 * @param {import('./stream-collector.js').StreamCollector} collector
 * @param {object} _page unused (kept for call-site stability)
 * @param {{ conversationId?: string }} opts
 */
export async function resolveArtifacts(collector, _page, opts = {}) {
  const conversationId = opts.conversationId || collector.conversationId || '';

  return {
    conversationId,
    text: collector.text || '',
    files: (collector.fileRefs || []).map((ref) => ({
      name: ref.fileName || '',
      messageId: ref.messageId || '',
      sandboxPath: ref.sandboxPath || '',
      status: ref.status || '',
      // Download URL is known from protocol shape; actual download should be a
      // later DOM/user-like click flow if needed — not silent backend fetch.
      downloadHint: conversationId && ref.messageId && ref.sandboxPath
        ? {
          conversationId,
          messageId: ref.messageId,
          sandboxPath: ref.sandboxPath,
        }
        : null,
    })),
    images: (collector.imagePointers || []).map((pointer) => ({
      type: pointer.type || '',
      id: pointer.id || '',
      messageId: pointer.messageId || '',
      // Protocol pointer only (file-service:// / sediment://); no silent resolve fetch.
      pointer: pointer.type && pointer.id ? `${pointer.type}://${pointer.id}` : '',
    })),
    sources: (collector.sources || []).map((s) => ({
      title: s.title || '',
      url: s.url || '',
      ref: s.ref || '',
    })),
  };
}
