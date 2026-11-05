import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { TerminalClientMessage, TerminalServerMessage } from '@sflow/domain';
import { bootTestServer, login, sessionCookie, type TestServerHandle } from './support';

interface TerminalSession {
  ws: WebSocket;
  output(): string;
  messages(): TerminalServerMessage[];
  waitForMessage(
    predicate: (message: TerminalServerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<TerminalServerMessage>;
  waitForOutput(text: string, timeoutMs?: number): Promise<void>;
  send(message: TerminalClientMessage): void;
  close(): Promise<void>;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${message}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function openTerminal(baseUrl: string, cookie: string): Promise<TerminalSession> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/terminal`, {
    headers: { cookie },
  });

  const messages: TerminalServerMessage[] = [];
  let output = '';
  const waiters = new Set<() => void>();

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as TerminalServerMessage;
    messages.push(message);
    if (message.type === 'output') output += message.data;
    for (const waiter of [...waiters]) waiter();
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (error) => reject(error));
  });

  function waitForMessage(
    predicate: (message: TerminalServerMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<TerminalServerMessage> {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timed out waiting for terminal message. Received: ${JSON.stringify(messages)}`));
      }, timeoutMs);

      const check = (): void => {
        const match = messages.find(predicate);
        if (!match) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(match);
      };

      waiters.add(check);
    });
  }

  return {
    ws,
    output: () => output,
    messages: () => messages,
    waitForMessage,
    waitForOutput: async (text, timeoutMs = 5_000) => {
      await waitForMessage(
        (message) => message.type === 'output' && output.includes(text),
        timeoutMs,
      );
    },
    send: (message) => ws.send(JSON.stringify(message)),
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.close();
      await closed;
    },
  };
}

async function websocketUpgradeStatus(url: string, cookie?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
    ws.on('open', () => {
      ws.terminate();
      reject(new Error('The websocket upgrade unexpectedly succeeded.'));
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.on('error', reject);
  });
}

