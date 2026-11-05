import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@sflow/domain';
import { ApiError, getSession } from './api';
import { LoginPage } from './components/LoginPage';
import { Workspace } from './components/Workspace';

type AppState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'anonymous' }
  | { status: 'authenticated'; project: Project };

/**
 * The Web entry point. `/` and `/login` are served by the Project Server; the
 * client asks the session endpoint which surface to show. An authenticated
 * session at `/login` is normalised to `/` without a reload.
 */
export function App() {
  const [state, setState] = useState<AppState>({ status: 'loading' });

  const loadSession = useCallback(() => {
    setState({ status: 'loading' });
    getSession()
      .then((session) => {
        if (window.location.pathname === '/login') {
          window.history.replaceState(null, '', '/');
        }
        setState({ status: 'authenticated', project: session.project });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          setState({ status: 'anonymous' });
          return;
        }
        setState({
          status: 'error',
          message:
            error instanceof Error ? error.message : 'The Project Server could not be reached.',
        });
      });
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  if (state.status === 'loading') {
    return <div className="app-loading">Loading SFlow…</div>;
  }

  if (state.status === 'error') {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="login-brand">SFlow</div>
          <h1 className="login-title">Project Server unavailable</h1>
          <p className="login-copy">{state.message}</p>
          <button type="button" className="button button-primary login-submit" onClick={loadSession}>
            Try again
          </button>
        </section>
      </main>
    );
  }

  if (state.status === 'anonymous') {
    return (
      <LoginPage
        onAuthenticated={(project) => {
          window.history.replaceState(null, '', '/');
          setState({ status: 'authenticated', project });
        }}
      />
    );
  }

  return (
    <Workspace
      project={state.project}
      onSignedOut={() => {
        window.history.replaceState(null, '', '/login');
        setState({ status: 'anonymous' });
      }}
    />
  );
}
