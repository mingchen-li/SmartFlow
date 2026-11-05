import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Project } from '@sflow/domain';
import { logout, rotateCredential } from '../api';

export interface SettingsDialogProps {
  project: Project;
  onClose: () => void;
  onSignedOut: () => void;
}

const ERROR_MESSAGES = {
  mismatch: 'The new credential and its confirmation do not match.',
  rotateFailed: 'The Project credential could not be rotated.',
  signOutFailed: 'Sign-out failed.',
} as const;

type SettingsError = keyof typeof ERROR_MESSAGES;

/** Project settings: identity, credential rotation, and sign-out. */
export function SettingsDialog({ project, onClose, onSignedOut }: SettingsDialogProps) {
  const [currentCredential, setCurrentCredential] = useState('');
  const [newCredential, setNewCredential] = useState('');
  const [confirmCredential, setConfirmCredential] = useState('');
  const [error, setError] = useState<SettingsError | null>(null);
  const [rotated, setRotated] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function onRotate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setRotated(false);

    if (newCredential !== confirmCredential) {
      setError('mismatch');
      return;
    }

    setBusy(true);
    try {
      await rotateCredential(currentCredential, newCredential);
      setRotated(true);
      setCurrentCredential('');
      setNewCredential('');
      setConfirmCredential('');
    } catch {
      setError('rotateFailed');
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut(): Promise<void> {
    setBusy(true);
    try {
      await logout();
      onSignedOut();
    } catch {
      setBusy(false);
      setError('signOutFailed');
    }
  }

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings-dialog"
      >
        <header className="dialog-header">
          <h2 className="dialog-title" id="settings-title">
            Project settings
          </h2>
          <button
            type="button"
            className="button button-ghost button-icon"
            aria-label="Close project settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <section>
          <h3 className="section-title">Project</h3>
          <div className="field">
            <span className="label">Name</span>
            <p className="settings-meta">{project.name}</p>
          </div>
          <div className="field">
            <span className="label">Directory</span>
            <p className="settings-meta">{project.root}</p>
          </div>
        </section>

        <section>
          <h3 className="section-title">Credential</h3>
          <p className="muted">
            One credential protects this Project Server for local and remote access. Rotating it
            keeps the current session signed in.
          </p>

          <form onSubmit={(event) => void onRotate(event)}>
            <div className="field">
              <label className="label" htmlFor="current-credential">
                Current credential
              </label>
              <input
                id="current-credential"
                className="input"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={currentCredential}
                onChange={(event) => setCurrentCredential(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="new-credential">
                New credential
              </label>
              <input
                id="new-credential"
                className="input"
                type="password"
                autoComplete="new-password"
                value={newCredential}
                onChange={(event) => setNewCredential(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="confirm-credential">
                Confirm new credential
              </label>
              <input
                id="confirm-credential"
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirmCredential}
                onChange={(event) => setConfirmCredential(event.target.value)}
              />
            </div>

            {error ? (
              <p className="error-text" role="alert">
                {ERROR_MESSAGES[error]}
              </p>
            ) : null}
            {rotated ? (
              <p className="success-text" role="status">
                Project credential rotated.
              </p>
            ) : null}

            <div className="dialog-actions">
              <button
                type="submit"
                className="button button-primary"
                disabled={
                  busy ||
                  currentCredential.length === 0 ||
                  newCredential.length === 0 ||
                  confirmCredential.length === 0
                }
              >
                {busy ? 'Rotating…' : 'Rotate credential'}
              </button>
            </div>
          </form>
        </section>

        <footer className="settings-footer">
          <span className="muted">Signed in with the Project credential.</span>
          <button
            type="button"
            className="button button-outline"
            onClick={() => void onSignOut()}
            disabled={busy}
          >
            Sign out
          </button>
        </footer>
      </section>
    </div>
  );
}
