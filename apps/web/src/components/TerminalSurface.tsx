import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { TerminalServerMessageSchema, type TerminalClientMessage } from '@sflow/domain';

const MAX_RECONNECT_ATTEMPTS = 5;
const WEBSOCKET_OPEN = 1;

type TerminalConnection =
  | { status: 'connecting' }
  | { status: 'connected'; cwd: string }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'ended'; code: number | null }
  | { status: 'error'; message: string };

function terminalWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/terminal`;
}

/** Reads a Matwings token so raw colors stay in `tokens.css`. */
function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function connectionLabel(connection: TerminalConnection): string {
  switch (connection.status) {
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return `Connected — ${connection.cwd}`;
    case 'reconnecting':
      return `Disconnected — reconnecting (attempt ${connection.attempt})…`;
    case 'ended':
      return 'Session ended';
    case 'error':
      return connection.message;
  }
}

/**
 * The authenticated terminal escape hatch. The WebSocket is opened only when
 * this component is mounted, and the Workspace mounts it only for an
 * authenticated session inside the Terminal section. Commands run directly in
 * the Project directory and are deliberately not part of Run/Task/Provenance
 * history.
 */
export function TerminalSurface() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const lineRef = useRef('');
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const sessionEndedRef = useRef(false);
  const [connection, setConnection] = useState<TerminalConnection>({ status: 'connecting' });
  const [generation, setGeneration] = useState(0);

  const send = useCallback((message: TerminalClientMessage) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WEBSOCKET_OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  // The terminal instance and its DOM survive reconnects so output history is
  // not lost when the shell restarts.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 2_000,
      screenReaderMode: true,
      theme: {
        background: cssToken('--color-surface-white'),
        foreground: cssToken('--color-text-primary'),
        cursor: cssToken('--color-brand-primary'),
        selectionBackground: cssToken('--color-brand-arcoblue-2'),
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fit = (): void => {
      try {
        fitAddon.fit();
      } catch {
        // The host can be detached briefly while panels collapse.
      }
    };

    // Input is edited locally and submitted one line at a time: without a PTY
    // the shell reads a pipe, not keystrokes, so raw editing keys would corrupt
    // commands.
    const onData = terminal.onData((data) => {
      // Function keys and other escape sequences have no meaning in the
      // piped, non-PTY shell.
      if (data.startsWith('\x1b')) return;

      for (const character of data) {
        if (character === '\r' || character === '\n') {
          const command = lineRef.current;
          lineRef.current = '';
          terminal.write('\r\n');
          send({ type: 'input', data: `${command}\n` });
          continue;
        }

        if (character === '\x7f') {
          if (lineRef.current.length > 0) {
            lineRef.current = lineRef.current.slice(0, -1);
            terminal.write('\b \b');
          }
          continue;
        }

        if (character === '\x03') {
          lineRef.current = '';
          terminal.write('^C\r\n');
          continue;
        }

        if (character === '\x0c') {
          terminal.clear();
          continue;
        }

        if (character < ' ') continue;

        lineRef.current += character;
        terminal.write(character);
      }
    });

    const onResize = terminal.onResize(({ cols, rows }) => {
      send({ type: 'resize', cols, rows });
    });

    const observer = new ResizeObserver(fit);
    observer.observe(host);
    const frame = window.requestAnimationFrame(fit);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [send]);

  // One WebSocket per connection generation. Terminal output is written into
  // the persistent xterm instance above.
  useEffect(() => {
    const terminal = terminalRef.current;
    const socket = new WebSocket(terminalWebSocketUrl());
    socketRef.current = socket;
    let disposed = false;
    let sessionEnded = false;

    sessionEndedRef.current = false;
    setConnection({ status: 'connecting' });

    socket.addEventListener('message', (event) => {
      const parsed = TerminalServerMessageSchema.safeParse(
        (() => {
          try {
            return JSON.parse(String(event.data));
          } catch {
            return undefined;
          }
        })(),
      );

      if (!parsed.success) {
        terminal?.write('\r\n[terminal] Received an invalid message from the Server.\r\n');
        return;
      }

      const message = parsed.data;
      switch (message.type) {
        case 'ready':
          reconnectAttemptsRef.current = 0;
          setConnection({ status: 'connected', cwd: message.cwd });
          fitAddonRef.current?.fit();
          if (terminal) {
            socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
          }
          break;
        case 'output':
          terminal?.write(message.data);
          break;
        case 'resized':
          break;
        case 'exit':
          sessionEnded = true;
          sessionEndedRef.current = true;
          terminal?.write('\r\n');
          setConnection({ status: 'ended', code: message.code });
          break;
        case 'error':
          if (message.error.code === 'TERMINAL_START_FAILED') {
            sessionEnded = true;
          }
          setConnection({ status: 'error', message: message.error.message });
          terminal?.write(`\r\n[terminal] ${message.error.message}\r\n`);
          break;
      }
    });

    socket.addEventListener('close', () => {
      if (disposed) return;
      if (sessionEnded || sessionEndedRef.current) {
        return;
      }

      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        setConnection({
          status: 'error',
          message: 'Terminal disconnected. Check the Project Server and reconnect.',
        });
        return;
      }

      setConnection({ status: 'reconnecting', attempt });
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        setGeneration((value) => value + 1);
      }, Math.min(1_000 * 2 ** (attempt - 1), 8_000));
    });

    // The close handler owns reconnection, so an error before close is not
    // surfaced separately to avoid duplicate messages.
    socket.addEventListener('error', () => {});

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socketRef.current = null;
      if (socket.readyState === WEBSOCKET_OPEN || socket.readyState === 0) {
        socket.close();
      }
    };
  }, [generation]);

  const reconnect = useCallback(() => {
    sessionEndedRef.current = false;
    reconnectAttemptsRef.current = 0;
    terminalRef.current?.write('\r\n');
    terminalRef.current?.focus();
    setGeneration((value) => value + 1);
  }, []);

  const canRestart = connection.status === 'ended' || connection.status === 'error';

  return (
    <div className="terminal-surface" data-testid="terminal-surface">
      <div className="terminal-notice" data-testid="terminal-out-of-band-notice" role="note">
        <strong>Outside Run history.</strong> Terminal commands run directly under this
        deployment&apos;s permissions. They are outside SFlow Run, Task, and Provenance history and
        are not recorded.
      </div>

      <div className="terminal-status-bar">
        <span
          className={`terminal-status terminal-status-${connection.status}`}
          data-testid="terminal-status"
          role="status"
        >
          {connectionLabel(connection)}
        </span>
        {canRestart ? (
          <button type="button" className="button button-outline button-sm" onClick={reconnect}>
            {connection.status === 'ended' ? 'Restart terminal' : 'Reconnect'}
          </button>
        ) : null}
      </div>

      <div className="terminal-host" ref={hostRef} data-testid="terminal-host" />
    </div>
  );
}
