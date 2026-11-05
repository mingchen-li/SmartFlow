import { describe, expect, it } from 'vitest';
import { NodeManifestSchema } from '@sflow/domain';
import { builtinManifestById } from '@sflow/nodes';
import {
  STRUCTURE_PREDICTION_PRODUCTION_VERSION,
  structurePredictionProductionManifest,
} from '../src';

/**
 * The production implementation replaces the deterministic structure-prediction
 * fixture behind the same scientific contract. These tests pin the Manifest
 * declaration; they do not require model weights, network, Docker, or Slurm.
 */
describe('production structure-prediction Node Manifest', () => {
  it('is a valid versioned Manifest with production container packaging', () => {
    const manifest = structurePredictionProductionManifest;

    expect(NodeManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.id).toBe('structure-prediction');
    expect(manifest.version).toBe(STRUCTURE_PREDICTION_PRODUCTION_VERSION);
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.environment.kind).toBe('container');
    expect(manifest.environment.image).toContain('structure-prediction');
    expect(manifest.environment.image).toContain('2.0.0');
    expect(manifest.environment.command?.length).toBeGreaterThan(0);
    expect(manifest.environment.command).toContain('--task-input');
    expect(manifest.environment.command).toContain('result.json');
    expect(manifest.resources.cpu).toBeGreaterThan(0);
    expect(manifest.resources.gpu).toBeGreaterThan(0);
    expect(manifest.retry.maxAttempts).toBeGreaterThanOrEqual(1);
  });

  it('declares the same ports, parameters, outputs, Metrics, resources, and retry policy as the deterministic fixture', () => {
    const fixture = builtinManifestById('structure-prediction');
    expect(fixture).toBeDefined();
    const production = structurePredictionProductionManifest;

    expect(production.inputs).toEqual(fixture!.inputs);
    expect(production.outputs).toEqual(fixture!.outputs);
    expect(production.parameters).toEqual(fixture!.parameters);
    expect(production.metrics).toEqual(fixture!.metrics);
    expect(production.resources).toEqual(fixture!.resources);
    expect(production.retry).toEqual(fixture!.retry);
    expect(production.category).toBe(fixture!.category);
    expect(production.type).toBe(fixture!.type);

    // The replacement is versioned, not a silent overwrite of the fixture.
    expect(production.version).not.toBe(fixture!.version);
    expect(production.environment.image).not.toBe(fixture!.environment.image);
    expect(production.environment.command).not.toEqual(fixture!.environment.command);
  });
});
