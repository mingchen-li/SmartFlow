import { afterEach, describe, expect, it } from 'vitest';
import { NodeCatalogResponseSchema, type ErrorResponse, type NodeManifest } from '@sflow/domain';
import {
  bootTestServer,
  getJson,
  login,
  readJson,
  sessionCookie,
  type TestServerHandle,
} from './support';

describe('Node catalog API', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function signIn(): Promise<string> {
    handle = await bootTestServer();
    const accepted = await login(handle.url, handle.credential);
    return sessionCookie(accepted)!;
  }

  it('requires authentication', async () => {
    handle = await bootTestServer();

    const response = await getJson(`${handle.url}/api/nodes`);
    expect(response.status).toBe(401);
    expect((await readJson<ErrorResponse>(response)).error.code).toBe('UNAUTHENTICATED');
  });

  it('lists built-in Node Manifests with generated-form metadata', async () => {
    const cookie = await signIn();

    const response = await getJson(`${handle!.url}/api/nodes`, cookie);
    expect(response.status).toBe(200);
    const catalog = NodeCatalogResponseSchema.parse(await readJson(response));

    expect(catalog.nodes.map((manifest) => manifest.id)).toEqual([
      'target-input',
      'candidate-generation',
      'sequence-design',
      'structure-prediction',
      'candidate-comparison',
    ]);

    const sequenceDesign = catalog.nodes.find(
      (manifest) => manifest.id === 'sequence-design',
    )!;
    expect(sequenceDesign.category).toBe('Protein design');
    expect(sequenceDesign.parameters.map((parameter) => parameter.type)).toEqual(
      expect.arrayContaining(['enum', 'number', 'boolean']),
    );
    expect(sequenceDesign.inputs.map((port) => port.id)).toEqual([
      'candidates',
      'control-in',
    ]);
    expect(sequenceDesign.outputs.map((port) => port.id)).toEqual([
      'designs',
      'control-out',
    ]);
  });

  it('returns a single Manifest and reports an unknown id', async () => {
    const cookie = await signIn();

    const found = await getJson(`${handle!.url}/api/nodes/target-input`, cookie);
    expect(found.status).toBe(200);
    const manifest = (await readJson<NodeManifest>(found));
    expect(manifest.id).toBe('target-input');
    expect(manifest.parameters[0]).toMatchObject({
      id: 'targetFile',
      type: 'file-reference',
      required: true,
    });

    const missing = await getJson(`${handle!.url}/api/nodes/not-a-node`, cookie);
    expect(missing.status).toBe(404);
    expect((await readJson<ErrorResponse>(missing)).error.code).toBe('NOT_FOUND');
  });
});
