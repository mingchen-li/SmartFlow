import type { FastifyInstance } from 'fastify';

/**
 * Authenticated terminal seam. The WebSocket route is real so the access
 * boundary can be tested; terminal process handling belongs to ticket #4.
 */
export function registerTerminalRoute(app: FastifyInstance): void {
  app.get('/api/terminal', { websocket: true }, (socket) => {
    socket.send(
      JSON.stringify({
        type: 'notice',
        code: 'TERMINAL_NOT_IMPLEMENTED',
        message: 'The SFlow terminal arrives in a later ticket.',
      }),
    );
  });
}
