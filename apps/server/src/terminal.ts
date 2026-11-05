import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { FastifyInstance } from 'fastify';
import {
  TerminalClientMessageSchema,
  type TerminalServerMessage,
} from '@sflow/domain';
import type { ProjectStore } from './store';

const WEBSOCKET_OPEN = 1;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const KILL_GRACE_MS = 1_500;

interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * The shell always belongs to the deployment, never to a user account: SFlow
 * has one Project credential. Commands inherit the Server process's OS
 * permissions and run with the Project directory as their working directory.
 */
function defaultShellCommand(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/sh';
}

/**
 * `WS /api/terminal` — the authenticated terminal escape hatch.
 *
 * A `child_process` shell (no PTY, per the architecture) is started for each
 * authenticated socket. Output is streamed as JSON frames; input and resize
 * frames are validated against the shared domain schema. A piped shell has no
 * PTY to resize, so resize frames update the session's recorded dimensions and
 * are acknowledged without signalling the running shell. Closing the socket
 * terminates the shell's process group.
 */
export function registerTerminalRoute(app: FastifyInstance, store: ProjectStore): void {
  app.get('/api/terminal', { websocket: true }, (socket) => {
    let size: TerminalSize = { cols: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;

    const send = (message: TerminalServerMessage): void => {
      if (socket.readyState !== WEBSOCKET_OPEN) return;
      socket.send(JSON.stringify(message));
    };

    const sendError = (code: string, message: string, details?: unknown): void => {
      send(
        details === undefined
          ? { type: 'error', error: { code, message } }
          : { type: 'error', error: { code, message, details } },
      );
    };

    const signalChild = (signal: NodeJS.Signals): void => {
      if (!child || exited) return;

      // The child is its own process-group leader on POSIX, so this also stops
      // commands it started (for example a long-running scientific tool).
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to signalling the shell process itself.
        }
      }

      child.kill(signal);
    };

    const shell = defaultShellCommand();

    try {
      child = spawn(shell, [], {
        cwd: store.root,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLUMNS: String(size.cols),
          LINES: String(size.rows),
          PWD: store.root,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch {
      sendError('TERMINAL_START_FAILED', 'The terminal shell could not be started.');
      socket.close(1011, 'terminal failed');
      return;
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    child.stdout.on('data', (chunk: Buffer) => {
      send({ type: 'output', data: stdoutDecoder.write(chunk) });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      send({ type: 'output', data: stderrDecoder.write(chunk) });
    });
    child.stdout.on('end', () => {
      const tail = stdoutDecoder.end();
      if (tail) send({ type: 'output', data: tail });
    });
    child.stderr.on('end', () => {
      const tail = stderrDecoder.end();
      if (tail) send({ type: 'output', data: tail });
    });

    // A closed stdin is a normal race when the shell exits; never let it
    // become an unhandled error.
    child.stdin.on('error', () => {});

    child.once('error', (error) => {
      exited = true;
      sendError('TERMINAL_START_FAILED', 'The terminal shell could not be started.', {
        reason: error.message,
      });
      socket.close(1011, 'terminal failed');
    });

    child.once('exit', (code, signal) => {
      exited = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      send({ type: 'exit', code, signal: signal ?? null });
      socket.close(1000, 'terminal exited');
    });

    socket.on('message', (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        sendError('INVALID_TERMINAL_MESSAGE', 'Terminal messages must be JSON.');
        return;
      }

      const parsed = TerminalClientMessageSchema.safeParse(payload);
      if (!parsed.success) {
        sendError(
          'INVALID_TERMINAL_MESSAGE',
          'The terminal message was not valid.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
        return;
      }

      if (parsed.data.type === 'resize') {
        size = { cols: parsed.data.cols, rows: parsed.data.rows };
        send({ type: 'resized', cols: size.cols, rows: size.rows });
        return;
      }

      if (!child || exited) {
        sendError('TERMINAL_NOT_RUNNING', 'The terminal shell is no longer running.');
        return;
      }

      child.stdin.write(parsed.data.data);
    });

    socket.on('close', () => {
      signalChild('SIGTERM');
      if (!exited) {
        killTimer = setTimeout(() => signalChild('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
      }
    });

    socket.on('error', () => {
      // The close handler owns teardown.
    });

    send({ type: 'ready', cwd: store.root, shell });
  });
}
