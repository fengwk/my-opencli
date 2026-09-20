/**
 * Same-origin Jimeng Canvas API transport.
 *
 * Authentication remains in the visible browser session. Callers own endpoint
 * contracts because Octo and Canvas Agent use different response envelopes.
 */

import { CommandExecutionError } from '@jackwener/opencli/errors';

export const CANVAS_PROJECT_UPDATE_PATH = '/octo_api/v1/project/update';
export const CANVAS_PROJECT_DRAFT_GET_PATH = '/octo_api/v1/project/draft/get';
export const CANVAS_RESOURCE_BATCH_GET_PATH = '/octo_api/v1/resource/batch_get';
export const CANVAS_AGENT_SESSIONS_LIST_PATH = '/octo_api/v1/canvas_agent/sessions/list';
export const CANVAS_AGENT_EVENTS_LIST_PATH = '/octo_api/v1/canvas_agent/events/list';

const JIMENG_APP_ID = '513695';

/**
 * Execute a JSON POST through the authenticated Jimeng page.
 *
 * @param {object} page
 * @param {string} path
 * @param {object} body
 * @returns {Promise<any>}
 */
export async function requestCanvasJson(page, path, body) {
  if (typeof page?.evaluate !== 'function') {
    throw new CommandExecutionError(
      'JIMENG_CANVAS_API_UNSUPPORTED: browser page does not support evaluate',
      'Use the OpenCLI Browser Bridge extension.',
    );
  }
  if (typeof path !== 'string' || !path.startsWith('/octo_api/v1/')) {
    throw new Error(`Unsupported Jimeng Canvas API path: ${String(path)}`);
  }

  const expression = `(async () => {
    const path = ${JSON.stringify(path)};
    const requestBody = ${JSON.stringify(body ?? {})};
    const traceSuffix = (
      globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2)
    );
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          accept: '*/*',
          appid: ${JSON.stringify(JIMENG_APP_ID)},
          'content-type': 'application/json',
          lan: 'zh-Hans',
          'x-octo-trace-id': 'opencli-' + traceSuffix,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      return {
        transportError: error instanceof Error ? error.message : String(error),
      };
    }

    const text = await response.text();
    let parsed = null;
    let parseError = '';
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      httpOk: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: parsed,
      parseError,
      bodyPreview: parseError ? text.slice(0, 500) : '',
    };
  })()`;

  let result;
  try {
    result = await page.evaluate(expression);
  } catch (error) {
    throw canvasApiError(
      path,
      `browser request failed: ${describeError(error)}`,
    );
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw canvasApiError(path, 'browser returned a malformed transport result');
  }
  if (result.transportError) {
    throw canvasApiError(path, String(result.transportError));
  }
  if (result.httpOk !== true) {
    const serviceMessage = extractServiceMessage(result.body);
    throw canvasApiError(
      path,
      `HTTP ${result.status ?? 'unknown'}${serviceMessage ? `: ${serviceMessage}` : ''}`,
    );
  }
  if (result.parseError) {
    throw canvasApiError(
      path,
      `response was not valid JSON (${result.parseError})`,
    );
  }
  if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw canvasApiError(path, 'response body was not a JSON object');
  }
  return result.body;
}

export function unwrapOctoData(envelope, path, { requireData = true } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`${path} returned a malformed Octo envelope`);
  }
  if (String(envelope.ret) !== '0') {
    throw new Error(
      `${path} rejected the request (ret=${String(envelope.ret ?? 'missing')}, errmsg=${String(envelope.errmsg || '')})`,
    );
  }
  if (requireData && (!envelope.data || typeof envelope.data !== 'object')) {
    throw new Error(`${path} returned no data object`);
  }
  return envelope.data;
}

export function unwrapCanvasAgentEnvelope(envelope, path) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`${path} returned a malformed Canvas Agent envelope`);
  }
  if (envelope.code !== 0) {
    throw new Error(
      `${path} rejected the request (code=${String(envelope.code ?? 'missing')}, message=${String(envelope.message || '')})`,
    );
  }
  return envelope;
}

export async function updateCanvasProjectTitle(page, projectId, title) {
  const envelope = await requestCanvasJson(page, CANVAS_PROJECT_UPDATE_PATH, {
    project_id: projectId,
    name: title,
  });
  unwrapOctoData(envelope, CANVAS_PROJECT_UPDATE_PATH, { requireData: false });
  return {
    projectId,
    title,
    logId: typeof envelope.logid === 'string' ? envelope.logid : '',
  };
}

function canvasApiError(path, detail) {
  return new CommandExecutionError(
    `JIMENG_CANVAS_API_FAILED: ${path}: ${detail}`,
    'Confirm that the Jimeng browser session is logged in and can access this canvas.',
  );
}

function extractServiceMessage(body) {
  if (!body || typeof body !== 'object') return '';
  return String(body.errmsg || body.message || body.error || '').trim();
}

function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'unknown error');
}
