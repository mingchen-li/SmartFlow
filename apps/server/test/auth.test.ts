import { afterEach, describe, expect, it } from 'vitest';
import type { ErrorResponse, Project } from '@sflow/domain';
import {
  bootTestServer,
  getJson,
  login,
  postJson,
  readJson,
  sessionCookie,
  type TestServerHandle,
} from './support';

describe('Project authentication and access boundary', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('rejects a wrong credential and accepts the Project credential', async () => {
    handle = await bootTestServer();

    const rejected = await login(handle.url, 'not-the-credential');
    expect(rejected.status).toBe(401);
    expect((await readJson<ErrorResponse>(rejected)).error.code).toBe('INVALID_CREDENTIAL');

    const accepted = await login(handle.url, handle.credential);
    expect(accepted.status).toBe(200);

    const body = await readJson<{ authenticated: boolean; project: Project }>(accepted);
    expect(body.authenticated).toBe(true);
    expect(body.project.name).toBeTruthy();

    const cookie = sessionCookie(accepted);
    expect(cookie).toBeDefined();
    const setCookie = accepted.headers.getSetCookie().join(';');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const session = await getJson(`${handle.url}/api/auth/session`, cookie);
    expect(session.status).toBe(200);
    expect((await readJson<{ project: Project }>(session)).project.id).toBe(body.project.id);
  });

  it('protects every private Project API route', async () => {
    handle = await bootTestServer();

    const privateRequests: Array<[string, string]> = [
      ['GET', '/api/auth/session'],
      ['GET', '/api/project'],
      ['GET', '/api/files'],
      ['GET', '/api/workflows/binder-design'],
      ['GET', '/api/terminal'],
      ['POST', '/api/auth/logout'],
      ['PUT', '/api/workflows/binder-design'],
      ['POST', '/api/workflows/binder-design/runs'],
      ['DELETE', '/api/nodes/example'],
    ];

    for (const [method, path] of privateRequests) {
      const response = await fetch(`${handle.url}${path}`, { method, redirect: 'manual' });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect((await readJson<ErrorResponse>(response)).error.code).toBe('UNAUTHENTICATED');
    }

    const rotateWithoutSession = await postJson(`${handle.url}/api/auth/rotate`, {
      currentCredential: handle.credential,
      newCredential: 'replacement',
    });
    expect(rotateWithoutSession.status).toBe(401);

    // Health and login are the only public API routes.
    expect((await fetch(`${handle.url}/api/health`)).status).toBe(200);
    expect((await postJson(`${handle.url}/api/auth/login`, { credential: 'wrong' })).status).toBe(
      401,
    );
  });

  it('logs out by clearing the session cookie', async () => {
    handle = await bootTestServer();
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted);

    expect((await getJson(`${handle.url}/api/project`, cookie)).status).toBe(200);

    const loggedOut = await postJson(`${handle.url}/api/auth/logout`, {}, cookie);
    expect(loggedOut.status).toBe(200);
    expect(await readJson(loggedOut)).toEqual({ authenticated: false });
    expect(loggedOut.headers.getSetCookie().join(';')).toContain('sflow_session=;');

    expect((await fetch(`${handle.url}/api/project`)).status).toBe(401);
  });

  it('rotates the credential without invalidating the current session', async () => {
    handle = await bootTestServer();
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted);

    const wrongCurrent = await postJson(
      `${handle.url}/api/auth/rotate`,
      { currentCredential: 'wrong', newCredential: 'next-credential' },
      cookie,
    );
    expect(wrongCurrent.status).toBe(401);

    const rotated = await postJson(
      `${handle.url}/api/auth/rotate`,
      { currentCredential: handle.credential, newCredential: 'next-credential' },
      cookie,
    );
    expect(rotated.status).toBe(200);
    expect(await readJson(rotated)).toEqual({ rotated: true });

    expect((await login(handle.url, handle.credential)).status).toBe(401);
    expect((await login(handle.url, 'next-credential')).status).toBe(200);

    // Rotation changes the credential, not the session signing secret.
    expect((await getJson(`${handle.url}/api/project`, cookie)).status).toBe(200);
  });

  it('generates a credential on first start when none is supplied', async () => {
    handle = await bootTestServer({ generateCredential: true });

    expect(handle.generatedCredential).toBeDefined();
    expect(handle.generatedCredential).not.toBe(handle.credential);
    expect((await login(handle.url, handle.generatedCredential!)).status).toBe(200);
    expect((await login(handle.url, handle.credential)).status).toBe(401);
  });

  it('rejects unauthenticated terminal websocket upgrades', async () => {
    handle = await bootTestServer();

    const opened = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`${handle!.url.replace(/^http/, 'ws')}/api/terminal`);
      const timer = setTimeout(() => {
        socket.close();
        resolve(false);
      }, 3_000);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        socket.close();
        resolve(true);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    expect(opened).toBe(false);
  });

  it('redirects unauthenticated pages to the login page', async () => {
    handle = await bootTestServer();

    const root = await fetch(`${handle.url}/`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/login');

    const loginPage = await fetch(`${handle.url}/login`, { redirect: 'manual' });
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers.get('content-type')).toContain('text/html');
    expect(await loginPage.text()).toContain('SFlow');

    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted);
    const authenticatedRoot = await fetch(`${handle.url}/`, {
      headers: { cookie: cookie! },
      redirect: 'manual',
    });
    expect(authenticatedRoot.status).toBe(200);
    expect(await authenticatedRoot.text()).toContain('SFlow');

    // An authenticated session at /login is sent back to the workspace.
    const authenticatedLogin = await fetch(`${handle.url}/login`, {
      headers: { cookie: cookie! },
      redirect: 'manual',
    });
    expect(authenticatedLogin.status).toBe(302);
    expect(authenticatedLogin.headers.get('location')).toBe('/');
  });
});
