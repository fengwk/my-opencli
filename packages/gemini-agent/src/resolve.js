export function hasReturnableArtifacts(artifacts) {
  return Boolean(String(artifacts?.text || '').trim())
    || (Array.isArray(artifacts?.files) && artifacts.files.length > 0)
    || (Array.isArray(artifacts?.images) && artifacts.images.length > 0);
}

export function resolveArtifacts(collector, opts = {}) {
  const sessionId = opts.sessionId || collector.sessionId || '';
  const conversationId = collector.conversationId || '';
  return {
    sessionId,
    conversationId,
    text: collector.text || '',
    files: Array.isArray(collector.files) ? collector.files : [],
    images: (collector.images || []).map((image) => ({
      url: image.url || '',
      type: image.type || 'url',
    })),
    sources: (collector.sources || []).map((source) => ({
      title: source.title || '',
      url: source.url || '',
    })),
    toolFlags: collector.toolFlags || [],
    truncated: !!collector.truncated,
  };
}
