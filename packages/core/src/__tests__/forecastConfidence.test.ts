import { describe, it, expect } from 'vitest';
import { assessForecastConfidence } from '../velocity.js';

// The verdict replaces a second date column, so the thing under test is
// "does it fire when it should" — not the exact wording of the note.
const base = {
  velocityHorizonDays: 28,
  ticketHorizonDays: 28,
  unestimatedOpenLeaves: 0,
  openLeaves: 26,
};

describe('assessForecastConfidence — agreement', () => {
  it('agrees when both models land together and everything is estimated', () => {
    const c = assessForecastConfidence(base);
    expect(c.level).toBe('agree');
    expect(c.divergenceDays).toBe(0);
  });

  it('tolerates small absolute gaps on a short horizon', () => {
    // MVP-shaped: 6-day horizon, models 1 day apart. The 25% band would say
    // 1.5d, so the 7-day floor is what keeps this quiet.
    const c = assessForecastConfidence({
      velocityHorizonDays: 6,
      ticketHorizonDays: 6.8,
      unestimatedOpenLeaves: 0,
      openLeaves: 4,
    });
    expect(c.level).toBe('agree');
  });

  it('reports no open work rather than inventing a verdict', () => {
    const c = assessForecastConfidence({ ...base, openLeaves: 0 });
    expect(c.level).toBe('agree');
    expect(c.note).toMatch(/no open work/i);
  });
});

describe('assessForecastConfidence — caution', () => {
  it('flags a material divergence between the two models', () => {
    // V1-shaped: velocity 28d, ticket 43d. Threshold is max(7, 7) = 7.
    const c = assessForecastConfidence({ ...base, ticketHorizonDays: 43 });
    expect(c.level).toBe('caution');
    expect(c.divergenceDays).toBe(15);
    expect(c.note).toMatch(/drifted/);
  });

  it('flags unestimated open work even when the models agree', () => {
    const c = assessForecastConfidence({ ...base, unestimatedOpenLeaves: 9 });
    expect(c.level).toBe('caution');
    expect(c.unestimatedOpenLeaves).toBe(9);
    expect(c.note).toMatch(/floor/);
  });

  it('names both causes when both fire', () => {
    const c = assessForecastConfidence({
      ...base,
      ticketHorizonDays: 43,
      unestimatedOpenLeaves: 9,
    });
    expect(c.level).toBe('caution');
    expect(c.note).toMatch(/15d longer/);
    expect(c.note).toMatch(/9 of 26/);
  });

  it('scales the band with the horizon instead of using a flat 7 days', () => {
    // 200-day horizon, 20 days apart — noise at that scale (band = 50d).
    const wide = assessForecastConfidence({
      velocityHorizonDays: 200,
      ticketHorizonDays: 220,
      unestimatedOpenLeaves: 0,
      openLeaves: 100,
    });
    expect(wide.level).toBe('agree');
    // Same 20 days on a 30-day horizon is a real disagreement (band = 7.5d).
    const tight = assessForecastConfidence({
      velocityHorizonDays: 30,
      ticketHorizonDays: 50,
      unestimatedOpenLeaves: 0,
      openLeaves: 20,
    });
    expect(tight.level).toBe('caution');
  });
});

describe('assessForecastConfidence — missing cross-check', () => {
  it('is unmeasured when there is no ticket model and nothing else is wrong', () => {
    const c = assessForecastConfidence({ ...base, ticketHorizonDays: null });
    expect(c.level).toBe('unmeasured');
    expect(c.divergenceDays).toBeNull();
  });

  it('still cautions on unestimated work with no ticket model to compare', () => {
    const c = assessForecastConfidence({
      ...base,
      ticketHorizonDays: null,
      unestimatedOpenLeaves: 3,
    });
    expect(c.level).toBe('caution');
    expect(c.divergenceDays).toBeNull();
  });
});
