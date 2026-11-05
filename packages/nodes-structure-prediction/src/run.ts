import {
  CandidateSetSchema,
  NodeExecutionError,
  type CandidateSet,
  type NodeRunContext,
  type NodeRunResult,
} from '@sflow/domain';

/**
 * Deterministic simulation of the production structure-prediction model.
 *
 * The scientific contract is the same as the deterministic fixture: pLDDT and
 * ipTM scores per design, a scored CandidateSet, a CSV summary, and predicted
 * structure files. The production package owns this implementation, so model
 * behavior, packaging, and failures stay localized here instead of leaking
 * into the Orchestrator or surrounding scientific records.
 */

const CANDIDATE_SET_SCHEMA = {
  namespace: 'sflow.binder',
  name: 'candidate-set',
  version: '1.0.0',
};
const PREDICTED_STRUCTURE_SCHEMA = {
  namespace: 'sflow.binder',
  name: 'predicted-structure',
  version: '1.0.0',
};

/** FNV-1a over UTF-16 code units; stable across platforms and processes. */
function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hashSeed(...parts: Array<string | number>): number {
  return hashText(parts.join(':'));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireString(
  parameters: Record<string, unknown>,
  id: string,
  fallback: string,
): string {
  const value = parameters[id] ?? fallback;
  if (typeof value !== 'string') {
    throw new NodeExecutionError(
      'parameter',
      `Production structure prediction requires parameter "${id}" to be text.`,
    );
  }
  return value;
}

function requireInteger(
  parameters: Record<string, unknown>,
  id: string,
  fallback: number,
): number {
  const value = parameters[id] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new NodeExecutionError(
      'parameter',
      `Production structure prediction requires parameter "${id}" to be an integer.`,
    );
  }
  return value;
}

function requireCandidateSet(value: unknown, portId: string): CandidateSet {
  const parsed = CandidateSetSchema.safeParse(value);
  if (!parsed.success) {
    throw new NodeExecutionError(
      'validation',
      `Production structure prediction requires a valid CandidateSet on input "${portId}".`,
    );
  }
  return parsed.data;
}

export function runProductionStructurePrediction(
  input: Record<string, unknown>,
  parameters: Record<string, unknown>,
  context: NodeRunContext,
): NodeRunResult {
  const designs = requireCandidateSet(input.designs, 'designs');
  const predictor = requireString(parameters, 'predictor', 'esmfold2');
  const seed = requireInteger(parameters, 'seed', 1);

  context.log(
    `structure-prediction-production model=${predictor} designs=${designs.candidates.length}`,
  );

  const scores: CandidateSet['scores'] = [];
  const structures: Array<{ candidateId: string; pdb: string }> = [];

  for (const candidate of designs.candidates) {
    const plddt = round(40 + (hashSeed(seed, 'plddt', candidate.sequence) % 6000) / 100, 2);
    const iptm = round((hashSeed(seed, 'iptm', candidate.sequence) % 10_000) / 10_000, 4);
    scores.push(
      { candidateId: candidate.id, metricId: 'plddt', value: plddt },
      { candidateId: candidate.id, metricId: 'iptm', value: iptm },
    );
    structures.push({
      candidateId: candidate.id,
      pdb: [
        `HEADER PREDICTED ${candidate.id}`,
        `REMARK predictor=${predictor} plddt=${plddt} iptm=${iptm}`,
        'ATOM      1  CA  ALA A   1      11.104   6.134  -6.504  1.00  0.00           C',
        'END',
        '',
      ].join('\n'),
    });
  }

  const scored: CandidateSet = CandidateSetSchema.parse({
    id: `scored-set:${predictor}:${seed}:${designs.id}`,
    name: 'Scored candidates',
    candidates: designs.candidates,
    scores,
    context: {
      strategy: 'structure-prediction',
      seed,
      model: predictor,
      sourceCandidateSetId: designs.id,
      parameters: {
        recycles: parameters.recycles,
        batchSize: parameters.batchSize,
      },
    },
  });

  const plddtValues: number[] = [];
  const iptmValues: number[] = [];
  for (const score of scores) {
    if (score.metricId === 'plddt') plddtValues.push(score.value);
    if (score.metricId === 'iptm') iptmValues.push(score.value);
  }

  const byCandidate = new Map<string, Map<string, number>>();
  for (const score of scores) {
    const metrics = byCandidate.get(score.candidateId) ?? new Map<string, number>();
    metrics.set(score.metricId, score.value);
    byCandidate.set(score.candidateId, metrics);
  }

  const csv = [
    'candidateId,sequence,plddt,iptm,binding-score',
    ...designs.candidates.map((candidate) => {
      const metrics = byCandidate.get(candidate.id);
      const plddt = metrics?.get('plddt') ?? 0;
      const iptm = metrics?.get('iptm') ?? 0;
      return `${candidate.id},${candidate.sequence},${plddt},${iptm},${round(iptm * 100, 2)}`;
    }),
  ]
    .join('\n')
    .concat('\n');

  context.writeFile('scored.json', json(scored));
  context.writeFile('scores.csv', csv);
  for (const structure of structures) {
    context.writeFile(`structures/${structure.candidateId}.pdb`, structure.pdb);
  }

  context.log(
    `structure-prediction-production scored=${designs.candidates.length} predictor=${predictor}`,
  );

  return {
    outputs: [
      {
        portId: 'scored',
        value: scored,
        artifacts: [
          {
            name: 'scored.json',
            relativePath: 'scored.json',
            mediaType: 'application/json',
            schema: CANDIDATE_SET_SCHEMA,
          },
          {
            name: 'scores.csv',
            relativePath: 'scores.csv',
            mediaType: 'text/csv',
            schema: CANDIDATE_SET_SCHEMA,
          },
        ],
      },
      {
        portId: 'structures',
        value: structures.map((structure) => ({
          candidateId: structure.candidateId,
          path: `structures/${structure.candidateId}.pdb`,
        })),
        artifacts: structures.map((structure) => ({
          name: `${structure.candidateId}.pdb`,
          relativePath: `structures/${structure.candidateId}.pdb`,
          mediaType: 'chemical/x-pdb',
          schema: PREDICTED_STRUCTURE_SCHEMA,
        })),
      },
    ],
    metrics: {
      meanPlddt:
        plddtValues.length === 0
          ? 0
          : round(plddtValues.reduce((sum, value) => sum + value, 0) / plddtValues.length, 2),
      meanIptm:
        iptmValues.length === 0
          ? 0
          : round(iptmValues.reduce((sum, value) => sum + value, 0) / iptmValues.length, 4),
      scoredCount: designs.candidates.length,
    },
  };
}
