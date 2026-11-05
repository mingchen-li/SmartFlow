import {
  CandidateSetSchema,
  NodeExecutionError,
  ComparisonReportSchema,
  TargetStructureSchema,
  type CandidateSet,
  type ComparisonReport,
  type NodeImplementation,
  type NodeRegistry,
  type NodeRunContext,
  type NodeRunResult,
  type TargetStructure,
} from '@sflow/domain';
import {
  builtinManifests,
  candidateComparisonManifest,
  candidateGenerationManifest,
  sequenceDesignManifest,
  structurePredictionManifest,
  targetInputManifest,
} from './manifests';

/**
 * Deterministic local implementations of the five built-in Binder Nodes.
 *
 * They implement the same ports, parameters, outputs, Metrics, resources, and
 * environment contract as the production Nodes but require no model weights,
 * network, or Slurm. Outputs are deterministic for a given seed: the
 * generated files are byte-identical across Runs and Task namespaces.
 */

const AMINO_ACIDS = 'ACDEFGHIKLMNPQRSTVWY';
const FRAMEWORK = [
  'QVQLVESGGGLVQAGGSLRLSCAAS',
  'GFTFSSYAMSWVRQAPGKEREFVA',
  'RFTISRDNAKNTVYLQMNSLKPEDTAVYYC',
  'WGQGTQVTVSS',
].join('');

const TARGET_SCHEMA = { namespace: 'sflow.binder', name: 'target-structure', version: '1.0.0' };
const CANDIDATE_SET_SCHEMA = {
  namespace: 'sflow.binder',
  name: 'candidate-set',
  version: '1.0.0',
};
const COMPARISON_REPORT_SCHEMA = {
  namespace: 'sflow.binder',
  name: 'comparison-report',
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

/** Mulberry32: small, deterministic, and adequate for test Nodes. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fasta(candidates: CandidateSet['candidates']): string {
  return candidates
    .map((candidate) => `>${candidate.id}\n${candidate.sequence}`)
    .join('\n')
    .concat('\n');
}

function requireNumber(
  parameters: Record<string, unknown>,
  id: string,
  fallback?: number,
): number {
  const value = parameters[id] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NodeExecutionError('parameter', `Parameter "${id}" must be a number.`);
  }
  return value;
}

function requireString(
  parameters: Record<string, unknown>,
  id: string,
  fallback?: string,
): string {
  const value = parameters[id] ?? fallback;
  if (typeof value !== 'string') {
    throw new NodeExecutionError('parameter', `Parameter "${id}" must be text.`);
  }
  return value;
}

function optionalBoolean(parameters: Record<string, unknown>, id: string, fallback: boolean): boolean {
  const value = parameters[id];
  return typeof value === 'boolean' ? value : fallback;
}

function asCandidateSet(value: unknown, portName: string): CandidateSet {
  const parsed = CandidateSetSchema.safeParse(value);
  if (!parsed.success) {
    throw new NodeExecutionError('validation', `Input "${portName}" is not a valid CandidateSet.`);
  }
  return parsed.data;
}

function asNumberMap(scores: CandidateSet['scores']): Map<string, Map<string, number>> {
  const byCandidate = new Map<string, Map<string, number>>();
  for (const score of scores) {
    const metrics = byCandidate.get(score.candidateId) ?? new Map<string, number>();
    metrics.set(score.metricId, score.value);
    byCandidate.set(score.candidateId, metrics);
  }
  return byCandidate;
}

/**
 * Counts residues on the selected chain. FASTA input counts sequence letters;
 * PDB input counts distinct residue numbers on ATOM records for the chain.
 */
function countResidues(contents: string, chain: string): number {
  const lines = contents.split(/\r?\n/);
  if (lines.some((line) => line.startsWith('>'))) {
    return lines
      .filter((line) => !line.startsWith('>') && line.trim().length > 0)
      .join('')
      .replace(/[^A-Za-z]/g, '').length;
  }

  const residues = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('ATOM')) continue;
    const lineChain = line.slice(21, 22).trim() || 'A';
    if (lineChain !== chain) continue;
    residues.add(line.slice(22, 27).trim());
  }
  return residues.size;
}

