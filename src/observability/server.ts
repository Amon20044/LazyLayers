import { createServer, type Server } from 'node:http';

import type { ObservabilityRequestHandler } from './handler.js';

export interface ObservabilityServerHandle {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface StartObservabilityServerOptions {
  host: string;
  port: number;
  route: string;
}

/**
 * Start a minimal standalone `node:http` server that delegates to the dashboard
 * handler. Bound to the configured host (127.0.0.1 by default). Requests outside
 * the dashboard route get a plain 404.
 */
export function startObservabilityServer(
  handler: ObservabilityRequestHandler,
  options: StartObservabilityServerOptions,
): ObservabilityServerHandle {
  const server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  server.listen(options.port, options.host);

  return {
    server,
    host: options.host,
    port: options.port,
    url: `http://${options.host}:${options.port}${options.route}`,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
