import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, type TestServerHandle } from './support';

describe('Project Server health', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('boots the real Fastify app on an ephemeral port and serves public health', async () => {
    handle = await bootTestServer();

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${handle.url}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', name: 'SFlow' });
  });
});
