import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  WorkflowDraftSchema,
  type Project,
  type SaveWorkflowDraftRequest,
  type WorkflowDraft,
} from '@sflow/domain';

interface SettingRow {
  value: string;
}

interface DraftRow {
  id: string;
  name: string;
  draft_json: string;
  layout_json: string;
  updated_at: string;
}

const SCRYPT_KEY_LENGTH = 64;

/**
 * Project-scoped persistence. The Project root is the user's directory; SFlow
 * owns `<project>/.sflow/` and never exposes it through the file explorer.
 */
export class ProjectStore {
  readonly root: string;
  readonly sflowDir: string;

  private readonly db: DatabaseSync;
  private closed = false;

  constructor(projectRoot: string) {
    this.root = resolve(projectRoot);
    this.sflowDir = join(this.root, '.sflow');
    mkdirSync(this.sflowDir, { recursive: true });
    mkdirSync(join(this.sflowDir, 'runs'), { recursive: true });
    mkdirSync(join(this.sflowDir, 'executor'), { recursive: true });
    mkdirSync(join(this.sflowDir, 'nodes'), { recursive: true });

    this.db = new DatabaseSync(join(this.sflowDir, 'sflow.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
    this.ensureProjectMetadata();
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as SettingRow | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /**
   * Establishes the one Project credential. A credential supplied by
   * `--credential`/`SFLOW_CREDENTIAL` is used on first start; otherwise a
   * credential is generated and returned so the CLI can print it exactly once.
   */
  initializeCredential(providedCredential?: string): { generatedCredential?: string } {
    if (this.getSetting('auth.hash')) {
      return {};
    }

    if (providedCredential !== undefined && providedCredential.length === 0) {
      throw new Error('The Project credential must not be empty.');
    }

    const generatedCredential =
      providedCredential === undefined ? randomBytes(18).toString('base64url') : undefined;
    this.setCredential(providedCredential ?? generatedCredential!);
    return generatedCredential ? { generatedCredential } : {};
  }

  setCredential(credential: string): void {
    const salt = randomBytes(16).toString('hex');
    this.setSetting('auth.algorithm', 'scrypt');
    this.setSetting('auth.salt', salt);
    this.setSetting('auth.hash', this.hashCredential(credential, salt));
  }

  verifyCredential(credential: string): boolean {
    if (this.getSetting('auth.algorithm') !== 'scrypt') return false;

    const salt = this.getSetting('auth.salt');
    const expectedHex = this.getSetting('auth.hash');
    if (!salt || !expectedHex) return false;

    try {
      const actual = scryptSync(credential, salt, SCRYPT_KEY_LENGTH);
      const expected = Buffer.from(expectedHex, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  getSessionSecret(): string {
    let secret = this.getSetting('auth.sessionSecret');
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      this.setSetting('auth.sessionSecret', secret);
    }
    return secret;
  }

  getProject(): Project {
    const id = this.getSetting('project.id');
    const name = this.getSetting('project.name');
    const createdAt = this.getSetting('project.createdAt');

    if (!id || !name || !createdAt) {
      throw new Error('Project metadata is missing from the Project store.');
    }

    return {
      id,
      name,
      root: this.root,
      createdAt,
      // Run state is derived by later tickets; the shell presents an idle
      // Project until the Orchestrator exists.
      state: 'idle',
    };
  }

  getDraft(id: string): WorkflowDraft | undefined {
    const row = this.db
      .prepare('SELECT id, name, draft_json, layout_json, updated_at FROM workflows WHERE id = ?')
      .get(id) as unknown as DraftRow | undefined;

    if (!row) return undefined;

    try {
      const parsed = WorkflowDraftSchema.safeParse({
        id: row.id,
        name: row.name,
        workflow: JSON.parse(row.draft_json),
        layout: JSON.parse(row.layout_json),
        updatedAt: row.updated_at,
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  saveDraft(id: string, input: SaveWorkflowDraftRequest): WorkflowDraft {
    const updatedAt = new Date().toISOString();
    const layout = input.layout ?? {};

    this.db
      .prepare(
        `INSERT INTO workflows (id, name, draft_json, layout_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           draft_json = excluded.draft_json,
           layout_json = excluded.layout_json,
           updated_at = excluded.updated_at`,
      )
      .run(id, input.name, JSON.stringify(input.workflow), JSON.stringify(layout), updatedAt);

    return {
      id,
      name: input.name,
      workflow: input.workflow,
      layout,
      updatedAt,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private hashCredential(credential: string, salt: string): string {
    return scryptSync(credential, salt, SCRYPT_KEY_LENGTH).toString('hex');
  }

  private ensureProjectMetadata(): void {
    if (this.getSetting('project.id')) return;

    this.transaction(() => {
      this.setSetting('project.id', randomUUID());
      this.setSetting('project.name', basename(this.root) || 'Project');
      this.setSetting('project.createdAt', new Date().toISOString());
    });
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        layout_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        spec_json TEXT,
        logs_path TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        provenance_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS result_views (
        run_id TEXT PRIMARY KEY,
        ir_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_patches (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installed_nodes (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        path TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        task_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS runs_workflow_id ON runs(workflow_id);
      CREATE INDEX IF NOT EXISTS tasks_run_id ON tasks(run_id);
      CREATE INDEX IF NOT EXISTS events_run_id ON events(run_id);
    `);
  }
}
