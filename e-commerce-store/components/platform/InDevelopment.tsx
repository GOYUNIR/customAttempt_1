/**
 * ─────────────────────────────────────────────────────────────────────────────
 * IN ACTIVE DEVELOPMENT — the one way this platform says "not yet".
 *
 * WHY THIS IS A COMPONENT AND NOT A SENTENCE. A platform being built in public
 * will always have edges. The question is whether those edges read as a product
 * under construction or as a product that is broken, and the difference is
 * almost entirely consistency: three different half-finished screens look like
 * three bugs, while three identical "here is what this will do" panels look
 * like a roadmap. So there is exactly one of these, and everything unfinished
 * uses it.
 *
 * THE COPY RULES, enforced by the props rather than by discipline:
 *   - `title` NAMES the feature. Not "Coming soon" — the name of the thing.
 *   - `children` says what it WILL do, in a sentence or two, in the future
 *     tense. A reader should finish it knowing what they would get.
 *   - `worksToday` is optional and is the most valuable part when present: it
 *     points at the thing that IS finished and adjacent. "This is not built,
 *     but that is" is a much stronger statement than either half alone.
 *
 * There is no apology in here and there is no "sorry". There is also no fake
 * progress bar and no invented delivery date — a date we have not committed to
 * is a promise made to someone who will remember it.
 *
 * TONE. The staff portals and the marketing site are dark; the storefront is
 * whatever the merchant themed it. `tone` picks the palette rather than
 * inheriting, because inheriting is how this ends up unreadable on exactly the
 * one surface nobody checked.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { CSSProperties, ReactNode } from 'react';

export type InDevelopmentTone = 'dark' | 'light';

const PALETTE: Record<InDevelopmentTone, {
  panel: string; border: string; text: string; muted: string; chipBg: string; chipText: string; rule: string;
}> = {
  dark: {
    panel: '#141417',
    border: '#2a2a30',
    text: '#f4f4f5',
    muted: '#9b9ba4',
    chipBg: 'rgba(59,130,246,0.14)',
    chipText: '#93c5fd',
    rule: '#26262c',
  },
  light: {
    panel: '#ffffff',
    border: 'rgba(0,0,0,0.12)',
    text: '#111114',
    muted: '#5c5c66',
    chipBg: 'rgba(0,113,227,0.10)',
    chipText: '#0071e3',
    rule: 'rgba(0,0,0,0.08)',
  },
};

export interface InDevelopmentProps {
  /** The feature's name. Never "Coming soon". */
  title: string;
  /** What it will do, in the future tense. One or two sentences. */
  children: ReactNode;
  /** The finished, adjacent thing worth looking at instead. */
  worksToday?: ReactNode;
  tone?: InDevelopmentTone;
  /** Fills its container rather than sitting in the middle of a tall panel. */
  compact?: boolean;
  style?: CSSProperties;
}

export default function InDevelopment({
  title,
  children,
  worksToday,
  tone = 'dark',
  compact = false,
  style,
}: InDevelopmentProps) {
  const ink = PALETTE[tone];

  return (
    <section
      // Announced as a region so a screen reader reaches the explanation, not
      // just an empty panel where a feature was expected.
      aria-label={title + ' — in active development'}
      style={{
        background: ink.panel,
        border: '1px solid ' + ink.border,
        borderRadius: 18,
        padding: compact ? '20px 20px 22px' : '34px 30px 36px',
        maxWidth: 620,
        ...style,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          background: ink.chipBg,
          color: ink.chipText,
          borderRadius: 999,
          padding: '5px 11px',
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.9px',
          textTransform: 'uppercase',
        }}
      >
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: 999, background: ink.chipText, display: 'inline-block' }}
        />
        In active development
      </span>

      <h2
        style={{
          margin: compact ? '13px 0 8px' : '17px 0 10px',
          fontSize: compact ? 17 : 21,
          fontWeight: 750,
          color: ink.text,
          letterSpacing: '-0.2px',
        }}
      >
        {title}
      </h2>

      <div style={{ fontSize: 14, lineHeight: 1.62, color: ink.muted, margin: 0 }}>{children}</div>

      {worksToday && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid ' + ink.rule }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: '1.1px',
              textTransform: 'uppercase',
              color: ink.muted,
              marginBottom: 6,
            }}
          >
            Working today
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: ink.text }}>{worksToday}</div>
        </div>
      )}
    </section>
  );
}