describe('Authenticated terminal escape hatch', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;
  let session: TerminalSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function bootWithSession(): Promise<{ cookie: string }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-terminal-'));
    handle = await bootTestServer({ projectRoot });
    const accepted = await login(handle.url, handle.credential);
    return { cookie: sessionCookie(accepted)! };
  }

  it('rejects terminal websocket upgrades without a valid session cookie', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-terminal-'));
    handle = await bootTestServer({ projectRoot });
    const url = `${handle.url.replace(/^http/, 'ws')}/api/terminal`;

    expect(await websocketUpgradeStatus(url)).toBe(401);
    expect(await websocketUpgradeStatus(url, 'sflow_session=forged-signature')).toBe(401);

    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;
    const authenticated = await openTerminal(handle.url, cookie);
    await expect(authenticated.waitForMessage((message) => message.type === 'ready')).resolves.toBeTruthy();
    await authenticated.close();
  });

  it('runs direct commands in the Project directory and acknowledges resize frames', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-terminal-'));
    writeFileSync(join(projectRoot, 'notes.txt'), 'project-file-contents\n');
    handle = await bootTestServer({ projectRoot });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;

    session = await openTerminal(handle.url, cookie);
    const ready = await session.waitForMessage((message) => message.type === 'ready');
    expect(ready).toMatchObject({
      type: 'ready',
      cwd: projectRoot,
    });
    if (ready.type !== 'ready') throw new Error('Expected a ready message.');
    expect(ready.shell.length).toBeGreaterThan(0);

    session.send({
      type: 'input',
      data: 'pwd -P\necho terminal-ok\ncat notes.txt\n',
    });

    await session.waitForOutput('project-file-contents');
    expect(session.output()).toContain('terminal-ok');
    expect(session.output()).toContain(realpathSync(projectRoot));

    session.send({ type: 'resize', cols: 120, rows: 40 });
    const resized = await session.waitForMessage(
      (message) => message.type === 'resized' && message.cols === 120 && message.rows === 40,
    );
    expect(resized).toEqual({ type: 'resized', cols: 120, rows: 40 });

    // The shell keeps accepting commands after a resize.
    session.send({ type: 'input', data: 'echo after-resize\n' });
    await session.waitForOutput('after-resize');

    // The terminal inherits the Server deployment's OS permissions.
    if (process.platform !== 'win32' && typeof process.getuid === 'function') {
      session.send({ type: 'input', data: 'printf "uid:%s\\n" "$(id -u)"\n' });
      await session.waitForOutput(`uid:${process.getuid()}`);
    }
  });

  it('reports protocol errors with the Project error shape without dropping the session', async () => {
    const { cookie } = await bootWithSession();
    session = await openTerminal(handle!.url, cookie);
    await session.waitForMessage((message) => message.type === 'ready');

    session.ws.send('not json');
    const malformed = await session.waitForMessage((message) => message.type === 'error');
    if (malformed.type !== 'error') throw new Error('Expected an error message.');
    expect(malformed.error.code).toBe('INVALID_TERMINAL_MESSAGE');
    expect(malformed.error.message).toBeTruthy();

    session.ws.send(JSON.stringify({ type: 'input' }));
    const invalidShape = await session.waitForMessage(
      (message) => message.type === 'error' && message.error.code === 'INVALID_TERMINAL_MESSAGE',
    );
    expect(invalidShape.type).toBe('error');

    session.send({ type: 'input', data: 'echo still-connected\n' });
    await session.waitForOutput('still-connected');
  });

  it('terminates the shell process when the socket closes', async () => {
    const { cookie } = await bootWithSession();
    session = await openTerminal(handle!.url, cookie);
    await session.waitForMessage((message) => message.type === 'ready');

    session.send({ type: 'input', data: 'echo $$\n' });
    await waitUntil(() => /\d+\r?\n$/.test(session!.output()), 'shell pid output');

    const match = session.output().match(/(\d+)\r?\n$/);
    expect(match).not.toBeNull();
    const shellPid = Number(match![1]);
    expect(processIsAlive(shellPid)).toBe(true);

    await session.close();
    session = undefined;

    await waitUntil(
      () => !processIsAlive(shellPid),
      `shell process ${shellPid} should exit after the socket closes`,
    );
  });

  it('does not record terminal activity as Runs, Tasks, Artifacts, Metrics, or Provenance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sflow-terminal-'));
    projectRoot = root;
    handle = await bootTestServer({ projectRoot: root });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;

    session = await openTerminal(handle.url, cookie);
    await session.waitForMessage((message) => message.type === 'ready');
    session.send({
      type: 'input',
      data: [
        'printf direct > direct-note.txt',
        'cat direct-note.txt',
        'mkdir -p inspected',
        'printf inspected > inspected/inspect.txt',
        'cat inspected/inspect.txt',
        '',
      ].join('\n'),
    });
    await session.waitForOutput('direct');
    await session.waitForOutput('inspected');
    await session.close();
    session = undefined;

    // Stop the Server so the SQLite WAL is settled before inspecting records.
    await handle.close({ cleanupProject: false });
    handle = undefined;

    const database = new DatabaseSync(join(root, '.sflow', 'sflow.db'));
    try {
      const count = (table: string): number =>
        Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
      expect({
        runs: count('runs'),
        tasks: count('tasks'),
        artifacts: count('artifacts'),
        metrics: count('metrics'),
        events: count('events'),
        resultViews: count('result_views'),
      }).toEqual({
        runs: 0,
        tasks: 0,
        artifacts: 0,
        metrics: 0,
        events: 0,
        resultViews: 0,
      });
    } finally {
      database.close();
    }

    expect(existsSync(join(root, 'direct-note.txt'))).toBe(true);
    expect(existsSync(join(root, 'inspected', 'inspect.txt'))).toBe(true);
    expect(readdirSync(join(root, '.sflow', 'runs'))).toEqual([]);
  });
});
