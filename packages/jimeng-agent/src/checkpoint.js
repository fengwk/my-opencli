/**
 * Two-phase preparation gates for jimeng-agent.
 *
 * 1) Pre-input controls: Agent / Auto / Video must be correct before uploads
 *    and prompt typing begin.
 * 2) Content checkpoint: after typing, only validate references + prompt
 *    content. Preference panels are not reopened here.
 */

/**
 * Normalize one prompt line for structure comparison: drop mention markers and
 * incidental whitespace so rich tags and plain text can be compared.
 */
export function normalizePromptValidationText(value) {
  return String(value || '')
    .replace(/@/g, '')
    .replace(/[\u00a0\u200b\s]+/g, '');
}

/**
 * Normalize a multi-line prompt into comparable line tokens.
 */
export function normalizePromptValidationLines(value) {
  return String(value || '').split('\n').map(normalizePromptValidationText);
}

/**
 * Build the expected content-checkpoint targets from the canonical prompt + assets.
 */
export function buildCheckpointExpectations(agentPrompt, assets) {
  const prompt = String(agentPrompt || '').replace(/\\n/g, '\n');
  const mentionLabels = [];
  const textAnchors = [];
  for (const segment of splitPromptSegments(prompt, assets)) {
    if (segment.type === 'mention') {
      mentionLabels.push(segment.label);
      continue;
    }
    if (segment.type !== 'text') continue;
    const normalized = normalizePromptValidationText(segment.value);
    if (!normalized) continue;
    if (normalized.length <= 48) textAnchors.push(normalized);
    else textAnchors.push(normalized.slice(0, 24), normalized.slice(-24));
  }
  return {
    expectedLines: normalizePromptValidationLines(prompt),
    expectedMentions: mentionLabels.length,
    expectedReferences: Array.isArray(assets) ? assets.length : 0,
    mentionLabels,
    textAnchors,
  };
}

/**
 * Pre-input gate: mode and preference controls only.
 * Call this after Agent/Auto/Video configuration and before upload/prompt input.
 *
 * Note: preferencePanelReadable is intentionally NOT required. Forcing the
 * Auto preference dropdown open just to re-read state was flaky on Hub and
 * is no longer part of the prepare path.
 */
export function evaluatePreInputControls(snapshot) {
  const checks = {
    surfaceReady: snapshot?.surfaceReady === true,
    agentSelected: snapshot?.agentSelected === true,
    autoEnabled: snapshot?.autoEnabled === true,
    videoSelected: snapshot?.videoSelected === true,
  };
  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    ok: failures.length === 0,
    failures,
    checks,
    phase: 'pre-input',
  };
}

/**
 * Post-input content gate: references + prompt content only.
 * Does not re-validate Auto/preference panels.
 */
export function evaluateContentCheckpoint(snapshot, expectations) {
  const checks = {
    surfaceReady: snapshot?.surfaceReady === true,
    referenceCount:
      Number(snapshot?.referenceCount) === Number(expectations.expectedReferences),
    mentionCount:
      Number(snapshot?.mentionCount) === Number(expectations.expectedMentions),
    mentionLabelsMatch: arraysEqual(
      snapshot?.observedMentionLabels || [],
      expectations.mentionLabels || [],
    ),
    noRawAt: snapshot?.rawAt !== true,
    noMentionMenu: snapshot?.menuVisible !== true,
    lineStructure: arraysEqual(
      snapshot?.editorLines || [],
      expectations.expectedLines || [],
    ),
    textAnchorsInOrder: anchorsInOrder(
      snapshot?.editorTextNormalized || '',
      expectations.textAnchors || [],
    ),
  };

  // Formal submit additionally requires an armed generate control.
  if (snapshot?.requireSubmitArmed === true) {
    checks.submitArmed = snapshot?.submitEnabled === true;
  }

  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return {
    ok: failures.length === 0,
    failures,
    checks,
    phase: 'content',
    expected: {
      mentions: expectations.expectedMentions,
      references: expectations.expectedReferences,
      lines: expectations.expectedLines,
      mentionLabels: expectations.mentionLabels,
    },
    observed: {
      mentionCount: snapshot?.mentionCount ?? null,
      referenceCount: snapshot?.referenceCount ?? null,
      mentionLabels: snapshot?.observedMentionLabels ?? [],
      editorLines: snapshot?.editorLines ?? [],
      submitEnabled: snapshot?.submitEnabled ?? null,
    },
  };
}

/**
 * @deprecated Use evaluateContentCheckpoint. Kept as a thin alias for imports.
 */
export function evaluatePreparationCheckpoint(snapshot, expectations) {
  return evaluateContentCheckpoint(snapshot, expectations);
}

function splitPromptSegments(agentPrompt, assets) {
  const byLabel = new Map((assets || []).map((asset) => [asset.label, asset]));
  const parts = [];
  const appendText = (value) => {
    const lines = String(value).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]) parts.push({ type: 'text', value: lines[i] });
      if (i + 1 < lines.length) parts.push({ type: 'newline', value: '\n' });
    }
  };
  const tokenPattern = /@(图片|视频|音频)([1-9]\d*)/g;
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(agentPrompt)) !== null) {
    if (match.index > cursor) appendText(agentPrompt.slice(cursor, match.index));
    const label = `${match[1]}${match[2]}`;
    if (!byLabel.has(label)) {
      parts.push({ type: 'mention', label, asset: null });
    } else {
      parts.push({ type: 'mention', label, asset: byLabel.get(label) });
    }
    cursor = tokenPattern.lastIndex;
  }
  if (cursor < agentPrompt.length) appendText(agentPrompt.slice(cursor));
  return parts;
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function anchorsInOrder(haystack, anchors) {
  let cursor = 0;
  for (const raw of anchors) {
    const anchor = normalizePromptValidationText(raw);
    if (!anchor) continue;
    const index = String(haystack || '').indexOf(anchor, cursor);
    if (index === -1) return false;
    cursor = index + anchor.length;
  }
  return true;
}
