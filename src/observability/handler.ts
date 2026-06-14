import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { StoreInspectOptions } from '../types/index.js';
import { ObservabilityCollector } from './collector.js';
import { ObservabilityInspector } from './inspector.js';
import { renderDashboard } from './dashboard.js';
import { renderPrometheus } from './prometheus.js';
import type { ResolvedObservabilityOptions } from './types.js';

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

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    const underRoute = path === base || path.startsWith(`${base}/`);
    if (!underRoute) {
      return false;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }

    // Prometheus scrapers may be allowed through without UI credentials.
    const publicMetrics =
      options.prometheus.enabled && options.prometheus.public && path === metricsPath;

    if (!publicMetrics && !isAuthorized(req, url, options)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="lazy-layers-cache observability"',
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }

    void route(path).catch((error) => {
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
          streamEvents(req, res, collector);
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
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  // Replay the current ring buffer so a freshly opened tab has context.
  for (const event of collector.recentEvents()) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = collector.subscribe((event) => {
    // Best-effort write; if the socket is backed up we skip rather than buffer.
    if (!res.writableEnded && res.writable) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 25_000);
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
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
