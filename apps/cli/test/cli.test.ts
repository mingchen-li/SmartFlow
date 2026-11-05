import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, DEFAULT_PORT, parseStartCommand } from '../src/index';

describe('sflow start command', () => {
  it('parses Project, port, host, browser, and credential options', () => {
    expect(
      parseStartCommand([
        'start',
        '--project',
        '/tmp/sflow-project',
        '--port',
        '8080',
        '--host',
        '0.0.0.0',
        '--no-open',
        '--credential',
        'project-secret',
      ]),
    ).toEqual({
      command: 'start',
      projectDir: '/tmp/sflow-project',
      port: 8080,
      host: '0.0.0.0',
      openBrowser: false,
      credential: 'project-secret',
    });
  });

  it('defaults to the current Project directory, localhost, port 4173, and opening the browser', () => {
    const options = parseStartCommand(['start']);
    expect(options).toMatchObject({
      command: 'start',
      projectDir: process.cwd(),
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      openBrowser: true,
    });
  });

  it('accepts SFLOW_CREDENTIAL when --credential is omitted', () => {
    const previous = process.env.SFLOW_CREDENTIAL;
    process.env.SFLOW_CREDENTIAL = 'environment-secret';
    try {
      expect(parseStartCommand(['start'])).toMatchObject({ credential: 'environment-secret' });
    } finally {
      if (previous === undefined) delete process.env.SFLOW_CREDENTIAL;
      else process.env.SFLOW_CREDENTIAL = previous;
    }
  });

  it('shows help without a command or with --help', () => {
    expect(parseStartCommand([])).toEqual({ help: true });
    expect(parseStartCommand(['--help'])).toEqual({ help: true });
  });

  it('rejects unknown commands and invalid ports', () => {
    expect(() => parseStartCommand(['stop'])).toThrow(/Unknown command/);
    expect(() => parseStartCommand(['start', '--port', 'not-a-port'])).toThrow(/Invalid --port/);
    expect(() => parseStartCommand(['start', '--port', '70000'])).toThrow(/Invalid --port/);
  });
});