function parseHotspots(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function generateSequence(random: () => number): string {
  let sequence = FRAMEWORK.slice(0, 75);
  for (let index = 0; index < 15; index += 1) {
    sequence += AMINO_ACIDS[Math.floor(random() * AMINO_ACIDS.length)];
  }
  sequence += FRAMEWORK.slice(75);
  return sequence;
}

function mutateSequence(sequence: string, random: () => number): string {
  const characters = [...sequence];
  const mutations = 1 + Math.floor(random() * 3);
  for (let mutation = 0; mutation < mutations; mutation += 1) {
    const position = Math.floor(random() * characters.length);
    characters[position] = AMINO_ACIDS[Math.floor(random() * AMINO_ACIDS.length)];
  }
  return characters.join('');
}

/** Target input: load a path-backed structure and declare its design context. */
export function runTargetInput(
  _input: Record<string, unknown>,
  parameters: Record<string, unknown>,
  context: NodeRunContext,
): NodeRunResult {
  const targetFile = parameters.targetFile as
    | { fileReferenceId?: unknown; path?: unknown; name?: unknown }
    | undefined;
  if (!targetFile || typeof targetFile.path !== 'string' || targetFile.path.length === 0) {
    throw new NodeExecutionError(
      'parameter',
      'Parameter "targetFile" must select a Project File Reference.',
    );
  }
  if (typeof targetFile.fileReferenceId !== 'string') {
    throw new NodeExecutionError(
      'parameter',
      'Parameter "targetFile" must carry a File Reference id.',
    );
  }

  const contents = context.readProjectFile(targetFile.path);
  if (contents === undefined) {
    throw new NodeExecutionError(
      'validation',
      `Target file "${targetFile.path}" could not be read from the Project.`,
    );
  }

  const chain = requireString(parameters, 'targetChain', 'A');
  const target: TargetStructure = TargetStructureSchema.parse({
    id: `target:${targetFile.fileReferenceId}`,
    name:
      typeof targetFile.name === 'string' && targetFile.name.length > 0
        ? targetFile.name
        : targetFile.path,
    chain,
    residueCount: countResidues(contents, chain),
    hotspots: parseHotspots(parameters.hotspotResidues),
    source: {
      path: targetFile.path,
      fileReferenceId: targetFile.fileReferenceId,
    },
  });

  context.log(`loaded target.path=${target.source.path}`);
  context.log(`loaded target.chain=${target.chain}`);
  context.log(`loaded target.residues=${target.residueCount}`);
  context.writeFile('target.json', json(target));

  return {
    outputs: [
      {
        portId: 'target',
        value: target,
        artifacts: [
          {
            name: 'target.json',
            relativePath: 'target.json',
            mediaType: 'application/json',
            schema: TARGET_SCHEMA,
          },
        ],
      },
    ],
    metrics: { targetResidueCount: target.residueCount },
  };
}

/** Candidate generation: seeded, production-shaped VHH candidate sequences. */
export function runCandidateGeneration(
  input: Record<string, unknown>,
  parameters: Record<string, unknown>,
  context: NodeRunContext,
): NodeRunResult {
  const numCandidates = requireNumber(parameters, 'numCandidates', 100);
  if (!Number.isInteger(numCandidates) || numCandidates < 1) {
    throw new NodeExecutionError(
      'parameter',
      'Parameter "numCandidates" must be a positive integer.',
    );
  }
  const seed = requireNumber(parameters, 'seed', 42);
  if (!Number.isInteger(seed)) {
    throw new NodeExecutionError('parameter', 'Parameter "seed" must be an integer.');
  }
  const strategy = requireString(parameters, 'strategy', 'random');
  const useHotspots = optionalBoolean(parameters, 'useTargetHotspots', true);
  const target =
    input.target && typeof input.target === 'object'
      ? (input.target as Partial<TargetStructure>)
      : undefined;
  const hotspotCount =
    useHotspots && Array.isArray(target?.hotspots) ? target.hotspots.length : 0;

  const candidates = Array.from({ length: numCandidates }, (_, index) => {
    const random = mulberry32(hashSeed(seed, strategy, index, hotspotCount));
    return {
      id: `candidate-${String(index + 1).padStart(4, '0')}`,
      sequence: generateSequence(random),
      generation: 'generated' as const,
      annotation: {
        strategy,
        seed,
        ...(hotspotCount > 0 ? { targetHotspots: hotspotCount } : {}),
      },
    };
  });

  const candidateSet: CandidateSet = CandidateSetSchema.parse({
    id: `candidate-set:${strategy}:${seed}:${numCandidates}`,
    name: 'Generated candidates',
    candidates,
    scores: [],
    context: {
      strategy,
      seed,
      parameters: {
        numCandidates,
        useTargetHotspots: useHotspots,
      },
    },
  });

  context.log(`generated candidates=${candidateSet.candidates.length}`);
  context.log(`generated seed=${seed} strategy=${strategy}`);
  context.writeFile('candidates.json', json(candidateSet));
  context.writeFile('candidates.fasta', fasta(candidateSet.candidates));

  return {
    outputs: [
      {
        portId: 'candidates',
        value: candidateSet,
        artifacts: [
          {
            name: 'candidates.json',
            relativePath: 'candidates.json',
            mediaType: 'application/json',
            schema: CANDIDATE_SET_SCHEMA,
          },
          {
            name: 'candidates.fasta',
            relativePath: 'candidates.fasta',
            mediaType: 'text/x-fasta',
            schema: CANDIDATE_SET_SCHEMA,
          },
        ],
      },
    ],
    metrics: {
      candidateCount: candidateSet.candidates.length,
      uniqueCandidates: new Set(candidateSet.candidates.map((candidate) => candidate.sequence))
        .size,
    },
  };
}

/** Sequence design: deterministic derived sequences for generated Candidates. */
export function runSequenceDesign(
  input: Record<string, unknown>,
  parameters: Record<string, unknown>,
  context: NodeRunContext,
): NodeRunResult {
  const candidates = asCandidateSet(input.candidates, 'candidates');
  const model = requireString(parameters, 'model', 'vhh-designer-v1');
  const temperature = requireNumber(parameters, 'temperature', 0.7);
  const numDesigns = requireNumber(parameters, 'numDesigns', 50);
  if (!Number.isInteger(numDesigns) || numDesigns < 1) {
    throw new NodeExecutionError(
      'parameter',
      'Parameter "numDesigns" must be a positive integer.',
    );
  }
  const randomSeed = requireNumber(parameters, 'randomSeed', 7);
  if (!Number.isInteger(randomSeed)) {
    throw new NodeExecutionError(
      'parameter',
      'Parameter "randomSeed" must be an integer.',
    );
  }
  const trimTerminalTags = optionalBoolean(parameters, 'trimTerminalTags', true);

  const designCount = Math.min(numDesigns, candidates.candidates.length);
  const designs = candidates.candidates.slice(0, designCount).map((parent, index) => {
    const random = mulberry32(hashSeed(randomSeed, model, parent.sequence, index));
    const sequence = mutateSequence(parent.sequence, random);
    return {
      id: `design-${String(index + 1).padStart(4, '0')}`,
      sequence,
      generation: 'designed' as const,
      parentId: parent.id,
      annotation: { model, temperature },
    };
  });

  const scores = designs.map((design) => ({
    candidateId: design.id,
    metricId: 'sequence-confidence',
    value: round(
      mulberry32(hashSeed(randomSeed, 'confidence', design.sequence))() * 0.5 + 0.5,
      4,
    ),
  }));

  const designSet: CandidateSet = CandidateSetSchema.parse({
    id: `design-set:${model}:${randomSeed}:${designCount}`,
    name: 'Designed sequences',
    candidates: designs,
    scores,
    context: {
      strategy: model,
      seed: randomSeed,
      model,
      sourceCandidateSetId: candidates.id,
      parameters: { temperature, trimTerminalTags },
    },
  });

  const meanConfidence =
    scores.length === 0
      ? 0
      : round(scores.reduce((sum, score) => sum + score.value, 0) / scores.length, 4);

  context.log(`designed count=${designSet.candidates.length}`);
  context.log(`designed model=${model} seed=${randomSeed}`);
  context.writeFile('designs.json', json(designSet));
  context.writeFile('designs.fasta', fasta(designSet.candidates));

  return {
    outputs: [
      {
        portId: 'designs',
        value: designSet,
        artifacts: [
          {
            name: 'designs.json',
            relativePath: 'designs.json',
            mediaType: 'application/json',
            schema: CANDIDATE_SET_SCHEMA,
          },
          {
            name: 'designs.fasta',
            relativePath: 'designs.fasta',
            mediaType: 'text/x-fasta',
            schema: CANDIDATE_SET_SCHEMA,
          },
        ],
      },
    ],
    metrics: {
      meanConfidence,
      designCount: designSet.candidates.length,
    },
  };
}

/** Structure prediction/scoring: deterministic pLDDT and ipTM per design. */
export function runStructurePrediction(
  input: Record<string, unknown>,
  parameters: Record<string, unknown>,
  context: NodeRunContext,
): NodeRunResult {
  const designs = asCandidateSet(input.designs, 'designs');
  const predictor = requireString(parameters, 'predictor', 'esmfold2');
  const seed = requireNumber(parameters, 'seed', 1);
  if (!Number.isInteger(seed)) {
    throw new NodeExecutionError('parameter', 'Parameter "seed" must be an integer.');
  }

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

  const byCandidate = asNumberMap(scores);
  const plddtValues: number[] = [];
  const iptmValues: number[] = [];
  for (const metrics of byCandidate.values()) {
    const plddt = metrics.get('plddt');
    const iptm = metrics.get('iptm');
    if (plddt !== undefined) plddtValues.push(plddt);
    if (iptm !== undefined) iptmValues.push(iptm);
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

  context.log(`predicted predictor=${predictor} structures=${designs.candidates.length}`);
  context.writeFile('scored.json', json(scored));
  context.writeFile('scores.csv', csv);
  for (const structure of structures) {
    context.writeFile(`structures/${structure.candidateId}.pdb`, structure.pdb);
  }

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
          schema: { namespace: 'sflow.binder', name: 'predicted-structure', version: '1.0.0' },
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

function scoreFor(candidateId: string, metricId: string, byCandidate: Map<string, Map<string, number>>): number {
  const metrics = byCandidate.get(candidateId);
  if (!metrics) return 0;
  if (metricId === 'binding-score') {
    const explicit = metrics.get('binding-score');
    if (explicit !== undefined) return explicit;
    return (metrics.get('iptm') ?? 0) * 100;
  }
  return metrics.get(metricId) ?? 0;
}

/** Candidate comparison: rank, deduplicate, select, and report. */
export function runCandidateComparison(
  input: Record<string, unknown>,
  parameters: Record<string, unknown>,
  context: NodeRunContext,
): NodeRunResult {
  const scored = asCandidateSet(input.scored, 'scored');
  const topN = requireNumber(parameters, 'topN', 10);
  if (!Number.isInteger(topN) || topN < 1) {
    throw new NodeExecutionError('parameter', 'Parameter "topN" must be a positive integer.');
  }
  const rankingMetric = requireString(parameters, 'rankingMetric', 'plddt');
  const deduplicate = optionalBoolean(parameters, 'deduplicate', true);
  const label = requireString(parameters, 'label', 'round-1');
  const byCandidate = asNumberMap(scored.scores);

  const ranked = scored.candidates
    .map((candidate) => ({
      candidate,
      score: scoreFor(candidate.id, rankingMetric, byCandidate),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.candidate.id.localeCompare(right.candidate.id);
    });

  const selected: typeof ranked = [];
  const seenSequences = new Set<string>();
  for (const entry of ranked) {
    if (deduplicate) {
      if (seenSequences.has(entry.candidate.sequence)) continue;
      seenSequences.add(entry.candidate.sequence);
    }
    selected.push(entry);
    if (selected.length >= topN) break;
  }

  const selectedIds = new Set(selected.map((entry) => entry.candidate.id));
  const selectedScores = scored.scores.filter((score) => selectedIds.has(score.candidateId));

  const ranking: CandidateSet = CandidateSetSchema.parse({
    id: `ranking:${label}:${rankingMetric}:${scored.id}`,
    name: `Ranked candidates (${label})`,
    candidates: selected.map((entry) => entry.candidate),
    scores: selectedScores,
    context: {
      strategy: 'candidate-comparison',
      label,
      sourceCandidateSetId: scored.id,
      parameters: { rankingMetric, topN, deduplicate },
    },
  });

  const plddtScores = scored.scores
    .filter((score) => score.metricId === 'plddt')
    .map((score) => score.value);
  const bestScore = plddtScores.length === 0 ? null : Math.max(...plddtScores);

  const report: ComparisonReport = ComparisonReportSchema.parse({
    label,
    rankingMetric,
    candidateCount: scored.candidates.length,
    selectedCount: selected.length,
    bestScore,
    entries: selected.map((entry, index) => ({
      rank: index + 1,
      candidateId: entry.candidate.id,
      sequence: entry.candidate.sequence,
      score: entry.score,
      scores: scored.scores.filter((score) => score.candidateId === entry.candidate.id),
    })),
  });

  context.log(`compared candidates=${report.candidateCount} selected=${report.selectedCount}`);
  context.log(`compared metric=${rankingMetric} best-plddt=${bestScore ?? 'none'}`);
  context.writeFile('ranking.json', json(ranking));
  context.writeFile('report.json', json(report));

  return {
    outputs: [
      {
        portId: 'ranking',
        value: ranking,
        artifacts: [
          {
            name: 'ranking.json',
            relativePath: 'ranking.json',
            mediaType: 'application/json',
            schema: CANDIDATE_SET_SCHEMA,
          },
        ],
      },
      {
        portId: 'report',
        value: report,
        artifacts: [
          {
            name: 'report.json',
            relativePath: 'report.json',
            mediaType: 'application/json',
            schema: COMPARISON_REPORT_SCHEMA,
          },
        ],
      },
    ],
    metrics: {
      selectedCount: report.selectedCount,
      bestPlddt: bestScore ?? 0,
    },
  };
}

/** The built-in registry pairs every Manifest with one deterministic run. */
export const builtinNodeImplementations: readonly NodeImplementation[] = [
  { manifest: targetInputManifest, run: runTargetInput },
  { manifest: candidateGenerationManifest, run: runCandidateGeneration },
  { manifest: sequenceDesignManifest, run: runSequenceDesign },
  { manifest: structurePredictionManifest, run: runStructurePrediction },
  { manifest: candidateComparisonManifest, run: runCandidateComparison },
];

export function builtinNodeImplementation(
  manifestId: string,
  manifestVersion?: string,
): NodeImplementation | undefined {
  return builtinNodeImplementations.find(
    (implementation) =>
      implementation.manifest.id === manifestId &&
      (manifestVersion === undefined || implementation.manifest.version === manifestVersion),
  );
}

export function createBuiltinNodeRegistry(): NodeRegistry {
  return {
    get: (manifestId, manifestVersion) =>
      builtinNodeImplementation(manifestId, manifestVersion),
    list: () => builtinNodeImplementations,
  };
}

/** Manifest ids and versions implemented by this package. */
export const BUILTIN_NODE_IDS: readonly string[] = builtinManifests.map(
  (manifest) => manifest.id,
);
