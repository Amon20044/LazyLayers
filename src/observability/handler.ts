import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { StoreInspectOptions } from '../types/index.js';
import { ObservabilityCollector } from './collector.js';
import { ObservabilityInspector } from './inspector.js';
import { renderDashboard } from './dashboard.js';
import { renderPrometheus } from './prometheus.js';
import { encodeBoundedEvent, eventLimit } from './eventEncoding.js';
import {
  DEFAULT_OBSERVABILITY_MAX_EVENT_BYTES,
  DEFAULT_OBSERVABILITY_MAX_STREAM_CLIENTS,
  type RecordedEvent,
  type ResolvedObservabilityOptions,
} from './types.js';

export interface ObservabilityHandlerDeps {
  collector: ObservabilityCollector;
  inspector: ObservabilityInspector;
  options: ResolvedObservabilityOptions;
}

export type ObservabilityRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean;

/**
 * Create a framework-agnostic request handler for the dashboard. Returns `true`
 * if the request fell under the configured route (and was answered), or `false`
 * so the caller can pass it through to the rest of their app.
 */
export function createObservabilityHandler(
  deps: ObservabilityHandlerDeps,
): ObservabilityRequestHandler {
  const { collector, inspector, options } = deps;
  const base = options.route;
  const metricsPath = `${base}/metrics`;
  const maxStreamClients = eventLimit(options.maxStreamClients ?? DEFAULT_OBSERVABILITY_MAX_STREAM_CLIENTS, 'maxStreamClients');
  const maxStreamEventBytes = eventLimit(options.maxStreamEventBytes ?? DEFAULT_OBSERVABILITY_MAX_EVENT_BYTES, 'maxStreamEventBytes');
  let activeStreams = 0;

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    const isAlias = base === '/__lazylayers' && (path === '/observelazyily' || path.startsWith('/observelazyily/'));
    const underRoute = path === base || path.startsWith(`${base}/`) || isAlias;
    if (!underRoute) {
      return false;
    }

    const canonicalPath = isAlias ? path.replace(/^\/observelazyily/, base) : path;

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }

    // Prometheus scrapers may be allowed through without UI credentials.
    const publicMetrics =
      options.prometheus.enabled && options.prometheus.public && canonicalPath === metricsPath;

    if (!publicMetrics && !isAuthorized(req, url, options)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="lazy-layers-cache observability"',
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }

    void route(canonicalPath).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(error) });
      }
    });

    return true;

    async function route(pathname: string): Promise<void> {
      if (pathname === base || pathname === `${base}/`) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboard(base));
        return;
      }

      switch (pathname) {
        case `${base}/api/overview`:
          sendJson(res, 200, collector.overview());
          return;
        case `${base}/api/reset`:
          collector.reset();
          sendJson(res, 200, { message: 'metrics reset', ok: true });
          return;
        case `${base}/api/l1`:
          sendJson(res, 200, await inspector.inspectL1(inspectOptions(url)));
          return;
        case `${base}/api/l2`:
          sendJson(res, 200, await inspector.inspectL2(inspectOptions(url)));
          return;
        case `${base}/api/config`:
          sendJson(res, 200, await inspector.config());
          return;
        case `${base}/stream`:
          if (activeStreams >= maxStreamClients) {
            sendJson(res, 503, { error: 'live event feed client limit reached' });
            return;
          }
          activeStreams += 1;
          streamEvents(req, res, collector, maxStreamEventBytes, () => { activeStreams -= 1; });
          return;
        case metricsPath: {
          if (!options.prometheus.enabled) {
            sendJson(res, 404, { error: 'prometheus disabled' });
            return;
          }
          const gauges = await inspector.sizes();
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(renderPrometheus(collector, options.prometheus.prefix, gauges));
          return;
        }
        default:
          sendJson(res, 404, { error: 'not found' });
      }
    }
  };
}

function inspectOptions(url: URL): StoreInspectOptions {
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  return {
    cursor: url.searchParams.get('cursor') ?? undefined,
    match: url.searchParams.get('match') ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    includeValues: url.searchParams.get('values') !== 'false',
  };
}

function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  collector: ObservabilityCollector,
  maxEventBytes: number,
  release: () => void,
): void {
  let closed = false;
  let blocked = res.writableNeedDrain;
  let unsubscribe = (): void => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    req.off('close', cleanup);
    req.off('aborted', cleanup);
    req.off('error', cleanup);
    res.off('close', cleanup);
    res.off('finish', cleanup);
    res.off('error', cleanup);
    res.off('drain', onDrain);
    release();
  };
  const onDrain = (): void => { if (!closed) blocked = res.writableNeedDrain; };
  const canWrite = (): boolean => {
    if (closed) return false;
    if (res.writableEnded || res.destroyed || !res.writable) { cleanup(); return false; }
    if (res.writableNeedDrain) blocked = true;
    return !blocked;
  };
  const write = (frame: string): boolean => {
    if (!canWrite() || Buffer.byteLength(frame, 'utf8') > maxEventBytes) return false;
    try {
      if (!res.write(frame) || res.writableNeedDrain) blocked = true;
      return !blocked;
    } catch {
      cleanup();
      return false;
    }
  };
  const writeEvent = (event: RecordedEvent): void => {
    if (!canWrite()) return;
    const json = encodeBoundedEvent(event, maxEventBytes - 8); // "data: " + two newlines
    if (json !== undefined) write(`data: ${json}\n\n`);
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
  res.on('drain', onDrain);

  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    write('retry: 3000\n\n');
    // Replay and live events are best effort. No application queue is retained
    // while the socket is blocked; the next live event resumes after drain.
    if (canWrite()) {
      for (const event of collector.recentEvents()) {
        if (!canWrite()) break;
        writeEvent(event);
      }
    }
    if (closed) return;
    unsubscribe = collector.subscribe(writeEvent);
    heartbeat = setInterval(() => { write(': ping\n\n'); }, 25_000);
    heartbeat.unref?.();
  } catch (error) {
    cleanup();
    throw error;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isAuthorized(
  req: IncomingMessage,
  url: URL,
  options: ResolvedObservabilityOptions,
): boolean {
  const { auth } = options;
  if (auth.disabled) {
    return true;
  }

  const header = req.headers.authorization;

  if (auth.token) {
    const queryToken = url.searchParams.get('token');
    if (queryToken && safeEqual(queryToken, auth.token)) {
      return true;
    }
    if (header?.startsWith('Bearer ') && safeEqual(header.slice(7), auth.token)) {
      return true;
    }
  }

  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      const user = decoded.slice(0, separator);
      const pass = decoded.slice(separator + 1);
      if (safeEqual(user, auth.username) && safeEqual(pass, auth.password)) {
        return true;
      }
    }
  }

  return false;
}

/** Constant-time-ish string compare (length-safe). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
