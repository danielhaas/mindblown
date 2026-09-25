/**
 * Calibrated effort estimate for one piece of work, reasoning from the
 * map's own completed leaves. Extracted from POST /api/ai/estimate so the
 * ticket-intake flow can attach the same number to a draft (#387) without
 * a second HTTP hop.
 *
 * The estimate stays in RAW planning units. The evidence-gated fudge is
 * reported, never multiplied in — forecasts apply it to remaining effort,
 * so baking it in here double-corrected every AI-estimated node (fudge²).
 */

import { assessCalibration, type Node as CoreNode, type MindMap } from '@mindblown/core';
import type { ChatProvider } from './providers/types.js';

export interface EstimateTarget {
  text: string;
  description?: string;
  /** Ancestor path rendered as "A → B → C". */
  path?: string;
  hint?: string;
}

export interface EstimateResult {
  estimate: number;
  rawEstimate: number;
  confidence: 'low' | 'medium' | 'high';
  notes?: string;
  samplesUsed: number;
  fudgeFactor: number | null;
  calibrationNote: string | null;
  effortUnit: string;
}

export class AiBadResponseError extends Error {
  readonly code = 'AI_BAD_RESPONSE' as const;
}

export async function estimateEffort(
  provider: ChatProvider,
  mapDetail: { map: MindMap; nodes: CoreNode[] },
  target: EstimateTarget,
): Promise<EstimateResult> {
  // Calibration samples: completed leaves with estimate and actual set.
  // The 30 most recent by updatedAt so old noisy data doesn't dominate.
  const calibrationLeaves = mapDetail.nodes
    .filter(
      (n) =>
        (n.childrenIds?.length ?? 0) === 0 &&
        n.effortEstimate != null &&
        n.actualEffort != null,
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 30);

  const calibration = assessCalibration(
    calibrationLeaves.map((n) => ({
      effortEstimate: n.effortEstimate as number,
      actualEffort: n.actualEffort as number,
      completedAt: n.completedAt ?? null,
    })),
  );
  const effortUnit = mapDetail.map.effortUnit ?? 'days';

  const samplesText =
    calibrationLeaves.length > 0
      ? calibrationLeaves
          .map(
            (n, i) =>
              `${i + 1}. "${n.text}" — estimated ${n.effortEstimate} ${effortUnit}, actual ${n.actualEffort} ${effortUnit}`,
          )
          .join('\n')
      : '(no calibration data yet — give an unscaled best-guess estimate)';

  const systemPrompt = `You are a project estimation assistant. You produce calibrated effort estimates by reasoning from past completed work on the same project.

Rules:
- Return ONLY a JSON object: {"estimate": <number>, "confidence": "low" | "medium" | "high", "notes": "<one short sentence>"}
- The raw estimate you produce should be in ${effortUnit}, in the SAME scale the team uses when planning (uncalibrated — velocity corrections happen at forecast time, never in stored estimates)
- Confidence is "high" when multiple samples strongly match, "medium" when you're inferring from loose analogies, "low" when calibration data is thin or the task is unusual
- Notes should be one brief sentence justifying the estimate (e.g. "Similar to #3 and #7; added buffer for migration")
- No preamble, no markdown fences, no explanation outside the JSON`;

  let userPrompt = `Project: ${mapDetail.map.name}
Effort unit: ${effortUnit}

Past completed work (planned → actual):
${samplesText}

New item to estimate:
Title: "${target.text}"`;
  if (target.path) userPrompt += `\nPath: ${target.path}`;
  if (target.description) userPrompt += `\nDescription: ${target.description}`;
  if (target.hint) userPrompt += `\nHint: ${target.hint}`;
  userPrompt += '\n\nReturn the JSON.';

  const raw = await provider.complete({
    systemPrompt,
    parts: [{ text: userPrompt }],
    format: 'json',
    temperature: 0.2,
    maxTokens: 512,
  });

  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: { estimate: unknown; confidence: unknown; notes?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new AiBadResponseError('Model returned invalid JSON');
  }

  const rawEstimate = typeof parsed.estimate === 'number' ? parsed.estimate : NaN;
  if (!Number.isFinite(rawEstimate) || rawEstimate < 0) {
    throw new AiBadResponseError('Model did not return a usable numeric estimate');
  }

  const confidence =
    parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
      ? parsed.confidence
      : 'low';
  const notes = typeof parsed.notes === 'string' ? parsed.notes.trim() : undefined;

  return {
    estimate: Math.round(rawEstimate * 100) / 100,
    rawEstimate,
    confidence,
    notes,
    samplesUsed: calibrationLeaves.length,
    fudgeFactor:
      calibration.fudgeFactor != null ? Math.round(calibration.fudgeFactor * 100) / 100 : null,
    calibrationNote: calibration.note,
    effortUnit,
  };
}
