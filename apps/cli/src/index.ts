#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startProjectServer } from '@sflow/server';

export const DEFAULT_PORT = 4173;
export const DEFAULT_HOST = '127.0.0.1';

const USAGE = `SFlow - project-scoped protein design workspace

Usage:
  sflow start [options]

Options:
  --project <dir>     Project directory (default: current directory)
  --port <port>       Port to listen on (default: ${DEFAULT_PORT})
  --host <host>       Host to bind (default: ${DEFAULT_HOST})
  --no-open           Do not open the browser
  --credential <pw>   Set the Project credential on first start
                      (or set SFLOW_CREDENTIAL)
  -h, --help          Show this help`;

export interface StartCommandOptions {
  command: 'start';
  projectDir: string;
  port: number;
  host: string;
  openBrowser: boolean;
  credential?: string;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --port value: ${raw}`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid --port value: ${raw}`);
  }
  return port;
}

export function parseStartCommand(argv: string[]): StartCommandOptions | { help: true } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      project: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      credential: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    return { help: true };
  }

  const [command, ...rest] = positionals;
  if (command !== 'start' || rest.length > 0) {
    throw new Error(`Unknown command: ${positionals.join(' ')}`);
  }

  return {
    command: 'start',
    projectDir: resolve(values.project ?? process.cwd()),
    port: parsePort(values.port ?? String(DEFAULT_PORT)),
    host: values.host ?? DEFAULT_HOST,
    openBrowser: !values['no-open'],
    credential: values.credential ?? process.env.SFLOW_CREDENTIAL,
  };
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // Opening a browser is best-effort; the URL is printed for manual use.
    });
    child.unref();
  } catch {
    // Ignore browser launch failures.
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options;
  try {
    options = parseStartCommand(argv);
  } catch (error) {
    console.error(`sflow: ${(error as Error).message}`);
    console.error('');
    console.error(USAGE);
    return 1;
  }

  if ('help' in options) {
    console.log(USAGE);
    return 0;
  }

  let running;
  try {
    running = await startProjectServer({
      projectRoot: options.projectDir,
      credential: options.credential,
      port: options.port,
      host: options.host,
    });
  } catch (error) {
    console.error(`sflow: could not start the Project Server: ${(error as Error).message}`);
    return 1;
  }

  console.log('SFlow Project Server');
  console.log(`  URL:     ${running.url}`);
  console.log(`  Project: ${running.store.root}`);

  if (running.generatedCredential) {
    console.log('');
    console.log('First start: store this Project credential. It is shown only once.');
    console.log(`  Credential: ${running.generatedCredential}`);
  }

  console.log('');
  console.log('Press Ctrl+C to stop.');

  if (options.openBrowser) {
    openInBrowser(running.url);
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\nStopping SFlow Project Server (${signal})...`);
    void running.close().finally(() => process.exit(0));
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return 0;
}

const entrypoint = process.argv[1];
if (entrypoint && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`sflow: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
