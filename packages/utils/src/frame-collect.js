/**
 * Frame-tree collection aligned with my-mcp PageScraper:
 * Playwright page.frames() is a full tree with parent/depth.
 * OpenCLI splits this into same-origin DOM walks + cross-origin evaluateInFrame.
 * Nested same-origin documents inside a cross-origin frame are collected by
 * running the same walker in that frame — better than taking only outerHTML.
 */

export const COLLECT_DOCUMENT_JS = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const frames = [];
  const inaccessible = [];
  let seq = 0;
  const baseOf = (doc) => {
    try {
      return doc.URL || doc.baseURI || location.href;
    } catch {
      return location.href;
    }
  };
  const frameUrlOf = (el, doc) => {
    const rawSrc = el.getAttribute('src') || el.src || '';
    try {
      if (rawSrc) return new URL(rawSrc, baseOf(doc)).href;
    } catch {}
    try {
      return (el.contentWindow && el.contentWindow.location && el.contentWindow.location.href) || baseOf(doc);
    } catch {
      return rawSrc || baseOf(doc);
    }
  };
  const walk = (doc, parentId, depth) => {
    if (!doc) return;
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll('iframe, frame'));
    } catch {
      nodes = [];
    }
    for (const el of nodes) {
      seq += 1;
      const id = 'frame-' + seq;
      const frameUrl = frameUrlOf(el, doc);
      let childDoc = null;
      try {
        childDoc = el.contentDocument;
      } catch {
        childDoc = null;
      }
      if (!childDoc || !childDoc.documentElement) {
        inaccessible.push({ parentId, url: frameUrl, order: seq, depth });
        continue;
      }
      frames.push({
        id,
        parentId,
        url: frameUrl,
        html: childDoc.documentElement.outerHTML || '',
        depth,
        order: seq,
      });
      walk(childDoc, id, depth + 1);
    }
  };
  const walkText = (doc) => {
    if (!doc) return 0;
    let total = 0;
    try {
      total += normalize((doc.body && doc.body.innerText) || '').length;
    } catch {}
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll('iframe, frame'));
    } catch {
      nodes = [];
    }
    for (const el of nodes) {
      try {
        const child = el.contentDocument;
        if (child) total += walkText(child);
      } catch {}
    }
    return total;
  };
  walk(document, null, 1);
  return {
    html: document.documentElement ? document.documentElement.outerHTML : '',
    title: document.title || '',
    url: location.href,
    textLength: walkText(document),
    frames,
    inaccessible,
  };
})()`;

export const TEXT_LENGTH_JS = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const walkText = (doc) => {
    if (!doc) return 0;
    let total = 0;
    try {
      total += normalize((doc.body && doc.body.innerText) || '').length;
    } catch {}
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll('iframe, frame'));
    } catch {
      nodes = [];
    }
    for (const el of nodes) {
      try {
        const child = el.contentDocument;
        if (child) total += walkText(child);
      } catch {}
    }
    return total;
  };
  return walkText(document);
})()`;

export function remapNestedSnapshot(prefix, snapshot, rootParentId, rootDepth, rootOrder) {
  const html = snapshot?.html || '';
  if (!String(html).trim()) {
    return { frames: [], inaccessible: [] };
  }
  const rootId = prefix;
  const frames = [{
    id: rootId,
    parentId: rootParentId,
    url: snapshot.url || '',
    html,
    depth: rootDepth,
    order: rootOrder,
  }];
  const idMap = new Map();
  for (const frame of snapshot.frames || []) {
    idMap.set(frame.id, `${prefix}/${frame.id}`);
  }
  for (const frame of snapshot.frames || []) {
    const parentId = frame.parentId == null ? rootId : (idMap.get(frame.parentId) || rootId);
    frames.push({
      id: idMap.get(frame.id),
      parentId,
      url: frame.url || '',
      html: frame.html || '',
      depth: rootDepth + (frame.depth || 1),
      order: frame.order || 0,
    });
  }
  const inaccessible = (snapshot.inaccessible || []).map((item) => ({
    parentId: item.parentId == null ? rootId : (idMap.get(item.parentId) || rootId),
    url: item.url || '',
    order: item.order || 0,
    depth: rootDepth + (item.depth || 1),
  }));
  return { frames, inaccessible };
}

export function attachCrossOriginRoots(sameOriginFrames, inaccessible, crossOriginRoots) {
  const remaining = inaccessible.map((item, index) => ({ ...item, index }));
  const used = new Set();
  const attached = [];

  for (const root of crossOriginRoots) {
    const match = remaining.find((item) => !used.has(item.index) && urlsMatch(item.url, root.url));
    let parentId = null;
    let depth = 1;
    let order = root.order;
    if (match) {
      used.add(match.index);
      parentId = match.parentId;
      const parent = sameOriginFrames.find((frame) => frame.id === parentId);
      depth = parent ? parent.depth + 1 : match.depth || 1;
      order = match.order;
    }
    attached.push({
      ...root,
      parentId,
      depth,
      order,
    });
  }

  return attached;
}

export function mergeFrameDocuments(mainSnapshot, crossOriginSnapshots) {
  const mainFrames = [...(mainSnapshot.frames || [])];
  const mainInaccessible = [...(mainSnapshot.inaccessible || [])];
  const bundles = [];
  for (const snapshot of crossOriginSnapshots || []) {
    bundles.push(remapNestedSnapshot(
      snapshot.id,
      snapshot,
      null,
      1,
      snapshot.order ?? 0,
    ));
  }

  const attachedRoots = attachCrossOriginRoots(
    mainFrames,
    mainInaccessible,
    bundles.map((bundle) => bundle.frames[0]).filter(Boolean),
  );
  const attachedById = new Map(attachedRoots.map((root) => [root.id, root]));

  const documents = [...mainFrames];
  for (const bundle of bundles) {
    const rawRoot = bundle.frames[0];
    if (!rawRoot) continue;
    const attached = attachedById.get(rawRoot.id) || rawRoot;
    const delta = (attached.depth || 1) - (rawRoot.depth || 1);
    documents.push(attached);
    for (const nested of bundle.frames.slice(1)) {
      documents.push({
        ...nested,
        depth: (nested.depth || 1) + delta,
      });
    }
  }

  return orderFrameDocuments(documents.filter((frame) => frame && String(frame.html || '').trim()));
}

export function orderFrameDocuments(frameDocuments) {
  if (!Array.isArray(frameDocuments) || frameDocuments.length === 0) return [];
  const childrenByParentId = new Map();
  const knownIds = new Set();
  for (const frame of frameDocuments) {
    knownIds.add(frame.id);
    const key = frame.parentId || 'root';
    if (!childrenByParentId.has(key)) childrenByParentId.set(key, []);
    childrenByParentId.get(key).push(frame);
  }
  for (const siblings of childrenByParentId.values()) {
    siblings.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  const roots = frameDocuments.filter((frame) => !frame.parentId || !knownIds.has(frame.parentId));
  roots.sort((a, b) => (a.order || 0) - (b.order || 0));
  const ordered = [];
  const visited = new Set();
  const append = (frame) => {
    if (!frame || visited.has(frame.id)) return;
    visited.add(frame.id);
    ordered.push(frame);
    for (const child of childrenByParentId.get(frame.id) || []) {
      append(child);
    }
  };
  for (const root of roots) append(root);
  return ordered;
}

function urlsMatch(left, right) {
  if (!left || !right) return false;
  return normalizeUrl(left) === normalizeUrl(right);
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(value);
  }
}
