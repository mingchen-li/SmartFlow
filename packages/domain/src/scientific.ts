import { z } from 'zod';

/**
 * Typed scientific data produced by Binder Nodes (ticket #7).
 *
 * Candidate identity, CandidateSet generation/comparison context, and
 * per-candidate Metric values are explicit so two contexts are never silently
 * merged.
 * These schemas describe values carried between Tasks and stored inside
 * Artifacts; Run/Task/Provenance identity lives in `execution.ts`.
 */

export const CANDIDATE_SEQUENCE_PATTERN = /^[A-Za-z*.-]+$/;

export const CandidateSchema = z.strictObject({
  id: z.string().min(1).max(200),
  sequence: z
    .string()
    .min(1)
    .max(10_000)
    .regex(CANDIDATE_SEQUENCE_PATTERN, 'Candidate sequences use amino-acid letters.'),
  generation: z.enum(['generated', 'designed', 'imported']).optional(),
  parentId: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  annotation: z.record(z.string(), z.unknown()).optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/**
 * One measured value for one Candidate. `metricId` refers to the producing
 * Node Manifest's Metric declaration; the typed Metric record with meaning,
 * unit or scale, namespaced schema, and Provenance is stored separately.
 */
export const CandidateMetricValueSchema = z.strictObject({
  candidateId: z.string().min(1).max(200),
  metricId: z.string().min(1).max(200),
  value: z.number(),
});
export type CandidateMetricValue = z.infer<typeof CandidateMetricValueSchema>;

/**
 * The generation, filtering, design, or comparison context that makes a set of
 * Candidates distinguishable. A Candidate may live in several CandidateSets.
 */
export const CandidateSetContextSchema = z.strictObject({
  strategy: z.string().min(1).max(200),
  seed: z.number().int().optional(),
  model: z.string().min(1).max(200).optional(),
  sourceCandidateSetId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(200).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type CandidateSetContext = z.infer<typeof CandidateSetContextSchema>;

export const CandidateSetSchema = z.strictObject({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(300),
  candidates: z.array(CandidateSchema),
  metricValues: z.array(CandidateMetricValueSchema),
  context: CandidateSetContextSchema,
});
export type CandidateSet = z.infer<typeof CandidateSetSchema>;

/** The target structure value carried from the target-input Node. */
export const TargetStructureSchema = z.strictObject({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(300),
  chain: z.string().min(1).max(10),
  residueCount: z.number().int().nonnegative(),
  hotspots: z.array(z.number().int().positive()),
  source: z.strictObject({
    path: z.string().min(1),
    fileReferenceId: z.string().min(1),
  }),
});
export type TargetStructure = z.infer<typeof TargetStructureSchema>;

/** Snapshot of ranking output produced by the comparison Node. */
export const ComparisonReportSchema = z.strictObject({
  label: z.string().min(1).max(200),
  rankingMetric: z.string().min(1).max(200),
  candidateCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  bestMetricValue: z.number().nullable(),
  entries: z.array(
    z.strictObject({
      rank: z.number().int().positive(),
      candidateId: z.string().min(1).max(200),
      sequence: z.string().min(1).max(10_000),
      rankingMetricValue: z.number(),
      metricValues: z.array(CandidateMetricValueSchema),
    }),
  ),
});
export type ComparisonReport = z.infer<typeof ComparisonReportSchema>;
