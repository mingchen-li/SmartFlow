import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Project } from '@sflow/domain';
import { ApiError, login } from '../api';

export interface LoginPageProps {
  onAuthenticated: (project: Project) => void;
}

type LoginError = { kind: 'invalid' } | { kind: 'raw'; message: string };

/**
 * The one Project credential sign-in surface. Both local and remote access go
 * through this form; the Server sets an HTTP-only session cookie on success.
 */
export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [credential, setCredential] = useState('');
  const [error, setError] = useState<LoginError | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!credential.trim() || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await login(credential);
      onAuthenticated(response.project);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError({ kind: 'invalid' });
      } else {
        setError({ kind: 'raw', message: cause instanceof Error ? cause.message : '' });
      }
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-header">
          <div className="login-brand">SFlow</div>
        </div>
        <h1 className="login-title" id="login-title">
          Sign in to your Project
        </h1>
        <p className="login-copy">
          Enter the credential for this Project Server. The same credential is required whether you
          are working locally or connecting remotely.
        </p>

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="label" htmlFor="project-credential">
              Project credential
            </label>
            <input
              id="project-credential"
              className="input"
              type="password"
              name="credential"
              autoComplete="current-password"
              autoFocus
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
            {error ? (
              <p className="error-text" id="login-error" role="alert">
                {error.kind === 'invalid'
                  ? 'Invalid Project credential.'
                  : error.message || 'Sign-in failed.'}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            className="button button-primary login-submit"
            disabled={busy || credential.trim().length === 0}
          >
            {busy ? 'Signing in…' : 'Open workspace'}
          </button>
        </form>
      </section>
    </main>
  );
}
