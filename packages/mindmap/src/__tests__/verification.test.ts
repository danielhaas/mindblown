import { describe, it, expect } from 'vitest';
import type { Node } from '@mindblown/core';
import { isDocumented, isHttpUrl, verificationOf } from '../verification.js';

/**
 * `verificationOf` decides what the Prüfanleitungen view has to show for a
 * criterion; `isDocumented` decides whether the register's row carries the
 * marker that jumps there. The promise is "nothing written → no marker, the
 * register looks exactly as it did before" — a row that sprouts a marker
 * over nothing is the visible regression, and a stray space left behind by
 * an older write is the way it happens.
 */

/** Only the three fields matter here; the rest of Node never gets read. */
function node(v: Partial<Node>): Node {
  return { verificationText: null, verificationUrl: null, verificationVideoUrl: null, ...v } as Node;
}

describe('verificationOf', () => {
  it('returns null when none of the three fields is set', () => {
    expect(verificationOf(node({}))).toBeNull();
  });

  it('treats whitespace-only fields as unset', () => {
    // The property panel writes null on clear, but rows written before that
    // can still carry ' ' — which is truthy and would render an empty card.
    expect(verificationOf(node({ verificationText: '   ' }))).toBeNull();
    expect(verificationOf(node({ verificationUrl: '\t' }))).toBeNull();
    expect(verificationOf(node({ verificationVideoUrl: '\n ' }))).toBeNull();
    expect(
      verificationOf(
        node({ verificationText: ' ', verificationUrl: ' ', verificationVideoUrl: ' ' }),
      ),
    ).toBeNull();
  });

  it('returns a card as soon as any single field is set', () => {
    // Each of the three on its own is enough — a requirement with only a
    // video and no written steps still needs the handle.
    expect(verificationOf(node({ verificationText: '1. Einloggen' }))).toEqual({
      text: '1. Einloggen',
      url: null,
      videoUrl: null,
    });
    expect(verificationOf(node({ verificationUrl: 'https://staging.example.com/x' }))).toEqual({
      text: null,
      url: 'https://staging.example.com/x',
      videoUrl: null,
    });
    expect(verificationOf(node({ verificationVideoUrl: 'https://v.example.com/a.mp4' }))).toEqual({
      text: null,
      url: null,
      videoUrl: 'https://v.example.com/a.mp4',
    });
  });

  it('trims the values it returns', () => {
    // A trailing newline in the URL would otherwise end up inside the href.
    expect(
      verificationOf(
        node({
          verificationText: '  1. Einloggen\n2. Mandat öffnen  ',
          verificationUrl: ' https://staging.example.com/x \n',
          verificationVideoUrl: '\thttps://v.example.com/a.mp4 ',
        }),
      ),
    ).toEqual({
      text: '1. Einloggen\n2. Mandat öffnen',
      url: 'https://staging.example.com/x',
      videoUrl: 'https://v.example.com/a.mp4',
    });
  });
});

/**
 * The register's marker. It is the only thing the register says about the
 * Prüf-felder, so what it counts as "documented" is the whole contract.
 */
describe('isDocumented', () => {
  it('is false when nothing is written', () => {
    expect(isDocumented(node({}))).toBe(false);
    expect(isDocumented(node({ verificationText: '   ' }))).toBe(false);
  });

  it('is true for a written Anleitung', () => {
    expect(isDocumented(node({ verificationText: '1. Einloggen' }))).toBe(true);
  });

  it('is true for a clip alone', () => {
    // No steps written yet, but a reviewer can still watch how it is done —
    // the marker has to lead him there.
    expect(isDocumented(node({ verificationVideoUrl: 'https://v.example.com/a.mp4' }))).toBe(true);
  });

  it('is false for a Prüf-Link alone', () => {
    // The deep link answers "where do I click this up", not "how do I check
    // it", and it is deliberately not surfaced in the register at all: the
    // reader of the register is asking where something stands, and a link
    // out of the application is an invitation to leave that view.
    expect(isDocumented(node({ verificationUrl: 'https://staging.example.com/x' }))).toBe(false);
    // …but it rides along once there is something to read.
    expect(
      isDocumented(
        node({ verificationText: '1. Einloggen', verificationUrl: 'https://staging.example.com/x' }),
      ),
    ).toBe(true);
  });
});

/**
 * Both URL fields are free-text columns with no server-side validation, and
 * the Prüfanleitung is the only surface that renders them as an `href`.
 */
describe('isHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isHttpUrl('https://staging.example.com/mandates/42')).toBe(true);
    expect(isHttpUrl('http://localhost:5173/?req=MAN-14')).toBe(true);
    expect(isHttpUrl('HTTPS://staging.example.com/x')).toBe(true);
  });

  it('rejects script-bearing schemes', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHttpUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects a scheme obfuscated with control characters', () => {
    // The reason this uses the URL parser and not startsWith(): browsers
    // strip tabs and newlines out of the scheme, so this navigates.
    expect(isHttpUrl('java\nscript:alert(1)')).toBe(false);
    expect(isHttpUrl('java\tscript:alert(1)')).toBe(false);
    expect(isHttpUrl(' javascript:alert(1)')).toBe(false);
  });

  it('rejects anything that is not an absolute URL', () => {
    // Nothing resolves a relative href usefully here — the card links out of
    // the application, not within it.
    expect(isHttpUrl('staging.example.com/x')).toBe(false);
    expect(isHttpUrl('/mandates/42')).toBe(false);
    expect(isHttpUrl('//staging.example.com/x')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});
