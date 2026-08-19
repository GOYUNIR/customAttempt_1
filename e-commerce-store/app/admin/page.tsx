'use client';

import Link from 'next/link';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { THEME_PRESETS } from '@/lib/theme-presets';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';
import LinkPreviewGallery from '@/components/LinkPreviewGallery';
import ProductLivePreview from '@/components/ProductLivePreview';
import { toHexColor } from '@/lib/share-card-config';
import { getNextDrawTimestampForSchedule, visibleProductCategories } from '@/lib/storefront-config';
import { isVideoMedia, normalizeCrop, coverStyle, aspectRatioLabel, DEFAULT_CROP, type MediaCrop } from '@/lib/media';
import { checkProductSanity, checkRewardsSanity, sortSanityIssues, type SanityIssue } from '@/lib/product-sanity';

type Tab = 'overview' | 'drops' | 'ledger' | 'growth' | 'system' | 'settings' | 'products' | 'users' | 'promotions' | 'catalog' | 'setup';

const SHIP_STATUSES = ['PENDING_FULFILLMENT', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED'] as const;

function typeColor(type: string | undefined) {
  if (!type) return '#a1a1aa';
  if (type === 'ENTERED' || type === 'WINNER_CHARGED') return '#34d399';
  if (type === 'INTENT_STARTED') return '#edb210';
  if (type === 'NOT_SELECTED' || type === 'INTENT_EXPIRED') return '#888888';
  if (type === 'WINNER_DECLINED' || type === 'ADDRESS_UPDATED') return '#60a5fa';
  if (type?.includes('CANCEL')) return '#f87171';
  if (type === 'ADMIN_NOTE') return '#c084fc';
  return '#a1a1aa';
}

function typeLabel(type: string | undefined) {
  const map: Record<string, string> = {
    ENTERED: 'Entered',
    WINNER_CHARGED: 'Won & Charged',
    WINNER_DECLINED: 'Charge Declined',
    NOT_SELECTED: 'Not Selected',
    INTENT_STARTED: 'Started (Unfinished)',
    INTENT_EXPIRED: 'Never Finished',
    ADDRESS_UPDATED: 'Address Changed',
    CANCELLED_BY_USER: 'Cancelled (Customer)',
    CANCELLED_BY_ADMIN: 'Cancelled (Admin)',
    ADMIN_NOTE: 'Admin Note',
  };
  return map[type || ''] || type || 'Unknown';
}

// Streamer-mode masks are FIXED-LENGTH bullet strings (never derived from the
// real value) so a livestream can't leak even the CHARACTER LENGTH of an email,
// address, card number, tracking number, promo code, name, phone or order ref.
// Deterministic by construction — SSR and the client can never disagree.
const MASK_EMAIL = '••••••••@••••••••';
const MASK_ADDRESS = '••••••••••••••••••';
const MASK_CARD = '•••• •••• •••• ••••';
const MASK_TRACKING = '••••••••••••';
const MASK_PROMO = '••••••••••••';
const MASK_NAME = '••••••••••••';
const MASK_PHONE = '••• ••• ••••';
const MASK_REF = '••-••••••••';

/** Mask an email for streamer mode: a fixed bullet string — the real value's
 *  length/domain are never visible on stream. */
function maskEmail(_email: string | undefined | null): string {
  return String(_email || '').trim() ? MASK_EMAIL : '';
}

/** Mask a shipping address: a fixed bullet string (no length leak). */
function maskAddress(_address: string | undefined | null): string {
  return String(_address || '').trim() ? MASK_ADDRESS : '';
}

/** Mask a card number: a fixed 16-digit bullet pattern. */
function maskCard(_value: string | undefined | null): string {
  return String(_value || '').replace(/\D/g, '') ? MASK_CARD : '';
}

/** Any other sensitive value (tracking number, promo code, name, phone, order
 *  ref): a fixed bullet string when the field is non-empty. */
function maskGeneric(_value: string | undefined | null, mask: string): string {
  return String(_value || '').trim() ? mask : '';
}

/** One helper for every PII/sensitive field rendered in the portal. Streamer
 *  mode routes every customer value through here so masking can never be
 *  forgotten — each field kind gets its own fixed-length mask. */
function pii(
  value: string | undefined | null,
  kind: 'email' | 'address' | 'card' | 'tracking' | 'promo' | 'name' | 'phone' | 'ref',
  streamer: boolean,
): string {
  if (!streamer) return String(value || '');
  switch (kind) {
    case 'email': return maskEmail(value);
    case 'address': return maskAddress(value);
    case 'card': return maskCard(value);
    case 'tracking': return maskGeneric(value, MASK_TRACKING);
    case 'promo': return maskGeneric(value, MASK_PROMO);
    case 'name': return maskGeneric(value, MASK_NAME);
    case 'phone': return maskGeneric(value, MASK_PHONE);
    case 'ref': return maskGeneric(value, MASK_REF);
    default: return maskGeneric(value, MASK_NAME);
  }
}

/** Redact free-form detail strings (audit log lines) for streamer mode: emails,
 *  phone numbers, and code-like tokens (tracking numbers, order refs, promo
 *  codes — any 6+ char token mixing letters + digits) become fixed masks.
 *  Over-masking is safe; under-masking leaks. */
function redactDetail(detail: string | undefined | null, streamer: boolean): string {
  const value = String(detail || '');
  if (!streamer || !value.trim()) return value;
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, MASK_EMAIL)
    .replace(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, MASK_PHONE)
    .replace(/\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9-]{6,}\b/g, MASK_TRACKING);
}

/** Pick readable text (black/white) on top of an arbitrary CSS color — used by
 *  the live previews so a dark or light CTA button always shows legible text. */
function readableOn(bg: string | undefined | null): string {
  const hex = toHexColor(bg || '#ffffff').replace('#', '');
  if (hex.length < 6) return '#ffffff';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 150 ? '#0b0b0d' : '#ffffff';
}

/** Section wrapper used across the admin — consistent card header + helper
 *  copy so every group (product form, settings) reads like a clean settings
 *  page instead of a wall of inputs. */
function SectionCard({ title, description, children, action, id }: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  id?: string;
}) {
  return (
    <div id={id} style={{ background: '#0d0d11', border: '1px solid #232329', borderRadius: 14, padding: 14, marginBottom: 12, scrollMarginTop: 96 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: description || action ? 8 : 0 }}>
        <h5 style={{ fontSize: 11, color: '#e4e4e7', margin: 0, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase' }}>
          {title}
        </h5>
        {action}
      </div>
      {description && <p style={{ fontSize: 10, color: '#8b8b94', margin: '0 0 10px', lineHeight: 1.5 }}>{description}</p>}
      {children}
    </div>
  );
}

/** Consistent empty-state block used across tabs. */
function EmptyState({ icon, title, hint, children }: {
  icon?: string;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ textAlign: 'center', padding: '28px 16px', color: '#6b6b74', border: '1px dashed #2e2e35', borderRadius: 14, background: 'rgba(255,255,255,0.015)' }}>
      {icon && <div style={{ fontSize: 22, marginBottom: 6 }}>{icon}</div>}
      <div style={{ fontSize: 12, fontWeight: 600, color: '#a1a1aa' }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: '#6b6b74', marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
      {children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

/** Small status pill used for state chips (Active / Hidden / Archived…). */
function Pill({ children, color = '#a1a1aa', background = 'rgba(161,161,170,0.12)', style }: {
  children: React.ReactNode;
  color?: string;
  background?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 999, color, background, whiteSpace: 'nowrap', marginLeft: 4, ...style }}>
      {children}
    </span>
  );
}

/** Quick-jump targets for the product editor form (id → pill label). Each id
 *  is set on the matching SectionCard so the operator can hop straight to the
 *  section they need instead of scrolling the whole form. */
const PRODUCT_FORM_SECTIONS: [string, string][] = [
  ['pf-basics', 'Basics'],
  ['pf-media', 'Media'],
  ['pf-sizes', 'Pricing, sizes & inventory'],
  ['pf-copy', 'Copy'],
  ['pf-schedule', 'Drop schedule'],
  ['pf-soldout', 'Sold-out'],
  ['pf-trial', 'Trial sizes'],
  ['pf-notes', 'Notes'],
];

/** Quick-jump targets for the Settings tab (id → pill label). Keeps the long
 *  settings page navigable without hunting through the whole form. */
const SETTINGS_SECTIONS: [string, string][] = [
  ['settings-presets', 'Design'],
  ['settings-theme', 'Theme'],
  ['settings-hero', 'Hero'],
  ['settings-behavior', 'Behavior'],
  ['settings-form', 'Form'],
  ['settings-footer', 'Footer'],
  ['settings-copy', 'Copy'],
  ['settings-catalog', 'Catalog'],
  ['settings-legal', 'Legal'],
  ['settings-branding', 'Branding'],
  ['settings-orbs', 'Orbs'],
  ['settings-rewards', 'Rewards'],
  ['settings-gallery', 'Gallery'],
];

/** Friendly labels for the registration-form + footer copy keys so no
 *  camelCase ever leaks into the admin UI (Settings → Registration Form / Footer). */
const COPY_FIELD_LABELS: Record<string, string> = {
  title: 'Form title',
  subtitle: 'Form subtitle',
  buttonLabel: 'Submit button label',
  emailPlaceholder: 'Email field placeholder',
  addressPlaceholder: 'Address field placeholder',
  cardPlaceholder: 'Card field placeholder',
  finePrint: 'Fine print',
  instagramLink: 'Instagram URL',
  tiktokLink: 'TikTok URL',
  supportEmail: 'Support email (footer link)',
  shippingReturnPolicyText: 'Shipping & returns line',
  corporateEntityCopyright: 'Copyright line',
};

/** Context-aware placeholders for the same fields — what the customer-facing
 *  value will look like, so the buyer knows the shape before typing. */
const COPY_FIELD_PLACEHOLDERS: Record<string, string> = {
  title: 'e.g. Join The Allocation Draw',
  subtitle: 'e.g. Enter to win — card is saved, charged only if selected',
  buttonLabel: 'e.g. Secure Entry Allocation Ticket',
  emailPlaceholder: 'e.g. email@domain.com',
  addressPlaceholder: 'e.g. 123 Rosewood Ave, Los Angeles, CA 90210',
  cardPlaceholder: 'e.g. Card number',
  finePrint: 'e.g. By entering you agree to the terms.',
  instagramLink: 'https://instagram.com/yourbrand',
  tiktokLink: 'https://tiktok.com/@yourbrand',
  supportEmail: 'support@yourbrand.com',
  shippingReturnPolicyText: 'e.g. Shipping & Returns Policy Apply.',
  corporateEntityCopyright: 'e.g. ALL RIGHTS RESERVED.',
};

/** Friendly labels / placeholders / hints for the Branding & Share fields so no
 *  raw camelCase ever leaks into the admin UI. */
const SHARE_FIELD_META: Record<string, { label: string; placeholder: string; hint?: string }> = {
  shareTitle: { label: 'Share title', placeholder: 'e.g. Winter Drop — Live Now', hint: 'Shown big on the card. Empty falls back to the brand name.' },
  shareDescription: { label: 'Share description', placeholder: 'e.g. Private releases, handled cleanly.', hint: 'The card subtitle — keep it under ~140 chars.' },
  shareTagline: { label: 'Share tagline', placeholder: 'e.g. EST. 2026', hint: 'Small line under the brand name on the card.' },
  shareUrl: { label: 'Share URL', placeholder: 'https://yourstore.com', hint: 'The domain shown on the card + the copied share link. Empty falls back to your deployed domain.' },
  shareImageUrl: { label: 'Share image URL', placeholder: 'https://… or /images/…', hint: 'The card background image (1200×630-ish). Empty = solid color + glow.' },
  shareBackground: { label: 'Share background', placeholder: '#0B0B0F' },
  shareAccent: { label: 'Share accent', placeholder: '#D4AF37' },
  shareText: { label: 'Share text color', placeholder: '#F5F2E9' },
  iconBackground: { label: 'Favicon background', placeholder: '#0B0B0F' },
  iconText: { label: 'Favicon accent', placeholder: '#D4AF37' },
};

/** Colored badge for the audit log actor (admin=blue, user=green, system=grey). */
function auditActorStyle(actor?: string): React.CSSProperties {
  const a = String(actor || 'admin').toLowerCase();
  if (a === 'user') return { background: 'rgba(52,211,153,0.16)', color: '#34d399' };
  if (a === 'system') return { background: 'rgba(148,163,184,0.18)', color: '#a1a1aa' };
  return { background: 'rgba(96,165,250,0.16)', color: '#60a5fa' };
}

function formatAuditTime(at?: string): string {
  if (!at) return '';
  try {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? String(at) : date.toLocaleString();
  } catch {
    return String(at || '');
  }
}

function stableOrderRef(entry: any) {
  const existing = formatOrderRef(entry?.orderRef || entry?.ref || '');
  if (existing) return existing;
  return buildOrderRef(entry?.email || 'anon', entry?.variant || 'product', entry?.size || 'size');
}

/**
 * Normalize a "Winners / draw" value into a comma-separated list of positive
 * integers (e.g. "3, 2, 2"). Winner tiers are per-draw counts, so the field is
 * a text input that accepts CSV — never a <input type="number">, which throws
 * "The specified value '3,2,2' cannot be parsed" for seeded multi-tier drops.
 */
function normalizeWinnerTiersCsv(value: string): string {
  const nums = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n >= 1);
  return nums.length > 0 ? nums.join(',') : '1';
}

/** Sampler credit helpers: the admin edits dollars, storage keeps cents. */
const samplerCentsToDollars = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '' : String(Number(cents) / 100);

const samplerDollarsToCents = (dollars: string): number | null => {
  const trimmed = String(dollars || '').trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) && num >= 0 ? Math.max(0, Math.round(num * 100)) : null;
};

/** URL-safe slug from a product name (used as the auto-fill for the Slug field). */
function slugifyName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max <= 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div style={{ height: 8, borderRadius: 6, background: '#1c1c1e', overflow: 'hidden', marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: 22,
  borderRadius: 18,
  background: '#141417',
  border: '1px solid #2a2a30',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.14)',
};

const inputStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: '#0d0d10',
  border: '1px solid #303036',
  color: '#fff',
  fontSize: 13,
  boxSizing: 'border-box',
};

/** Font-family presets shown in the Settings → Font Family dropdown, each option
 *  rendered in its own typeface so admins see a live preview of the style. */
const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'SF Pro / system (Apple default)', value: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  { label: 'Inter — clean modern sans', value: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" },
  { label: 'Space Grotesk — techy geometric sans', value: "'Space Grotesk', 'Inter', 'Segoe UI', Arial, sans-serif" },
  { label: 'Sora — rounded friendly sans', value: "'Sora', 'Inter', 'Segoe UI', Arial, sans-serif" },
  { label: 'IBM Plex Sans — crisp corporate sans', value: "'IBM Plex Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif" },
  { label: 'Archivo — bold condensed sans', value: "'Archivo', 'Helvetica Neue', Arial, sans-serif" },
  { label: 'Nunito — soft rounded sans', value: "'Nunito', 'Poppins', 'Segoe UI', sans-serif" },
  { label: 'Playfair Display — elegant editorial serif', value: "'Playfair Display', Georgia, 'Times New Roman', serif" },
  { label: 'Cormorant Garamond — luxury fashion serif', value: "'Cormorant Garamond', 'Playfair Display', Georgia, serif" },
  { label: 'Georgia — classic book serif', value: "Georgia, 'Times New Roman', serif" },
  { label: 'System UI — native platform font', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif" },
  { label: 'Monospace — terminal / technical', value: "'SF Mono', 'Cascadia Code', Consolas, 'Courier New', monospace" },
];

/** Friendly labels for the theme color inputs (Settings → Theme Colors) so the
 *  admin UI reads like Apple settings instead of raw camelCase key names. */
const THEME_COLOR_LABELS: Record<string, string> = {
  primaryBackground: 'Page background',
  cardBackground: 'Card surface',
  cardBorder: 'Card hairline border',
  accentPurple: 'Accent (violet)',
  accentBlue: 'Accent (blue / links)',
  textMain: 'Page text',
  textMuted: 'Page muted text',
  cardTextMain: 'Text on cards',
  cardTextMuted: 'Muted text on cards',
  checkoutCtaButton: 'Checkout button',
  headerBackground: 'Top bar background',
  headerText: 'Top bar text / icons',
};

const buttonPrimary: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 10,
  border: 'none',
  background: '#fff',
  color: '#000',
  fontWeight: 700,
  fontSize: 12,
  cursor: 'pointer',
};

const buttonGhost: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #27272a',
  background: 'transparent',
  color: '#ccc',
  fontSize: 11,
  cursor: 'pointer',
};

function adminFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, credentials: 'include' }).then((res) => {
    // If the proxy's two-step device cookie is missing/expired, every /api/admin
    // request returns 401 { error: 'ADMIN_2FA_REQUIRED' }. Surface that to the
    // portal so it can re-show the verification screen instead of a silent error.
    if (res.status === 401 && typeof window !== 'undefined') {
      res
        .clone()
        .json()
        .then((d) => {
          if (d && d.error === 'ADMIN_2FA_REQUIRED') {
            window.dispatchEvent(new CustomEvent('goyunir-admin-2fa-required'));
          }
        })
        .catch(() => {});
    }
    return res;
  });
}

// Default Stripe price ID prefilled in the product form. Mirrors the server-side
// default (lib/server-config.ts): the STRIPE_PRODUCT_ID env var when set,
// otherwise an obvious placeholder that forces the operator to set a real ID
// per size. /api/admin/products GET returns the live value so this stays in
// sync without a redeploy. There is intentionally NO hardcoded Stripe price ID
// anywhere in this template.
const UNCONFIGURED_STRIPE_PRICE_ID = 'price_placeholder_not_configured';

// Sentinel for an unconfigured product price. New products start at this
// obviously-wrong value so nobody can accidentally publish a product priced at
// $0 or charge the sentinel amount — every checkout path rejects it.
const UNCONFIGURED_PRICE_SENTINEL = 9999999;

// Defaults for the glow-orb system (/admin → Settings → Orb Glow). These mirror
// the storefront defaults so a fresh portal has sane values before any save.
const DEFAULT_ORBS: any = {
  enabled: true,
  primary: { enabled: true, color: '#3b82f6', opacity: 12, size: 58 },
  secondary: { enabled: true, color: '#a855f7', opacity: 15, size: 44 },
  tertiary: { enabled: true, color: '#ffd79b', opacity: 8, size: 28 },
  fourth: { enabled: true, color: '#7dd3fc', opacity: 8, size: 36 },
  fifth: { enabled: true, color: '#f472b6', opacity: 6, size: 24 },
  motion: {
    idleEnabled: true,
    pointerEnabled: true,
    scrollEnabled: true,
    intensity: 100,
    speed: 100,
    momentum: 40,
  },
};

function mergeOrbSettings(base: any, incoming: any): any {
  if (!incoming) return base;
  return {
    enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : base.enabled,
    primary: { ...(base.primary || {}), ...(incoming.primary || {}) },
    secondary: { ...(base.secondary || {}), ...(incoming.secondary || {}) },
    tertiary: { ...(base.tertiary || {}), ...(incoming.tertiary || {}) },
    fourth: { ...(base.fourth || {}), ...(incoming.fourth || {}) },
    fifth: { ...(base.fifth || {}), ...(incoming.fifth || {}) },
    motion: { ...(base.motion || {}), ...(incoming.motion || {}) },
  };
}

// Accepted media formats in the products panel. Images + videos share the
// gallery; videos are stored as-is (never rasterized) and render in <video>.
const ACCEPTED_IMAGE_EXTS = ['png', 'jpeg', 'jpg', 'svg', 'webp', 'gif', 'bmp', 'avif'];
const ACCEPTED_VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
const ACCEPTED_MEDIA_TYPES =
  ACCEPTED_IMAGE_EXTS.map((e) => `image/${e === 'jpg' ? 'jpeg' : e}`).join(', ') +
  ', ' +
  ACCEPTED_VIDEO_EXTS.map((e) => `video/${e}`).join(', ');

function isAcceptedMediaFile(file: File): boolean {
  const name = String(file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() || '' : '';
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('image/')) return ACCEPTED_IMAGE_EXTS.includes(ext) || type.includes(ext);
  if (type.startsWith('video/')) return ACCEPTED_VIDEO_EXTS.includes(ext) || type.includes(ext);
  return ACCEPTED_IMAGE_EXTS.includes(ext) || ACCEPTED_VIDEO_EXTS.includes(ext);
}

// ===== Helper: convert file to base64 data URL =====
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Compress a photo for storage. Photos (jpg/png/webp/bmp/avif) are downscaled +
 * re-encoded to JPEG so a product gallery stays small in Redis. Vector/animated
 * formats (svg, gif) and ALL videos keep their original bytes — canvas would
 * destroy SVG transparency / GIF animation and videos can't be rasterized.
 */
async function compressImageFile(file: File, maxSize = 1440, quality = 0.82): Promise<File> {
  if (typeof window === 'undefined') return file;
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('video/')) return file;
  if (type === 'image/svg+xml' || type === 'image/gif') return file;
  // Accept files even when the browser reports an empty/odd MIME type (some
  // .jpeg exports do) — the file picker is already restricted to media/*.
  if (file.type && !file.type.startsWith('image/')) return file;
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, width, height);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', quality));
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

// Module-level defaults for the settings forms. These are the "clean" values a
// freshly-fetched server payload starts from — fetchSettings() merges the Redis
// store:config over them deterministically, then snapshots the result so the
// admin can see when their edits diverge (the Discard-changes button).
const DEFAULT_BRANDING_SETTINGS = {
  logoUrl: '',
  logoWidth: 28,
  logoHeight: 28,
  logoTransparent: false,
  brandName: '',
  brandFontFamily: '',
  brandFontSize: 14,
  headerMode: 'both',
  headerActionMode: 'cart',
  shareImageUrl: '',
  shareTitle: '',
  shareDescription: '',
  shareTagline: '',
  shareUrl: '',
  shareBackground: '#0B0B0F',
  shareAccent: '#D4AF37',
  shareText: '#F5F2E9',
  iconBackground: '#0B0B0F',
  iconText: '#D4AF37',
  // Share-card composition knobs (Settings → Branding & Share → Card style).
  shareLogoVisible: true,
  shareTaglineVisible: true,
  shareSiteVisible: true,
  shareTitleSize: 74,
  shareDescriptionSize: 30,
  shareLayout: 'classic',
  shareFontFamily: 'system',
  shareGlowIntensity: 40,
  shareCornerRadius: 0,
  shareImageOverlay: 60,
};

const DEFAULT_REWARDS_SETTINGS = {
  pointsPerDollar: 100,
  minRedeemPoints: 100,
  maxRedeemPoints: 0,
  purchasePointsPerDollar: 10,
  giftingEnabled: true,
  giftDiscountPercent: 10,
  // Custom caption shown in the account "Redeem points" box. Leave empty to
  // use the built-in dynamic message (gifting + percentage aware).
  redemptionInfoMessage: '',
};

const DEFAULT_GALLERY_SETTINGS = {
  autoPlay: true,
  intervalSeconds: 4,
  zoom: true,
  zoomDurationSeconds: 14,
};

const DEFAULT_COPY_SETTINGS = {
  heroTitle: '',
  heroSubtitle: '',
  entryCta: '',
  cartTitle: '',
  footerTagline: '',
  supportEmail: '',
  priorityDropsTitle: '',
  priorityDropsSubtitle: '',
  // Product-page urgency/status story (the box under the release header).
  // Leave empty to keep the built-in copy.
  urgencyInStock: '',
  urgencySoldOut: '',
  statusLive: '',
  statusArchived: '',
  // Mixed-format ribbon shown on product pages that mix raffle + instant-buy
  // sizes. Template tokens: {raffle} = raffle size count, {fcfs} = instant-buy
  // size count. Leave empty to keep the built-in sentence.
  mixedFormatRibbon: '',
};

const DEFAULT_LEGAL_SETTINGS = {
  companyName: '',
  supportEmail: '',
  terms: '',
  privacy: '',
  shipping: '',
};

const DEFAULT_CATALOG_SETTINGS = {
  sectionOrder: ['upcoming', 'archive', 'live'],
  // Admin-managed product categories (Settings → Catalog). Buyers can add,
  // rename and delete these freely; products are tagged with any subset.
  categories: ['New Arrivals', 'Limited Edition', 'Best Sellers', 'Signature', 'Seasonal', 'Perfume', 'Fragrance', 'Candles & Home', 'Apparel', 'Accessories', 'Men', 'Women', 'Unisex'],
};

const DEFAULT_BEHAVIOR_SETTINGS = {
  scrollToTopOnLoad: true,
};

const DEFAULT_CHECKOUT_SETTINGS = {
  // When ON, customer "update address" flows require the complete Mapbox
  // dropdown address (a partial address can never be saved). The admin portal
  // can override and save a partial address regardless.
  requireAddressAutofill: true,
};

const DEFAULT_REF_PREFIX = 'GU';

// ---------------------------------------------------------------------------
// CROP EDITOR — the product gallery's "what shoppers will actually see"
// ---------------------------------------------------------------------------
// Each uploaded photo has an optional crop (normalized center + size). The
// editor shows TWO live previews of exactly what the product page renders:
//   • Desktop — the gallery box is ~560×280 (2:1) on a desktop browser.
//   • Mobile  — ~328×280 (1.17:1) on a phone.
// Drag inside either preview to pan, use the slider to zoom, and the aspect
// ratio each box uses is labeled — so the buyer sets the crop by SEEING the
// result on both devices, not by guessing CSS values.

const DESKTOP_PREVIEW = { w: 320, h: 160 };
const MOBILE_PREVIEW = { w: 200, h: 171 };

type CropEditorProps = {
  src: string;
  crop: unknown;
  onCrop: (c: MediaCrop) => void;
};

function CropEditor({ src, crop, onCrop }: CropEditorProps) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startCrop: MediaCrop; boxW: number; boxH: number } | null>(null);

  const c = normalizeCrop(crop);

  // Load natural dimensions once (data URLs + remote URLs both work).
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setNatural({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Keep the slider in sync with the stored crop (e.g. when switching images).
  useEffect(() => {
    setZoom(Math.max(0, Math.min(100, Math.round(((1 - c.w) / 0.8) * 100))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const clampCenter = useCallback((next: MediaCrop): MediaCrop => {
    const size = Math.max(0.2, next.w);
    return {
      ...next,
      x: Math.max(size / 2, Math.min(1 - size / 2, next.x)),
      y: Math.max(size / 2, Math.min(1 - size / 2, next.y)),
    };
  }, []);

  const setZoomed = useCallback(
    (z: number) => {
      const zz = Math.max(0, Math.min(100, Number(z) || 0));
      const size = Math.max(0.2, 1 - (zz / 100) * 0.8);
      setZoom(zz);
      onCrop(clampCenter({ ...c, w: size, h: size }));
    },
    [c, onCrop, clampCenter],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, boxW: number, boxH: number) => {
      if (!natural) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = { startX: e.clientX, startY: e.clientY, startCrop: c, boxW, boxH };
      setDragging(true);
    },
    [natural, c],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      // The crop region maps 1:1 onto the preview box, so a pointer delta of
      // one box-width moves the crop center by one crop-width (drag left/right
      // to look around — the image follows the finger).
      const dx = ((e.clientX - d.startX) / d.boxW) * d.startCrop.w;
      const dy = ((e.clientY - d.startY) / d.boxH) * d.startCrop.h;
      onCrop(
        clampCenter({
          ...d.startCrop,
          x: d.startCrop.x - dx,
          y: d.startCrop.y - dy,
        }),
      );
    },
    [onCrop, clampCenter],
  );

  const onPointerEnd = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  const renderPreview = (boxW: number, boxH: number, label: string, ratioLabel: string) => {
    const style = natural ? coverStyle(natural.w, natural.h, boxW, boxH, c) : null;
    return (
      <div style={{ flex: '0 0 auto' }}>
        <div style={{ fontSize: 10, color: '#8b95a7', marginBottom: 4 }}>
          {label} <span style={{ color: '#5d6570' }}>· aspect {ratioLabel}</span>
        </div>
        <div
          onPointerDown={(e) => onPointerDown(e, boxW, boxH)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          style={{
            width: boxW,
            height: boxH,
            borderRadius: 10,
            overflow: 'hidden',
            position: 'relative',
            background: '#0a0a0c',
            border: dragging ? '1px solid #7dd3fc' : '1px solid #26262e',
            cursor: natural ? 'grab' : 'wait',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTapHighlightColor: 'transparent',
          }}
          title="Drag to adjust which part of the photo shows"
        >
          {natural && style ? (
            <img
              src={src}
              alt="crop preview"
              draggable={false}
              style={{
                position: 'absolute',
                width: style.width,
                height: style.height,
                left: style.left,
                top: style.top,
                maxWidth: 'none',
                maxHeight: 'none',
                pointerEvents: 'none',
              }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 10, color: '#666' }}>Loading…</div>
          )}
          {natural && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)' }} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ margin: '8px 0', padding: 12, borderRadius: 12, background: '#0b0b0d', border: '1px solid #1f2937' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#dbe3ee' }}>✂️ Crop — live preview</span>
        <span style={{ fontSize: 10, color: '#8b95a7' }}>
          Shows exactly how this photo is cropped on the product page. Drag to pan, zoom below.
        </span>
        <button
          onClick={() => onCrop({ ...DEFAULT_CROP })}
          style={{ ...buttonGhost, marginLeft: 'auto', padding: '4px 10px', fontSize: 10 }}
        >
          Reset crop
        </button>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        {renderPreview(DESKTOP_PREVIEW.w, DESKTOP_PREVIEW.h, 'Computer', aspectRatioLabel(DESKTOP_PREVIEW.w, DESKTOP_PREVIEW.h))}
        {renderPreview(MOBILE_PREVIEW.w, MOBILE_PREVIEW.h, 'Mobile', aspectRatioLabel(MOBILE_PREVIEW.w, MOBILE_PREVIEW.h))}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: '#a1a1aa' }}>
        <span style={{ whiteSpace: 'nowrap' }}>Zoom</span>
        <input
          type="range"
          min={0}
          max={100}
          value={zoom}
          onChange={(e) => setZoomed(Number(e.target.value))}
          style={{ flex: 1, accentColor: '#7dd3fc' }}
        />
        <span style={{ whiteSpace: 'nowrap', color: '#8b95a7', minWidth: 52, textAlign: 'right' }}>
          {zoom === 0 ? 'Full photo' : `${Math.round((1 - (zoom / 100) * 0.8) * 100)}%`}
        </span>
      </label>
      <div style={{ fontSize: 10, color: '#5d6570', marginTop: 8, lineHeight: 1.5 }}>
        The crop is saved with the product and applies to the product-page gallery, home cards and catalog tiles.
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Live preview helpers — mirror SiteChrome's header/footer color math so the
// admin "Live preview — top bar & footer" panel shows the REAL rendered result.
// ---------------------------------------------------------------------------

/** Pick readable header text (near-black on light bg, near-white on dark). */
function previewHeaderText(bg: string, explicit?: string): string {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const hex = String(bg || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return '#f5f5f7';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return '#f5f5f7';
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.58 ? '#0a0a0c' : '#f5f5f7';
}

/** Mix a chrome color to the configured transparency (same as SiteChrome). */
function previewChromeBackground(color: string, alphaPct: number, fallback: string, minPct = 40): string {
  const c = String(color || '').trim();
  if (!c) return fallback;
  const raw = Number(alphaPct);
  const safe = Math.max(minPct, Math.min(100, Number.isFinite(raw) ? raw : 94));
  return safe >= 100 ? c : `color-mix(in srgb, ${c} ${safe}%, transparent)`;
}

export default function AdminPortal() {
  const [tab, setTab] = useState<Tab>('overview');
  const [drawsSub, setDrawsSub] = useState<'run' | 'automation'>('run');
  const [password, setPassword] = useState('');
  const [toast, setToast] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  // STREAMER MODE: default ON. Masks all customer PII (addresses, emails, card
  // numbers) with fixed-length bullet masks so even character lengths never
  // leak. It is PURELY a display mask — it never blocks saving, drawing,
  // editing or any other action (the admin password stays in memory once
  // typed). The initial value is ALWAYS true (deterministic — SSR and the
  // first client render agree, so there can never be a hydration mismatch); a
  // session preference is restored from sessionStorage AFTER hydration.
  const [streamerMode, setStreamerMode] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Settings dirty-tracking. fetchSettings() stores the merged server payload
  // as a JSON snapshot; `settingsDirty` compares the live form state against it
  // so the "Discard changes" button only appears when there really are unsaved
  // edits. Product-form dirty-tracking uses a snapshot (state, not a ref — refs
  // must never be read during render) taken when the editor opens.
  const [settingsSnapshot, setSettingsSnapshot] = useState<string | null>(null);
  const [productFormSnapshot, setProductFormSnapshot] = useState('');

  // Restore + persist the streamer-mode preference for this tab (session-only).
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.sessionStorage.getItem('goyunir-admin-streamer-mode'); } catch { /* noop */ }
    if (stored === 'off') setStreamerMode(false);
    const onStorage = () => {
      try { setStreamerMode(window.sessionStorage.getItem('goyunir-admin-streamer-mode') !== 'off'); } catch { /* noop */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    try { window.sessionStorage.setItem('goyunir-admin-streamer-mode', streamerMode ? 'on' : 'off'); } catch { /* noop */ }
  }, [streamerMode]);

  // Guard for write/destructive actions: the admin password must be in memory
  // (it travels in the request body so every admin route can verify it). While
  // Streamer Mode is ON the password FIELD is locked (so the real password can
  // never be typed on a livestream), but a password typed earlier stays in
  // memory — so ALL actions keep working with customer data masked. Streamer
  // Mode ONLY masks sensitive data; it never blocks work.
  const requireUnlocked = (): boolean => {
    if (!password) {
      showToast('Enter the admin password first');
      return false;
    }
    return true;
  };

  // TWO-STEP ADMIN VERIFICATION: after HTTP Basic Auth, the operator must also
  // confirm a one-time code emailed to ADMIN_VERIFY_EMAIL before the portal
  // (and every /api/admin request via proxy.ts) is unlocked. `adminVerified`
  // starts null = still checking the device cookie; false renders the gate.
  const [adminVerified, setAdminVerified] = useState<boolean | null>(null);
  const [verifyEmail, setVerifyEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyRemember, setVerifyRemember] = useState(true);
  const [verifyMsg, setVerifyMsg] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyDevCode, setVerifyDevCode] = useState('');
  // Guards the AUTO-SEND so the code is emailed exactly ONCE per gate open (not
  // on every re-render). Reset when the gate closes so a mid-session re-lock
  // (401 ADMIN_2FA_REQUIRED) auto-sends a fresh code again.
  const verifyAutoSentRef = useRef(false);
  // Guards the AUTO-VERIFY: a 6-digit code is submitted exactly once per gate
  // open (not re-submitted on every re-render while it stays at 6 digits, and
  // never after a resend replaced the challenge).
  const lastSubmittedCodeRef = useRef('');

  const [isRunning, setIsRunning] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [selectedDrawTarget, setSelectedDrawTarget] = useState('ALL_POOLS');

  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 40;
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState('ALL');
  const [shipMsg, setShipMsg] = useState('');
  const [editingAddressEntry, setEditingAddressEntry] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [editingShippingEntry, setEditingShippingEntry] = useState<string | null>(null);
  const [shippingStatusDraft, setShippingStatusDraft] = useState('PENDING_FULFILLMENT');
  const [trackingDraft, setTrackingDraft] = useState('');

  const [recovery, setRecovery] = useState({ enabled: true, earlyDelayHours: 3, preDrawHours: 6, preDrawEnabled: true });
  const [recoveryMsg, setRecoveryMsg] = useState('');

  const [promos, setPromos] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsMsg, setAlertsMsg] = useState('');
  const [selectedAlertProductId, setSelectedAlertProductId] = useState('');
  const [promoForm, setPromoForm] = useState({
    code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '', promoterPayoutPercent: '', maxUsesPerEmail: '',
    timeLimited: false, startAt: '', endAt: '', maxUsesTotal: '',
  });
  const [promoMsg, setPromoMsg] = useState('');
  const [audit, setAudit] = useState<any[]>([]);

  const [scheduleForm, setScheduleForm] = useState<any>({});
  const [socialForm, setSocialForm] = useState<any>({});
  const [configMsg, setConfigMsg] = useState('');

  const [selftestResults, setSelftestResults] = useState<any>(null);
  const [selftestRunning, setSelftestRunning] = useState(false);
  const [organizeMsg, setOrganizeMsg] = useState('');
  const [wipeMsg, setWipeMsg] = useState('');
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState('');
  const [wipeRebuild, setWipeRebuild] = useState(true);
  const [envStatus, setEnvStatus] = useState<any>(null);
  const [envStatusLoading, setEnvStatusLoading] = useState(false);
  
  const [drawHistory, setDrawHistory] = useState<any[]>([]);
  const [drawHistoryLoading, setDrawHistoryLoading] = useState(false);
  const [expandedDraw, setExpandedDraw] = useState<number | null>(null);

  // ===== Products state (UPDATED) =====
  const [allProducts, setAllProducts] = useState<any[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<any>({
    name: '', slug: '', prefix: '', tagline: '', desc: '',
    checkoutMode: 'RAFFLE',
    productType: 'raffle',
    maxPerEmail: 1,
    maxPerCart: 1,
    isActive: false,       // default HIDDEN (as requested)
    isArchived: false,
    isUpcoming: false,
    goLiveAt: '',
    releaseEndsAt: '',
    customDropSchedule: null,
    soldOutBehavior: 'stay_visible',
    soldOutArchiveDelayHours: 24,
    // Per-product customer-facing copy overrides (empty = inherit global copy).
    urgencyInStock: '',
    urgencySoldOut: '',
    statusLive: '',
    statusArchived: '',
    mixedFormatRibbon: '',
    // Customer-facing show/hide toggles (default ALL on) — the product page
    // renders these blocks only while the corresponding toggle is enabled.
    showUrgencyLine: true,
    showStatusLine: true,
    showNotesSection: true,
    showMixedRibbon: true,
    deliveryIncentiveEnabled: false,
    deliveryIncentiveCreditCents: 0,
    deliveryIncentiveMinOrderSubtotalCents: 0,
    deliveryIncentiveExpiresDays: 60,
    deliveryIncentiveCodePrefix: '',
    deliveryIncentiveEligibleProductSlugs: [],
    deliveryIncentiveEligibleSizes: [],
    deliveryIncentiveTriggerSizes: [],
    // Per-size sampler records: each entry marks ONE size in Pricing & Sizes as
    // a trial SKU and can override the product-level credit defaults.
    samplerSizes: [],
    sortOrder: 0,
    notes: [],
    images: [],
    // NEW: dynamic price categories
    priceCategories: [
      { size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: UNCONFIGURED_STRIPE_PRICE_ID, winnerTiers: '1' }
    ]
  });
  const [defaultStripePriceId, setDefaultStripePriceId] = useState(UNCONFIGURED_STRIPE_PRICE_ID);
  const [productMsg, setProductMsg] = useState('');
  const [showProductForm, setShowProductForm] = useState(false);
  const [imageInput, setImageInput] = useState('');
  const [editingNoteIdx, setEditingNoteIdx] = useState<number | null>(null);
  const [noteForm, setNoteForm] = useState({ label: '', name: '', text: '' });
  const [productActionLoading, setProductActionLoading] = useState(false);
  // True while files are being uploaded/compressed in the product gallery. The
  // Save Product button is disabled during this window so a buyer can never
  // save the product with a half-finished image list.
  const [imageUploadBusy, setImageUploadBusy] = useState(false);
  const [imageUploadLabel, setImageUploadLabel] = useState('');
  // Which gallery media's crop editor is expanded (null = none).
  const [cropEditorIdx, setCropEditorIdx] = useState<number | null>(null);
  // ===== Users state =====
  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [userForm, setUserForm] = useState({ email: '', password: '', role: 'customer', rewards: 0 });
  const [userMsg, setUserMsg] = useState('');
  const [showUserForm, setShowUserForm] = useState(false);

  // ===== Catalog state =====
  const [catalogUpcoming, setCatalogUpcoming] = useState<any[]>([]);
  const [catalogArchive, setCatalogArchive] = useState<any[]>([]);
  const [catalogMsg, setCatalogMsg] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [themeSettings, setThemeSettings] = useState(GOYUNIR_STORE_SUITE.themeColors);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [heroSettings, setHeroSettings] = useState(GOYUNIR_STORE_SUITE.heroContent);
  const [formSettings, setFormSettings] = useState(GOYUNIR_STORE_SUITE.raffleRegistrationForm);
  const [footerSettings, setFooterSettings] = useState(GOYUNIR_STORE_SUITE.brandFooterData);
  const [brandingSettings, setBrandingSettings] = useState(DEFAULT_BRANDING_SETTINGS);
  // Rewards & points configuration (points earned per $1, redemption rate).
  const [rewardsSettings, setRewardsSettings] = useState(DEFAULT_REWARDS_SETTINGS);
  // Product gallery behaviour (auto-advance + slow zoom).
  const [gallerySettings, setGallerySettings] = useState(DEFAULT_GALLERY_SETTINGS);
  // Storefront copy overrides — saved under settings.copy. Storefront
  // components keep their built-in defaults until a string here is non-empty.
  const [copySettings, setCopySettings] = useState(DEFAULT_COPY_SETTINGS);
  // Catalog presentation — section order on /catalog. Default: live at the
  // BOTTOM (upcoming → archives → currently available). Stored under
  // store:config.catalog.sectionOrder.
  const [catalogSettings, setCatalogSettings] = useState<{
    sectionOrder: string[];
    categories: string[];
  }>(DEFAULT_CATALOG_SETTINGS);
  // Site behaviour (admin → Settings → Behavior). Whether the storefront forces
  // the page to start at the TOP on load (default ON) instead of letting the
  // browser restore the previous scroll position. Stored under store:config.behavior.
  const [behaviorSettings, setBehaviorSettings] = useState<{ scrollToTopOnLoad: boolean }>(DEFAULT_BEHAVIOR_SETTINGS);
  // Checkout & orders policy (admin → Settings → Checkout & Orders).
  const [checkoutSettings, setCheckoutSettings] = useState<{ requireAddressAutofill: boolean }>(DEFAULT_CHECKOUT_SETTINGS);
  // Reference-code prefix (admin → Settings → Checkout & Orders). Every order /
  // entry reference starts with this prefix (default `GU-`). Stored under
  // store:config.refPrefix.
  const [refPrefix, setRefPrefix] = useState(DEFAULT_REF_PREFIX);
  // Legal & policy content for /terms, /privacy, /shipping — all admin-editable
  // so buyers never need code changes to update policies, company name, or the
  // support address. Stored under store:config.legal.
  const [legalSettings, setLegalSettings] = useState<{
    companyName: string;
    supportEmail: string;
    terms: string;
    privacy: string;
    shipping: string;
  }>(DEFAULT_LEGAL_SETTINGS);
  const [legalOpen, setLegalOpen] = useState(false);
  const [productNotes, setProductNotes] = useState<Record<string, any[]>>({});
  const [orbSettings, setOrbSettings] = useState<any>(mergeOrbSettings(DEFAULT_ORBS, (GOYUNIR_STORE_SUITE as any).orbs));
  const [settingsMsg, setSettingsMsg] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  // Category draft input + handlers (Settings → Catalog → Product categories).
  const [categoryDraft, setCategoryDraft] = useState('');
  const addCategory = () => {
    const raw = categoryDraft.trim();
    if (!raw) return showToast('Type a category name first');
    setCatalogSettings((prev) => {
      const existing = (prev.categories || []).map((c) => c.toLowerCase());
      if (existing.includes(raw.toLowerCase())) {
        showToast('That category already exists');
        return prev;
      }
      return { ...prev, categories: [...(prev.categories || []), raw.slice(0, 40)] };
    });
    setCategoryDraft('');
  };
  const removeCategory = (cat: string) => {
    if (!confirm(`Delete category "${cat}"? Products already tagged with it keep their tags but the chip stops filtering.`)) return;
    setCatalogSettings((prev) => ({ ...prev, categories: (prev.categories || []).filter((c) => c !== cat) }));
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2800);
  };

  // ============================================================
  // FETCH FUNCTIONS (unchanged)
  // ============================================================
  const fetchStatus = async () => {
    try {
      // Date.now is used here as a cache-buster in an async handler (called
      // from effects + the refresh button), never during render — the React
      // Compiler cannot classify async handlers that are both effect- and
      // event-driven, so this is a documented false positive.
      // eslint-disable-next-line react-hooks/purity
      const res = await adminFetch(`/api/admin/status?t=${Date.now()}`);
      if (res.status === 401 || res.status === 403) {
        window.location.assign('/');
        return;
      }
      const data = await res.json();
      setStatus(data);
      // eslint-disable-next-line react-hooks/purity -- real wall-clock stamp for the "Updated Xs ago" label; async handler, not render.
      setLastUpdatedAt(Date.now());
    } catch {
      setStatus({ error: 'Unable to fetch status' });
    }
  };

  const refreshAll = async () => {
    setIsRefreshing(true);
    await Promise.all([
      fetchStatus(),
      fetchCatalogStatus(),
      fetchRecovery(),
      fetchPromos(),
      fetchConfig(),
      fetchDrawHistory(),
      fetchSettings(),
      fetchProducts(),
      fetchUsers(),
      fetchCatalogSettings(),
      fetchAlerts(),
    ]);
    setIsRefreshing(false);
    showToast('🔄 All data refreshed');
  };

  const fetchCatalogStatus = async () => {
    try {
      await fetch('/api/catalog/status');
    } catch {}
  };

  const fetchRecovery = async () => {
    try {
      const res = await adminFetch('/api/admin/recovery-config');
      const data = await res.json();
      setRecovery({
        enabled: data.enabled !== false,
        earlyDelayHours: data.earlyDelayHours ?? 3,
        preDrawHours: data.preDrawHours ?? 6,
        preDrawEnabled: data.preDrawEnabled !== false,
      });
    } catch {}
  };

  const fetchPromos = async () => {
    try {
      const res = await adminFetch('/api/admin/promos');
      const data = await res.json();
      setPromos(Array.isArray(data.promos) ? data.promos : []);
    } catch {}
  };

  const fetchAlerts = async () => {
    if (!password) {
      setAlerts([]);
      return;
    }
    setAlertsLoading(true);
    try {
      const res = await adminFetch('/api/admin/alerts');
      const data = await res.json();
      setAlerts(Array.isArray(data.subscribers) ? data.subscribers : []);
    } catch {
      setAlerts([]);
    }
    setAlertsLoading(false);
  };

  const fetchAudit = async () => {
    if (!password) {
      setAudit([]);
      return;
    }
    try {
      const res = await adminFetch('/api/admin/audit');
      const data = await res.json();
      setAudit(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      console.error('[Audit] Error:', err);
      setAudit([]);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await adminFetch('/api/admin/config');
      const data = await res.json();
      setScheduleForm({ ...data.baseSchedule, ...(data.globalScheduleOverride || {}) });
      setSocialForm({ ...data.baseSocialProof, ...(data.socialProofOverride || {}) });
      
      const notes: Record<string, any[]> = {};
      for (const p of GOYUNIR_STORE_SUITE.productCatalog) {
        notes[p.id] = p.notes || [];
      }
      setProductNotes(notes);
    } catch {}
  };

  const fetchDrawHistory = async () => {
    setDrawHistoryLoading(true);
    try {
      const res = await adminFetch('/api/admin/draw-history');
      const data = await res.json();
      if (Array.isArray(data.draws)) setDrawHistory(data.draws);
    } catch {}
    setDrawHistoryLoading(false);
  };

  const fetchSettings = async () => {
    setSettingsLoading(true);
    try {
      const res = await adminFetch('/api/admin/settings');
      const data = await res.json();
      if (data.settings) {
        const s = data.settings;
        // Merge the server payload over the module defaults DETERMINISTICALLY
        // (never over the live form state) so the snapshot below is a clean
        // "what's saved" baseline that dirty-tracking can compare against.
        const next = {
          theme: { ...GOYUNIR_STORE_SUITE.themeColors, ...(s.themeColors || {}) },
          hero: { ...GOYUNIR_STORE_SUITE.heroContent, ...(s.heroContent || {}) },
          form: s.raffleRegistrationForm || GOYUNIR_STORE_SUITE.raffleRegistrationForm,
          footer: s.brandFooterData || GOYUNIR_STORE_SUITE.brandFooterData,
          branding: { ...DEFAULT_BRANDING_SETTINGS, ...(s.branding || {}) },
          rewards: { ...DEFAULT_REWARDS_SETTINGS, ...(s.rewards || {}) },
          gallery: { ...DEFAULT_GALLERY_SETTINGS, ...(s.gallery || {}) },
          copy: { ...DEFAULT_COPY_SETTINGS, ...(s.copy || {}) },
          legal: { ...DEFAULT_LEGAL_SETTINGS, ...(s.legal || {}) },
          catalog: {
            sectionOrder: Array.isArray(s.catalog?.sectionOrder) ? s.catalog.sectionOrder : DEFAULT_CATALOG_SETTINGS.sectionOrder,
            // An EMPTY array is a real state: the operator deleted every
            // category. Never replace it with the seeded defaults or the
            // deletions silently come back on the next reload.
            categories: Array.isArray(s.catalog?.categories) ? s.catalog.categories : DEFAULT_CATALOG_SETTINGS.categories,
          },
          behavior: { ...DEFAULT_BEHAVIOR_SETTINGS, ...(s.behavior || {}) },
          checkout: { ...DEFAULT_CHECKOUT_SETTINGS, ...(s.checkout || {}) },
          refPrefix: (() => {
            const raw = String(s.refPrefix || '').trim().toUpperCase();
            return /^[A-Z0-9]{1,4}$/.test(raw) ? raw : DEFAULT_REF_PREFIX;
          })(),
          orbs: mergeOrbSettings(DEFAULT_ORBS, s.orbs || {}),
        };
        setThemeSettings(next.theme);
        setHeroSettings(next.hero);
        setFormSettings(next.form);
        setFooterSettings(next.footer);
        setBrandingSettings(next.branding);
        setRewardsSettings(next.rewards);
        setGallerySettings(next.gallery);
        setCopySettings(next.copy);
        setLegalSettings(next.legal);
        setCatalogSettings(next.catalog);
        setBehaviorSettings(next.behavior);
        setCheckoutSettings(next.checkout);
        setRefPrefix(next.refPrefix);
        setOrbSettings(next.orbs);
        if (s.productNotes) setProductNotes(s.productNotes);
        // Baseline for the "Discard changes" button — everything saved as-is.
        setSettingsSnapshot(JSON.stringify(next));
      }
      setSettingsMsg('');
    } catch (err: any) {
      setSettingsMsg('Could not load settings: ' + err.message);
    }
    setSettingsLoading(false);
  };

  // ===== UPDATED fetchProducts to handle priceCategories =====
  const fetchProducts = async () => {
    setProductsLoading(true);
    try {
      const res = await adminFetch('/api/admin/products?includeArchived=true');
      const data = await res.json();
      if (data.defaultStripePriceId) setDefaultStripePriceId(String(data.defaultStripePriceId));
      if (data.products) {
        const sorted = [...data.products].sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)));
        setAllProducts(sorted);
      }
    } catch (err) {
      console.error('[Products] Fetch error:', err);
    }
    setProductsLoading(false);
  };

  const fetchUsers = async () => {
    if (!password) return;
    setUsersLoading(true);
    try {
      const res = await adminFetch('/api/admin/users');
      const data = await res.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      console.error('[Users] Fetch error:', err);
    }
    setUsersLoading(false);
  };

  const fetchCatalogSettings = async () => {
    setCatalogLoading(true);
    try {
      const res = await adminFetch('/api/admin/catalog-settings');
      const data = await res.json();
      if (data.upcomingDrops) setCatalogUpcoming(data.upcomingDrops);
      if (data.archiveScents) setCatalogArchive(data.archiveScents);
    } catch (err) {
      console.error('Failed to load catalog settings:', err);
    }
    setCatalogLoading(false);
  };

  // ============================================================
  // PRODUCT FUNCTIONS (UPDATED)
  // ============================================================

  const resetProductForm = () => {
    const fresh = {
      name: '', slug: '', prefix: '', tagline: '', desc: '',
      checkoutMode: 'RAFFLE',
      productType: 'raffle',
      maxPerEmail: 1,
      maxPerCart: 1,
      totalInventory: 0,
      inventoryPerSize: {},
      maxRaffleAllocationLimit: 0,
      isActive: false, // default hidden
      isArchived: false,
      isUpcoming: false,
      goLiveAt: '',
      releaseEndsAt: '',
      customDropSchedule: null,
      // Per-size raffle configs — "customize each raffle differently". Keyed by
      // normalized size label; each entry can carry its own releaseEndsAt + schedule.
      sizeConfigs: {},
      // Per-product customer-facing copy overrides (empty = inherit global copy).
      urgencyInStock: '',
      urgencySoldOut: '',
      statusLive: '',
      statusArchived: '',
      // Mixed-format ribbon: template with {raffle}/{fcfs} count tokens, shown on
      // the product page when sizes mix raffle + instant-buy. Blank = inherit the
      // global Settings → Storefront copy (which falls back to the built-in line).
      mixedFormatRibbon: '',
      // Customer-facing show/hide toggles (default ALL on).
      showUrgencyLine: true,
      showStatusLine: true,
      showNotesSection: true,
      showMixedRibbon: true,
      soldOutBehavior: 'stay_visible',
      soldOutArchiveDelayHours: 24,
      deliveryIncentiveEnabled: false,
      deliveryIncentiveCreditCents: 0,
      deliveryIncentiveMinOrderSubtotalCents: 0,
      deliveryIncentiveExpiresDays: 60,
      deliveryIncentiveNeverExpires: false,
      deliveryIncentiveCodePrefix: '',
      deliveryIncentiveEligibleProductSlugs: [],
      deliveryIncentiveEligibleSizes: [],
      deliveryIncentiveTriggerSizes: [],
      // Per-size sampler records (trial SKUs) — see Trial sizes & sample credits.
      samplerSizes: [],
      sortOrder: 0,
      categories: [],
      notes: [],
      images: [],
      crops: [],
      priceCategories: [
        { size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId, winnerTiers: '1' }
      ]
    };
    setProductForm(fresh);
    setProductFormSnapshot(JSON.stringify(fresh));
    setEditingProduct(null);
    setEditingNoteIdx(null);
    setNoteForm({ label: '', name: '', text: '' });
    setImageInput('');
  };

  const editProduct = (product: any) => {
    setEditingProduct(product.id);
    // Ensure priceCategories exists
    const categories = product.priceCategories && Array.isArray(product.priceCategories)
      ? product.priceCategories
      : [{ size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId, winnerTiers: '1' }];
    const form = {
      ...product,
      customDropSchedule: product.customDropSchedule && typeof product.customDropSchedule === 'object' && Object.keys(product.customDropSchedule).length > 0
        ? product.customDropSchedule
        : null,
      // Per-size sampler records. Products saved with the OLD "Trigger on
      // size(s) CSV" get their legacy trigger sizes promoted into per-sampler
      // records (each falling back to the product-level credit defaults) so the
      // new per-size editor shows every sampler and nothing is lost.
      samplerSizes: (() => {
        const existing = Array.isArray(product.samplerSizes) ? product.samplerSizes : [];
        if (existing.length > 0) return existing;
        const legacy = product.deliveryIncentiveEnabled === true && Array.isArray(product.deliveryIncentiveTriggerSizes)
          ? product.deliveryIncentiveTriggerSizes.map(String).filter(Boolean)
          : [];
        return legacy.map((size: string) => ({
          size,
          label: '',
          fullSize: '',
          creditCents: null,
          minOrderSubtotalCents: null,
          neverExpires: null,
          expiresDays: null,
          codePrefix: '',
          eligibleProductSlugs: null,
          eligibleSizes: null,
          note: '',
        }));
      })(),
      priceCategories: categories,
      notes: product.notes || [],
      images: product.images || [],
      crops: Array.isArray(product.crops) && product.crops.length === (product.images || []).length
        ? product.crops
        : (product.images || []).map(() => DEFAULT_CROP),
      isUpcoming: product.isUpcoming || false,
      checkoutMode: String(product.checkoutMode || '').toUpperCase() === 'FCFS' || product.isRaffle === false ? 'FCFS' : 'RAFFLE',
      productType: product.productType || (product.isRaffle === false ? 'fcfs' : 'raffle'),
      maxPerEmail: Number(product.maxPerEmail || 1),
      maxPerCart: Number(product.maxPerCart || product.maxPerEmail || 1),
      totalInventory: Number(product.totalInventory || 0),
      inventoryPerSize: product.inventoryPerSize && typeof product.inventoryPerSize === 'object' ? product.inventoryPerSize : {},
      categories: Array.isArray(product.categories) ? product.categories : [],
      maxRaffleAllocationLimit: Number(product.maxRaffleAllocationLimit || 0),
      sortOrder: product.sortOrder || 0,
      // Ensure default hidden if new
      isActive: product.isActive !== undefined ? product.isActive : false,
    };
    setProductForm(form);
    setProductFormSnapshot(JSON.stringify(form));
    setShowProductForm(true);
  };

  /** Open the product editor pre-filled with a COPY of an existing release. The
   *  copy gets a fresh name/slug, starts hidden, and saving it creates a NEW
   *  product (the original is untouched) — a fast start for a variant launch. */
  const duplicateProduct = (product: any) => {
    const copyName = `${String(product.name || 'Product').trim()} (copy)`;
    const copySlug = `${String(product.slug || slugifyName(String(product.name || ''))).replace(/[^a-z0-9-]+/g, '-')}-copy`;
    const form = {
      ...product,
      id: undefined,
      name: copyName,
      slug: copySlug,
      _slugAuto: false,
      isActive: false,
      sortOrder: (Number(product.sortOrder) || 0) + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: Array.isArray(product.notes) ? product.notes : [],
      images: Array.isArray(product.images) ? product.images : [],
      crops: Array.isArray(product.crops) && product.crops.length === (product.images || []).length
        ? product.crops
        : (product.images || []).map(() => DEFAULT_CROP),
      categories: Array.isArray(product.categories) ? product.categories : [],
      inventoryPerSize: product.inventoryPerSize && typeof product.inventoryPerSize === 'object' ? product.inventoryPerSize : {},
    };
    setEditingProduct(null);
    setProductForm(form);
    setProductFormSnapshot(JSON.stringify(form));
    setShowProductForm(true);
    showToast('Duplicate created — tweak it, then Save Product');
  };

  // ===== Handle dynamic price categories =====
  const addPriceCategory = () => {
    setProductForm((prev: any) => ({
      ...prev,
      priceCategories: [
        ...prev.priceCategories,
        { size: '', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId, winnerTiers: '1' }
      ]
    }));
  };

  const removePriceCategory = (index: number) => {
    setProductForm((prev: any) => {
      const removedSize = String(prev.priceCategories?.[index]?.size || '').trim();
      const samplers = Array.isArray(prev.samplerSizes) ? prev.samplerSizes : [];
      const removedKey = removedSize.toLowerCase();
      const nextSamplers = removedKey
        ? samplers.filter((s: any) => String(s?.size || '').trim().toLowerCase() !== removedKey)
        : samplers;
      const sizeConfigs = { ...(prev.sizeConfigs || {}) };
      if (removedKey && sizeConfigs[removedKey]) delete sizeConfigs[removedKey];
      return {
        ...prev,
        priceCategories: prev.priceCategories.filter((_: any, i: number) => i !== index),
        samplerSizes: nextSamplers,
        sizeConfigs,
      };
    });
  };

  const updatePriceCategory = (index: number, field: string, value: any) => {
    setProductForm((prev: any) => {
      const updated = [...prev.priceCategories];
      const previousSize = String(updated[index]?.size || '').trim();
      updated[index] = { ...updated[index], [field]: value };
      // Keep sampler records attached when a sampler size is renamed, and point
      // any "credits toward" target at the new name if it referenced this size.
      if (field === 'size') {
        const nextSize = String(value || '').trim();
        const prevKey = previousSize.toLowerCase();
        const nextKey = nextSize.toLowerCase();
        let sizeConfigs: any = null;
        let samplerSizes: any = null;
        let inventoryPerSize: any = null;
        // Keep EVERY per-size record attached when a size is renamed: the sampler
        // marker + its "credits toward" pointer, any per-size raffle config, and
        // the per-size stock. Renaming "Standard" → "Full Bottle" must never orphan
        // its raffle timer, inventory or trial-SKU setup.
        if (previousSize && nextSize && prevKey !== nextKey) {
          const cfg = (prev.sizeConfigs || {})[prevKey];
          if (cfg) {
            sizeConfigs = { ...(prev.sizeConfigs || {}) };
            delete sizeConfigs[prevKey];
            sizeConfigs[nextKey] = cfg;
          }
          const inv = (prev.inventoryPerSize || {})[previousSize];
          if (inv !== undefined) {
            inventoryPerSize = { ...(prev.inventoryPerSize || {}) };
            delete inventoryPerSize[previousSize];
            inventoryPerSize[nextSize] = inv;
          }
          const samplers = Array.isArray(prev.samplerSizes) ? prev.samplerSizes : [];
          if (samplers.some((s: any) => String(s?.size || '').trim().toLowerCase() === prevKey)) {
            samplerSizes = samplers.map((s: any) =>
              String(s?.size || '').trim().toLowerCase() === prevKey
                ? { ...s, size: nextSize, fullSize: String(s?.fullSize || '').trim().toLowerCase() === prevKey ? nextSize : s?.fullSize }
                : s,
            );
          }
        }
        return {
          ...prev,
          priceCategories: updated,
          sizeConfigs: sizeConfigs || prev.sizeConfigs || {},
          samplerSizes: samplerSizes || prev.samplerSizes || [],
          inventoryPerSize: inventoryPerSize || prev.inventoryPerSize || {},
        };
      }
      return { ...prev, priceCategories: updated };
    });
  };

  // Update one field on a size's per-size raffle config (matched by the size's
  // exact label). An empty releaseEndsAt removes the override so the size falls
  // back to the product-level countdown; an empty schedule clears the per-size
  // cadence. Never stores a config for a size that isn't in Pricing & Sizes.
  const updateSizeConfig = (size: string, patch: any) => {
    setProductForm((prev: any) => {
      const sizeKey = String(size || '').trim().toLowerCase();
      if (!sizeKey) return prev;
      const valid = (prev.priceCategories || []).some((c: any) => String(c?.size || '').trim().toLowerCase() === sizeKey);
      if (!valid) return prev;
      const current = (prev.sizeConfigs || {})[sizeKey] || {};
      const next = { ...current, ...patch };
      const sizeConfigs = { ...(prev.sizeConfigs || {}) };
      if (Object.keys(next).length > 0 && (next.releaseEndsAt || next.customDropSchedule)) sizeConfigs[sizeKey] = next;
      else delete sizeConfigs[sizeKey];
      return { ...prev, sizeConfigs };
    });
  };

  // Mark/unmark a size as a sampler (trial SKU) directly from Pricing & Sizes.
  const toggleSampler = (index: number) => {
    const cat = productForm.priceCategories?.[index];
    if (!cat) return;
    const size = String(cat.size || '').trim();
    if (!size) {
      setProductMsg('❌ Give the size a name first, then mark it as a sampler.');
      showToast('Name the size first');
      return;
    }
    setProductForm((prev: any) => {
      const samplers = Array.isArray(prev.samplerSizes) ? prev.samplerSizes : [];
      const key = size.toLowerCase();
      if (samplers.some((s: any) => String(s?.size || '').trim().toLowerCase() === key)) {
        return { ...prev, samplerSizes: samplers.filter((s: any) => String(s?.size || '').trim().toLowerCase() !== key) };
      }
      return {
        ...prev,
        samplerSizes: [
          ...samplers,
          {
            size,
            label: '',
            fullSize: '',
            creditCents: null,
            minOrderSubtotalCents: null,
            neverExpires: null,
            expiresDays: null,
            codePrefix: '',
            eligibleProductSlugs: null,
            eligibleSizes: null,
            note: '',
          },
        ],
      };
    });
  };

  // Update one field on a sampler record (matched by the size's exact name).
  const updateSampler = (size: string, patch: any) => {
    setProductForm((prev: any) => {
      const samplers = Array.isArray(prev.samplerSizes) ? prev.samplerSizes : [];
      return {
        ...prev,
        samplerSizes: samplers.map((s: any) =>
          String(s?.size || '').trim().toLowerCase() === String(size || '').trim().toLowerCase() ? { ...s, ...patch } : s,
        ),
      };
    });
  };

  // Remove a sampler record from the per-sampler panel (matched by name).
  const removeSamplerByName = (size: string) => {
    setProductForm((prev: any) => ({
      ...prev,
      samplerSizes: (Array.isArray(prev.samplerSizes) ? prev.samplerSizes : []).filter(
        (s: any) => String(s?.size || '').trim().toLowerCase() !== String(size || '').trim().toLowerCase(),
      ),
    }));
  };

  // ===== Handle image/video file uploads =====
  const handleImageFiles = async (files: FileList) => {
    if (!requireUnlocked()) {
      setProductMsg('❌ Enter the admin password first.');
      return;
    }
    if (!editingProduct) {
      setProductMsg('❌ Save the product first, then upload images.');
      return;
    }
    const fileArray = Array.from(files);
    const unsupported = fileArray.filter((f) => !isAcceptedMediaFile(f));
    if (unsupported.length > 0) {
      setProductMsg(`❌ Unsupported file type: ${unsupported.map((f) => f.name).join(', ')}. Use PNG, JPEG, JPG, SVG, WEBP, GIF, BMP or video (MP4, MOV, MKV, AVI, WEBM).`);
      return;
    }
    let uploaded = 0;
    let failed = 0;
    setImageUploadBusy(true);
    try {
      for (let i = 0; i < fileArray.length; i += 1) {
        const file = fileArray[i];
        setImageUploadLabel(`Uploading ${file.name} (${i + 1}/${fileArray.length})…`);
        const compressed = await compressImageFile(file);
        const previewUrl = await fileToDataURL(compressed);
        // Keep the crop list aligned with the media list — a new item always
        // starts at the default (full-image) crop.
        setProductForm((prev: any) => {
          const nextImages = [...(prev.images || []), previewUrl];
          const nextCrops = [...(Array.isArray(prev.crops) ? prev.crops : prev.images.map(() => DEFAULT_CROP)), DEFAULT_CROP];
          return { ...prev, images: nextImages, crops: nextCrops };
        });
        const uploadData = new FormData();
        uploadData.append('productId', editingProduct);
        uploadData.append('password', password);
        uploadData.append('file', compressed);
        const res = await adminFetch('/api/admin/upload', { method: 'POST', body: uploadData });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          failed += 1;
          setProductMsg(`⚠ Upload to store failed for ${file.name}: ${data.error || 'unknown error'}. The media stays in this form — press Save Product to store it directly.`);
          // NOTE: we intentionally do NOT remove the preview. The data URL stays
          // in productForm.images so clicking "Save Product" persists it to Redis
          // even if the separate upload endpoint was blocked (e.g. size limits).
          continue;
        }
        uploaded += 1;
      }
      await fetchProducts();
      if (failed === 0 && uploaded > 0) {
        setProductMsg(`✅ Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}.`);
      }
      showToast(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}${failed ? ` · ${failed} kept locally` : ''}`);
    } finally {
      setImageUploadBusy(false);
      setImageUploadLabel('');
    }
  };

  // ===== Save product (UPDATED to send priceCategories + crops) =====
  // ── Live "smart math" health check ────────────────────────────────────────
  // Runs the SAME pure engine the server uses at save time, live on every
  // keystroke, so the operator sees exploitable/broken math the moment it is
  // typed (never after a failed save). `productIssues` drives the "Math &
  // health check" panel at the top of the form AND the Overview health card.
  const productIssues: SanityIssue[] = useMemo(
    () => sortSanityIssues(checkProductSanity(productForm, { rewards: rewardsSettings })),
    [productForm, rewardsSettings],
  );
  const blockingCount = productIssues.filter((i) => i.severity === 'error').length;
  const warningCount = productIssues.filter((i) => i.severity === 'warning').length;
  const rewardsIssues: SanityIssue[] = useMemo(
    () => sortSanityIssues(checkRewardsSanity(rewardsSettings)),
    [rewardsSettings],
  );

  const saveProduct = async () => {
    if (!requireUnlocked()) return;
    // Never save a product while files are still uploading — the form would
    // persist a half-finished media list and lose the queued files.
    if (imageUploadBusy) {
      setProductMsg(`⏳ Still ${imageUploadLabel || 'uploading files'} — wait for the upload to finish before saving.`);
      showToast('Wait for uploads to finish before saving');
      return;
    }

    // ── Mistake-proof validation (friendly inline messages, never a bare alert) ──
    const name = String(productForm.name || '').trim();
    if (!name) {
      setProductMsg('❌ Product name is required.');
      showToast('Product name is required');
      return;
    }
    // Auto-generate the slug from the name when the operator left it blank.
    const autoSlug = slugifyName(name);
    const slug = String(productForm.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || autoSlug;
    if (!slug) {
      setProductMsg('❌ A URL slug is required (or auto-generated from the name).');
      showToast('Slug is required');
      return;
    }
    // Every sellable size needs a size label. Dedupe the categories so the same
    // size can never be saved twice (it would shadow itself at checkout).
    const seenSizes = new Set<string>();
    const priceCategories = (productForm.priceCategories || [])
      .filter((c: any) => String(c?.size || '').trim())
      .filter((c: any) => {
        const sizeKey = String(c.size).trim().toLowerCase();
        if (seenSizes.has(sizeKey)) return false;
        seenSizes.add(sizeKey);
        return true;
      });
    if (priceCategories.length === 0) {
      setProductMsg('❌ Add at least one size with a price (e.g. 50ml / 100ml).');
      showToast('At least one size + price is required');
      return;
    }
    // ── Smart-math gate: never save EXPLOITABLE math. The server enforces the
    // same rule on POST; this client-side copy gives instant feedback so the
    // operator fixes it BEFORE a round-trip.
    const sanity = sortSanityIssues(checkProductSanity({ ...productForm, priceCategories }, { rewards: rewardsSettings }));
    const blockers = sanity.filter((i) => i.severity === 'error');
    if (blockers.length > 0) {
      const first = blockers[0];
      setProductMsg(`❌ Can't save — ${first.message}${first.detail ? ` ${first.detail}` : ''} (${blockers.length} blocking issue${blockers.length === 1 ? '' : 's'})`);
      showToast(`Blocked: ${first.message}`);
      return;
    }
    setProductMsg('');
    setProductActionLoading(true);
    try {
      // Build payload with priceCategories
      const payload = {
        password,
        action: 'upsert',
        ...productForm,
        name,
        slug,
        priceCategories,
        notes: productForm.notes || [],
        images: productForm.images || [],
        crops: Array.isArray(productForm.crops) ? productForm.crops : (productForm.images || []).map(() => DEFAULT_CROP),
        sortOrder: Number(productForm.sortOrder) || 0,
        checkoutMode: productForm.checkoutMode === 'FCFS' ? 'FCFS' : 'RAFFLE',
        isRaffle: productForm.checkoutMode !== 'FCFS',
        productType: productForm.checkoutMode === 'FCFS' ? 'fcfs' : 'raffle',
        maxPerEmail: Math.max(1, Number(productForm.maxPerEmail) || 1),
        maxPerCart: Math.max(1, Number(productForm.maxPerCart) || Number(productForm.maxPerEmail) || 1),
        // Per-size stock (multi-size products keep a separate inventory per size).
        inventoryPerSize: productForm.inventoryPerSize && typeof productForm.inventoryPerSize === 'object' ? productForm.inventoryPerSize : {},
        // Category tags (admin-managed list lives in Settings → Catalog → Categories).
        categories: Array.isArray(productForm.categories) ? productForm.categories : [],
        // Ensure we send isActive, isArchived, isUpcoming
      };
      // Remove old price50ml/100ml if present (they shouldn't be)
      delete payload.price50ml;
      delete payload.price100ml;
      delete payload.stripeId50ml;
      delete payload.stripeId100ml;

      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text || 'Non-JSON response from server' };
      }
      if (res.ok) {
        setProductMsg(`✅ Product "${data?.product?.name || productForm.name}" saved successfully!`);
        showToast('UPDATED · Product');
        await fetchProducts();
        setShowProductForm(false);
        resetProductForm();
      } else {
        setProductMsg('❌ Error: ' + (data.error || `HTTP ${res.status}`));
      }
    } catch (err: any) {
      setProductMsg('❌ Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  // ===== Delete, archive, active toggles (unchanged logic, but now archiving/upcoming does NOT hide) =====
  const deleteProduct = async (id: string) => {
    if (!requireUnlocked()) return;
    if (!confirm('Are you sure you want to delete this product? This cannot be undone.')) return;
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'delete', id }),
      });
      if (res.ok) {
        showToast('DELETED · Product');
        await fetchProducts();
      } else {
        const data = await res.json();
        showToast('Delete failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      showToast('Delete failed: ' + err.message);
    }
    setProductActionLoading(false);
  };

  // Archive/Unarchive: now they do NOT affect isActive – they just move the product to the archive list while remaining visible.
  const toggleArchive = async (id: string, currentArchived: boolean) => {
    if (!requireUnlocked()) return;
    const action = currentArchived ? 'unarchive' : 'archive';
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, id }),
      });
      if (res.ok) {
        showToast(`UPDATED · ${currentArchived ? 'Unarchived' : 'Archived'}`);
        await fetchProducts();
        await fetchCatalogStatus();
      }
    } catch (err: any) {
      showToast('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  // Toggle active: simply toggles visibility without affecting archive/upcoming status
  const toggleActive = async (id: string, currentActive: boolean) => {
    if (!requireUnlocked()) return;
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'toggleActive', id, nextActive: !currentActive }),
      });
      if (res.ok) {
        showToast(`UPDATED · ${currentActive ? 'Hidden' : 'Visible'}`);
        await fetchProducts();
      }
    } catch (err: any) {
      showToast('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  // Upcoming toggle: does not hide, just marks/unmarks as upcoming
  const toggleUpcoming = async (id: string, currentUpcoming: boolean) => {
    if (!requireUnlocked()) return;
    const action = currentUpcoming ? 'removeFromUpcoming' : 'addToUpcoming';
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, id }),
      });
      if (res.ok) {
        showToast(`UPDATED · ${currentUpcoming ? 'Removed from Upcoming' : 'Added to Upcoming'}`);
        await fetchProducts();
      }
    } catch (err: any) {
      showToast('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const reorderProducts = async (productId: string, newOrder: number) => {
    if (!requireUnlocked()) return;
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'reorder', id: productId, sortOrder: newOrder }),
      });
      if (res.ok) {
        showToast('UPDATED · Reordered');
        await fetchProducts();
      }
    } catch (err: any) {
      showToast('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const addNote = () => {
    if (!noteForm.label || !noteForm.name) return;
    setProductForm((prev: any) => {
      const nextNotes = [...(prev.notes || [])];
      if (editingNoteIdx !== null) nextNotes[editingNoteIdx] = { ...noteForm };
      else nextNotes.push({ ...noteForm });
      return { ...prev, notes: nextNotes };
    });
    setNoteForm({ label: '', name: '', text: '' });
    setEditingNoteIdx(null);
  };

  const removeNote = (idx: number) => {
    setProductForm((prev: any) => ({
      ...prev,
      notes: prev.notes.filter((_: any, i: number) => i !== idx)
    }));
  };

  const editNote = (idx: number) => {
    setEditingNoteIdx(idx);
    setNoteForm(productForm.notes[idx]);
  };

  // For image URL input (still supported). URL media always starts at the
  // default crop (full image) and keeps the crops list aligned by index.
  const addImageUrl = () => {
    if (!imageInput.trim()) return;
    setProductForm((prev: any) => {
      const nextImages = [...(prev.images || []), imageInput.trim()];
      const nextCrops = [...(Array.isArray(prev.crops) ? prev.crops : (prev.images || []).map(() => DEFAULT_CROP)), DEFAULT_CROP];
      return { ...prev, images: nextImages, crops: nextCrops };
    });
    setImageInput('');
  };

  const removeImage = (idx: number) => {
    setProductForm((prev: any) => ({
      ...prev,
      images: prev.images.filter((_: any, i: number) => i !== idx),
      crops: (Array.isArray(prev.crops) ? prev.crops : prev.images.map(() => DEFAULT_CROP)).filter((_: any, i: number) => i !== idx),
    }));
  };

  const seedDefaultProducts = async () => {
    if (!requireUnlocked()) return;
    if (!confirm('This will seed default placeholder products into Redis. Existing products will NOT be overwritten. Continue?')) return;
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/seed');
      const data = await res.json();
      if (res.ok) {
        setProductMsg('✅ ' + data.message);
        showToast('SEEDED · Default products');
        await fetchProducts();
      } else {
        setProductMsg('❌ Error: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      setProductMsg('❌ Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  // ============================================================
  // USER FUNCTIONS (unchanged)
  // ============================================================
  const saveUser = async () => {
    if (!requireUnlocked()) return;
    if (!userForm.email) { showToast('Email is required'); return; }
    setProductActionLoading(true);
    try {
      const body: any = {
        password: password,
        action: editingUser ? 'update' : 'create',
        email: userForm.email,
        role: userForm.role,
        rewards: userForm.rewards,
      };
      if (userForm.password) {
        body.userPassword = userForm.password;
      }
      if (editingUser) {
        body.id = editingUser;
      }

      const res = await adminFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setUserMsg('✅ User saved successfully!');
        showToast('UPDATED · User');
        await fetchUsers();
        setShowUserForm(false);
        setUserForm({ email: '', password: '', role: 'customer', rewards: 0 });
        setEditingUser(null);
      } else {
        setUserMsg('❌ Error: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      setUserMsg('❌ Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const deleteUser = async (id: string) => {
    if (!requireUnlocked()) return;
    if (!confirm('Delete this user?')) return;
    try {
      const res = await adminFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'delete', id }),
      });
      if (res.ok) {
        showToast('DELETED · User');
        await fetchUsers();
      }
    } catch (err: any) {
      showToast('Error: ' + err.message);
    }
  };

  // ============================================================
  // CATALOG FUNCTIONS (unchanged)
  // ============================================================
  const saveCatalogSettings = async () => {
    if (!requireUnlocked()) return;
    setCatalogLoading(true);
    try {
      const res = await adminFetch('/api/admin/catalog-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          upcomingDrops: catalogUpcoming,
          archiveScents: catalogArchive,
          // The Catalog tab carries the admin-managed category list too — save
          // it so category deletions persist even when saved from here.
          categories: Array.isArray(catalogSettings.categories) ? catalogSettings.categories : [],
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCatalogMsg('Catalog settings saved!');
        showToast('UPDATED · Catalog');
      } else {
        setCatalogMsg('Error: ' + (data.error || 'Unknown'));
      }
    } catch (err: any) {
      setCatalogMsg('Error: ' + err.message);
    }
    setCatalogLoading(false);
  };

  // ============================================================
  // PROMO FUNCTIONS (unchanged)
  // ============================================================
  const savePromo = async () => {
    if (!requireUnlocked()) return;
    const customerDiscount = Number(promoForm.customerDiscountPercent);
    const promoterPayout = Number(promoForm.promoterPayoutPercent);
    const maxUses = Number(promoForm.maxUsesPerEmail);
    const maxUsesTotal = Number(promoForm.maxUsesTotal) || 0;
    
    if (isNaN(customerDiscount) || customerDiscount < 0 || customerDiscount > 50) {
      showToast('Customer discount must be between 0 and 50');
      return;
    }
    if (isNaN(promoterPayout) || promoterPayout < 0 || promoterPayout > 50) {
      showToast('Promoter payout must be between 0 and 50');
      return;
    }
    if (isNaN(maxUses) || maxUses < 0) {
      showToast('Max uses must be 0 or more');
      return;
    }
    if (!String(promoForm.code || '').trim()) {
      showToast('Promo code is required');
      return;
    }
    
    try {
      const res = await adminFetch('/api/admin/promos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          action: 'upsert',
          code: promoForm.code,
          promoterName: promoForm.promoterName,
          promoterEmail: promoForm.promoterEmail,
          customerDiscountPercent: customerDiscount,
          promoterPayoutPercent: promoterPayout,
          maxUsesPerEmail: maxUses,
          maxUsesTotal: maxUsesTotal,
          timeLimited: promoForm.timeLimited,
          startAt: promoForm.startAt || null,
          endAt: promoForm.endAt || null,
          active: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPromoMsg(`Saved ${data.promo?.code}.`); showToast('UPDATED · Promo');
        setPromoForm({ code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '', promoterPayoutPercent: '', maxUsesPerEmail: '', timeLimited: false, startAt: '', endAt: '', maxUsesTotal: '' });
        await fetchPromos();
      } else setPromoMsg(data.error || 'Failed');
    } catch {
      setPromoMsg('Failed');
    }
  };

  const deletePromo = async (code: string) => {
    if (!requireUnlocked()) return;
    if (!confirm(`Delete promo code ${code}?`)) return;
    await adminFetch('/api/admin/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, action: 'delete', code }) });
    await fetchPromos();
  };

  // ============================================================
  // OTHER FUNCTIONS (unchanged)
  // ============================================================
  const saveSchedule = async () => {
    if (!requireUnlocked()) return;
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'schedule', value: scheduleForm }),
    });
    if (res.ok) { setConfigMsg('Schedule saved — live immediately, no redeploy needed.'); showToast('UPDATED · Schedule'); } else setConfigMsg('Failed to save schedule.');
  };

  const saveSocial = async () => {
    if (!requireUnlocked()) return;
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'socialProof', value: socialForm }),
    });
    if (res.ok) { setConfigMsg('Social proof settings saved.'); showToast('UPDATED · Social proof'); } else setConfigMsg('Failed to save.');
  };

  const runSelftest = async () => {
    if (!password) return showToast('Enter the admin password first');
    setSelftestRunning(true);
    setSelftestResults(null);
    try {
      const res = await adminFetch('/api/admin/self-test');
      const data = await res.json();
      setSelftestResults(data);
    } catch {
      setSelftestResults({ error: 'Could not run self-test — connection failed.' });
    } finally {
      setSelftestRunning(false);
    }
  };

  const triggerDrop = async () => {
    if (!requireUnlocked()) return;
    if (!confirm('This will run the draw and charge selected winners\' saved cards. Continue?')) return;
    setIsRunning(true);
    setResultMessage('Running…');
    try {
      const res = await adminFetch('/api/admin/trigger-drop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPool: selectedDrawTarget, verificationKey: password }),
      });
      const data = await res.json();
      if (res.ok) {
        const ds = data.drawSummary || {};
        const winners = ds.processedWinners || [];
        const charged = winners.filter((w: any) => w.status === 'SUCCESS_CHARGED' || w.status === 'charged');
        const revenue = (ds.totalRevenueCents != null
          ? ds.totalRevenueCents
          : charged.reduce((sum: number, w: any) => sum + (Number(w.amountCents) || 0), 0)) / 100;
        const lines = [
          `Done · ${ds.totalSuccessfulCharges ?? charged.length} charged`,
          ds.executionTime ? `Time: ${ds.executionTime}` : '',
          revenue > 0 ? `Revenue: $${revenue.toFixed(2)}` : '',
          ...charged.slice(0, 8).map((w: any) =>
            `${pii(w.email, 'email', streamerMode)} · ${w.product || ''} ${w.size || ''} · $${((w.amountCents || 0) / 100).toFixed(2)}${w.promoCode ? ` · promo ${pii(w.promoCode, 'promo', streamerMode)}` : ''}`
          ),
          ...winners.filter((w: any) => w.status && w.status !== 'SUCCESS_CHARGED' && w.status !== 'charged').slice(0, 5).map((w: any) =>
            `${pii(w.email, 'email', streamerMode)}: ${w.status}`
          ),
        ].filter(Boolean);
        setResultMessage(lines.join('\n'));
        showToast('UPDATED · Draw complete');
        await fetchStatus();
        await fetchDrawHistory();
      } else setResultMessage(data.error || 'Failed');
    } catch {
      setResultMessage('Connection failed');
    } finally {
      setIsRunning(false);
    }
  };

  const updateAddress = async (entry: any, newAddress: string) => {
    if (!requireUnlocked()) return;
    setShipMsg('Updating address…');
    try {
      const res = await adminFetch('/api/admin/update-address', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          password, 
          email: entry.email, 
          variant: entry.variant, 
          size: entry.size, 
          newAddress
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setShipMsg('Address updated.');
        showToast('UPDATED · Address');
        await fetchStatus();
        setEditingAddressEntry(null);
      } else setShipMsg(data.error || 'Failed: ' + (data.error || 'Unknown error'));
    } catch (err: any) {
      setShipMsg('Failed: ' + err.message);
    }
  };

  // Update shipping status + tracking for a Won & Charged ledger entry. The
  // /api/admin/update-shipping route persists it on the ledger entry AND emails
  // the customer (and issues any configured post-delivery credit on DELIVERED).
  const updateShipping = async (entry: any) => {
    if (!requireUnlocked()) return;
    setShipMsg('Updating shipping…');
    try {
      const res = await adminFetch('/api/admin/update-shipping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          email: entry.email,
          variant: entry.variant,
          size: entry.size,
          shippingStatus: shippingStatusDraft,
          trackingNumber: trackingDraft.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const notified = data.notified === true;
        const matched = Number(data.updated || 0) > 0;
        setShipMsg(matched
          ? `Shipping updated to ${shippingStatusDraft.replace(/_/g, ' ')}${notified ? ' — customer notified by email.' : ' — saved.'}`
          : `No WINNER_CHARGED record matched ${entry.email} · ${entry.variant} ${entry.size} — nothing was changed.`);
        showToast('UPDATED · Shipping');
        await fetchStatus();
        setEditingShippingEntry(null);
      } else setShipMsg(data.error || 'Failed to update shipping.');
    } catch (err: any) {
      setShipMsg('Failed: ' + err.message);
    }
  };

  const saveRecovery = async () => {
    if (!requireUnlocked()) return;
    try {
      const res = await adminFetch('/api/admin/recovery-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, ...recovery }) });
      const data = await res.json();
      if (res.ok) { setRecoveryMsg('Recovery settings saved.'); showToast('UPDATED · Recovery'); } else setRecoveryMsg(data.error || 'Failed');
    } catch {
      setRecoveryMsg('Failed');
    }
  };

  const cancelOrder = async (entry: any) => {
    if (!requireUnlocked()) return;
    const reason = prompt(`Cancel ${pii(entry.email, 'email', streamerMode)}'s entry for ${entry.variant} (${entry.size})? Optional reason:`);
    if (reason === null) return;
    try {
      const res = await adminFetch('/api/admin/cancel-entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, variant: entry.variant, size: entry.size, email: entry.email, reason }),
      });
      const data = await res.json();
      if (res.ok) { setShipMsg('Entry cancelled.'); await fetchStatus(); } else setShipMsg(data.error || 'Failed.');
    } catch {
      setShipMsg('Connection failed.');
    }
  };

  const organizeRedis = async () => {
    if (!requireUnlocked()) return;
    setOrganizeMsg('Migrating legacy keys and tidying the Redis schema...');
    try {
      const res = await adminFetch('/api/admin/organize-redis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok) {
        const migrated = Array.isArray(data.migrated) && data.migrated.length > 0 ? ` Migrated: ${data.migrated.length} key(s).` : '';
        const removed = Array.isArray(data.removed) && data.removed.length > 0 ? ` Removed legacy: ${data.removed.join(', ')}.` : '';
        setOrganizeMsg((data.message || 'Redis schema is tidy.') + migrated + removed);
        showToast('UPDATED · Redis schema tidy');
        await fetchProducts();
        await fetchCatalogSettings();
      } else {
        setOrganizeMsg(data.error || 'Failed to tidy Redis.');
      }
    } catch (err: any) {
      setOrganizeMsg(err.message || 'Failed to tidy Redis.');
    }
  };

  /** Wipe & Rebuild Redis — requires the password AND typing the confirmation phrase. */
  const runWipe = async () => {
    if (!requireUnlocked()) return;
    if (!requireUnlocked()) return;
    if (wipeConfirm.trim().toUpperCase() !== 'WIPE') {
      showToast('Type WIPE in the confirmation box to erase Redis');
      return;
    }
    setWipeBusy(true);
    setWipeMsg('Wiping Redis... this permanently deletes every key.');
    try {
      const res = await adminFetch('/api/admin/wipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, confirm: wipeConfirm.trim(), rebuild: wipeRebuild }),
      });
      const data = await res.json();
      if (res.ok) {
        setWipeMsg(data.message || 'Redis wiped.');
        showToast('REDIS WIPED' + (wipeRebuild ? ' · REBUILT' : ''));
        setWipeConfirm('');
        await refreshAll();
      } else {
        setWipeMsg(data.error || 'Wipe failed.');
      }
    } catch (err: any) {
      setWipeMsg(err.message || 'Wipe failed.');
    } finally {
      setWipeBusy(false);
    }
  };

  /** Load env-var status for the SetUp tab (never returns secret values). */
  const fetchEnvStatus = async () => {
    setEnvStatusLoading(true);
    try {
      const res = await adminFetch('/api/admin/env-status');
      const data = await res.json();
      setEnvStatus(data || null);
    } catch {
      setEnvStatus(null);
    } finally {
      setEnvStatusLoading(false);
    }
  };

  const saveSettings = async () => {
    if (!password) {
      return showToast('Enter the admin password first');
    }
    setSettingsLoading(true);
    try {
      const res = await adminFetch('/api/admin/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          theme: themeSettings,
          hero: heroSettings,
          form: formSettings,
          footer: footerSettings,
          branding: brandingSettings,
          rewards: rewardsSettings,
          gallery: gallerySettings,
          copy: copySettings,
          legal: legalSettings,
          catalog: catalogSettings,
          behavior: behaviorSettings,
          checkout: checkoutSettings,
          refPrefix,
          productNotes,
          orbs: orbSettings,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettingsMsg('Settings saved successfully!');
        showToast('UPDATED · Settings');
        // The saved state is now the baseline — the Discard button disappears.
        setSettingsSnapshot(JSON.stringify({
          theme: themeSettings,
          hero: heroSettings,
          form: formSettings,
          footer: footerSettings,
          branding: brandingSettings,
          rewards: rewardsSettings,
          gallery: gallerySettings,
          copy: copySettings,
          legal: legalSettings,
          catalog: catalogSettings,
          behavior: behaviorSettings,
          checkout: checkoutSettings,
          refPrefix,
          orbs: orbSettings,
        }));
      } else setSettingsMsg(data.error || 'Failed to save settings.');
    } catch (err: any) {
      setSettingsMsg('Connection failed: ' + err.message);
    }
    setSettingsLoading(false);
  };

  const applyThemePreset = (presetId: string) => {
    const preset = THEME_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setThemeSettings({ ...GOYUNIR_STORE_SUITE.themeColors, ...preset.themeColors });
    // Match the glow orbs to the new accent so the storefront glow reads on-brand.
    setOrbSettings((prev: any) => mergeOrbSettings(prev || DEFAULT_ORBS, {
      primary: preset.orbs.primary,
      secondary: preset.orbs.secondary,
      tertiary: preset.orbs.tertiary,
      fourth: preset.orbs.fourth,
      fifth: preset.orbs.fifth,
    }));
    // Design presets also drive the share-card (OG link preview) colors so the
    // fancy box friends see when you paste a link matches the store theme.
    setBrandingSettings((prev) => ({
      ...prev,
      shareBackground: preset.themeColors.primaryBackground || prev.shareBackground || '#0B0B0F',
      shareAccent: preset.themeColors.checkoutCtaButton || preset.accent || prev.shareAccent || '#D4AF37',
      shareText: preset.themeColors.textMain || prev.shareText || '#F5F2E9',
    }));
    setActivePreset(presetId);
    showToast(`PRESET · ${preset.name} applied — press Save to publish`);
  };

  const notifyReleaseList = async () => {
    if (!requireUnlocked()) return;
    if (!selectedAlertProductId) return showToast('Choose a product first');
    setAlertsMsg('Sending release emails…');
    try {
      const res = await adminFetch('/api/admin/alerts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'notifyProduct', productId: selectedAlertProductId }),
      });
      const data = await res.json();
      if (res.ok) {
        setAlertsMsg(`Sent ${data.sent || 0} release alerts${data.skipped ? ` · skipped ${data.skipped}` : ''}.`);
        await fetchAlerts();
      } else {
        setAlertsMsg(data.error || 'Failed to send alerts.');
      }
    } catch (err: any) {
      setAlertsMsg(err.message || 'Failed to send alerts.');
    }
  };

  const removeAlertSubscriber = async (email: string) => {
    if (!requireUnlocked()) return;
    try {
      const res = await adminFetch('/api/admin/alerts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'remove', email }),
      });
      if (res.ok) await fetchAlerts();
    } catch {}
  };

  // ============================================================
  // USE EFFECTS
  // ============================================================

  // Load the portal data only after two-step verification has been confirmed.
  const runInitialLoads = () => {
    fetchStatus();
    fetchCatalogStatus();
    fetchRecovery();
    fetchPromos();
    fetchProducts();
    fetchUsers();
    fetchCatalogSettings();
  };

  useEffect(() => {
    // Step 1 — check the two-step verification device cookie BEFORE loading
    // anything. When the cookie is missing, /api/admin/* returns 401 and the
    // portal must show the verification gate instead of a wall of errors.
    (async () => {
      try {
        const res = await fetch('/api/admin/verify-status', { credentials: 'include' });
        const data = await res.json();
        const verified = Boolean(data?.verified);
        setAdminVerified(verified);
        if (verified) runInitialLoads();
      } catch {
        // Network blip — never hard-lock the portal; let the 2FA screen appear
        // only when the proxy actually rejects a request.
        setAdminVerified(true);
        runInitialLoads();
      }
    })();
    const on2faRequired = () => setAdminVerified(false);
    window.addEventListener('goyunir-admin-2fa-required', on2faRequired);
    return () => window.removeEventListener('goyunir-admin-2fa-required', on2faRequired);
    // Fetch helpers are intentionally stable per-mount; including them would
    // restart the poll loop on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Poll only while verified (the 2FA gate has its own step; a locked portal
    // should not hammer the API).
    if (adminVerified !== true) return;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!pollTimer) pollTimer = setInterval(fetchStatus, 30000); };
    const stop = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };
    const vis = () => { if (document.visibilityState === 'visible') { fetchStatus(); start(); } else stop(); };
    start();
    document.addEventListener('visibilitychange', vis);
    return () => { stop(); document.removeEventListener('visibilitychange', vis); };
  }, [adminVerified]);

  // TWO-STEP ADMIN VERIFICATION handlers — send/confirm the emailed code.
  // The password travels via the browser's cached Basic Auth header (proxy.ts
  // already verified it on this request), so no extra typing is needed here.
  const sendAdminVerifyCode = async () => {
    setVerifyBusy(true);
    setVerifyMsg('');
    try {
      const res = await adminFetch('/api/admin/verify-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        setVerifyEmail(data.sentTo || '');
        setVerifyMsg(`Code sent to ${data.sentTo || 'your admin inbox'} — it's in the email subject line, so it shows right in your notification.`);
        setVerifyDevCode(data.devCode || '');
        lastSubmittedCodeRef.current = '';
      } else {
        setVerifyMsg(data.error || 'Could not send the code.');
      }
    } catch (err: any) {
      setVerifyMsg('Network error: ' + err.message);
    }
    setVerifyBusy(false);
  };

  const confirmAdminVerifyCode = async () => {
    setVerifyBusy(true);
    setVerifyMsg('');
    try {
      const res = await adminFetch('/api/admin/verify-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: verifyCode, remember: verifyRemember }),
      });
      const data = await res.json();
      if (res.ok) {
        setVerifyCode('');
        setVerifyMsg('');
        setVerifyDevCode('');
        setAdminVerified(true);
        runInitialLoads();
      } else {
        setVerifyMsg(data.error || 'Verification failed.');
      }
    } catch (err: any) {
      setVerifyMsg('Network error: ' + err.message);
    }
    setVerifyBusy(false);
  };

  const resendAdminVerifyCode = async () => {
    setVerifyBusy(true);
    setVerifyMsg('');
    try {
      const res = await adminFetch('/api/admin/verify-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        setVerifyMsg('A fresh code was sent — it shows in your email notification.');
        setVerifyDevCode(data.devCode || '');
        lastSubmittedCodeRef.current = '';
      } else {
        setVerifyMsg(data.error || 'Could not resend the code.');
      }
    } catch (err: any) {
      setVerifyMsg('Network error: ' + err.message);
    }
    setVerifyBusy(false);
  };

  // AUTO-SEND the 6-digit code the moment the 2FA gate appears — the operator
  // should never have to press "Send me a code" before an email is sent. The
  // server's 60s resend throttle means this can't spam the inbox even if the
  // gate is re-opened quickly.
  useEffect(() => {
    if (adminVerified === false && !verifyAutoSentRef.current) {
      verifyAutoSentRef.current = true;
      sendAdminVerifyCode();
    }
    if (adminVerified !== false) verifyAutoSentRef.current = false;
    // sendAdminVerifyCode is stable per-mount (it only touches setters), so
    // keying on the gate state alone is intentional — re-running exactly when
    // the gate opens/closes is the desired behaviour.
  }, [adminVerified]);

  // AUTO-VERIFY: the instant all 6 digits are present (typed, pasted, or filled
  // by the iOS/Android one-time-code autofill bar) the code is submitted
  // immediately — no extra "Verify & unlock" tap. The ref keeps a wrong code
  // from being re-submitted on every re-render, and a resend resets it.
  useEffect(() => {
    if (adminVerified !== false || verifyBusy) return;
    const code = verifyCode.trim();
    if (code.length === 6 && code !== lastSubmittedCodeRef.current) {
      lastSubmittedCodeRef.current = code;
      confirmAdminVerifyCode();
    }
    // confirmAdminVerifyCode is stable per-mount (only touches setters); keying
    // on the code length + busy flag is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyCode, adminVerified, verifyBusy]);

  // Read a 6-digit code from the clipboard and fill the field (desktop
  // convenience — e.g. a mail app that copied the code for you). iOS/Android
  // get native OTP autofill from the notification instead.
  const pasteVerifyCode = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const text = await navigator.clipboard.readText();
        const digits = String(text || '').replace(/\D/g, '').slice(0, 6);
        if (digits.length === 6) {
          setVerifyMsg('Pasted — verifying…');
          setVerifyCode(digits);
          return;
        }
        setVerifyMsg('The clipboard does not contain a 6-digit code.');
      } else {
        setVerifyMsg('Clipboard access is unavailable here — tap the field and paste with Ctrl/Cmd+V.');
      }
    } catch {
      setVerifyMsg('Clipboard access was blocked — tap the field and paste with Ctrl/Cmd+V.');
    }
  };

  // CSV export uses fetch (not a plain <a>) so the admin password never travels
  // in the URL — proxy.ts Basic Auth + the 2FA device cookie authorize it.
  const downloadWinners = async () => {
    try {
      const res = await adminFetch('/api/admin/export-winners');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data?.error || 'Export failed.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `winners-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      showToast('Export failed: ' + err.message);
    }
  };

  useEffect(() => {
    const t = setInterval(() => { if (lastUpdatedAt) setSecondsAgo(Math.round((Date.now() - lastUpdatedAt) / 1000)); }, 1000);
    return () => clearInterval(t);
  }, [lastUpdatedAt]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const term = searchTerm.trim();
    if (!term) { setSearchResults(null); setCurrentPage(1); return; }
    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await adminFetch(`/api/admin/search?q=${encodeURIComponent(term)}`);
        const data = await res.json();
        setSearchResults(Array.isArray(data.results) ? data.results : []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
        setCurrentPage(1);
      }
    }, 400);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [searchTerm]);

  const pools = status?.pools || [];
  const totalInt = pools.reduce((s: number, p: any) => s + (p.intCount || 0), 0);
  const totalSub = pools.reduce((s: number, p: any) => s + (p.subCount || 0), 0);
  const totalSales = pools.reduce((s: number, p: any) => s + (p.salesCount || 0), 0);
  const totalInv = pools.reduce((s: number, p: any) => s + (p.maxLimit || 0), 0);
  const maxBar = Math.max(totalInt, totalSub, totalSales, totalInv, 1);
  const maxSubPool = Math.max(...pools.map((x: any) => x.subCount || 0), 1);
  const conv = totalInt + totalSub > 0 ? Math.round((totalSub / (totalInt + totalSub)) * 100) : 0;
  // Lifetime charged revenue across the (most recent) ledger — useful headline number.
  const allLedger = Array.isArray(status?.fallbackEntries) ? status?.fallbackEntries : [];
  const totalRevenueCents = allLedger.reduce((s: number, e: any) => s + (e.type === 'WINNER_CHARGED' ? (Number(e.amountCents) || 0) : 0), 0);
  const productCount = Array.isArray(allProducts) ? allProducts.length : 0;

  const allEntries = searchResults !== null ? searchResults : status?.fallbackEntries || [];
  const rawFilteredEntries = Array.isArray(allEntries) ? allEntries : [];
  const filteredEntries = rawFilteredEntries.filter((e) => ledgerTypeFilter === 'ALL' || e.type === ledgerTypeFilter);
  const totalPages = Math.ceil(filteredEntries.length / itemsPerPage) || 1;
  const currentEntries = filteredEntries.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const totalOwed = promos.reduce((s, p) => s + (p.payoutOwedCents || 0), 0);

  // Streamer Mode only masks DISPLAYED customer data — it never gates actions.

  // True when any settings form differs from the last fetched/saved baseline.
  // Drives the "Discard changes" button in the sticky save bar.
  const settingsDirty = (() => {
    if (!settingsSnapshot) return false;
    const current = JSON.stringify({
      theme: themeSettings,
      hero: heroSettings,
      form: formSettings,
      footer: footerSettings,
      branding: brandingSettings,
      rewards: rewardsSettings,
      gallery: gallerySettings,
      copy: copySettings,
      legal: legalSettings,
      catalog: catalogSettings,
      behavior: behaviorSettings,
      orbs: orbSettings,
    });
    return current !== settingsSnapshot;
  })();

  // Product-editor dirty state: compares the live form against the snapshot
  // taken when the editor opened (editProduct / resetProductForm + Add).
  const productFormDirty = productFormSnapshot !== ''
    && JSON.stringify(productForm) !== productFormSnapshot;

  // Revert every settings form back to the last SAVED state by re-fetching
  // from Redis (fetchSettings sets both the form states and the baseline).
  const discardSettings = async () => {
    if (!settingsDirty) return;
    if (!confirm('Discard all unsaved changes? This reverts every settings tab to the last saved state.')) return;
    await fetchSettings();
    showToast('DISCARDED · Reverted to last saved settings');
  };

  const tabs: { id: Tab; label: string; group: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview', group: 'Store' },
    { id: 'drops', label: 'Drops', group: 'Store' },
    { id: 'products', label: 'Products', group: 'Store', badge: allProducts.filter(p => !p.isArchived && !p.isUpcoming).length || undefined },
    { id: 'ledger', label: 'Ledger', group: 'Store' },
    { id: 'users', label: 'Users', group: 'Customers', badge: users.length || undefined },
    { id: 'promotions', label: 'Promotions', group: 'Customers' },
    { id: 'growth', label: 'Growth', group: 'Customers' },
    { id: 'settings', label: 'Settings', group: 'Configuration' },
    { id: 'system', label: 'System', group: 'Configuration' },
    { id: 'setup', label: 'SetUp', group: 'Configuration' },
  ];

  // ============================================================
  // TWO-STEP VERIFICATION GATE — shown until the operator confirms an emailed code.
  // While the device cookie is still being checked (`adminVerified === null`) we
  // render a NEUTRAL screen, never the portal: the secret admin data can't flash
  // before verification, AND SSR + hydration always agree on a small,
  // deterministic tree (the full portal markup used to hydrate first and threw a
  // React 418 "server rendered text didn't match the client" error on /admin).
  if (adminVerified === null) {
    return (
      <main style={{ minHeight: '100vh', padding: '24px 16px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 34, height: 34, borderRadius: 999, margin: '0 auto 16px', background: 'radial-gradient(circle, #edb210 0%, #a855f7 55%, transparent 72%)', animation: 'goyunirSpin 1.1s linear infinite' }} />
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.5px' }}>Checking admin verification…</div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Confirming this browser&apos;s two-step device cookie.</div>
        </div>
      </main>
    );
  }

  if (adminVerified === false) {
    return (
      <main style={{ minHeight: '100vh', padding: '24px 16px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 420, width: '100%', background: '#101013', border: '1px solid #27272a', borderRadius: 18, padding: '26px 24px', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ width: 9, height: 9, borderRadius: 999, background: '#edb210', boxShadow: '0 0 0 4px rgba(237,178,16,0.16)' }} />
            <span style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: '#edb210', fontWeight: 700 }}>Admin · Two-step verification</span>
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>Confirm it&apos;s really you</h1>
          <p style={{ fontSize: 12, color: '#a1a1aa', lineHeight: 1.6, margin: '0 0 16px' }}>
            Your password was accepted. To protect the admin portal, a one-time code is emailed to your admin inbox before the portal unlocks.
            {verifyMsg && verifyMsg.toLowerCase().includes('sent') && verifyEmail && <span> Sending to <strong style={{ color: '#f7f7f7' }}>{verifyEmail}</strong>.</span>}
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button onClick={sendAdminVerifyCode} disabled={verifyBusy} style={{ ...buttonPrimary, flex: 1, background: verifyBusy ? '#555' : '#fff' }}>
              {verifyBusy ? 'Sending…' : (verifyMsg && verifyMsg.toLowerCase().includes('sent') ? 'Send a new code' : 'Send me a code')}
            </button>
          </div>
          {verifyDevCode && (
            <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(237,178,16,0.1)', border: '1px solid rgba(237,178,16,0.35)', fontSize: 12, color: '#fbbf24', lineHeight: 1.5 }}>
              <strong>Dev mode code:</strong> <span style={{ letterSpacing: 4, fontWeight: 800 }}>{verifyDevCode}</span> — use it below (production sends this only by email).
            </div>
          )}
          <input
            id="admin-verify-code"
            type="text"
            name="one-time-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoFocus
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            ref={(el) => {
              // WebKit's OTP-autofill trigger (iOS): React's web typings don't
              // expose `textContentType`, so set the DOM property directly.
              if (el) (el as HTMLInputElement & { textContentType?: string }).textContentType = 'oneTimeCode';
            }}
            placeholder="6-digit code"
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 8, background: '#09090b', border: '1px solid #27272a', color: '#fff', fontSize: 16, letterSpacing: 6, textAlign: 'center', marginBottom: 8 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button
              type="button"
              onClick={pasteVerifyCode}
              disabled={verifyBusy}
              style={{ background: 'transparent', border: 'none', color: '#a1a1aa', fontSize: 11, cursor: verifyBusy ? 'not-allowed' : 'pointer', padding: '2px 4px', textDecoration: 'underline' }}
            >
              📋 Paste code from clipboard
            </button>
          </div>
          {/* The label wraps the checkbox so the whole row is tappable. Some
              mobile browsers don't toggle a label-wrapped controlled checkbox
              reliably (the tap lands on the text, not the input), so we also
              force the toggle on label click when the tap missed the input. */}
          <label
            htmlFor="admin-verify-remember"
            onClick={(e) => {
              const target = e.target as HTMLElement;
              if (target.tagName !== 'INPUT') {
                e.preventDefault();
                setVerifyRemember((prev) => !prev);
              }
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#a1a1aa', marginBottom: 14, cursor: 'pointer', WebkitTapHighlightColor: 'transparent', userSelect: 'none', touchAction: 'manipulation' }}
          >
            <input id="admin-verify-remember" type="checkbox" checked={verifyRemember} onChange={(e) => setVerifyRemember(e.target.checked)} style={{ accentColor: '#fff', width: 16, height: 16, flexShrink: 0 }} />
            <span>Remember this device for 30 days (otherwise this browser re-verifies every 24 hours)</span>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={confirmAdminVerifyCode} disabled={verifyBusy || verifyCode.length !== 6} style={{ ...buttonPrimary, flex: 1, background: verifyBusy || verifyCode.length !== 6 ? '#555' : '#fff' }}>
              {verifyBusy ? 'Checking…' : 'Verify & unlock'}
            </button>
            <button onClick={resendAdminVerifyCode} disabled={verifyBusy} style={{ ...buttonGhost }}>
              Resend
            </button>
          </div>
          {verifyMsg && <p style={{ marginTop: 12, fontSize: 12, color: verifyMsg.toLowerCase().includes('sent') ? '#34d399' : '#f87171', lineHeight: 1.5 }}>{verifyMsg}</p>}
          <p style={{ marginTop: 14, fontSize: 10, color: '#666', lineHeight: 1.5 }}>
            The code is in the email <strong style={{ color: '#999' }}>subject line</strong>, so it shows right in your phone&apos;s notification — no need to open the email. On iOS/Android it also appears as a one-tap autofill above this field, and it verifies automatically the moment all 6 digits are in. Set <code style={{ color: '#999' }}>ADMIN_VERIFY_EMAIL</code> (or <code style={{ color: '#999' }}>SUPPORT_EMAIL</code>) in the platform environment to choose where these codes are delivered. Codes expire in 10 minutes; wrong codes lock the email for 15 minutes after 5 tries.
          </p>
        </div>
      </main>
    );
  }

  // RENDER (UPDATED product form with dynamic categories, explanations, file upload)
  // ============================================================
  return (
    <main style={{ minHeight: '100vh', padding: '32px 20px 72px', background: '#060608', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, margin: 0, fontWeight: 700, letterSpacing: '-0.02em' }}>Store Admin</h1>
            {toast ? (
              <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 200, background: '#14532d', color: '#bbf7d0', border: '1px solid #22c55e', padding: '10px 16px', borderRadius: 12, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>
                {toast}
              </div>
            ) : null}
            <p style={{ color: '#888', margin: '6px 0 0', fontSize: 12 }}>
              {lastUpdatedAt ? `Updated ${secondsAgo}s ago` : 'Loading…'} ·{' '}
              <span style={{ color: status?.stripeConfigured ? '#34d399' : '#f87171' }}>Stripe</span> ·{' '}
              <span style={{ color: status?.redisConfigured ? '#34d399' : '#f87171' }}>Redis</span>{' · '}<span style={{ color: status?.resendConfigured ? '#34d399' : '#f87171' }}>Resend</span> ·{' '}
              <span style={{ color: '#34d399' }}>{status?.liveActiveUsersOnline ?? 0} online</span>
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={refreshAll} disabled={isRefreshing} style={{ ...buttonGhost, padding: '6px 12px' }}>
              {isRefreshing ? '⟳' : '🔄 Refresh'}
            </button>
            <Link href="/" prefetch={false} style={{ color: '#888', fontSize: 12, textDecoration: 'none', padding: '6px 0' }}>← Store</Link>
          </div>
        </div>

        <div style={{ ...cardStyle, marginBottom: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Streamer Mode — polished shield toggle. Defaults ON; masks every
              customer email/address/card and locks the password so the portal
              is safe to share on a livestream. */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: streamerMode ? 'rgba(237,178,16,0.10)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${streamerMode ? 'rgba(237,178,16,0.45)' : '#27272a'}`,
              borderRadius: 999, padding: '4px 6px 4px 12px', flexShrink: 0,
            }}
            title={streamerMode
              ? 'Streamer Mode is ON — customer emails, addresses and card numbers are masked and the admin password is locked. Safe to share your screen on a livestream. Click the switch to work with real data.'
              : 'Streamer Mode is OFF — real customer data is visible. Click the switch to mask everything again before you share your screen.'}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>🛡️</span>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: streamerMode ? '#edb210' : '#d4d4d8', letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>
                {streamerMode ? 'STREAMER MODE ON' : 'STREAMER MODE OFF'}
              </span>
              <span style={{ fontSize: 9, color: '#8b8b94', whiteSpace: 'nowrap' }}>
                {streamerMode ? 'Customer data masked' : 'Real data visible'}
              </span>
            </div>
            <button
              onClick={() => { setStreamerMode((v) => !v); }}
              aria-pressed={streamerMode}
              aria-label="Toggle Streamer Mode"
              title={streamerMode ? 'Turn Streamer Mode OFF to unlock the admin password and see real customer data' : 'Turn Streamer Mode ON to mask customer data for a livestream'}
              style={{
                width: 40, height: 22, borderRadius: 999, border: 'none', position: 'relative', cursor: 'pointer',
                background: streamerMode ? '#edb210' : '#3f3f46', transition: 'background 150ms ease', flexShrink: 0,
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: streamerMode ? 20 : 2, width: 18, height: 18, borderRadius: 999,
                background: streamerMode ? '#0b0b0d' : '#fff', transition: 'left 150ms ease', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
              }} />
            </button>
          </div>

          <span style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#9a9aa3',
            background: 'rgba(255,255,255,0.03)', border: '1px dashed #33333a', borderRadius: 10,
            padding: '8px 12px', flex: 1, minWidth: 220,
          }}>
            {streamerMode ? (
              <span>🔒 <strong style={{ color: '#d4d4d8' }}>Streamer Mode</strong> — emails, addresses and card numbers are masked with
                fixed-length bullets (even character lengths are hidden). Every action keeps working while masked; the password field is
                locked so the real password can never be typed on a livestream.</span>
            ) : (
              <span>🛡️ <strong style={{ color: '#d4d4d8' }}>Real data visible</strong> — customer PII shows in full. Toggle Streamer
                Mode ON before sharing your screen.</span>
            )}
          </span>
          <input
            type="password"
            value={streamerMode ? '••••••••' : password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            autoComplete="current-password"
            disabled={streamerMode}
            title={streamerMode
              ? 'Locked while Streamer Mode is ON — type it with Streamer Mode OFF, then toggle back on. A password already typed stays active.'
              : 'Required to save settings and trigger destructive actions'}
            style={{ ...inputStyle, flex: 1, minWidth: 160, padding: '10px 12px', opacity: streamerMode ? 0.55 : 1 }} />
        </div>

        {/* Apple-style grouped tab bar: Store / Customers / Configuration */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {['Store', 'Customers', 'Configuration'].map((groupName) => {
            const groupTabs = tabs.filter((t) => t.group === groupName);
            if (groupTabs.length === 0) return null;
            return (
              <div key={groupName}>
                <div style={{ fontSize: 9, letterSpacing: '2px', textTransform: 'uppercase', color: '#6b6b74', margin: '2px 4px 4px', fontWeight: 700 }}>{groupName}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {groupTabs.map((t) => (
                    <button key={t.id}
                      onClick={() => {
                        setTab(t.id);
                        if (t.id === 'growth') { fetchPromos(); fetchAudit(); fetchAlerts(); }
                        if (t.id === 'system') { if (password) fetchAudit(); fetchDrawHistory(); }
                        if (t.id === 'drops') fetchConfig();
                        if (t.id === 'drops' && drawsSub === 'run') fetchDrawHistory();
                        if (t.id === 'settings') fetchSettings();
                        if (t.id === 'setup') fetchEnvStatus();
                        if (t.id === 'products') fetchProducts();
                        if (t.id === 'products') fetchSettings();
                        if (t.id === 'users') fetchUsers();
                      }}
                      style={{
                        padding: '8px 14px', borderRadius: 20, border: tab === t.id ? '1px solid #fff' : '1px solid #27272a',
                        background: tab === t.id ? '#fff' : 'transparent', color: tab === t.id ? '#000' : '#aaa',
                        fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                        transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
                      }}
                    >
                      {t.label}
                      {t.badge ? (
                        <span style={{ background: tab === t.id ? '#000' : '#edb210', color: tab === t.id ? '#fff' : '#000', fontSize: 9, padding: '1px 5px', borderRadius: 8, fontWeight: 700 }}>
                          {t.badge}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* ============ OVERVIEW (unchanged) ============ */}
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Store Overview</h2>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => { resetProductForm(); setShowProductForm(true); setEditingProduct(null); setTab('products'); }} style={{ ...buttonPrimary, padding: '6px 12px', fontSize: 10 }}>+ Add Product</button>
                  <button onClick={() => { setTab('drops'); setDrawsSub('run'); }} style={{ ...buttonGhost, padding: '6px 12px', fontSize: 10 }}>🎲 Run a Draw</button>
                  <button onClick={() => setTab('settings')} style={{ ...buttonGhost, padding: '6px 12px', fontSize: 10 }}>⚙️ Settings</button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
                {[
                  { l: 'STARTED', v: totalInt, c: '#edb210' },
                  { l: 'ENTERED', v: totalSub, c: '#34d399' },
                  { l: 'CHARGED', v: totalSales, c: '#60a5fa' },
                  { l: 'INVENTORY LEFT', v: totalInv, c: '#fff' },
                  { l: 'PRODUCTS', v: productCount, c: '#c084fc' },
                  { l: 'REVENUE', v: `$${(totalRevenueCents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`, c: '#fbbf24' },
                ].map((k) => (
                  <div key={k.l} style={cardStyle}>
                    <div style={{ fontSize: 10, color: k.c, fontWeight: 700, letterSpacing: '0.5px' }}>{k.l}</div>
                    <div style={{ fontSize: 24, fontFamily: 'monospace', fontWeight: 700 }}>{k.v}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* ── Catalog health: the portal understands the catalog and flags
                exploitable/broken math before it ever reaches customers. */}
            {(() => {
              const healthy: any[] = [];
              const warn: any[] = [];
              const block: any[] = [];
              for (const p of allProducts) {
                const issues = sortSanityIssues(checkProductSanity(p, { rewards: rewardsSettings }));
                const errs = issues.filter((i) => i.severity === 'error');
                const warns = issues.filter((i) => i.severity === 'warning');
                if (errs.length > 0) block.push({ p, count: errs.length, first: errs[0] });
                else if (warns.length > 0) warn.push({ p, count: warns.length, first: warns[0] });
                else healthy.push(p);
              }
              const totalIssues = block.length + warn.length;
              return (
                <div style={{ ...cardStyle, borderColor: block.length > 0 ? 'rgba(239,68,68,0.45)' : warn.length > 0 ? 'rgba(245,158,11,0.35)' : 'rgba(34,197,94,0.25)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                    <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}>🧮 Catalog Health</h2>
                    {totalIssues === 0 ? (
                      <span style={{ fontSize: 10, fontWeight: 800, padding: '4px 10px', borderRadius: 999, background: 'rgba(34,197,94,0.14)', color: '#4ade80', letterSpacing: '0.5px' }}>ALL CLEAR · {healthy.length} PRODUCT{healthy.length === 1 ? '' : 'S'}</span>
                    ) : (
                      <span style={{ fontSize: 10, fontWeight: 800, padding: '4px 10px', borderRadius: 999, background: block.length > 0 ? 'rgba(239,68,68,0.16)' : 'rgba(245,158,11,0.14)', color: block.length > 0 ? '#f87171' : '#fbbf24', letterSpacing: '0.5px' }}>{block.length} BLOCKING · {warn.length} WARNINGS</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: '#8b95a7', lineHeight: 1.5, marginBottom: 8 }}>
                    Live math checks across every product — sampler credit arbitrage, raffles that over-sell inventory, timers that end before they open, inventory mismatches. Products with a blocking issue can&apos;t be saved.
                  </div>
                  {totalIssues === 0 && (
                    <div style={{ fontSize: 11, color: '#34d399' }}>✓ Every product passes its math checks. Nothing exploitable, nothing contradictory.</div>
                  )}
                  {block.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 6 }}>
                      {block.map(({ p, first }) => (
                        <button key={`block-${p.id}`} onClick={() => { setEditingProduct(p.id); editProduct(p); setTab('products'); }} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '7px 9px', cursor: 'pointer', fontSize: 10.5, color: '#fca5a5', lineHeight: 1.4 }}>
                          <span style={{ fontSize: 11 }}>✖</span>
                          <span><strong>{p.name}</strong> — {first.message}{first.detail ? <span style={{ color: '#8b95a7' }}> {first.detail}</span> : null}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {warn.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {warn.map(({ p, first }) => (
                        <button key={`warn-${p.id}`} onClick={() => { setEditingProduct(p.id); editProduct(p); setTab('products'); }} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.26)', borderRadius: 8, padding: '7px 9px', cursor: 'pointer', fontSize: 10.5, color: '#fde68a', lineHeight: 1.4 }}>
                          <span style={{ fontSize: 11 }}>⚠</span>
                          <span><strong>{p.name}</strong> — {first.message}{first.detail ? <span style={{ color: '#8b95a7' }}> {first.detail}</span> : null}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
            <div style={cardStyle}>
              <div style={{ fontSize: 12, marginBottom: 8, color: '#ccc' }}>Started → Entered conversion: <strong style={{ color: '#fff' }}>{conv}%</strong></div>
              <Bar value={totalInt} max={maxBar} color="#edb210" />
              <div style={{ height: 8 }} />
              <Bar value={totalSub} max={maxBar} color="#34d399" />
              <div style={{ height: 8 }} />
              <Bar value={totalSales} max={maxBar} color="#60a5fa" />
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 10px', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active Pools</h2>
              {pools.length === 0 && (
                <EmptyState icon="🗄️" title="No live pools yet" hint="Entry pools appear here as soon as customers start entering a drop. A store with zero traffic legitimately has none." />
              )}
              {pools.map((p: any, i: number) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span>{p.product} — {p.size}</span>
                    <span style={{ fontFamily: 'monospace', color: '#34d399' }}>{(p.intCount ?? 0)} started · {(p.subCount || 0)} entered · {(p.salesCount ?? 0)} sold · {p.maxLimit ?? 0} left</span>
                  </div>
                  <Bar value={p.subCount || 0} max={maxSubPool} color="#34d399" />
                </div>
              ))}
            </div>
            {totalOwed > 0 && (
              <div style={{ ...cardStyle, borderColor: '#edb210' }}>
                <div style={{ fontSize: 12, color: '#edb210', fontWeight: 700 }}>💰 ${(totalOwed / 100).toFixed(2)} owed to promoters — see Growth tab</div>
              </div>
            )}
          </div>
        )}

        {/* ============ DROPS (unchanged) ============ */}
        {tab === 'drops' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['run', 'automation'] as const).map((s) => (
                <button key={s} onClick={() => { setDrawsSub(s); if (s === 'automation') fetchConfig(); if (s === 'run') fetchDrawHistory(); }}
                  style={{ ...buttonGhost, border: drawsSub === s ? '1px solid #fff' : '1px solid #333', background: drawsSub === s ? '#1c1c1e' : 'transparent', textTransform: 'capitalize' }}>
                  {s === 'run' ? 'Run Draw' : 'Automation'}
                </button>
              ))}
            </div>
            {drawsSub === 'run' && (
              <div style={cardStyle}>
                <h3 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Trigger a Draw</h3>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                  Randomly selects winners up to each pool&apos;s configured count and charges their saved cards immediately. Non-winners stay entered for next time.
                </p>
                <select value={selectedDrawTarget} onChange={(e) => setSelectedDrawTarget(e.target.value)}
                  style={{ ...inputStyle, width: '100%', marginBottom: 10 }}>
                  <option value="ALL_POOLS">All pools</option>
                  {allProducts.map((p) =>
                    (p.priceCategories || []).map((cat: any) => (
                      <option key={`${p.name}-${cat.size}`} value={`entries:pool:${p.name}:${cat.size}`}>{p.name} — {cat.size}</option>
                    ))
                  )}
                </select>
                <button onClick={triggerDrop} disabled={isRunning}
                  style={{ width: '100%', padding: 14, borderRadius: 12, border: 'none', background: isRunning ? '#333' : '#edb210', color: isRunning ? '#777' : '#09090b', fontWeight: 700, cursor: isRunning ? 'not-allowed' : 'pointer' }}>
                  {isRunning ? 'Running…' : 'Authorize & Trigger Draw'}
                </button>
                {password && (
                  <button onClick={downloadWinners}
                    style={{ display: 'inline-block', marginTop: 12, fontSize: 12, color: '#60a5fa', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
                    ↓ Download all-time winners CSV
                  </button>
                )}
                {resultMessage && <pre style={{ fontSize: 12, color: '#cbd5e1', marginTop: 10, whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#09090b', padding: 12, borderRadius: 10 }}>{resultMessage}</pre>}
                
                <div style={{ marginTop: 16, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ color: '#888' }}>Draw History</div>
                    <button onClick={fetchDrawHistory} disabled={drawHistoryLoading} style={buttonGhost}>
                      {drawHistoryLoading ? 'Loading…' : 'Refresh'}
                    </button>
                  </div>
                  {drawHistory.length === 0 && !drawHistoryLoading && (
                    <EmptyState icon="🎲" title="No draws have been run yet" hint="Trigger a draw above, or let the countdown + cron engine do it automatically. History appears here after the first drop." />
                  )}
                  {drawHistoryLoading && <p style={{ color: '#555' }}>Loading history…</p>}
                  <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                    {drawHistory.map((draw: any, idx: number) => {
                      const isExpanded = expandedDraw === idx;
                      const winners = draw.processedWinners || [];
                      const chargedCount = winners.filter((w: any) => w.status === 'SUCCESS_CHARGED' || w.status === 'charged').length;
                      const totalRevenue = draw.totalRevenueCents != null ? draw.totalRevenueCents : 
                        winners.filter((w: any) => w.status === 'SUCCESS_CHARGED' || w.status === 'charged')
                          .reduce((s: number, w: any) => s + (Number(w.amountCents) || 0), 0);
                      
                      return (
                        <div key={idx} style={{ background: '#09090b', padding: 12, borderRadius: 8, marginBottom: 8 }}>
                          <div 
                            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                            onClick={() => setExpandedDraw(isExpanded ? null : idx)}
                          >
                            <span style={{ color: '#34d399', fontWeight: 600 }}>
                              Draw #{draw.drawNumber || idx + 1}
                              {draw.executionTime ? ` · ${draw.executionTime}` : ''}
                            </span>
                            <span style={{ color: '#888', fontSize: 11 }}>
                              {chargedCount} charged · ${(totalRevenue / 100).toFixed(2)}
                              <span style={{ marginLeft: 8 }}>{isExpanded ? '▼' : '▶'}</span>
                            </span>
                          </div>
                          {isExpanded && (
                            <div style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
                              {winners.length === 0 && <div style={{ color: '#555', fontSize: 11 }}>No winners recorded.</div>}
                              {winners.map((w: any, wi: number) => (
                                <div key={wi} style={{ fontSize: 11, color: '#666', marginTop: 4, paddingLeft: 8, borderLeft: '2px solid #222' }}>
                                  {pii(w.email, 'email', streamerMode)} · {w.product || w.variant || ''} {w.size || ''}
                                  {w.status === 'SUCCESS_CHARGED' || w.status === 'charged' ? (
                                    <span style={{ color: '#34d399' }}> ✓ ${((w.amountCents || 0) / 100).toFixed(2)}</span>
                                  ) : (
                                    <span style={{ color: '#f87171' }}> ✗ {w.status}</span>
                                  )}
                                  {w.promoCode && <span style={{ color: '#edb210', marginLeft: 4 }}>· {pii(w.promoCode, 'promo', streamerMode)}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            {drawsSub === 'automation' && (
              <div style={cardStyle}>
                <h3 style={{ margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase' }}>Automation</h3>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>Schedule and social proof settings — overrides goyunir.config.ts live, no redeploy needed.</p>
                <p style={{ fontSize: 11, color: '#b8b8c0', marginTop: 0, marginBottom: 12 }}>Global schedule is now just the fallback. Each product can also carry its own go-live time, countdown end, and sold-out handling rules from Product Management.</p>
                
                <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Drop Schedule</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                  <label style={{ fontSize: 11 }}>Mode
                    <select value={scheduleForm.mode || 'weekly'} onChange={(e) => setScheduleForm((f: any) => ({ ...f, mode: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}>
                      <option value="fixed">Fixed date</option>
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Biweekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="yearly">Yearly</option>
                      <option value="custom">Custom interval (hours)</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 11 }}>Timezone
                    <input value={scheduleForm.timezone || ''} onChange={(e) => setScheduleForm((f: any) => ({ ...f, timezone: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  {scheduleForm.mode === 'custom' && (
                    <label style={{ fontSize: 11, gridColumn: '1 / -1' }}>Every N hours
                      <input
                        type="number"
                        min={1}
                        max={720}
                        value={scheduleForm.customIntervalHours ?? 24}
                        onChange={(e) => setScheduleForm((f: any) => ({ ...f, customIntervalHours: Math.max(1, Math.min(720, Number(e.target.value) || 24)) }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                      />
                      <span style={{ fontSize: 10, color: '#666' }}>A new global draw becomes due every N hours (e.g. 6 → every 6 hours). Products with their own schedule still follow theirs.</span>
                    </label>
                  )}
                  {(scheduleForm.mode === 'fixed' || scheduleForm.mode === 'biweekly' || scheduleForm.mode === 'yearly') && (
                    <label style={{ fontSize: 11, gridColumn: '1 / -1' }}>{scheduleForm.mode === 'fixed' ? 'Fixed date/time (YYYY-MM-DDTHH:MM:SS)' : 'Anchor date/time (YYYY-MM-DDTHH:MM:SS)'}
                      <input value={scheduleForm.targetEndDateTime || ''} onChange={(e) => setScheduleForm((f: any) => ({ ...f, targetEndDateTime: e.target.value }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                    </label>
                  )}
                  {scheduleForm.mode === 'weekly' && (
                    <label style={{ fontSize: 11 }}>Day of week (0=Sun..6=Sat)
                      <input type="number" min={0} max={6} value={scheduleForm.drawDayOfWeek ?? 6}
                        onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawDayOfWeek: Number(e.target.value) }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                    </label>
                  )}
                  {scheduleForm.mode === 'monthly' && (
                    <label style={{ fontSize: 11 }}>Day of month (1-31)
                      <input type="number" min={1} max={31} value={scheduleForm.drawDayOfMonth ?? 1}
                        onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawDayOfMonth: Number(e.target.value) }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                    </label>
                  )}
                  {scheduleForm.mode === 'hourly' && (
                    <label style={{ fontSize: 11 }}>Minute (0-59)
                      <input type="number" min={0} max={59} value={scheduleForm.drawMinute ?? 0}
                        onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawMinute: Number(e.target.value) }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                    </label>
                  )}
                  {(scheduleForm.mode === 'daily' || scheduleForm.mode === 'weekly' || scheduleForm.mode === 'monthly') && (
                    <>
                      <label style={{ fontSize: 11 }}>Hour (0-23)
                        <input type="number" min={0} max={23} value={scheduleForm.drawHour ?? 21}
                          onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawHour: Number(e.target.value) }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                      </label>
                      <label style={{ fontSize: 11 }}>Minute (0-59)
                        <input type="number" min={0} max={59} value={scheduleForm.drawMinute ?? 0}
                          onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawMinute: Number(e.target.value) }))}
                          style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                      </label>
                    </>
                  )}
                </div>

                {/* Live preview: next global draw computed from the CURRENT form
                    state (before saving) using the same engine helper the
                    storefront countdowns use. `lastUpdatedAt` (a state value,
                    refreshed by the status poll) is the "now" reference so the
                    past/future badge stays pure during render. */}
                {(() => {
                  const mode = scheduleForm?.mode;
                  if (!mode) return null;
                  if (mode === 'fixed' && !String(scheduleForm?.targetEndDateTime || '').trim()) return null;
                  try {
                    const nextMs = getNextDrawTimestampForSchedule(scheduleForm as any);
                    if (!Number.isFinite(nextMs)) return null;
                    const label = new Date(nextMs).toLocaleString(undefined, {
                      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    });
                    const nowMs = lastUpdatedAt ?? null;
                    const inPast = nowMs != null && nextMs <= nowMs;
                    return (
                      <div style={{
                        marginBottom: 10, padding: '8px 12px', borderRadius: 10, fontSize: 11,
                        background: inPast ? 'rgba(237,178,16,0.10)' : 'rgba(52,211,153,0.08)',
                        border: `1px solid ${inPast ? 'rgba(237,178,16,0.4)' : 'rgba(52,211,153,0.3)'}`,
                        color: inPast ? '#fde68a' : '#a7f3d0',
                      }}>
                        <span style={{ fontWeight: 700 }}>{inPast ? '⚠ Next draw is due now' : '🎯 Next draw'}</span>
                        <span style={{ opacity: 0.85 }}> — {inPast ? 'the pool is due and will draw on the next engine check. Save, then trigger or wait for the countdown.' : `${label} (${scheduleForm.timezone || 'store timezone'})`}</span>
                      </div>
                    );
                  } catch {
                    return null;
                  }
                })()}

                <button onClick={saveSchedule} style={buttonPrimary}>Save Schedule</button>
                {configMsg && <p style={{ fontSize: 12, color: '#cbd5e1', marginTop: 10 }}>{configMsg}</p>}

                <h4 style={{ fontSize: 11, color: '#aaa', margin: '20px 0 8px', textTransform: 'uppercase' }}>Social Proof Counter</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                  <label style={{ fontSize: 11 }}>Base count
                    <input type="number" value={socialForm.baseCount ?? 0} onChange={(e) => setSocialForm((f: any) => ({ ...f, baseCount: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginTop: 20 }}>
                    <input type="checkbox" checked={socialForm.autoIncrementEnabled !== false} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementEnabled: e.target.checked }))} />
                    Auto-increment hype ticks
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginTop: 20 }}>
                    <input type="checkbox" checked={socialForm.showSection !== false} onChange={(e) => setSocialForm((f: any) => ({ ...f, showSection: e.target.checked }))} />
                    Show the counter on the home page
                  </label>
                  <label style={{ fontSize: 11 }}>Max ticks/day
                    <input type="number" value={socialForm.autoIncrementMaxPerDay ?? 4} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementMaxPerDay: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>Min ticks/day
                    <input type="number" value={socialForm.autoIncrementMinPerDay ?? 3} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementMinPerDay: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>Min hours between ticks
                    <input type="number" value={socialForm.autoIncrementMinHourGap ?? 2} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementMinHourGap: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>Max hours between ticks
                    <input type="number" value={socialForm.autoIncrementMaxHourGap ?? 8} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementMaxHourGap: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                </div>
                <p style={{ fontSize: 10, color: '#8b8b95', margin: '0 0 10px' }}>
                  Default cadence: <strong>3–4 ticks/day</strong> spaced <strong>2–8 hours</strong> apart — the
                  guaranteed minimum is spread across the day so the counter drifts naturally instead of inflating.
                </p>
                <button onClick={saveSocial} style={buttonPrimary}>Save Social Proof</button>

                <h4 style={{ fontSize: 11, color: '#aaa', margin: '20px 0 8px', textTransform: 'uppercase' }}>Abandoned Entry Recovery</h4>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                  When someone starts an entry (enters email + address) but doesn&apos;t complete card setup in Stripe, this system sends them reminder emails to finish. The &quot;early nudge&quot; goes out a few hours after they start, and the &quot;pre-draw reminder&quot; goes out before the allocation closes (default 6 hours before). Each person gets at most one of each type per product, so they won&apos;t be spammed.
                </p>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={recovery.enabled} onChange={(e) => setRecovery((r) => ({ ...r, enabled: e.target.checked }))} />
                    Enable early nudge
                  </label>
                  <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={recovery.preDrawEnabled} onChange={(e) => setRecovery((r) => ({ ...r, preDrawEnabled: e.target.checked }))} />
                    Enable pre-draw reminder
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
                  <label style={{ fontSize: 11 }}>Early nudge delay (hours)
                    <input type="number" value={recovery.earlyDelayHours} onChange={(e) => setRecovery((r) => ({ ...r, earlyDelayHours: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: 80, marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>Pre-draw window (hours)
                    <input type="number" value={recovery.preDrawHours} onChange={(e) => setRecovery((r) => ({ ...r, preDrawHours: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: 80, marginTop: 4 }} />
                  </label>
                </div>
                <button onClick={saveRecovery} style={{ ...buttonPrimary, marginTop: 12 }}>Save Recovery Settings</button>
                {recoveryMsg && <p style={{ fontSize: 12, color: '#34d399' }}>{recoveryMsg}</p>}
              </div>
            )}
          </div>
        )}

        {/* ============ LEDGER (unchanged) ============ */}
        {tab === 'ledger' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Full Ledger</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>Every event, ever, for every entry — nothing is deleted. Filter, search, and manage entries directly.</p>
            
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <select value={ledgerTypeFilter} onChange={(e) => setLedgerTypeFilter(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 120 }}>
                <option value="ALL">All event types</option>
                <option value="ENTERED">Entered</option>
                <option value="WINNER_CHARGED">Won & Charged</option>
                <option value="NOT_SELECTED">Not Selected</option>
                <option value="WINNER_DECLINED">Charge Declined</option>
                <option value="CANCELLED_BY_USER">Cancelled (Customer)</option>
                <option value="CANCELLED_BY_ADMIN">Cancelled (Admin)</option>
                <option value="INTENT_STARTED">Started (Unfinished)</option>
                <option value="ADDRESS_UPDATED">Address Changed</option>
              </select>
            </div>
            <input placeholder="Search email, product, or address…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
              style={{ ...inputStyle, width: '100%', marginBottom: 12 }} />
            {isSearching && <p style={{ fontSize: 11, color: '#666' }}>Searching…</p>}
            {shipMsg && <p style={{ fontSize: 12, color: '#34d399', marginBottom: 10 }}>{shipMsg}</p>}
            
            <div>
              {filteredEntries.length === 0 && (
                <EmptyState
                  icon="📜"
                  title="No ledger entries found"
                  hint={searchTerm ? `Nothing matches “${searchTerm}”. Try a different email, product, or address.` : 'Every entry event (entered, charged, declined, cancelled…) lands here permanently. Entries appear the moment a customer starts one.'}
                />
              )}
              {currentEntries.map((e: any, i: number) => {
                const entryKey = `${e.email}|${e.variant}|${e.size}|${i}`;
                const isEditingAddress = editingAddressEntry === entryKey;
                const isEditingShipping = editingShippingEntry === entryKey;
                const orderRef = e.orderRef || stableOrderRef(e);
                const displayPrice = e.amountCents ? (e.amountCents / 100).toFixed(2) : (e.listPrice || 0).toFixed(2);
                
                return (
                  <div key={i} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                    <div style={{ fontWeight: 600 }}>{pii(e.email, 'email', streamerMode)}</div>
                    <div style={{ color: '#666', fontSize: 10 }}>Ref: {pii(orderRef, 'ref', streamerMode)}</div>
                    <div style={{ color: '#888' }}>
                      {e.variant} · {e.size} · <span style={{ color: typeColor(e.type), fontWeight: 700 }}>{typeLabel(e.type)}</span>
                      {e.promoCode && <span style={{ color: '#edb210', marginLeft: 6 }}>· promo {pii(e.promoCode, 'promo', streamerMode)}</span>}
                      {(e.amountCents || e.listPrice) && (
                        <span style={{ color: '#34d399', marginLeft: 6 }}>· ${displayPrice}</span>
                      )}
                    </div>
                    <div style={{ color: '#666', marginTop: 4 }}>
                      📍 {pii(e.shippingAddress, 'address', streamerMode) || '•••• hidden'}
                      {e.cardLast4 && <span style={{ marginLeft: 6 }}>💳 {streamerMode ? maskCard(`•••• •••• •••• ${e.cardLast4}`) : `••${e.cardLast4}`}</span>}
                      {e.type === 'WINNER_CHARGED' && (
                        <span style={{ marginLeft: 6 }}>
                          · {e.shippingStatus ? e.shippingStatus.replace(/_/g, ' ').toLowerCase() : 'pending fulfillment'}
                          {e.trackingNumber ? ` · 📦 ${pii(e.trackingNumber, 'tracking', streamerMode)}` : ''}
                        </span>
                      )}
                    </div>
                    {(e.type === 'WINNER_CHARGED' || e.type === 'ENTERED') && (
                      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {isEditingAddress ? (
                          <>
                            <input type="text" value={addressDraft} onChange={(ev) => setAddressDraft(ev.target.value)}
                              placeholder="New address" style={{ ...inputStyle, padding: 6, flex: 2 }} />
                            <button onClick={() => updateAddress(e, addressDraft)} style={{ ...buttonPrimary, padding: '6px 10px', fontSize: 11 }}>Save</button>
                            <button onClick={() => setEditingAddressEntry(null)} style={{ ...buttonGhost, padding: '6px 10px', fontSize: 11 }}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => { setEditingAddressEntry(entryKey); setAddressDraft(e.shippingAddress || ''); }} style={buttonGhost}>
                              Edit Address
                            </button>
                            <button onClick={() => cancelOrder(e)} style={{ ...buttonGhost, border: '1px solid #f87171', color: '#f87171' }}>Cancel Entry</button>
                          </>
                        )}
                      </div>
                    )}
                    {e.type === 'WINNER_CHARGED' && (
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1c1c1e' }}>
                        {isEditingShipping ? (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            <select value={shippingStatusDraft} onChange={(ev) => setShippingStatusDraft(ev.target.value)}
                              style={{ ...inputStyle, padding: 6, fontSize: 11, flex: 1, minWidth: 130 }}>
                              {SHIP_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                            </select>
                            <input type="text" value={trackingDraft} onChange={(ev) => setTrackingDraft(ev.target.value)}
                              placeholder="Tracking number" style={{ ...inputStyle, padding: 6, fontSize: 11, flex: 1, minWidth: 130 }} />
                            <button onClick={() => updateShipping(e)} style={{ ...buttonPrimary, padding: '6px 10px', fontSize: 11 }}>Save & email</button>
                            <button onClick={() => setEditingShippingEntry(null)} style={{ ...buttonGhost, padding: '6px 10px', fontSize: 11 }}>Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => { setEditingShippingEntry(entryKey); setShippingStatusDraft(e.shippingStatus || 'PENDING_FULFILLMENT'); setTrackingDraft(e.trackingNumber || ''); }} style={{ ...buttonGhost, fontSize: 11 }}>
                            Update shipping & tracking
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <button disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => p - 1)} style={buttonGhost}>Prev</button>
                <span style={{ fontSize: 12, color: '#888' }}>{currentPage}/{totalPages}</span>
                <button disabled={currentPage >= totalPages} onClick={() => setCurrentPage((p) => p + 1)} style={buttonGhost}>Next</button>
              </div>
            )}
          </div>
        )}

        {/* ============ PRODUCTS (UPDATED) ============ */}
        {tab === 'products' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Product Management</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={seedDefaultProducts} disabled={productActionLoading} style={{ ...buttonGhost, border: '1px solid #34d399', color: '#34d399' }}>
                  {productActionLoading ? 'Loading…' : 'Seed Defaults'}
                </button>
                <button onClick={() => { resetProductForm(); setShowProductForm(true); setEditingProduct(null); }} style={buttonPrimary}>
                  + Add Product
                </button>
              </div>
            </div>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Manage all products. <strong>New products default to hidden</strong> – publish them by setting &quot;Active&quot; to true. Archived and Upcoming are now mutually exclusive, each product can carry its own go-live/countdown timing, and sold-out handling can either stay visible as proof of demand or auto-archive later.
              {allProducts.length === 0 && ' No products exist yet — click "Seed Defaults" to add placeholder products or "Add Product" to create your own.'}
            </p>
            
            {productMsg && (
              <p style={{ fontSize: 12, color: productMsg.includes('Error') || productMsg.includes('❌') ? '#f87171' : '#34d399', marginBottom: 10 }}>
                {productMsg}
              </p>
            )}

            {showProductForm && (
              <div style={{ background: '#09090b', padding: 16, borderRadius: 12, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: 13, color: '#e4e4e7' }}>
                    {editingProduct ? 'Edit Product' : 'New Product'}
                    {productFormDirty && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: '#edb210', marginLeft: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>● Unsaved changes</span>
                    )}
                  </h4>
                  <button onClick={() => { setShowProductForm(false); resetProductForm(); }} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>✕ Close</button>
                </div>

                {/* At-a-glance summary: live status + shape of this product while
                    the operator works, so they never lose the plot in a long form. */}
                <div style={{ marginBottom: 12, padding: 12, borderRadius: 12, background: '#0d0d11', border: '1px solid #232329' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: '#8b8b94', marginRight: 2 }}>Status</span>
                    <Pill color={productForm.isActive ? '#34d399' : '#a1a1aa'} background={productForm.isActive ? 'rgba(52,211,153,0.14)' : 'rgba(161,161,170,0.12)'}>
                      {productForm.isActive ? 'Active (visible)' : 'Hidden'}
                    </Pill>
                    {productForm.isArchived && <Pill color="#f59e0b" background="rgba(245,158,11,0.14)">Archived</Pill>}
                    {productForm.isUpcoming && <Pill color="#60a5fa" background="rgba(96,165,250,0.14)">Upcoming</Pill>}
                    {(() => {
                      // Effective per-size modes: per-size override wins, else the
                      // product-level mode. This drives the MIXED pill so a product
                      // with one raffle size + one instant-buy size reads correctly.
                      const cats = Array.isArray(productForm.priceCategories) ? productForm.priceCategories : [];
                      const productMode = productForm.checkoutMode === 'FCFS' ? 'FCFS' : 'RAFFLE';
                      const modes: string[] = cats.map((c: any): string => {
                        const m = String(c?.checkoutMode || '').toUpperCase();
                        return m === 'RAFFLE' || m === 'FCFS' ? m : productMode;
                      });
                      const hasR = modes.includes('RAFFLE');
                      const hasF = modes.includes('FCFS');
                      const mixed = hasR && hasF;
                      if (mixed) {
                        return <Pill color="#c084fc" background="rgba(168,85,247,0.16)">MIXED · 🎟 {modes.filter((m) => m === 'RAFFLE').length} raffle + ⚡ {modes.filter((m) => m === 'FCFS').length} instant-buy</Pill>;
                      }
                      return <Pill color={hasF ? '#93c5fd' : '#fbbf24'} background={hasF ? 'rgba(59,130,246,0.14)' : 'rgba(245,158,11,0.14)'}>
                        {hasF ? 'FCFS · instant buy' : 'RAFFLE'}
                      </Pill>;
                    })()}
                    {(() => {
                      const hasSamplers = Array.isArray(productForm.samplerSizes) && productForm.samplerSizes.length > 0;
                      return hasSamplers ? <Pill color="#34d399" background="rgba(52,211,153,0.14)">🧪 trial SKU</Pill> : null;
                    })()}
                  </div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: '#8b8b94' }}>
                    {(() => {
                      const sizeCount = (productForm.priceCategories || []).length;
                      const prices = (productForm.priceCategories || [])
                        .map((c: any) => Number(c?.price) || 0)
                        .filter((p: number) => p > 0 && p !== UNCONFIGURED_PRICE_SENTINEL);
                      const minP = prices.length ? Math.min(...prices) : 0;
                      const maxP = prices.length ? Math.max(...prices) : 0;
                      const per = productForm.inventoryPerSize || {};
                      const perSum = Object.keys(per).reduce((s, k) => s + (Number(per[k]) > 0 ? Number(per[k]) : 0), 0);
                      const invTotal = perSum > 0 ? perSum : (Number(productForm.totalInventory) || 0);
                      const catCount = Array.isArray(productForm.categories) ? productForm.categories.length : 0;
                      return (
                        <>
                          <span><strong style={{ color: '#d4d4d8' }}>{sizeCount}</strong> size{sizeCount === 1 ? '' : 's'}</span>
                          <span>Prices <strong style={{ color: '#d4d4d8' }}>${minP}–${maxP}</strong></span>
                          <span>Inventory <strong style={{ color: '#d4d4d8' }}>{invTotal}</strong></span>
                          <span><strong style={{ color: '#d4d4d8' }}>{catCount}</strong> categor{catCount === 1 ? 'y' : 'ies'}</span>
                          {productForm.goLiveAt && <span>Goes live <strong style={{ color: '#d4d4d8' }}>{productForm.goLiveAt}</strong></span>}
                          {productForm.releaseEndsAt && <span>Ends <strong style={{ color: '#d4d4d8' }}>{productForm.releaseEndsAt}</strong></span>}
                        </>
                      );
                    })()}
                  </div>
                </div>

                {/* Live storefront preview — a mini render of the REAL product
                    page built from the current (unsaved) form + theme + copy.
                    Updates on every keystroke: images/crops, prices, size modes,
                    samplers, urgency/status copy, mixed ribbon, notes, sold-out. */}
                <ProductLivePreview
                  key={editingProduct || 'new-product'}
                  product={productForm}
                  theme={themeSettings}
                  copy={copySettings}
                  categories={catalogSettings.categories}
                />

                {/* ── Math & health check: the admin portal understands what's
                    going on. Live issues (blocking red / warning amber) update on
                    every keystroke; a product with ANY blocking issue cannot be
                    saved (same engine enforced on the server). */}
                <div style={{ marginBottom: 12, borderRadius: 12, border: blockingCount > 0 ? '1px solid rgba(239,68,68,0.4)' : warningCount > 0 ? '1px solid rgba(245,158,11,0.35)' : '1px solid rgba(34,197,94,0.3)', background: blockingCount > 0 ? 'rgba(239,68,68,0.06)' : warningCount > 0 ? 'rgba(245,158,11,0.05)' : 'rgba(34,197,94,0.04)', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <span style={{ fontSize: 13 }}>🧮</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.6px', textTransform: 'uppercase', color: blockingCount > 0 ? '#f87171' : warningCount > 0 ? '#fbbf24' : '#34d399' }}>
                        Math &amp; health check
                      </div>
                      <div style={{ fontSize: 9.5, color: '#8b95a7', marginTop: 1 }}>
                        {blockingCount > 0
                          ? `${blockingCount} blocking issue${blockingCount === 1 ? '' : 's'} — this product cannot be saved until fixed.`
                          : warningCount > 0
                            ? `${warningCount} warning${warningCount === 1 ? '' : 's'} — review below before going live.`
                            : 'All math checks pass — nothing exploitable, nothing contradictory.'}
                      </div>
                    </div>
                    {blockingCount > 0 && (
                      <span style={{ fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 999, background: 'rgba(239,68,68,0.16)', color: '#f87171', letterSpacing: '0.5px' }}>SAVE BLOCKED</span>
                    )}
                  </div>
                  {productIssues.length > 0 ? (
                    <div style={{ padding: '8px 12px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {productIssues.map((issue: SanityIssue, idx: number) => (
                        <div key={`${issue.code}-${idx}`} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 10.5, lineHeight: 1.45 }}>
                          <span style={{ color: issue.severity === 'error' ? '#f87171' : issue.severity === 'warning' ? '#fbbf24' : '#60a5fa', fontSize: 11, marginTop: 0 }}>{issue.severity === 'error' ? '✖' : issue.severity === 'warning' ? '⚠' : 'ℹ'}</span>
                          <div>
                            <span style={{ color: issue.severity === 'error' ? '#fca5a5' : issue.severity === 'warning' ? '#fde68a' : '#93c5fd', fontWeight: 700 }}>{issue.message}</span>
                            {issue.detail && <div style={{ color: '#8b95a7' }}>{issue.detail}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: '8px 12px', fontSize: 10.5, color: '#34d399' }}>✓ Nothing to flag.</div>
                  )}
                </div>

                {/* Quick-jump nav so the long product form is navigable. Sticky at
                    top: 92 (below the fixed storefront header) so the section pills
                    stay reachable no matter how deep into the form you scroll. */}
                <div style={{ position: 'sticky', top: 92, zIndex: 10, display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, padding: '6px 8px', borderRadius: 999, background: 'rgba(13,13,17,0.94)', border: '1px solid #232329', boxShadow: '0 6px 18px rgba(0,0,0,0.25)' }}>
                  {PRODUCT_FORM_SECTIONS.map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      style={{ ...buttonGhost, padding: '4px 10px', fontSize: 9.5, borderRadius: 999 }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* ============ BASICS ============ */}
                <SectionCard
                  id="pf-basics"
                  title="Basics"
                  description="What the product is called, its URL, and how it appears on the storefront. Products start hidden — flip “Active (visible)” on when you are ready to publish."
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Name *</label>
                    <input
                      type="text"
                      placeholder="Product name"
                      value={productForm.name}
                      onChange={(e) => {
                        const name = e.target.value;
                        setProductForm((p: any) => {
                          // Live auto-slug: fill the URL field from the name as the
                          // operator types, but NEVER overwrite a manually edited slug.
                          const shouldAutoSlug = !String(p.slug || '').trim() || (p._slugAuto === true);
                          const nextSlug = shouldAutoSlug ? slugifyName(name) : p.slug;
                          return { ...p, name, slug: nextSlug, _slugAuto: shouldAutoSlug };
                        });
                      }}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Slug (URL) – auto‑generated from name</label>
                    <input
                      type="text"
                      placeholder="slug (e.g. elysian-white)"
                      value={productForm.slug}
                      onChange={(e) => setProductForm((p: any) => ({ ...p, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), _slugAuto: false }))}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Prefix (image folder) – auto from slug</label>
                    <input type="text" placeholder="prefix" value={productForm.prefix} onChange={(e) => setProductForm((p: any) => ({ ...p, prefix: e.target.value }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Tagline (short subtitle)</label>
                    <input type="text" placeholder="e.g. WHITE ALLOCATION / 01" value={productForm.tagline} onChange={(e) => setProductForm((p: any) => ({ ...p, tagline: e.target.value }))} style={inputStyle} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ fontSize: 10, color: '#888' }}>Description</label>
                    <textarea
                      rows={3}
                      placeholder="Product description — what makes this drop matter"
                      value={productForm.desc}
                      onChange={(e) => setProductForm((p: any) => ({ ...p, desc: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', fontFamily: 'inherit', resize: 'vertical' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Checkout Mode</label>
                    <select value={productForm.checkoutMode || 'RAFFLE'} onChange={(e) => setProductForm((p: any) => ({ ...p, checkoutMode: e.target.value === 'FCFS' ? 'FCFS' : 'RAFFLE' }))} style={inputStyle}>
                      <option value="RAFFLE">RAFFLE — draw winners when the countdown ends</option>
                      <option value="FCFS">FCFS — first come, first served</option>
                    </select>
                    <div style={{ marginTop: 6, padding: '8px 9px', borderRadius: 8, background: '#0b0b0d', border: '1px solid #1f2937', fontSize: 10, color: '#8b95a7', lineHeight: 1.5 }}>
                      Raffle keeps the release selective. FCFS supports immediate conversion. Upcoming and archived FCFS items can also surface a reserve option so collectors can signal intent without forcing a checkout. <strong>Per-size override:</strong> each size row in Pricing &amp; Sizes has its own mode — leave it on <em>Auto (product)</em> to follow this setting, or mix formats (e.g. sampler = FCFS instant buy, full size = RAFFLE). FCFS sizes are never drawn and charge immediately at checkout.
                    </div>
                    {(() => {
                      const perCat = Array.isArray(productForm.priceCategories) ? productForm.priceCategories : [];
                      const overrides = perCat.filter((c: any) => String(c?.checkoutMode || '').toUpperCase() === 'RAFFLE' || String(c?.checkoutMode || '').toUpperCase() === 'FCFS');
                      const raffleOverrides = overrides.filter((c: any) => String(c.checkoutMode).toUpperCase() === 'RAFFLE').length;
                      const fcfsOverrides = overrides.filter((c: any) => String(c.checkoutMode).toUpperCase() === 'FCFS').length;
                      const productDefault = productForm.checkoutMode === 'FCFS' ? 'FCFS' : 'RAFFLE';
                      const autoRaffle = perCat.filter((c: any) => !String(c?.checkoutMode || '').trim() && productDefault === 'RAFFLE').length;
                      const autoFcfs = perCat.filter((c: any) => !String(c?.checkoutMode || '').trim() && productDefault === 'FCFS').length;
                      const totalRaffle = raffleOverrides + autoRaffle;
                      const totalFcfs = fcfsOverrides + autoFcfs;
                      const mixed = totalRaffle > 0 && totalFcfs > 0;
                      return (
                        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 10 }}>
                          <span style={{ padding: '3px 8px', borderRadius: 999, background: mixed ? 'rgba(168,85,247,0.14)' : (totalRaffle > 0 ? 'rgba(245,158,11,0.14)' : 'rgba(59,130,246,0.14)'), border: mixed ? '1px solid rgba(168,85,247,0.4)' : (totalRaffle > 0 ? '1px solid rgba(245,158,11,0.4)' : '1px solid rgba(59,130,246,0.4)'), color: mixed ? '#c084fc' : (totalRaffle > 0 ? '#fbbf24' : '#93c5fd'), fontWeight: 700 }}>
                            {mixed ? 'MIXED FORMAT' : totalRaffle > 0 ? 'RAFFLE' : 'FCFS'}
                          </span>
                          <span style={{ color: '#8b95a7' }}>
                            {totalRaffle > 0 ? <span style={{ color: '#fbbf24' }}>🎟 {totalRaffle} raffle</span> : null}
                            {totalRaffle > 0 && totalFcfs > 0 ? ' · ' : ''}
                            {totalFcfs > 0 ? <span style={{ color: '#93c5fd' }}>⚡ {totalFcfs} instant-buy</span> : null}
                            {overrides.length > 0 ? <span style={{ color: '#555' }}> ({overrides.length} size override{overrides.length === 1 ? '' : 's'})</span> : null}
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Sort Order (lower = appears first)</label>
                    <input type="number" placeholder="0" value={productForm.sortOrder} onChange={(e) => setProductForm((p: any) => ({ ...p, sortOrder: Number(e.target.value) }))} style={inputStyle} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ fontSize: 10, color: '#888' }}>Categories (customers filter the catalog by these)</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      {(catalogSettings.categories || []).map((cat) => {
                        const selected = Array.isArray(productForm.categories) && productForm.categories.includes(cat);
                        return (
                          <button
                            key={cat}
                            onClick={() => setProductForm((p: any) => {
                              const current = Array.isArray(p.categories) ? p.categories : [];
                              const next = selected ? current.filter((c: string) => c !== cat) : [...current, cat];
                              return { ...p, categories: next };
                            })}
                            style={{ padding: '5px 12px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: selected ? '1px solid #7dd3fc' : '1px solid #2a2a30', background: selected ? 'rgba(125,211,252,0.14)' : '#15151b', color: selected ? '#7dd3fc' : '#aaa' }}
                          >
                            {cat}
                          </button>
                        );
                      })}
                      {(catalogSettings.categories || []).length === 0 && (
                        <span style={{ fontSize: 10, color: '#666' }}>No categories defined — add them under Settings → Catalog → Product categories.</span>
                      )}
                    </div>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={productForm.isActive} onChange={(e) => setProductForm((p: any) => ({ ...p, isActive: e.target.checked }))} />
                        <span title="If checked, product is visible on the storefront (if not hidden by other flags).">Active (visible)</span>
                      </label>
                      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={productForm.isArchived} onChange={(e) => setProductForm((p: any) => ({ ...p, isArchived: e.target.checked, isUpcoming: e.target.checked ? false : p.isUpcoming }))} />
                        <span title="Moves to archive section – product remains visible.">Archived</span>
                      </label>
                      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={productForm.isUpcoming} onChange={(e) => setProductForm((p: any) => ({ ...p, isUpcoming: e.target.checked, isArchived: e.target.checked ? false : p.isArchived }))} />
                        <span title="Shows in upcoming section – product remains visible.">Upcoming</span>
                      </label>
                    </div>
                    <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: '#0b0b0d', border: '1px solid #1f2937', fontSize: 10, color: '#8b95a7', lineHeight: 1.5 }}>
                      RAFFLE is best for scarcity, list building, and selective access. FCFS is best for immediate conversion. Upcoming builds anticipation with an automatic go-live moment. Archived moves the release to the “Past Archives” section without hiding it.
                    </div>
                  </div>
                  </div>
                </SectionCard>

                {/* ============ MEDIA & GALLERY ============ */}
                <SectionCard
                  id="pf-media"
                  title="Gallery & Images"
                  description="Product photos are swipeable on the product page. Upload images or videos, or paste a media URL — the first item is the cover. Click the crop button on any photo to see exactly how it will be framed on desktop and mobile."
                >
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                    <input
                      type="file"
                      multiple
                      accept={`${ACCEPTED_MEDIA_TYPES},image/*,video/*,.png,.jpeg,.jpg,.svg,.webp,.gif,.bmp,.avif,.mp4,.mov,.mkv,.avi,.webm`}
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleImageFiles(e.target.files);
                        }
                        // Allow re-selecting the same file after an upload.
                        e.target.value = '';
                      }}
                      disabled={imageUploadBusy}
                      style={{ ...inputStyle, padding: 6, fontSize: 11, flex: 1 }}
                    />
                    <input
                      type="text"
                      placeholder="Or paste image / video URL"
                      value={imageInput}
                      onChange={(e) => setImageInput(e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: 6, fontSize: 11 }}
                    />
                    <button onClick={addImageUrl} style={{ ...buttonGhost, padding: '6px 12px', fontSize: 11 }}>Add URL</button>
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 8, lineHeight: 1.6 }}>
                    <strong style={{ color: '#9ca3af' }}>Images:</strong> PNG · JPEG · JPG · SVG · WEBP · GIF · BMP (photos auto-compress)
                    &nbsp;·&nbsp; <strong style={{ color: '#9ca3af' }}>Videos:</strong> MP4 · MOV · MKV · AVI · WEBM
                  </div>
                  {imageUploadBusy && (
                    <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(125,211,252,0.1)', border: '1px solid rgba(125,211,252,0.35)', fontSize: 11, color: '#7dd3fc', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 999, border: '2px solid rgba(125,211,252,0.3)', borderTopColor: '#7dd3fc', animation: 'goyunirSpin 0.7s linear infinite', display: 'inline-block' }} />
                      {imageUploadLabel || 'Uploading files…'}
                    </div>
                  )}
                  {(!productForm.images || productForm.images.length === 0) && (
                    <div style={{ fontSize: 10, color: '#666', marginBottom: 8, border: '1px dashed #2e2e35', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                      No media yet — upload a file or paste a URL above. The seed products ship with a 3-photo gallery so the swipe demo works out of the box.
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {(productForm.images || []).map((img: string, idx: number) => {
                      const isVideo = isVideoMedia(img);
                      const cropForIdx = Array.isArray(productForm.crops) ? productForm.crops[idx] : undefined;
                      const cropped = !isVideo && !!cropForIdx && normalizeCrop(cropForIdx).w < 0.999;
                      return (
                        <div key={`${img}-${idx}`} style={{ position: 'relative', background: '#060606', padding: 4, borderRadius: 4, maxWidth: 60, maxHeight: 60, overflow: 'hidden' }}>
                          {isVideo ? (
                            <video src={img} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
                          ) : (
                            <img src={img} alt={`media-${idx + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          )}
                          <span style={{ fontSize: 8, color: '#888', position: 'absolute', bottom: 0, left: 2, background: 'rgba(0,0,0,0.7)', padding: '0 4px' }}>
                            {isVideo ? `▶${idx + 1}` : `#${idx + 1}`}
                          </span>
                          {cropped && (
                            <span style={{ fontSize: 8, color: '#7dd3fc', position: 'absolute', top: 0, left: 2, background: 'rgba(0,0,0,0.7)', padding: '0 4px' }}>✂</span>
                          )}
                          <button onClick={() => removeImage(idx)} style={{ ...buttonGhost, padding: '0 4px', fontSize: 8, color: '#f87171', borderColor: '#f87171', position: 'absolute', top: 0, right: 0, background: 'rgba(0,0,0,0.5)' }}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {(productForm.images || []).map((img: string, idx: number) => {
                      if (isVideoMedia(img)) return null;
                      return (
                        <button
                          key={`cropbtn-${idx}`}
                          onClick={() => setCropEditorIdx(cropEditorIdx === idx ? null : idx)}
                          style={{ ...buttonGhost, padding: '3px 10px', fontSize: 10, marginRight: 4, marginBottom: 4, borderColor: cropEditorIdx === idx ? '#7dd3fc' : '#27272a', color: cropEditorIdx === idx ? '#7dd3fc' : '#aaa' }}
                        >
                          {cropEditorIdx === idx ? '▾ Close crop' : '✂ Crop'} · {idx + 1}
                        </button>
                      );
                    })}
                  </div>
                  {cropEditorIdx !== null && productForm.images[cropEditorIdx] && !isVideoMedia(productForm.images[cropEditorIdx]) && (
                    <CropEditor
                      src={productForm.images[cropEditorIdx]}
                      crop={Array.isArray(productForm.crops) ? productForm.crops[cropEditorIdx] : DEFAULT_CROP}
                      onCrop={(c) =>
                        setProductForm((prev: any) => {
                          const nextCrops = [...(Array.isArray(prev.crops) ? prev.crops : prev.images.map(() => DEFAULT_CROP))];
                          nextCrops[cropEditorIdx] = c;
                          return { ...prev, crops: nextCrops };
                        })
                      }
                    />
                  )}
                  <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                    <span>💡 Uploaded media is stored as data URLs (base64) — for production, consider using cloud storage. The prefix (folder name) is set from the slug.</span>
                  </div>
                </SectionCard>

                {/* ============ PRICING & SIZES ============ */}
                <SectionCard
                  id="pf-sizes"
                  title="Pricing, Sizes & Inventory"
                  description="Define each size/variant the customer can buy — price, Stripe ID, stock for that size, winner tiers and its own raffle timer. “Winners / draw” is a CSV like 3,2,2 = 3 winners on draw 1, 2 on draw 2, etc. Inventory & limits for the whole release live in the panel below the sizes."
                  action={<button onClick={addPriceCategory} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>+ Add Size</button>}
                >
                  {productForm.priceCategories.map((cat: any, idx: number) => {
                    const sizeKey = String(cat.size || '').trim().toLowerCase();
                    const sizeCfg = (productForm.sizeConfigs || {})[sizeKey] || {};
                    const effectiveMode = String(cat.checkoutMode || '').toUpperCase() === 'FCFS'
                      ? 'FCFS'
                      : String(cat.checkoutMode || '').toUpperCase() === 'RAFFLE'
                        ? 'RAFFLE'
                        : (productForm.checkoutMode === 'FCFS' ? 'FCFS' : 'RAFFLE');
                    const isSamplerCat = Array.isArray(productForm.samplerSizes)
                      && productForm.samplerSizes.some((s: any) => String(s?.size || '').trim().toLowerCase() === sizeKey);
                    const sizeHasOwnConfig = Boolean(sizeCfg.releaseEndsAt) || Boolean(sizeCfg.customDropSchedule);
                    return (
                      <div key={idx} style={{ background: '#0b0b0d', border: '1px solid #232329', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                        {/* Row 1 — identity + price */}
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        type="text"
                        placeholder="Size (e.g. Standard)"
                        value={cat.size}
                        onChange={(e) => updatePriceCategory(idx, 'size', e.target.value)}
                        style={{ ...inputStyle, width: 100, padding: 6, fontSize: 11 }}
                      />
                      <input
                        type="number"
                        placeholder="Price ($)"
                        value={cat.price}
                        onChange={(e) => updatePriceCategory(idx, 'price', Number(e.target.value))}
                        style={{ ...inputStyle, width: 80, padding: 6, fontSize: 11 }}
                      />
                      <input
                        type="number"
                        min={0}
                        placeholder="Units"
                        title="Stock for THIS size — live inventory seeds from this number (blank = falls back to Total inventory)."
                        value={productForm.inventoryPerSize?.[cat.size] ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setProductForm((p: any) => {
                            const inv = { ...(p.inventoryPerSize || {}) };
                            if (v === '' || Number(v) <= 0) delete inv[cat.size];
                            else inv[cat.size] = Math.max(0, Number(v));
                            return { ...p, inventoryPerSize: inv };
                          });
                        }}
                        style={{ ...inputStyle, width: 64, padding: 6, fontSize: 11 }}
                      />
                      <input
                        type="text"
                        placeholder="Stripe Price ID"
                        value={cat.stripeId}
                        onChange={(e) => updatePriceCategory(idx, 'stripeId', e.target.value)}
                        style={{ ...inputStyle, flex: 1, minWidth: 120, padding: 6, fontSize: 11 }}
                      />
                      </div>
                      {/* Row 2 — draw / format controls. The "Winners / draw"
                          input is only meaningful for raffle sizes — an FCFS
                          (instant-buy) size is never drawn, so it shows a clear
                          note instead of a confusing winners field. */}
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                      {effectiveMode === 'RAFFLE' ? (
                        <input
                          type="text"
                          placeholder="Winners / draw (e.g. 3,2,2)"
                          title="How many winners this raffle picks per draw. A CSV like 3,2,2 means 3 winners on draw 1, 2 on draw 2, and so on. Applies to THIS size only."
                          value={Array.isArray(cat.winnerTiers) ? cat.winnerTiers.join(',') : String(cat.winnerTiers ?? '1')}
                          onChange={(e) => updatePriceCategory(idx, 'winnerTiers', normalizeWinnerTiersCsv(e.target.value))}
                          style={{ ...inputStyle, width: 140, padding: 6, fontSize: 11 }}
                        />
                      ) : (
                        <span style={{ fontSize: 10, color: '#93c5fd', fontWeight: 700, letterSpacing: '0.4px' }}>
                          ⚡ Sells instantly at checkout — never drawn
                        </span>
                      )}
                      <select
                        title="Checkout mode for THIS size. Leave on Auto to follow the product's Checkout Mode. A product can mix formats — e.g. a sampler sells instantly (FCFS) while the full size runs a raffle."
                        value={cat.checkoutMode || ''}
                        onChange={(e) => updatePriceCategory(idx, 'checkoutMode', e.target.value || '')}
                        style={{ ...inputStyle, width: 122, padding: 6, fontSize: 10, color: String(cat.checkoutMode || '').toUpperCase() === 'RAFFLE' ? '#fbbf24' : String(cat.checkoutMode || '').toUpperCase() === 'FCFS' ? '#60a5fa' : '#8b95a7' }}
                      >
                        <option value="">Auto (product)</option>
                        <option value="RAFFLE">🎟 RAFFLE</option>
                        <option value="FCFS">⚡ FCFS</option>
                      </select>
                          <button
                            onClick={() => toggleSampler(idx)}
                            title={isSamplerCat
                              ? 'Remove the sampler marker — this size is no longer a trial SKU.'
                              : 'Mark as a sampler: the customer can try this size first and gets a credit toward the full size after delivery.'}
                            style={{
                              ...buttonGhost,
                              padding: '2px 8px',
                              fontSize: 10,
                              borderRadius: 999,
                              background: isSamplerCat ? 'rgba(34,197,94,0.12)' : 'transparent',
                              borderColor: isSamplerCat ? '#22c55e' : '#2e2e35',
                              color: isSamplerCat ? '#4ade80' : '#8b95a7',
                            }}
                          >
                            {isSamplerCat ? '🧪 Sample' : 'Sample'}
                          </button>
                          <span style={{ fontSize: 9.5, color: effectiveMode === 'RAFFLE' ? '#fbbf24' : '#60a5fa', fontWeight: 700, letterSpacing: '0.5px' }}>
                            {effectiveMode === 'RAFFLE' ? '🎟 RAFFLE' : '⚡ FCFS'}
                          </span>
                          <button onClick={() => removePriceCategory(idx)} style={{ ...buttonGhost, padding: '2px 6px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>✕</button>
                      </div>
                      {/* Per-size summary — what THIS size actually does, so a mixed
                          product (one raffle + one instant-buy) reads clearly. */}
                      <div style={{ marginTop: 5, fontSize: 10, color: '#8b95a7', lineHeight: 1.5 }}>
                        {effectiveMode === 'RAFFLE' ? (
                          <>
                            <span style={{ color: '#fbbf24', fontWeight: 700 }}>🎟 Raffle size</span>
                            {' · '}
                            {(() => {
                              const tiers = Array.isArray(cat.winnerTiers) ? cat.winnerTiers : String(cat.winnerTiers ?? '').split(',').map((t) => t.trim()).filter(Boolean);
                              const firstTier = Number(tiers?.[0]) > 0 ? Number(tiers[0]) : null;
                              return firstTier ? <>draws <strong style={{ color: '#d4d4d8' }}>{firstTier}</strong> winner{firstTier === 1 ? '' : 's'} on draw 1</> : <>winner count set below</>;
                            })()}
                            {sizeHasOwnConfig ? ' · owns its timer' : ' · inherits product timer'}
                          </>
                        ) : (
                          <>
                            <span style={{ color: '#93c5fd', fontWeight: 700 }}>⚡ Instant-buy size</span>
                            {' · charges at checkout · never enters a raffle pool'}
                          </>
                        )}
                      </div>
                      {/* Row 3 — per-size raffle settings: when this size runs a raffle,
                          it can draw on its OWN countdown end + its OWN recurring
                          schedule ("customize each raffle differently"). Blank =
                          inherit the product-level Drop Schedule. */}
                      {effectiveMode === 'RAFFLE' && (
                        <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: '#08080a', border: sizeHasOwnConfig ? '1px solid rgba(245,158,11,0.35)' : '1px dashed #2a2a31' }}>
                          <div style={{ fontSize: 9.5, fontWeight: 700, color: sizeHasOwnConfig ? '#fbbf24' : '#8b95a7', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 6 }}>
                            🎟 Per-size raffle settings {sizeHasOwnConfig ? '— overrides product' : '— inherits product schedule'}
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                            <div>
                              <label style={{ fontSize: 10, color: '#888' }}>Own countdown ends at (blank = the product&apos;s)</label>
                              <input
                                type="datetime-local"
                                value={sizeCfg.releaseEndsAt || ''}
                                onChange={(e) => updateSizeConfig(cat.size, { releaseEndsAt: e.target.value })}
                                style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 3 }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
                                <input
                                  type="checkbox"
                                  checked={!!sizeCfg.customDropSchedule}
                                  onChange={(e) => updateSizeConfig(cat.size, {
                                    customDropSchedule: e.target.checked
                                      ? {
                                          mode: 'daily',
                                          timezone: productForm.customDropSchedule?.timezone || scheduleForm.timezone || 'America/Los_Angeles',
                                          targetEndDateTime: '',
                                          drawDayOfWeek: 6,
                                          drawDayOfMonth: 1,
                                          drawHour: 21,
                                          drawMinute: 0,
                                          drawSecond: 0,
                                          customIntervalHours: 24,
                                        }
                                      : null,
                                  })}
                                />
                                <span>Own recurring schedule</span>
                              </label>
                            </div>
                          </div>
                          {sizeCfg.customDropSchedule && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                              <label style={{ fontSize: 11 }}>Cadence
                                <select
                                  value={sizeCfg.customDropSchedule.mode || 'daily'}
                                  onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), mode: e.target.value } })}
                                  style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                >
                                  <option value="hourly">Hourly</option>
                                  <option value="daily">Daily</option>
                                  <option value="weekly">Weekly</option>
                                  <option value="biweekly">Biweekly</option>
                                  <option value="monthly">Monthly</option>
                                  <option value="yearly">Yearly</option>
                                  <option value="custom">Custom (every N hours)</option>
                                </select>
                              </label>
                              {sizeCfg.customDropSchedule.mode === 'custom' && (
                                <label style={{ fontSize: 11 }}>Every N hours
                                  <input
                                    type="number"
                                    min={1}
                                    max={720}
                                    value={sizeCfg.customDropSchedule.customIntervalHours ?? 24}
                                    onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), customIntervalHours: Number(e.target.value) } })}
                                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                  />
                                </label>
                              )}
                              {(sizeCfg.customDropSchedule.mode === 'daily' || sizeCfg.customDropSchedule.mode === 'weekly' || sizeCfg.customDropSchedule.mode === 'monthly') && (
                                <>
                                  <label style={{ fontSize: 11 }}>Hour (0-23)
                                    <input
                                      type="number"
                                      min={0}
                                      max={23}
                                      value={sizeCfg.customDropSchedule.drawHour ?? 21}
                                      onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), drawHour: Number(e.target.value) } })}
                                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                    />
                                  </label>
                                  <label style={{ fontSize: 11 }}>Minute (0-59)
                                    <input
                                      type="number"
                                      min={0}
                                      max={59}
                                      value={sizeCfg.customDropSchedule.drawMinute ?? 0}
                                      onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), drawMinute: Number(e.target.value) } })}
                                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                    />
                                  </label>
                                </>
                              )}
                              {sizeCfg.customDropSchedule.mode === 'weekly' && (
                                <label style={{ fontSize: 11 }}>Day of week (0=Sun..6=Sat)
                                  <input
                                    type="number"
                                    min={0}
                                    max={6}
                                    value={sizeCfg.customDropSchedule.drawDayOfWeek ?? 6}
                                    onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), drawDayOfWeek: Number(e.target.value) } })}
                                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                  />
                                </label>
                              )}
                              {sizeCfg.customDropSchedule.mode === 'monthly' && (
                                <label style={{ fontSize: 11 }}>Day of month (1-31)
                                  <input
                                    type="number"
                                    min={1}
                                    max={31}
                                    value={sizeCfg.customDropSchedule.drawDayOfMonth ?? 1}
                                    onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), drawDayOfMonth: Number(e.target.value) } })}
                                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                  />
                                </label>
                              )}
                              {sizeCfg.customDropSchedule.mode === 'hourly' && (
                                <label style={{ fontSize: 11 }}>Minute (0-59)
                                  <input
                                    type="number"
                                    min={0}
                                    max={59}
                                    value={sizeCfg.customDropSchedule.drawMinute ?? 0}
                                    onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), drawMinute: Number(e.target.value) } })}
                                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                  />
                                </label>
                              )}
                              {sizeCfg.customDropSchedule.mode === 'fixed' && (
                                <label style={{ fontSize: 11 }}>One-shot draw at
                                  <input
                                    type="datetime-local"
                                    value={sizeCfg.customDropSchedule.targetEndDateTime || ''}
                                    onChange={(e) => updateSizeConfig(cat.size, { customDropSchedule: { ...(sizeCfg.customDropSchedule || {}), targetEndDateTime: e.target.value } })}
                                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                                  />
                                </label>
                              )}
                              <p style={{ gridColumn: '1 / -1', fontSize: 9.5, color: '#8b95a7', margin: '2px 0 0', lineHeight: 1.5 }}>
                                This size draws on its OWN timer. Leave <strong>Own countdown ends at</strong> blank to inherit the product&apos;s countdown, and
                                leave the schedule off to inherit the product&apos;s cadence (then the global cadence). Every raffle size can run independently.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                      {effectiveMode === 'FCFS' && (
                        <div style={{ marginTop: 8, padding: '7px 9px', borderRadius: 8, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.22)', fontSize: 10, color: '#93c5fd', lineHeight: 1.5 }}>
                          ⚡ This size sells instantly — it never draws and has no countdown or raffle schedule. Its price charges right at checkout (perfect for sampler/instant-buy sizes sitting next to a raffle size).
                        </div>
                      )}
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                    <span>💡 If STRIPE_PRODUCT_ID is set, the Stripe ID prefills with <code>{defaultStripePriceId}</code> — you can always override it per size. New sizes start at price <code>{UNCONFIGURED_PRICE_SENTINEL}</code> (obviously-wrong sentinel) until you set a real price; checkout refuses to charge it. Toggle <strong>Sample</strong> on a size to turn it into a trial SKU — tune it in the &ldquo;Trial sizes &amp; sample credits&rdquo; panel below. The <strong>Units</strong> field on each size is its own stock; the totals below reconcile them.</span>
                  </div>

                  {/* ====== Inventory & limits (merged INTO Pricing & Sizes so the
                       whole sellable shape of the release lives in one place) ====== */}
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: '#0b0b0d', border: '1px solid #1f2937' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 6 }}>
                      Inventory &amp; limits
                    </div>
                    <p style={{ fontSize: 10, color: '#8b95a7', margin: '0 0 8px', lineHeight: 1.5 }}>
                      Total inventory drives the sold-out state (0 units shows the release as sold out while “stay visible” keeps it on the page as proof of demand). Max per email / cart cap how much ONE customer can take so a single buyer can never wipe a drop.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <label style={{ fontSize: 10, color: '#888' }}>Total inventory (units)
                        <input type="number" min={0} value={productForm.totalInventory ?? 0} onChange={(e) => setProductForm((p: any) => ({ ...p, totalInventory: Math.max(0, Number(e.target.value) || 0) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 3 }} />
                      </label>
                      <label style={{ fontSize: 10, color: '#888' }}>Max raffle allocation (0 = unlimited)
                        <input type="number" min={0} value={productForm.maxRaffleAllocationLimit ?? 0} onChange={(e) => setProductForm((p: any) => ({ ...p, maxRaffleAllocationLimit: Math.max(0, Number(e.target.value) || 0) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 3 }} />
                      </label>
                      <label style={{ fontSize: 10, color: '#888' }}>Max per email (entry or purchase count)
                        <input type="number" min={1} value={productForm.maxPerEmail ?? 1} onChange={(e) => setProductForm((p: any) => ({ ...p, maxPerEmail: Number(e.target.value) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 3 }} />
                      </label>
                      <label style={{ fontSize: 10, color: '#888' }}>Max in cart per email
                        <input type="number" min={1} value={productForm.maxPerCart ?? productForm.maxPerEmail ?? 1} onChange={(e) => setProductForm((p: any) => ({ ...p, maxPerCart: Number(e.target.value) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 3 }} />
                      </label>
                    </div>
                    {/* Live reconciliation: per-size units vs the total. The math
                        & health check panel also flags a mismatch — this shows the
                        numbers side by side so it's obvious what to fix. */}
                    {(() => {
                      const cats = (productForm.priceCategories || []).filter((c: any) => String(c?.size || '').trim());
                      const per = productForm.inventoryPerSize || {};
                      const sum = cats.reduce((s: number, c: any) => s + (Number(per[c.size]) > 0 ? Number(per[c.size]) : 0), 0);
                      const total = Math.max(0, Number(productForm.totalInventory) || 0);
                      if (cats.length <= 1) return null;
                      const mismatch = total > 0 && sum > 0 && sum !== total;
                      return (
                        <div style={{ marginTop: 8, fontSize: 10, lineHeight: 1.5, padding: '7px 9px', borderRadius: 8, background: mismatch ? 'rgba(245,158,11,0.07)' : 'rgba(34,197,94,0.06)', border: mismatch ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(34,197,94,0.22)' }}>
                          {sum > 0
                            ? <span style={{ color: mismatch ? '#fde68a' : '#4ade80' }}>Per-size units sum to <strong>{sum}</strong> vs Total inventory <strong>{total}</strong>{mismatch ? ' — they disagree. The storefront keys sold-out off the total while live states seed per size; make them match.' : ' — all good.'}</span>
                            : <span style={{ color: '#8b95a7' }}>No per-size units set — every size falls back to Total inventory ({total}).</span>}
                        </div>
                      );
                    })()}
                  </div>
                </SectionCard>

                {/* ============ CUSTOMER-FACING COPY ============ */}
                <SectionCard
                  id="pf-copy"
                  title="Customer-facing copy"
                  description="The exact lines customers read on this product's page. Every field is optional — leave it blank to inherit the global Settings → Storefront copy (which falls back to the built-in default), or write per-product copy here for a product-specific voice."
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <label style={{ fontSize: 10, color: '#888' }}>
                      In-stock urgency line (default: “Handmade allocation. Low supply by design.”)
                      <textarea
                        rows={2}
                        placeholder="Handmade allocation. Low supply by design."
                        value={productForm.urgencyInStock || ''}
                        onChange={(e) => setProductForm((p: any) => ({ ...p, urgencyInStock: e.target.value }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', fontFamily: 'inherit', marginTop: 3, resize: 'vertical' }}
                      />
                    </label>
                    <label style={{ fontSize: 10, color: '#888' }}>
                      Sold-out urgency line (default: “This release is fully spoken for.”)
                      <textarea
                        rows={2}
                        placeholder="This release is fully spoken for."
                        value={productForm.urgencySoldOut || ''}
                        onChange={(e) => setProductForm((p: any) => ({ ...p, urgencySoldOut: e.target.value }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', fontFamily: 'inherit', marginTop: 3, resize: 'vertical' }}
                      />
                    </label>
                    <label style={{ fontSize: 10, color: '#888' }}>
                      Live status story (default: “Reserved for collectors moving early, before the allocation tightens further.”)
                      <textarea
                        rows={2}
                        placeholder="Reserved for collectors moving early, before the allocation tightens further."
                        value={productForm.statusLive || ''}
                        onChange={(e) => setProductForm((p: any) => ({ ...p, statusLive: e.target.value }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', fontFamily: 'inherit', marginTop: 3, resize: 'vertical' }}
                      />
                    </label>
                    <label style={{ fontSize: 10, color: '#888' }}>
                      Archived status story (default: “Archive placement preserves the release as proof of demand and collectability.”)
                      <textarea
                        rows={2}
                        placeholder="Archive placement preserves the release as proof of demand and collectability."
                        value={productForm.statusArchived || ''}
                        onChange={(e) => setProductForm((p: any) => ({ ...p, statusArchived: e.target.value }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', fontFamily: 'inherit', marginTop: 3, resize: 'vertical' }}
                      />
                    </label>
                  </div>
                  <label style={{ fontSize: 10, color: '#888', display: 'block', marginTop: 8 }}>
                    Mixed-format ribbon (only shows when sizes mix raffle + instant-buy). Template tokens: <code>{'{raffle}'}</code> = raffle size count, <code>{'{fcfs}'}</code> = instant-buy count.
                    <textarea
                      rows={2}
                      placeholder="This release mixes formats — {raffle} raffle size(s) and {fcfs} instant-buy size(s). Pick a size above to see its option."
                      value={productForm.mixedFormatRibbon || ''}
                      onChange={(e) => setProductForm((p: any) => ({ ...p, mixedFormatRibbon: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', fontFamily: 'inherit', marginTop: 3, resize: 'vertical' }}
                    />
                  </label>
                  {/* Enable/disable each block on the product page — "show or hide
                      text items for everything". Every toggle defaults ON. */}
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: '#0b0b0d', border: '1px solid #1f2937' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 6 }}>
                      Show / hide on the product page
                    </div>
                    <p style={{ fontSize: 10, color: '#8b95a7', margin: '0 0 8px', lineHeight: 1.5 }}>
                      Turn any block off and it stops rendering for customers — no code change needed, works instantly on save.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {([
                        ['showUrgencyLine', 'Urgency line', 'The “Only X left” / in-stock urgency line under the price.'],
                        ['showStatusLine', 'Status story', 'The “Reserved for collectors…” status story line.'],
                        ['showNotesSection', '“Why this drop matters”', 'The whole notes section at the bottom of the product page.'],
                        ['showMixedRibbon', 'Mixed-format ribbon', 'The purple “mixes formats” ribbon (only ever shown on mixed products).'],
                      ] as const).map(([key, label, hint]) => (
                        <label key={key} style={{ fontSize: 10.5, color: '#cbd5e1', display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', padding: '7px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid #232329' }}>
                          <input
                            type="checkbox"
                            checked={productForm[key] !== false}
                            onChange={(e) => setProductForm((p: any) => ({ ...p, [key]: e.target.checked }))}
                            style={{ marginTop: 1 }}
                          />
                          <span>
                            <strong style={{ display: 'block' }}>{label}</strong>
                            <span style={{ fontSize: 9.5, color: '#8b95a7' }}>{hint}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: '#8b95a7', marginTop: 6, lineHeight: 1.5 }}>
                    Type Enter for a real line break — the storefront renders these lines with <code>white-space: pre-line</code>. These five lines are the
                    same ones editable site-wide in Settings → Storefront copy; a value here wins for THIS product only.
                  </div>
                </SectionCard>

                {/* ============ DROP SCHEDULE ============ */}
                <SectionCard
                  id="pf-schedule"
                  title="Drop Schedule"
                  description="When the release opens and when each raffle round ends. Upcoming products auto-activate at the go-live moment; the countdown end is when a raffle draws (or a recurring raffle rolls to the next round)."
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <label style={{ fontSize: 10, color: '#888' }}>Go live at (upcoming auto-activates)</label>
                      <input type="datetime-local" value={productForm.goLiveAt || ''} onChange={(e) => setProductForm((p: any) => ({ ...p, goLiveAt: e.target.value }))} style={inputStyle} />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: '#888' }}>Countdown ends at (draw moment)</label>
                      <input type="datetime-local" value={productForm.releaseEndsAt || ''} onChange={(e) => setProductForm((p: any) => ({ ...p, releaseEndsAt: e.target.value }))} style={inputStyle} />
                    </div>
                  </div>
                  {/* Live schedule preview — the admin understands what the clock will
                      do so the operator never has to imagine the cadence. */}
                  {(() => {
                    try {
                      const effective = productForm.customDropSchedule
                        ? { ...scheduleForm, ...productForm.customDropSchedule }
                        : scheduleForm;
                      if (!effective || !effective.mode) return null;
                      const nextMs = getNextDrawTimestampForSchedule(effective);
                      const hasRecurring = Boolean(productForm.customDropSchedule);
                      const tz = effective.timezone || 'store timezone';
                      const nextLabel = Number.isFinite(nextMs) && nextMs > 0
                        ? new Date(nextMs).toLocaleString(undefined, { timeZoneName: 'short' })
                        : '—';
                      return (
                        <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.22)', fontSize: 10.5, color: '#93c5fd', lineHeight: 1.6 }}>
                          🗓 <strong style={{ color: '#bfdbfe' }}>Next scheduled draw:</strong> {nextLabel}{' '}
                          <span style={{ color: '#8b95a7' }}>
                            ({effective.mode === 'custom' ? `every ${effective.customIntervalHours || 24} hours` : effective.mode}
                            {hasRecurring ? ' · this product repeats while inventory remains' : ` · global cadence (${tz})`})
                          </span>
                        </div>
                      );
                    } catch {
                      return null;
                    }
                  })()}

                  {/* Per-product raffle schedule: lets a raffle REPEAT on a cadence
                      (hourly/daily/weekly/biweekly/monthly/yearly/custom) while
                      inventory remains. When enabled, the product's countdown
                      rolls forward to the next scheduled draw after each drop —
                      the "new raffle" timer. Leave disabled to inherit the global
                      schedule from Draws → Automation. */}
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: '#0b0b0d', border: '1px solid #1f2937' }}>
                    <label style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={!!productForm.customDropSchedule}
                        onChange={(e) => setProductForm((p: any) => ({
                          ...p,
                          customDropSchedule: e.target.checked
                            ? {
                                mode: 'daily',
                                timezone: scheduleForm.timezone || 'America/Los_Angeles',
                                targetEndDateTime: scheduleForm.targetEndDateTime || '',
                                drawDayOfWeek: 6,
                                drawDayOfMonth: 1,
                                drawHour: 21,
                                drawMinute: 0,
                                drawSecond: 0,
                                customIntervalHours: 24,
                              }
                            : null,
                        }))}
                      />
                      <span>Repeat this raffle on a schedule while inventory remains</span>
                    </label>
                    {productForm.customDropSchedule && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                      <label style={{ fontSize: 11 }}>Cadence
                        <select
                          value={productForm.customDropSchedule.mode || 'daily'}
                          onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), mode: e.target.value } }))}
                          style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                        >
                          <option value="hourly">Hourly</option>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="biweekly">Biweekly</option>
                          <option value="monthly">Monthly</option>
                          <option value="yearly">Yearly</option>
                          <option value="custom">Custom interval (hours)</option>
                        </select>
                      </label>
                      <label style={{ fontSize: 11 }}>Timezone
                        <input value={productForm.customDropSchedule.timezone || 'America/Los_Angeles'} onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), timezone: e.target.value } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                      </label>
                      {productForm.customDropSchedule.mode === 'custom' && (
                        <label style={{ fontSize: 11, gridColumn: '1 / -1' }}>Every N hours
                          <input
                            type="number"
                            min={1}
                            max={720}
                            value={productForm.customDropSchedule.customIntervalHours ?? 24}
                            onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), customIntervalHours: Math.max(1, Math.min(720, Number(e.target.value) || 24)) } }))}
                            style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                          />
                          <span style={{ fontSize: 10, color: '#666' }}>A new raffle round starts every N hours (e.g. 6 → a draw every 6 hours).</span>
                        </label>
                      )}
                      {productForm.customDropSchedule.mode === 'hourly' && (
                        <label style={{ fontSize: 11 }}>Minute (0-59)
                          <input type="number" min={0} max={59} value={productForm.customDropSchedule.drawMinute ?? 0} onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), drawMinute: Number(e.target.value) } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                        </label>
                      )}
                      {productForm.customDropSchedule.mode === 'weekly' && (
                        <label style={{ fontSize: 11 }}>Day of week (0=Sun..6=Sat)
                          <input type="number" min={0} max={6} value={productForm.customDropSchedule.drawDayOfWeek ?? 6} onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), drawDayOfWeek: Number(e.target.value) } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                        </label>
                      )}
                      {productForm.customDropSchedule.mode === 'monthly' && (
                        <label style={{ fontSize: 11 }}>Day of month (1-31)
                          <input type="number" min={1} max={31} value={productForm.customDropSchedule.drawDayOfMonth ?? 1} onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), drawDayOfMonth: Number(e.target.value) } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                        </label>
                      )}
                      {(productForm.customDropSchedule.mode === 'daily' || productForm.customDropSchedule.mode === 'weekly' || productForm.customDropSchedule.mode === 'monthly') && (
                        <>
                          <label style={{ fontSize: 11 }}>Hour (0-23)
                            <input type="number" min={0} max={23} value={productForm.customDropSchedule.drawHour ?? 21} onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), drawHour: Number(e.target.value) } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                          </label>
                          <label style={{ fontSize: 11 }}>Minute (0-59)
                            <input type="number" min={0} max={59} value={productForm.customDropSchedule.drawMinute ?? 0} onChange={(e) => setProductForm((p: any) => ({ ...p, customDropSchedule: { ...(p.customDropSchedule || {}), drawMinute: Number(e.target.value) } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                          </label>
                        </>
                      )}
                      <p style={{ gridColumn: '1 / -1', fontSize: 10, color: '#8b95a7', margin: '4px 0 0', lineHeight: 1.6 }}>
                        <strong style={{ color: '#aab6c8' }}>How this works:</strong> the schedule only starts <strong style={{ color: '#aab6c8' }}>AFTER the countdown above ends</strong>. The first raffle round runs on the
                        &quot;Countdown ends at&quot; time — when that timer hits zero the draw fires, and this cadence takes over, rolling the countdown forward to the next round. Later draws happen on this
                        cadence while allocation remains, and unselected entries carry over into the next raffle.
                      </p>
                      <p style={{ gridColumn: '1 / -1', fontSize: 10, color: '#8b95a7', margin: '2px 0 0', lineHeight: 1.6 }}>
                        <strong style={{ color: '#aab6c8' }}>Want the raffle to start right at release?</strong> Clear the &quot;Countdown ends at&quot; field above (leave it empty). The first round then starts when
                        the release goes live (or per the global schedule), and this cadence takes over after that round&apos;s draw.
                      </p>
                    </div>
                  )}
                </div>
                </SectionCard>

                {/* ============ SOLD-OUT BEHAVIOR ============ */}
                <SectionCard
                  id="pf-soldout"
                  title="Sold-out behavior"
                  description="What happens to the product page when every unit is allocated. “Stay visible” keeps momentum as social proof; archiving moves the release to Past Archives."
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <label style={{ fontSize: 10, color: '#888' }}>Sold-out behavior</label>
                      <select value={productForm.soldOutBehavior || 'stay_visible'} onChange={(e) => setProductForm((p: any) => ({ ...p, soldOutBehavior: e.target.value }))} style={inputStyle}>
                        <option value="stay_visible">Stay visible as social proof</option>
                        <option value="archive_now">Archive immediately</option>
                        <option value="archive_after_delay">Archive after delay</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: '#888' }}>Archive delay after sold out (hours)</label>
                      <input type="number" min={0} value={productForm.soldOutArchiveDelayHours ?? 24} onChange={(e) => setProductForm((p: any) => ({ ...p, soldOutArchiveDelayHours: Number(e.target.value) }))} style={inputStyle} />
                    </div>
                  </div>
                </SectionCard>
                {/* ============ TRIAL SIZES & SAMPLE CREDITS ============ */}
                <SectionCard
                  id="pf-trial"
                  title="Trial sizes &amp; sample credits"
                  description="Mark a size as a sampler (trial SKU) in Pricing &amp; Sizes, then fine-tune how each sampler converts. When a sampler order is marked delivered, the buyer gets a one-time credit code bound to their email — so the full size costs &ldquo;the difference&rdquo;. This is the big-brand try-first pattern: every trial SKU tells its own story, never one generic line."
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                    <input type="checkbox" checked={productForm.deliveryIncentiveEnabled === true} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveEnabled: e.target.checked }))} style={{ marginTop: 2 }} />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#e5e7eb' }}>Enable trial credits</div>
                      <div style={{ fontSize: 10, color: '#8b95a7', lineHeight: 1.5 }}>Off = no sampler messaging on the storefront and no credit codes issued at delivery.</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: '#8b95a7', lineHeight: 1.5, marginTop: -6, marginBottom: 10, padding: '8px 9px', borderRadius: 8, background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.25)' }}>
                    💡 <strong>Pair it with mixed formats:</strong> set this sampler&apos;s size mode to <strong style={{ color: '#93c5fd' }}>⚡ FCFS</strong> in Pricing &amp; Sizes above and it becomes an <em>instant-buy trial</em> while the full size keeps running a raffle — exactly the &ldquo;try the sampler, enter the draw for the full bottle&rdquo; pattern.
                  </div>

                  {productForm.deliveryIncentiveEnabled === true && (
                    <>
                      {/* Product-level defaults — every sampler falls back to these. */}
                      <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, background: '#0b0b0d', border: '1px solid #1f2937' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 6 }}>
                          Product defaults
                        </div>
                        <p style={{ fontSize: 10, color: '#8b95a7', margin: '0 0 8px', lineHeight: 1.5 }}>
                          Every sampler falls back to these when its own field below is left blank — set one sane default, then fine-tune a single size.
                        </p>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          <label style={{ fontSize: 10, color: '#888' }}>Default credit value ($)
                            <input type="number" step="0.01" min={0} value={samplerCentsToDollars(productForm.deliveryIncentiveCreditCents ?? 0)} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveCreditCents: samplerDollarsToCents(e.target.value) ?? 0 }))} style={inputStyle} />
                          </label>
                    <label style={{ fontSize: 10, color: '#888' }}>Default minimum next order ($)
                      <input type="number" step="0.01" min={0} value={samplerCentsToDollars(productForm.deliveryIncentiveMinOrderSubtotalCents ?? 0)} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveMinOrderSubtotalCents: samplerDollarsToCents(e.target.value) ?? 0 }))} style={inputStyle} />
                    </label>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 10, whiteSpace: 'nowrap' }}>
                        <input type="checkbox" checked={productForm.deliveryIncentiveNeverExpires === true} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveNeverExpires: e.target.checked }))} />
                        <span>Never expires</span>
                      </label>
                      {productForm.deliveryIncentiveNeverExpires !== true && (
                        <label style={{ fontSize: 10, color: '#888' }}>Default validity (days)
                          <input type="number" min={1} value={productForm.deliveryIncentiveExpiresDays ?? 60} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveExpiresDays: Number(e.target.value) }))} style={inputStyle} />
                        </label>
                      )}
                    </div>
                    <label style={{ fontSize: 10, color: '#888' }}>Default code prefix
                      <input type="text" value={productForm.deliveryIncentiveCodePrefix || ''} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveCodePrefix: e.target.value.toUpperCase() }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Eligible product slugs CSV (default)
                      <input type="text" value={Array.isArray(productForm.deliveryIncentiveEligibleProductSlugs) ? productForm.deliveryIncentiveEligibleProductSlugs.join(', ') : ''} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveEligibleProductSlugs: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Eligible size(s) CSV (default)
                      <input type="text" value={Array.isArray(productForm.deliveryIncentiveEligibleSizes) ? productForm.deliveryIncentiveEligibleSizes.join(', ') : ''} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveEligibleSizes: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) }))} style={inputStyle} />
                    </label>
                        </div>
                        <p style={{ fontSize: 10, color: '#8b95a7', margin: '6px 0 0', lineHeight: 1.6 }}>
                          <strong style={{ color: '#aab6c8' }}>Eligible products / sizes</strong> restrict where the generated code can be used (e.g. <code style={{ color: '#cbd5e1' }}>full-size-perfume</code> and <code style={{ color: '#cbd5e1' }}>100ml, 50ml</code>). Blank = the code works anywhere. The generated code looks like <code style={{ color: '#cbd5e1' }}>{String(productForm.deliveryIncentiveCodePrefix || 'DROP').toUpperCase()}-XXXXX-XXX</code>; letters/numbers only.
                        </p>
                      </div>

                      {/* Per-sampler setup — one card per size marked "Sample" in Pricing & Sizes. */}
                      {(Array.isArray(productForm.samplerSizes) ? productForm.samplerSizes : []).length === 0 ? (
                        <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px dashed #2e2e35', fontSize: 11, color: '#8b95a7', lineHeight: 1.6 }}>
                          No samplers yet — flip the <strong style={{ color: '#4ade80' }}>🧪 Sample</strong> toggle on a size in <strong style={{ color: '#cbd5e1' }}>Pricing &amp; Sizes</strong> above, then its setup card appears here. Every sampler gets its own badge, upgrade target and credit.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {(Array.isArray(productForm.samplerSizes) ? productForm.samplerSizes : []).map((sampler: any, sidx: number) => {
                            const samplerSizeKey = String(sampler?.size || '').trim();
                            const otherCats = (productForm.priceCategories || []).filter(
                              (c: any) => String(c?.size || '').trim().toLowerCase() !== samplerSizeKey.toLowerCase(),
                            );
                            const expiryState = sampler?.neverExpires === true ? 'never' : sampler?.neverExpires === false ? 'expires' : 'default';
                            return (
                              <div key={`sampler-${samplerSizeKey || sidx}`} style={{ padding: 12, borderRadius: 10, background: '#0b0b0d', border: '1px solid rgba(34,197,94,0.35)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: '#4ade80', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)', borderRadius: 999, padding: '3px 10px' }}>🧪 {samplerSizeKey || 'Sample size'}</span>
                                    <span style={{ fontSize: 10, color: '#8b95a7' }}>trial SKU — fields left blank use the product defaults</span>
                                  </div>
                                  <button onClick={() => removeSamplerByName(samplerSizeKey)} style={{ ...buttonGhost, padding: '3px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>Remove sampler</button>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                  <label style={{ fontSize: 10, color: '#888' }}>Badge label (shown on the size chip)
                                    <input type="text" value={sampler?.label || ''} onChange={(e) => updateSampler(samplerSizeKey, { label: e.target.value })} placeholder="Trial / Discovery / Mini" style={inputStyle} />
                                  </label>
                                  <label style={{ fontSize: 10, color: '#888' }}>Credits toward
                                    <select value={sampler?.fullSize || ''} onChange={(e) => updateSampler(samplerSizeKey, { fullSize: e.target.value })} style={inputStyle}>
                                      <option value="">Any next order</option>
                                      {otherCats.map((c: any) => (
                                        <option key={c.size} value={c.size}>{c.size}</option>
                                      ))}
                                    </select>
                                  </label>
                                  <label style={{ fontSize: 10, color: '#888' }}>Credit value ($)
                                    <input type="number" step="0.01" min={0} value={samplerCentsToDollars(sampler?.creditCents)} onChange={(e) => updateSampler(samplerSizeKey, { creditCents: samplerDollarsToCents(e.target.value) })} placeholder={samplerCentsToDollars(productForm.deliveryIncentiveCreditCents ?? 0) || '0'} style={inputStyle} />
                                  </label>
                                  <label style={{ fontSize: 10, color: '#888' }}>Minimum next order ($)
                                    <input type="number" step="0.01" min={0} value={samplerCentsToDollars(sampler?.minOrderSubtotalCents)} onChange={(e) => updateSampler(samplerSizeKey, { minOrderSubtotalCents: samplerDollarsToCents(e.target.value) })} placeholder={samplerCentsToDollars(productForm.deliveryIncentiveMinOrderSubtotalCents ?? 0) || '0'} style={inputStyle} />
                                  </label>
                                  <label style={{ fontSize: 10, color: '#888' }}>Credit expiry
                                    <select value={expiryState} onChange={(e) => updateSampler(samplerSizeKey, { neverExpires: e.target.value === 'never' ? true : e.target.value === 'expires' ? false : null })} style={inputStyle}>
                                      <option value="default">Use product default</option>
                                      <option value="never">Never expires</option>
                                      <option value="expires">Expires after N days</option>
                                    </select>
                                  </label>
                                  {expiryState === 'expires' && (
                                    <label style={{ fontSize: 10, color: '#888' }}>Validity (days)
                                      <input type="number" min={1} value={sampler?.expiresDays ?? ''} onChange={(e) => updateSampler(samplerSizeKey, { expiresDays: e.target.value === '' ? null : Math.max(1, Number(e.target.value) || 60) })} placeholder={String(productForm.deliveryIncentiveExpiresDays ?? 60)} style={inputStyle} />
                                    </label>
                                  )}
                                  <label style={{ fontSize: 10, color: '#888' }}>Code prefix
                                    <input type="text" value={sampler?.codePrefix || ''} onChange={(e) => updateSampler(samplerSizeKey, { codePrefix: e.target.value.toUpperCase() })} placeholder={String(productForm.deliveryIncentiveCodePrefix || 'DROP').toUpperCase()} style={inputStyle} />
                                  </label>
                                  <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Customer-facing note (optional)
                                    <input type="text" value={sampler?.note || ''} onChange={(e) => updateSampler(samplerSizeKey, { note: e.target.value })} placeholder="Blank = auto-generated from the size, credit and full-size target" style={inputStyle} />
                                  </label>
                                  <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Eligible product slugs CSV (this sampler)
                                    <input type="text" value={Array.isArray(sampler?.eligibleProductSlugs) ? sampler.eligibleProductSlugs.join(', ') : ''} onChange={(e) => updateSampler(samplerSizeKey, { eligibleProductSlugs: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="Blank = product default" style={inputStyle} />
                                  </label>
                                  <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Eligible size(s) CSV (this sampler)
                                    <input type="text" value={Array.isArray(sampler?.eligibleSizes) ? sampler.eligibleSizes.join(', ') : ''} onChange={(e) => updateSampler(samplerSizeKey, { eligibleSizes: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder="Blank = product default" style={inputStyle} />
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <p style={{ fontSize: 10, color: '#8b95a7', margin: '8px 0 0', lineHeight: 1.6 }}>
                        Each credit is a one-time code bound to the buyer&apos;s email, issued when the sampler order is marked <strong style={{ color: '#aab6c8' }}>delivered</strong> in Shipping. <strong style={{ color: '#aab6c8' }}>Never expires</strong> keeps it usable until manually removed; otherwise it lapses after the validity window.
                      </p>
                    </>
                  )}
                </SectionCard>

                {/* ============ NOTES ============ */}
                <SectionCard
                  id="pf-notes"
                  title="Notes"
                  description="Scrollable story cards on the product page (“Why this drop matters”, “How it works”, …). Label is the small eyebrow, name the heading, text the body."
                >
                  <div style={{ marginBottom: 8 }}>
                    {productForm.notes && productForm.notes.map((note: any, idx: number) => (
                      <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', background: '#060606', padding: 6, borderRadius: 6 }}>
                        <span style={{ fontSize: 10, color: '#888', minWidth: 60 }}>{note.label}</span>
                        <span style={{ fontSize: 11, color: '#ccc', flex: 1 }}>{note.name}</span>
                        <span style={{ fontSize: 10, color: '#666', flex: 1 }}>{note.text}</span>
                        <button onClick={() => editNote(idx)} style={{ ...buttonGhost, padding: '2px 8px', fontSize: 10 }}>Edit</button>
                        <button onClick={() => removeNote(idx)} style={{ ...buttonGhost, padding: '2px 8px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>✕</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <input type="text" placeholder="Label (e.g. TOP PROFILE)" value={noteForm.label} onChange={(e) => setNoteForm((n) => ({ ...n, label: e.target.value }))} style={{ ...inputStyle, width: 120, padding: 6, fontSize: 11 }} />
                    <input type="text" placeholder="Name" value={noteForm.name} onChange={(e) => setNoteForm((n) => ({ ...n, name: e.target.value }))} style={{ ...inputStyle, width: 140, padding: 6, fontSize: 11 }} />
                    <input type="text" placeholder="Text" value={noteForm.text} onChange={(e) => setNoteForm((n) => ({ ...n, text: e.target.value }))} style={{ ...inputStyle, flex: 1, padding: 6, fontSize: 11 }} />
                    <button onClick={addNote} style={{ ...buttonPrimary, padding: '6px 12px', fontSize: 11 }}>{editingNoteIdx !== null ? 'Update' : 'Add'}</button>
                    {editingNoteIdx !== null && <button onClick={() => { setEditingNoteIdx(null); setNoteForm({ label: '', name: '', text: '' }); }} style={{ ...buttonGhost, padding: '6px 12px', fontSize: 11 }}>Cancel</button>}
                  </div>
                </SectionCard>



                <div style={{ position: 'sticky', bottom: 12, zIndex: 20, display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderRadius: 14, background: 'rgba(18,18,22,0.92)', border: '1px solid #2a2a30', boxShadow: '0 8px 28px rgba(0,0,0,0.35)' }}>
                  <button onClick={saveProduct} disabled={productActionLoading || imageUploadBusy} style={{ ...buttonPrimary, margin: 0, opacity: imageUploadBusy ? 0.6 : 1 }}>
                    {imageUploadBusy ? 'Uploading…' : productActionLoading ? 'Saving…' : 'Save Product'}
                  </button>
                  <button
                    onClick={() => {
                      if (productFormDirty && !confirm('Discard your unsaved changes to this product?')) return;
                      setShowProductForm(false);
                      resetProductForm();
                    }}
                    style={buttonGhost}
                  >
                    Cancel
                  </button>
                  <span style={{ fontSize: 10, color: '#666' }}>
                    {imageUploadBusy
                      ? '⏳ Upload in progress — save is locked until files finish.'
                      : productFormDirty
                        ? '● You have unsaved changes in this product.'
                        : 'No unsaved changes.'}
                  </span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {allProducts.length === 0 && !productsLoading && (
                <EmptyState
                  icon="📦"
                  title="No products yet"
                  hint="Click “Seed Defaults” to load the demo catalog, or “Add Product” to build your own release from scratch."
                >
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button onClick={seedDefaultProducts} disabled={productActionLoading} style={{ ...buttonGhost, border: '1px solid #34d399', color: '#34d399' }}>
                      {productActionLoading ? 'Loading…' : 'Seed Defaults'}
                    </button>
                    <button onClick={() => { resetProductForm(); setShowProductForm(true); setEditingProduct(null); }} style={buttonPrimary}>
                      + Add Product
                    </button>
                  </div>
                </EmptyState>
              )}
              {allProducts.length > 0 && allProducts.map((product) => {
                const isPublished = product.isActive === true;
                const isActive = isPublished && !product.isArchived && !product.isUpcoming;
                const isArchived = product.isArchived;
                const isUpcoming = product.isUpcoming;
                const isHidden = !isPublished;
                return (
                  <div key={product.id} style={{ background: '#09090b', padding: 12, borderRadius: 8, border: `1px solid ${isActive ? '#1c1c1e' : isArchived ? '#5a3d1a' : isUpcoming ? '#1a3a5a' : '#2a1a1a'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{product.name}</div>
                        <div style={{ fontSize: 10, color: '#666' }}>
                          slug: {product.slug} · images: {product.images?.length || 0}
                          {isPublished && <Pill color="#d4d4d8" background="rgba(212,212,216,0.12)">Published</Pill>}
                          {isActive && <Pill color="#34d399" background="rgba(52,211,153,0.14)">Active</Pill>}
                          {isArchived && <Pill color="#f59e0b" background="rgba(245,158,11,0.14)">Archived</Pill>}
                          {isUpcoming && <Pill color="#3b82f6" background="rgba(59,130,246,0.14)">Upcoming</Pill>}
                          {product.soldOutBehavior === 'archive_after_delay' && <Pill color="#d6c29c" background="rgba(214,194,156,0.14)">Delayed archive</Pill>}
                          {isHidden && <Pill color="#f87171" background="rgba(248,113,113,0.14)">Hidden</Pill>}
                          {(() => {
                            const cats = Array.isArray(product.priceCategories) ? product.priceCategories : [];
                            if (cats.length === 0) return null;
                            const productMode = String(product.checkoutMode || '').toUpperCase() === 'FCFS' || product.isRaffle === false ? 'FCFS' : 'RAFFLE';
                            const effective = cats.map((c: any) => {
                              const m = String(c?.checkoutMode || '').toUpperCase();
                              return (m === 'RAFFLE' || m === 'FCFS') ? m : productMode;
                            });
                            const hasR = effective.includes('RAFFLE');
                            const hasF = effective.includes('FCFS');
                            if (hasR && hasF) return <Pill color="#c084fc" background="rgba(168,85,247,0.16)">MIXED</Pill>;
                            return <Pill color={hasR ? '#fbbf24' : '#93c5fd'} background={hasR ? 'rgba(245,158,11,0.14)' : 'rgba(59,130,246,0.14)'}>{hasR ? 'RAFFLE' : 'FCFS'}</Pill>;
                          })()}
                          <span style={{ color: '#888', marginLeft: 8 }}>Order: {product.sortOrder || 0}</span>
                        </div>
                        {product.priceCategories && (
                          <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>
                            Sizes: {product.priceCategories.map((c: any) => `${c.size} ($${c.price})`).join(' · ')}
                          </div>
                        )}
                        {visibleProductCategories(product.categories, catalogSettings.categories).length > 0 && (
                          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {visibleProductCategories(product.categories, catalogSettings.categories).map((c: string) => (
                              <span key={c} style={{ fontSize: 8.5, color: '#7dd3fc', background: 'rgba(125,211,252,0.12)', borderRadius: 999, padding: '1px 8px' }}>{c}</span>
                            ))}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: '#7c8596', marginTop: 4 }}>
                          Inventory: {(() => {
                            const per = product.inventoryPerSize && typeof product.inventoryPerSize === 'object' ? product.inventoryPerSize : {};
                            const perSum = Object.keys(per).reduce((s, k) => s + (Number(per[k]) > 0 ? Number(per[k]) : 0), 0);
                            const total = perSum > 0 ? perSum : (Number(product.totalInventory) || 0);
                            return total;
                          })()}{(() => {
                            const per = product.inventoryPerSize && typeof product.inventoryPerSize === 'object' ? product.inventoryPerSize : {};
                            const keys = Object.keys(per).filter((k) => Number(per[k]) > 0);
                            return keys.length > 0 ? ` · ${keys.map((k) => `${k}: ${per[k]}`).join(' · ')}` : '';
                          })()}
                        </div>
                        {(product.goLiveAt || product.releaseEndsAt) && (
                          <div style={{ fontSize: 9, color: '#7c8596', marginTop: 4 }}>
                            {product.goLiveAt ? `Live at ${product.goLiveAt}` : ''}{product.goLiveAt && product.releaseEndsAt ? ' · ' : ''}{product.releaseEndsAt ? `Ends ${product.releaseEndsAt}` : ''}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button onClick={() => editProduct(product)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>Edit</button>
                        <button onClick={() => { const newOrder = prompt('New sort order (lower = first):', String(product.sortOrder || 0)); if (newOrder !== null) reorderProducts(product.id, Number(newOrder)); }} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>Reorder</button>
                        <button onClick={() => toggleActive(product.id, isPublished)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isPublished ? '#f87171' : '#34d399', color: isPublished ? '#f87171' : '#34d399' }}>
                          {isPublished ? 'Unpublish' : 'Publish'}
                        </button>
                        <button onClick={() => toggleArchive(product.id, isArchived)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isArchived ? '#34d399' : '#f59e0b', color: isArchived ? '#34d399' : '#f59e0b' }}>
                          {isArchived ? 'Unarchive' : 'Archive'}
                        </button>
                        <button onClick={() => toggleUpcoming(product.id, isUpcoming)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isUpcoming ? '#34d399' : '#3b82f6', color: isUpcoming ? '#34d399' : '#3b82f6' }}>
                          {isUpcoming ? 'Remove Upcoming' : 'Upcoming'}
                        </button>
                        <button onClick={() => duplicateProduct(product)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>⧉ Duplicate</button>
                        <button onClick={() => deleteProduct(product.id)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>Delete</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ============ USERS (unchanged) ============ */}
        {tab === 'users' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>User Accounts</h2>
              <button onClick={() => { setShowUserForm(true); setEditingUser(null); setUserForm({ email: '', password: '', role: 'customer', rewards: 0 }); }} style={buttonPrimary}>
                + Add User
              </button>
            </div>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Manage user accounts. Users can log in to track entries, manage payment methods, and earn rewards.
            </p>
            
            {userMsg && (
              <p style={{ fontSize: 12, color: userMsg.includes('Error') ? '#f87171' : '#34d399', marginBottom: 10 }}>{userMsg}</p>
            )}

            {showUserForm && (
              <div style={{ background: '#09090b', padding: 16, borderRadius: 12, marginBottom: 16 }}>
                <h4 style={{ margin: '0 0 8px', fontSize: 12, color: '#aaa' }}>{editingUser ? 'Edit User' : 'New User'}</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input type="email" placeholder="Email *" value={userForm.email} onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))} style={inputStyle} />
                  <input type="password" placeholder="Password (leave blank to keep current)" value={userForm.password} onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))} style={inputStyle} />
                  <select value={userForm.role} onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))} style={inputStyle}>
                    <option value="customer">Customer</option>
                    <option value="admin">Admin</option>
                  </select>
                  <input type="number" placeholder="Rewards Points" value={userForm.rewards} onChange={(e) => setUserForm((f) => ({ ...f, rewards: Number(e.target.value) }))} style={inputStyle} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={saveUser} disabled={productActionLoading} style={buttonPrimary}>{productActionLoading ? 'Saving…' : 'Save User'}</button>
                  <button onClick={() => { setShowUserForm(false); setEditingUser(null); }} style={buttonGhost}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.length === 0 && !usersLoading && (
                <EmptyState
                  icon="👤"
                  title="No customer accounts yet"
                  hint="Accounts are created automatically when someone signs up or enters a drop. You can also create one manually below."
                />
              )}
              {users.map((user) => (
                <div key={user.id} style={{ background: '#09090b', padding: 12, borderRadius: 8, border: '1px solid #1c1c1e' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{pii(user.email, 'email', streamerMode)}</div>
                      <div style={{ fontSize: 10, color: '#666' }}>
                        Role: {user.role} · Rewards: {user.rewards || 0}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => {
                        setEditingUser(user.id); setUserForm({ email: user.email, password: '', role: user.role, rewards: user.rewards || 0 }); setShowUserForm(true);
                      }} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>Edit</button>
                      <button onClick={() => deleteUser(user.id)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============ PROMOTIONS (unchanged) ============ */}
        {tab === 'promotions' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Promotions & Affiliate Codes</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Create promo codes with time limits, max uses, and special discounts for the first X winners.
              <strong style={{ color: '#ccc' }}> Codes now work on raffle entries too</strong> — a percentage discount is applied &quot;if selected&quot; when the draw charges a winner, and direct purchases get the discount immediately at checkout. Set <code style={{ color: '#7dd3fc' }}>eligibleProductSlugs</code>/<code style={{ color: '#7dd3fc' }}>eligibleSizes</code> to restrict, or leave empty to work on everything.
            </p>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <input placeholder="Code" value={promoForm.code} onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} style={inputStyle} />
              <input placeholder="Promoter Name" value={promoForm.promoterName} onChange={(e) => setPromoForm((f) => ({ ...f, promoterName: e.target.value }))} style={inputStyle} />
              <input placeholder="Promoter Email" value={promoForm.promoterEmail} onChange={(e) => setPromoForm((f) => ({ ...f, promoterEmail: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" max="50" placeholder="Customer Discount %" value={promoForm.customerDiscountPercent} onChange={(e) => setPromoForm((f) => ({ ...f, customerDiscountPercent: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" max="50" placeholder="Promoter Payout %" value={promoForm.promoterPayoutPercent} onChange={(e) => setPromoForm((f) => ({ ...f, promoterPayoutPercent: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" placeholder="Max uses per email (0=unlimited)" value={promoForm.maxUsesPerEmail} onChange={(e) => setPromoForm((f) => ({ ...f, maxUsesPerEmail: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" placeholder="Total max uses (0=unlimited)" value={promoForm.maxUsesTotal} onChange={(e) => setPromoForm((f) => ({ ...f, maxUsesTotal: e.target.value }))} style={inputStyle} />
            </div>
            
            <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={promoForm.timeLimited} onChange={(e) => setPromoForm((f) => ({ ...f, timeLimited: e.target.checked }))} />
                Time Limited
              </label>
              {promoForm.timeLimited && (
                <>
                  <label style={{ fontSize: 11 }}>Start Date
                    <input type="datetime-local" value={promoForm.startAt} onChange={(e) => setPromoForm((f) => ({ ...f, startAt: e.target.value }))} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 11 }}>End Date
                    <input type="datetime-local" value={promoForm.endAt} onChange={(e) => setPromoForm((f) => ({ ...f, endAt: e.target.value }))} style={inputStyle} />
                  </label>
                </>
              )}
            </div>
            
            <button onClick={savePromo} style={buttonPrimary}>{promoForm.code && promos.some((p) => p.code === promoForm.code) ? 'Update Promo' : 'Create Promo'}</button>
            {promoMsg && <p style={{ fontSize: 12, color: '#34d399' }}>{promoMsg}</p>}

            <div style={{ marginTop: 16 }}>
              {promos.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No promo codes yet.</p>}
              {promos.map((p) => (
                <div key={p.code} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 700 }}>{p.code} {!p.active && <span style={{ color: '#f87171' }}>(disabled)</span>}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => {
                        setPromoForm({
                        code: p.code, promoterName: p.promoterName, promoterEmail: p.promoterEmail,
                        customerDiscountPercent: String(p.customerDiscountPercent || ''), 
                        promoterPayoutPercent: String(p.promoterPayoutPercent || ''), 
                        maxUsesPerEmail: String(p.maxUsesPerEmail ?? ''),
                        timeLimited: p.timeLimited || false,
                        startAt: p.startAt || '',
                        endAt: p.endAt || '',
                        maxUsesTotal: String(p.maxUsesTotal || ''),
                      });}} style={buttonGhost}>Edit</button>
                      <button onClick={() => deletePromo(p.code)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>Delete</button>
                    </div>
                  </div>
                  <div style={{ color: '#888', fontSize: 10 }}>
                    Uses: {p.uses || 0} · Revenue: ${Number(p.revenueAttributed || 0).toFixed(2)}
                    {p.timeLimited && p.startAt && p.endAt && ` · Valid: ${new Date(p.startAt).toLocaleDateString()} - ${new Date(p.endAt).toLocaleDateString()}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============ CATALOG (unchanged) ============ */}
        {tab === 'catalog' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Catalog Management</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Manage the &quot;Upcoming Releases&quot; and &quot;Past Archives&quot; sections shown on the catalog page.
              These appear in addition to products pulled from Redis.
            </p>

            {catalogLoading && <p style={{ color: '#888' }}>Loading…</p>}
            {catalogMsg && <p style={{ fontSize: 12, color: catalogMsg.includes('Error') ? '#f87171' : '#34d399', marginBottom: 10 }}>{catalogMsg}</p>}

            <h4 style={{ fontSize: 11, color: '#aaa', marginTop: 12 }}>📅 Upcoming Drops</h4>
            <p style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
              These appear in the &quot;Upcoming Releases&quot; grid on the catalog page. Fill in name, ETA, and image URL.
            </p>
            <div style={{ marginBottom: 12 }}>
              {catalogUpcoming.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', background: '#09090b', padding: 6, borderRadius: 6, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={item.name || ''}
                    placeholder="Name *"
                    onChange={(e) => {
                      const newList = [...catalogUpcoming];
                      newList[idx] = { ...newList[idx], name: e.target.value };
                      setCatalogUpcoming(newList);
                    }}
                    style={{ ...inputStyle, flex: 1, minWidth: 100, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.eta || ''}
                    placeholder="ETA (e.g. 'Summer 2026')"
                    onChange={(e) => {
                      const newList = [...catalogUpcoming];
                      newList[idx] = { ...newList[idx], eta: e.target.value };
                      setCatalogUpcoming(newList);
                    }}
                    style={{ ...inputStyle, width: 120, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.image || ''}
                    placeholder="Image URL"
                    onChange={(e) => {
                      const newList = [...catalogUpcoming];
                      newList[idx] = { ...newList[idx], image: e.target.value };
                      setCatalogUpcoming(newList);
                    }}
                    style={{ ...inputStyle, width: 150, padding: 4, fontSize: 11 }}
                  />
                  <button
                    onClick={() => setCatalogUpcoming(catalogUpcoming.filter((_, i) => i !== idx))}
                    style={{ ...buttonGhost, padding: '2px 6px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => setCatalogUpcoming([...catalogUpcoming, { name: '', status: 'Upcoming', eta: '', image: '' }])}
                style={{ ...buttonGhost, padding: '4px 10px', fontSize: 11 }}
              >
                + Add Upcoming
              </button>
            </div>

            <h4 style={{ fontSize: 11, color: '#aaa', marginTop: 12 }}>📦 Past Archives</h4>
            <p style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
              These appear in the &quot;Past Archives&quot; grid. Provide name, image, and a short description.
            </p>
            <div style={{ marginBottom: 12 }}>
              {catalogArchive.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', background: '#09090b', padding: 6, borderRadius: 6, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={item.name || ''}
                    placeholder="Name *"
                    onChange={(e) => {
                      const newList = [...catalogArchive];
                      newList[idx] = { ...newList[idx], name: e.target.value };
                      setCatalogArchive(newList);
                    }}
                    style={{ ...inputStyle, flex: 1, minWidth: 100, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.image || ''}
                    placeholder="Image URL"
                    onChange={(e) => {
                      const newList = [...catalogArchive];
                      newList[idx] = { ...newList[idx], image: e.target.value };
                      setCatalogArchive(newList);
                    }}
                    style={{ ...inputStyle, width: 120, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.description || ''}
                    placeholder="Short description"
                    onChange={(e) => {
                      const newList = [...catalogArchive];
                      newList[idx] = { ...newList[idx], description: e.target.value };
                      setCatalogArchive(newList);
                    }}
                    style={{ ...inputStyle, width: 180, padding: 4, fontSize: 11 }}
                  />
                  <button
                    onClick={() => setCatalogArchive(catalogArchive.filter((_, i) => i !== idx))}
                    style={{ ...buttonGhost, padding: '2px 6px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => setCatalogArchive([...catalogArchive, { name: '', status: 'Archived', image: '', description: '' }])}
                style={{ ...buttonGhost, padding: '4px 10px', fontSize: 11 }}
              >
                + Add Archive
              </button>
            </div>

            <button onClick={saveCatalogSettings} disabled={catalogLoading} style={buttonPrimary}>
              {catalogLoading ? 'Saving…' : 'Save Catalog Settings'}
            </button>
          </div>
        )}

        {/* ============ GROWTH (unchanged) ============ */}
        {tab === 'growth' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Growth & Analytics</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Track affiliate payouts and promoter performance.
            </p>
            {promos.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No promoter data yet.</p>}
            {promos.map((p) => (
              <div key={p.code} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 700 }}>{p.code} - {p.promoterName}</div>
                <div style={{ color: '#888' }}>
                  Revenue: ${Number(p.revenueAttributed || 0).toFixed(2)} · Owed: ${((p.payoutOwedCents || 0) / 100).toFixed(2)}
                </div>
                {p.payoutOwedCents > 0 && (
                  <button onClick={async () => {
                    if (!requireUnlocked()) return;
                    await adminFetch('/api/admin/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, action: 'markPaid', code: p.code }) });
                    await fetchPromos();
                  }} style={{ fontSize: 11, color: '#34d399', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    Mark ${((p.payoutOwedCents || 0) / 100).toFixed(2)} as paid
                  </button>
                )}
              </div>
            ))}

            <div style={{ marginTop: 18, borderTop: '1px solid #27272a', paddingTop: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase' }}>Release Alert List</h3>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Capture private-release emails from the storefront and notify the list from here when a product goes live.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <select value={selectedAlertProductId} onChange={(e) => setSelectedAlertProductId(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 180 }}>
                  <option value="">Choose a product to notify</option>
                  {allProducts.map((product) => (
                    <option key={product.id} value={product.id}>{product.name}</option>
                  ))}
                </select>
                <button onClick={notifyReleaseList} style={buttonPrimary}>Notify Release List</button>
                <button onClick={fetchAlerts} style={buttonGhost}>{alertsLoading ? 'Loading…' : 'Refresh'}</button>
              </div>
              {alertsMsg && <p style={{ fontSize: 12, color: alertsMsg.includes('Failed') ? '#f87171' : '#34d399', marginBottom: 10 }}>{alertsMsg}</p>}
              {alerts.length === 0 && !alertsLoading && <p style={{ color: '#555', fontSize: 12 }}>No subscribers yet.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
                {alerts.map((subscriber) => (
                  <div key={subscriber.email} style={{ background: '#09090b', padding: 12, borderRadius: 10, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{pii(subscriber.email, 'email', streamerMode)}</div>
                        <div style={{ color: '#888', fontSize: 10, marginTop: 2 }}>
                          Sources: {(subscriber.sources || []).join(', ') || 'site'} · joined {subscriber.createdAt ? new Date(subscriber.createdAt).toLocaleDateString() : 'n/a'}
                        </div>
                      </div>
                      <button onClick={() => removeAlertSubscriber(subscriber.email)} style={{ ...buttonGhost, color: '#f87171', borderColor: '#f87171' }}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ============ SYSTEM (unchanged) ============ */}
        {tab === 'system' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Site Self-Test</h2>
                <button onClick={runSelftest} disabled={selftestRunning} style={buttonPrimary}>
                  {selftestRunning ? 'Running…' : 'Run All Checks'}
                </button>
              </div>
              <p style={{ fontSize: 11, color: '#888', marginTop: 4, marginBottom: 12 }}>
                Checks every environment variable (including the Mapbox token), Redis/Stripe connectivity, store config + theme integrity, every product&apos;s price/Stripe ID/images, slug uniqueness, winner tiers, inventory, live states, drop pools, and legacy-key hygiene — run this after any config change or before a big drop.
              </p>
              {selftestResults?.error && <p style={{ color: '#f87171', fontSize: 12 }}>{selftestResults.error}</p>}
              {selftestResults?.results && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: selftestResults.allPassed ? '#34d399' : '#f87171' }}>
                    {selftestResults.summary} {selftestResults.allPassed ? '✓' : '— fix the items below'}
                  </div>
                  <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                    {selftestResults.results.map((r: any, i: number) => (
                      <div key={i} style={{
                        display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px',
                        background: r.pass ? 'transparent' : 'rgba(248,113,113,0.08)', borderRadius: 8, marginBottom: 2,
                      }}>
                        <span style={{ color: r.pass ? '#34d399' : '#f87171', fontSize: 13, marginTop: 1 }}>{r.pass ? '✓' : '✗'}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{r.name}</div>
                          <div style={{ fontSize: 11, color: '#888' }}>{r.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Admin Action Audit Log</h2>
                <button onClick={fetchAudit} style={buttonGhost}>Refresh</button>
              </div>
              <p style={{ fontSize: 11, color: '#888', marginTop: 4, marginBottom: 12 }}>
                Tracks admin actions like cancelling entries, updating shipping, and archiving products. Only shows actions performed from this admin portal.
              </p>
              <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 10 }}>
                {audit.length === 0 && <p style={{ fontSize: 11, color: '#888' }}>No audit entries yet. Actions like cancelling entries, updating shipping, or archiving products will appear here.</p>}
                {audit.map((a, i) => (
                  <div key={i} style={{ marginBottom: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid #1c1c1e', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: '#888' }}>{formatAuditTime(a.at)}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 999, ...auditActorStyle(a.actor) }}>
                        {String(a.actor || 'admin')}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#e4e4e7' }}>{a.action}</span>
                    </div>
                    {a.detail ? <div style={{ fontSize: 10, color: '#888', marginTop: 2, lineHeight: 1.5 }}>{redactDetail(a.detail, streamerMode)}</div> : null}
                  </div>
                ))}
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 6px', fontSize: 13, textTransform: 'uppercase' }}>Tidy Redis Schema</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 10 }}>
                Migrates any legacy key names (drop_pool:*, intent_pool:*, session:*, live_state, stats:*, etc.) into the tidy <code>domain:subdomain:</code> schema from lib/redis-keys.ts, then removes redundant mirror keys and runs a maintenance sweep (converts the unbounded legacy <code>entries:processed</code> / <code>entries:email_sent</code> sets into bounded timestamp-scored zsets, and prunes per-product state that outlived a deleted product or user). It is lossless (data is renamed, never dropped) and safe to re-run anytime — run it a few times a year to keep the key space small. See AGENTS.md for the key map.
              </p>
              <button onClick={organizeRedis} style={buttonGhost}>Tidy &amp; Migrate Redis Schema</button>
              {organizeMsg && <p style={{ fontSize: 11, color: organizeMsg.includes('Failed') ? '#f87171' : '#34d399', marginTop: 10 }}>{organizeMsg}</p>}
            </div>

            <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.35)' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: 13, textTransform: 'uppercase', color: '#f87171' }}>Wipe &amp; Rebuild Redis</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 10 }}>
                <strong style={{ color: '#f87171' }}>DESTRUCTIVE.</strong> Deletes <em>every key</em> in this Redis database — products, config, entries, ledger, promos, users, sessions, analytics, everything. Use it to reset a demo store or hand a clean slate to a new buyer. Requires the admin password <em>and</em> typing <strong>WIPE</strong> to confirm (two-step verification). Streamer mode must be OFF.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input type="text" value={wipeConfirm} onChange={(e) => setWipeConfirm(e.target.value)} placeholder="Type WIPE to confirm"
                  style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
                <label style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={wipeRebuild} onChange={(e) => setWipeRebuild(e.target.checked)} />
                  Rebuild with Seed Defaults after wipe
                </label>
                <button onClick={runWipe} disabled={wipeBusy}
                  style={{ ...buttonPrimary, background: '#ef4444', color: '#fff' }}>
                  {wipeBusy ? 'Wiping…' : 'Wipe Redis'}
                </button>
              </div>
              {wipeMsg && <p style={{ fontSize: 11, color: wipeMsg.includes('Failed') || wipeMsg.includes('Type') ? '#f87171' : '#34d399', marginTop: 10 }}>{wipeMsg}</p>}
            </div>
          </div>
        )}

        {/* ============ SETUP (env vars / production checklist) ============ */}
        {tab === 'setup' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Environment Variables</h2>
                <button onClick={fetchEnvStatus} disabled={envStatusLoading} style={buttonGhost}>
                  {envStatusLoading ? 'Checking…' : 'Refresh'}
                </button>
              </div>
              <p style={{ fontSize: 11, color: '#888', marginTop: 4, marginBottom: 12 }}>
                Shows whether each variable is configured in this deployment. <strong>Values are never shown</strong> — only ✓ set / ✗ missing. Secrets (Redis token, Stripe keys, cron secret, Resend key) must be set in your platform (Vercel) Environment Variables; they are write-only and can never be read back.
              </p>
              {envStatus && (
                <div style={{ fontSize: 12, marginBottom: 12 }}>
                  Environment: <strong>{envStatus.environment}</strong> · Configured <strong>{envStatus.summary.configured}/{envStatus.summary.total}</strong>
                  {envStatus.summary.requiredMissing.length > 0 ? (
                    <span style={{ color: '#f87171' }}> · Missing required: {envStatus.summary.requiredMissing.join(', ')}</span>
                  ) : (
                    <span style={{ color: '#34d399' }}> · All required variables present ✓</span>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(envStatus?.items || []).map((item: any, index: number) => (
                  <div key={item.key || index} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid #1c1c1e' }}>
                    <span style={{ fontSize: 13, marginTop: 1, color: item.set ? '#34d399' : '#f87171' }}>{item.set ? '✓' : '✗'}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>
                        {item.label}
                        {item.required ? <span style={{ marginLeft: 6, fontSize: 9, color: '#f87171' }}>REQUIRED</span> : <span style={{ marginLeft: 6, fontSize: 9, color: '#888' }}>optional</span>}
                        {item.buildTime && <span style={{ marginLeft: 6, fontSize: 9, color: '#edb210' }}>build-time · redeploy to change</span>}
                        {item.sensitive && <span style={{ marginLeft: 6, fontSize: 9, color: '#edb210' }}>secret · write-only</span>}
                      </div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{item.hint}</div>
                      <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>Reads: {item.aliases.join(' → ')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 6px', fontSize: 13, textTransform: 'uppercase' }}>Production Launch Checklist</h2>
              <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.7 }}>
                <p style={{ margin: '6px 0' }}>1. Set the environment variables above in your platform (Vercel) for Production + Preview, then redeploy.</p>
                <p style={{ margin: '6px 0' }}>2. In <strong>/admin → Settings → Branding &amp; Share</strong>: set your brand name, logo, favicon colors, share card, and header mode.</p>
                <p style={{ margin: '6px 0' }}>3. In <strong>/admin → Settings → Legal &amp; Policies</strong>: replace the company name + support email and review Terms / Privacy / Shipping.</p>
                <p style={{ margin: '6px 0' }}>4. In <strong>/admin → Products</strong>: set real Stripe price IDs per size, real prices, inventory, and winner tiers. The seeded placeholder prices will refuse to charge until real IDs/prices are set.</p>
                <p style={{ margin: '6px 0' }}>5. Point your Stripe webhook at <code>https://YOUR_DOMAIN/api/stripe/webhook</code> and set <strong>STRIPE_WEBHOOK_SECRET</strong>.</p>
                <p style={{ margin: '6px 0' }}>6. Add <strong>NEXT_PUBLIC_MAPBOX_TOKEN</strong> (public pk.* token) and redeploy to turn on full-address autofill at checkout — the dropdown fills street, city, state, ZIP and country.</p>
                <p style={{ margin: '6px 0' }}>7. Run <strong>/admin → System → Site Self-Test</strong> before a drop. It verifies every env var, product price/Stripe ID, live state, and key-space hygiene.</p>
                <p style={{ margin: '6px 0' }}>8. This portal opens in <strong>Streamer Mode</strong> (customer data masked with fixed-length bullets — even character lengths stay hidden). It only masks display; every save, draw and edit keeps working, so you can run the whole store live on a stream. Toggle it ON before sharing your screen.</p>
              </div>
            </div>
          </div>
        )}

        {/* ============ SETTINGS (unchanged) ============ */}
        {tab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Site Settings</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Edit site appearance and content. Theme colors, card backgrounds/borders, radius, and text colors apply live to product pages and the cart (cached up to ~10s); static pages (home/catalog/legal) are baked at build time, so a redeploy may be needed for those to pick up color changes. Every section below has a <strong style={{ color: '#ccc' }}>live preview</strong> that updates as you type — nothing is published until you press Save All Settings.
              </p>

              {/* Quick-jump pills so the long settings form is easy to navigate. */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {SETTINGS_SECTIONS.map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    style={{ ...buttonGhost, padding: '5px 11px', fontSize: 10, borderRadius: 999 }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {settingsLoading && <p style={{ color: '#888', fontSize: 11 }}>Loading settings…</p>}

              {/* Sticky top save button — stays visible while scrolling the long settings form.
                  top: 92 keeps it BELOW the fixed storefront header (84px) instead of sliding
                  underneath it while you scroll. */}
              <div style={{ position: 'sticky', top: 92, zIndex: 5, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16, padding: '10px 14px', borderRadius: 14, background: 'rgba(18,18,22,0.9)', border: '1px solid #2a2a30', boxShadow: '0 8px 28px rgba(0,0,0,0.3)' }}>
                <button onClick={saveSettings} style={{ ...buttonPrimary, margin: 0 }} disabled={settingsLoading}>
                  {settingsLoading ? 'Saving…' : 'Save All Settings'}
                </button>
                {settingsDirty && (
                  <button onClick={discardSettings} style={buttonGhost} title="Revert every settings tab to the last saved state">
                    Discard changes
                  </button>
                )}
                <span style={{ fontSize: 11, color: '#888' }}>
                  {settingsDirty
                    ? <strong style={{ color: '#edb210' }}>● Unsaved changes</strong>
                    : 'Changes below publish to the live store immediately.'}
                </span>
                {settingsMsg && <span style={{ fontSize: 11, fontWeight: 700, color: settingsMsg.includes('Failed') ? '#f87171' : '#34d399' }}>{settingsMsg}</span>}
              </div>

              <h4 id="settings-presets" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Design Presets</h4>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 10 }}>
                One-click market skins for client onboarding. Applying a preset fills the theme colors, font, border treatment and glow below — then press <strong style={{ color: '#ccc' }}>Save Settings</strong>.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
                {THEME_PRESETS.map((preset) => {
                  const isActive = activePreset === preset.id;
                  return (
                    <div
                      key={preset.id}
                      onClick={() => applyThemePreset(preset.id)}
                      style={{
                        padding: 14,
                        borderRadius: 12,
                        background: '#111',
                        border: `1px solid ${isActive ? preset.accent : '#27272a'}`,
                        cursor: 'pointer',
                        boxShadow: isActive ? `0 0 0 1px ${preset.accent}, 0 14px 30px rgba(0,0,0,0.25)` : 'none',
                        transition: 'border-color 160ms ease',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                        <div style={{ flex: 1, height: 34, borderRadius: 8, background: preset.background, border: '1px solid rgba(255,255,255,0.14)' }} />
                        <div style={{ flex: 1, height: 34, borderRadius: 8, background: preset.container }} />
                        <div style={{ flex: 1, height: 34, borderRadius: 8, background: preset.accent }} />
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{preset.name}</div>
                      <div style={{ fontSize: 10, color: preset.accent, margin: '2px 0 6px', letterSpacing: 1, textTransform: 'uppercase' }}>
                        {preset.fontLabel} · {preset.radiusLabel}
                      </div>
                      <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0, lineHeight: 1.5 }}>{preset.tagline}</p>
                      <button
                        onClick={(e) => { e.stopPropagation(); applyThemePreset(preset.id); }}
                        style={{
                          ...buttonGhost,
                          marginTop: 10,
                          width: '100%',
                          borderColor: isActive ? preset.accent : '#27272a',
                          color: isActive ? preset.accent : '#ccc',
                          fontWeight: 700,
                        }}
                      >
                        {isActive ? '✓ Applied — save' : 'Apply preset'}
                      </button>
                    </div>
                  );
                })}
              </div>

              <h4 id="settings-theme" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Theme Colors</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(themeSettings)
                  .filter(([key]) => key !== 'fontFamily' && key !== 'borderRadius' && key !== 'chromeTransparency' && key !== 'surfaceTransparency' && key !== 'radiusStyle' && key !== 'cardShadow' && key !== 'backdropBlur' && key !== 'contentSpacing' && key !== 'headerBackground' && key !== 'headerText')
                  .map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {THEME_COLOR_LABELS[key] || key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="color" 
                      value={toHexColor(value)} 
                      onChange={(e) => setThemeSettings({ ...themeSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: 4, height: 40 }} />
                  </label>
                ))}
              </div>

              {/* Live preview: a mini storefront rendered from the CURRENT theme
                  state — top bar, hero line, and a card row all update instantly
                  as colors/radius/transparency change. */}
              {(() => {
                const pageBg = themeSettings.primaryBackground || '#f2f2f7';
                const cardBg = themeSettings.cardBackground || '#ffffff';
                const cardBorder = themeSettings.cardBorder || 'rgba(0,0,0,0.12)';
                const radius = Math.max(4, Number(themeSettings.borderRadius) || 18);
                const shadow = Number(themeSettings.cardShadow) || 12;
                const headerBase = String(themeSettings.headerBackground || themeSettings.cardBackground || '#ffffff').trim();
                const chromeAlpha = Math.max(0, Math.min(100, Number(themeSettings.chromeTransparency ?? 62) || 62));
                const headerBg = previewChromeBackground(headerBase, chromeAlpha, 'rgba(248,248,252,0.86)');
                const headerText = previewHeaderText(headerBase, themeSettings.headerText);
                const accent = themeSettings.accentBlue || '#0071e3';
                const textMain = themeSettings.textMain || '#1d1d1f';
                const textMuted = themeSettings.textMuted || '#52525a';
                const cardText = themeSettings.cardTextMain || '#1d1d1f';
                const cardMuted = themeSettings.cardTextMuted || '#52525a';
                const cta = themeSettings.checkoutCtaButton || '#0071e3';
                return (
                  <div style={{ margin: '4px 0 14px', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#8b8b94', padding: '10px 14px 0' }}>
                      ● Live preview — how the storefront looks with these settings
                    </div>
                    <div style={{ background: pageBg, padding: 12, marginTop: 8 }}>
                      {/* mini top bar (same chrome math as the real header) */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: Math.max(4, Math.round(radius * 0.6)), background: headerBg, border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 6px 18px rgba(0,0,0,0.08)' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: headerText, letterSpacing: '1px' }}>YOUR BRAND</span>
                        <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: headerText, opacity: 0.85 }}>ACCOUNT</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: headerText, opacity: 0.85 }}>BAG</span>
                      </div>
                      {/* mini hero */}
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 8, letterSpacing: 2, textTransform: 'uppercase', color: accent, fontWeight: 700 }}>CALIFORNIA USA</div>
                        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4, color: textMain, lineHeight: 1.2 }}>by our hands. to your hands.</div>
                        <div style={{ fontSize: 9, color: textMuted, marginTop: 4, lineHeight: 1.5 }}>homemade &amp; designed, with real ingredients, with real hands.</div>
                      </div>
                      {/* mini card row */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                        {[0, 1].map((i) => (
                          <div key={i} style={{ background: cardBg, border: `1px solid ${cardBorder}`, borderRadius: radius, padding: 10, boxShadow: `0 ${Math.round(shadow / 3)}px ${Math.max(10, shadow * 2)}px rgba(0,0,0,0.10)` }}>
                            <div style={{ height: 36, borderRadius: Math.max(4, Math.round(radius * 0.5)), background: 'linear-gradient(135deg, rgba(0,113,227,0.25), rgba(191,90,242,0.25))', marginBottom: 8 }} />
                            <div style={{ fontSize: 10, fontWeight: 700, color: cardText }}>Elysian White</div>
                            <div style={{ fontSize: 8, color: cardMuted, marginTop: 2 }}>$95 · RAFFLE</div>
                            <div style={{ marginTop: 6 }}>
                              <span style={{ background: cta, color: readableOn(cta), fontSize: 8, fontWeight: 700, padding: '4px 10px', borderRadius: 999 }}>Enter</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize: 8, color: textMuted, marginTop: 10, lineHeight: 1.6 }}>
                        Radius {radius}px · Page {pageBg} · Card {cardBg} · Chrome {chromeAlpha}% transparent · Shadow {shadow}/100
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 8px' }}>
                <h4 style={{ fontSize: 11, color: '#aaa', margin: 0, textTransform: 'uppercase' }}>Top bar</h4>
                <span style={{ fontSize: 10, color: '#888' }}>Give the top bar its own colors. Empty = auto-match the card surface.</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  {THEME_COLOR_LABELS.headerBackground}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="color"
                      value={toHexColor(themeSettings.headerBackground || themeSettings.cardBackground)}
                      onChange={(e) => setThemeSettings({ ...themeSettings, headerBackground: e.target.value })}
                      style={{ ...inputStyle, display: 'block', flex: 1, marginTop: 4, padding: 4, height: 40 }} />
                    <button
                      type="button"
                      onClick={() => setThemeSettings({ ...themeSettings, headerBackground: '' })}
                      style={{ ...buttonGhost, marginTop: 4, whiteSpace: 'nowrap' }}
                      title="Reset to auto (match card surface)"
                    >
                      Auto
                    </button>
                  </div>
                  <span style={{ fontSize: 10, color: '#888', display: 'block', marginTop: 2 }}>{themeSettings.headerBackground ? 'Custom top-bar color' : 'Auto — matches card surface'}</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  {THEME_COLOR_LABELS.headerText}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="color"
                      value={toHexColor(themeSettings.headerText || (themeSettings.headerBackground || themeSettings.cardBackground))}
                      onChange={(e) => setThemeSettings({ ...themeSettings, headerText: e.target.value })}
                      style={{ ...inputStyle, display: 'block', flex: 1, marginTop: 4, padding: 4, height: 40 }} />
                    <button
                      type="button"
                      onClick={() => setThemeSettings({ ...themeSettings, headerText: '' })}
                      style={{ ...buttonGhost, marginTop: 4, whiteSpace: 'nowrap' }}
                      title="Reset to auto (readable text picked from the background)"
                    >
                      Auto
                    </button>
                  </div>
                  <span style={{ fontSize: 10, color: '#888', display: 'block', marginTop: 2 }}>{themeSettings.headerText ? 'Custom text color' : 'Auto — readable on the top bar'}</span>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  Chrome opacity (header / footer / cart drawer)
                  <input
                    type="range"
                    min={40}
                    max={100}
                    value={Number(themeSettings.chromeTransparency ?? 70)}
                    onChange={(e) => setThemeSettings({ ...themeSettings, chromeTransparency: Number(e.target.value) })}
                    style={{ display: 'block', width: '100%', marginTop: 8 }} />
                  <span style={{ fontSize: 10, color: '#888' }}>{Number(themeSettings.chromeTransparency ?? 70)}% — lower = more frosted glass</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Surface opacity (cards on product / catalog pages)
                  <input
                    type="range"
                    min={40}
                    max={100}
                    value={Number(themeSettings.surfaceTransparency ?? 100)}
                    onChange={(e) => setThemeSettings({ ...themeSettings, surfaceTransparency: Number(e.target.value) })}
                    style={{ display: 'block', width: '100%', marginTop: 8 }} />
                  <span style={{ fontSize: 10, color: '#888' }}>{Number(themeSettings.surfaceTransparency ?? 100)}%</span>
                </label>
              </div>

              {/* Apple design language — precise squircles, tactile glass, soft depth. */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  Corner style (squircles)
                  <select
                    value={String(themeSettings.radiusStyle || 'squircle')}
                    onChange={(e) => setThemeSettings({ ...themeSettings, radiusStyle: e.target.value as 'squircle' | 'rounded' | 'sharp' })}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, height: 40 }}
                  >
                    <option value="squircle">Squircle (Apple continuous curve)</option>
                    <option value="rounded">Rounded</option>
                    <option value="sharp">Sharp (flat)</option>
                  </select>
                  <span style={{ fontSize: 10, color: '#888' }}>Refines the Border Radius (px) below.</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Page spacing (whitespace)
                  <select
                    value={String(themeSettings.contentSpacing || 'comfortable')}
                    onChange={(e) => setThemeSettings({ ...themeSettings, contentSpacing: e.target.value as 'compact' | 'comfortable' | 'spacious' })}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, height: 40 }}
                  >
                    <option value="compact">Compact</option>
                    <option value="comfortable">Comfortable (default)</option>
                    <option value="spacious">Spacious</option>
                  </select>
                  <span style={{ fontSize: 10, color: '#888' }}>&ldquo;Less is more&rdquo; — airy pages breathe.</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Card shadow intensity
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Number(themeSettings.cardShadow ?? 12)}
                    onChange={(e) => setThemeSettings({ ...themeSettings, cardShadow: Number(e.target.value) })}
                    style={{ display: 'block', width: '100%', marginTop: 8 }} />
                  <span style={{ fontSize: 10, color: '#888' }}>{Number(themeSettings.cardShadow ?? 12)} — 0 is flat, ~12 is Apple&apos;s soft depth</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Frosted-glass blur (header / drawer)
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Number(themeSettings.backdropBlur ?? 55)}
                    onChange={(e) => setThemeSettings({ ...themeSettings, backdropBlur: Number(e.target.value) })}
                    style={{ display: 'block', width: '100%', marginTop: 8 }} />
                  <span style={{ fontSize: 10, color: '#888' }}>{Number(themeSettings.backdropBlur ?? 55)} — 0 = solid chrome, 100 = heavy glass</span>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  Font Family
                  <select
                    value={FONT_OPTIONS.some((f) => f.value === String(themeSettings.fontFamily || '').trim()) ? String(themeSettings.fontFamily || '').trim() : '__custom__'}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v !== '__custom__') setThemeSettings({ ...themeSettings, fontFamily: v });
                    }}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, height: 40 }}
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>
                    ))}
                    <option value="__custom__">Custom font stack…</option>
                  </select>
                  {!FONT_OPTIONS.some((f) => f.value === String(themeSettings.fontFamily || '').trim()) && (
                    <input
                      type="text"
                      value={String(themeSettings.fontFamily || '')}
                      onChange={(e) => setThemeSettings({ ...themeSettings, fontFamily: e.target.value })}
                      placeholder="e.g. Georgia, serif"
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                    />
                  )}
                  <span style={{ fontSize: 10, color: '#888' }}>Each option is previewed in its own typeface.</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Border Radius (px)
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={Number(themeSettings.borderRadius ?? 12)}
                    onChange={(e) => {
                      let v = Number(e.target.value);
                      if (Number.isNaN(v)) v = 1;
                      v = Math.max(1, Math.min(999, v));
                      setThemeSettings({ ...themeSettings, borderRadius: v });
                    }}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                  />
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    {[1, 2, 4, 6, 8, 12, 16, 24, 999].map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setThemeSettings({ ...themeSettings, borderRadius: r })}
                        style={{
                          ...buttonGhost,
                          padding: '3px 8px',
                          fontSize: 10,
                          borderRadius: 6,
                          borderColor: Number(themeSettings.borderRadius ?? 12) === r ? '#7dd3fc' : '#27272a',
                          color: Number(themeSettings.borderRadius ?? 12) === r ? '#7dd3fc' : '#aaa',
                        }}
                      >
                        {r === 999 ? 'Full' : `${r}px`}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 10, color: '#888' }}>Minimum 1px — square (0px) is no longer offered because it clips card content.</span>
                </label>
              </div>

              <h4 id="settings-hero" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Hero Content</h4>
              <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>
                The intro section on the home page (the brand / location block). Every line is editable.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {([
                  ['eyebrow', 'Eyebrow (rendered after the brand name)'],
                  ['headline', 'Headline'],
                  ['body', 'Body copy'],
                  ['ctaLabel', 'Primary button label'],
                  ['storyHeadline', 'Story link label'],
                  ['storyBody', 'Story footer line'],
                ] as const).map(([key, label]) => {
                  // Longer prose fields are textareas so buyers can add real
                  // line breaks (the storefront renders them with pre-line).
                  const isMultiLine = key === 'headline' || key === 'body' || key === 'eyebrow' || key === 'storyBody';
                  return (
                    <label key={key} style={{ fontSize: 11 }}>
                      {label}
                      {isMultiLine ? (
                        <textarea
                          rows={3}
                          value={String(heroSettings[key] ?? '')}
                          onChange={(e) => setHeroSettings({ ...heroSettings, [key]: e.target.value })}
                          placeholder={isMultiLine ? 'You can press Enter for a line break' : undefined}
                          style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, resize: 'vertical' }}
                        />
                      ) : (
                        <input
                          type="text"
                          value={String(heroSettings[key] ?? '')}
                          onChange={(e) => setHeroSettings({ ...heroSettings, [key]: e.target.value })}
                          style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                        />
                      )}
                    </label>
                  );
                })}
              </div>

              {/* Show / hide each hero element on the home page — text items can
                  be enabled/disabled per block (default ALL on). */}
              <div style={{ marginBottom: 10, padding: 10, borderRadius: 10, background: '#0b0b0d', border: '1px solid #1f2937' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 6 }}>
                  Show / hide hero elements
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {([
                    ['showEyebrow', 'Eyebrow line'],
                    ['showHeadline', 'Headline'],
                    ['showBody', 'Body copy'],
                    ['showCta', 'Primary button'],
                    ['showStory', 'Story link'],
                  ] as const).map(([key, label]) => (
                    <label key={key} style={{ fontSize: 10.5, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={heroSettings[key] !== false} onChange={(e) => setHeroSettings({ ...heroSettings, [key]: e.target.checked })} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Live preview: the home hero block rendered from the CURRENT copy
                  + theme — line breaks (pre-line) included, brand name + accent
                  colors live. */}
              {(() => {
                const pageBg = themeSettings.primaryBackground || '#f2f2f7';
                const textMain = themeSettings.textMain || '#1d1d1f';
                const textMuted = themeSettings.textMuted || '#52525a';
                const accent = themeSettings.accentBlue || '#0071e3';
                const cta = themeSettings.checkoutCtaButton || '#0071e3';
                const brand = String(brandingSettings.brandName || '').trim() || 'YOUR BRAND';
                const brandFont = String(brandingSettings.brandFontFamily || '').trim() || undefined;
                return (
                  <div style={{ margin: '4px 0 14px', borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#8b8b94', padding: '10px 14px 0' }}>
                      ● Live hero preview — home page top block
                    </div>
                    <div style={{ background: pageBg, padding: 20, marginTop: 8 }}>
                      <div style={{ fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase', color: accent, fontWeight: 700 }}>
                        {(heroSettings.eyebrow || 'CALIFORNIA USA').toUpperCase()}
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8, whiteSpace: 'pre-line', color: textMain, fontFamily: brandFont || 'Georgia, Times New Roman, serif', lineHeight: 1.2 }}>
                        {heroSettings.headline || 'by our hands. to your hands.'}
                      </div>
                      <div style={{ fontSize: 12, color: textMuted, marginTop: 10, whiteSpace: 'pre-line', lineHeight: 1.6, maxWidth: 460 }}>
                        {heroSettings.body || 'homemade & designed, with real ingredients, with real hands. for real people.'}
                      </div>
                      <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{
                          background: cta, color: readableOn(cta),
                          padding: '10px 20px', borderRadius: 999, fontSize: 12, fontWeight: 700,
                        }}>
                          {heroSettings.ctaLabel || 'Browse drops'}
                        </span>
                        <span style={{ fontSize: 12, color: textMuted, textDecoration: 'underline', textUnderlineOffset: 3 }}>
                          {heroSettings.storyHeadline || 'Our Story'}
                        </span>
                      </div>
                      <div style={{ fontSize: 8, color: textMuted, opacity: 0.8, marginTop: 12 }}>
                        Brand name on this page: “{brand}” · rendered on page background {pageBg}
                      </div>
                    </div>
                  </div>
                );
              })()}

              <h4 id="settings-behavior" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Behavior</h4>
              <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>
                How the storefront behaves when a visitor opens or refreshes a page. Changes apply on the next storefront load.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={behaviorSettings.scrollToTopOnLoad !== false} onChange={(e) => setBehaviorSettings({ scrollToTopOnLoad: e.target.checked })} />
                Start at the top when the page opens
              </label>

              <h4 id="settings-form" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Registration Form</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(formSettings).map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {COPY_FIELD_LABELS[key] || key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="text" 
                      value={value} 
                      placeholder={COPY_FIELD_PLACEHOLDERS[key] || 'Leave empty to keep the default'}
                      onChange={(e) => setFormSettings({ ...formSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                ))}
              </div>

              {/* Live preview: the entry form the customer sees on a product page,
                  built from the CURRENT form copy + theme. */}
              {(() => {
                const cardBg = themeSettings.cardBackground || '#ffffff';
                const cardText = themeSettings.cardTextMain || '#1d1d1f';
                const cardMuted = themeSettings.cardTextMuted || '#52525a';
                const radius = Math.max(4, Number(themeSettings.borderRadius) || 18);
                const cta = themeSettings.checkoutCtaButton || '#0071e3';
                const title = String(formSettings.titleHeader || '').trim() || 'Join The Allocation Draw';
                const emailPh = String(formSettings.emailPlaceholder || '').trim() || 'name@domain.com';
                const addressPh = String(formSettings.addressPlaceholder || '').trim() || '123 Luxury Dr, New York, NY';
                const button = String(formSettings.submitButtonText || '').trim() || '🏆 Secure Entry Allocation Ticket';
                const fine = 'By entering you agree to the terms.';
                return (
                  <div style={{ margin: '4px 0 14px', borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#8b8b94', padding: '10px 14px 0' }}>
                      ● Live preview — the entry form customers see
                    </div>
                    <div style={{ padding: 16, marginTop: 8 }}>
                      <div style={{ background: cardBg, border: '1px solid rgba(0,0,0,0.12)', borderRadius: radius, padding: 16, boxShadow: '0 12px 30px rgba(0,0,0,0.12)', maxWidth: 420 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: cardText }}>{title}</div>
                        <div style={{ fontSize: 9, color: cardMuted, marginTop: 10 }}>{String(formSettings.emailLabel || '').trim() || 'Contact Email Address'}</div>
                        <div style={{ marginTop: 3, padding: '8px 10px', borderRadius: 8, background: '#f5f5f7', border: '1px solid rgba(0,0,0,0.14)', color: '#8e8e93', fontSize: 11 }}>{emailPh}</div>
                        <div style={{ fontSize: 9, color: cardMuted, marginTop: 10 }}>{String(formSettings.addressLabel || '').trim() || 'Full Shipping Destination'}</div>
                        <div style={{ marginTop: 3, padding: '8px 10px', borderRadius: 8, background: '#f5f5f7', border: '1px solid rgba(0,0,0,0.14)', color: '#8e8e93', fontSize: 11 }}>{addressPh}</div>
                        <div style={{ marginTop: 12 }}>
                          <span style={{ background: cta, color: readableOn(cta), display: 'inline-block', padding: '10px 16px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{button}</span>
                        </div>
                        {fine && <div style={{ fontSize: 8, color: cardMuted, marginTop: 10, lineHeight: 1.5 }}>{fine}</div>}
                      </div>
                    </div>
                  </div>
                );
              })()}

              <h4 id="settings-footer" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Footer</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(footerSettings).filter(([key]) => key !== 'showTagline').map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {COPY_FIELD_LABELS[key] || key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="text" 
                      value={String(value ?? '')} 
                      placeholder={COPY_FIELD_PLACEHOLDERS[key] || 'Leave empty to keep the default'}
                      onChange={(e) => setFooterSettings({ ...footerSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                ))}
              </div>
              <label style={{ fontSize: 10.5, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 10 }}>
                <input type="checkbox" checked={footerSettings.showTagline !== false} onChange={(e) => setFooterSettings({ ...footerSettings, showTagline: e.target.checked })} />
                <span>Show the footer tagline line</span>
              </label>

              <h4 id="settings-copy" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>
                <button
                  onClick={() => setCopyOpen((v) => !v)}
                  style={{ background: 'none', border: 'none', color: '#aaa', fontSize: 11, textTransform: 'uppercase', padding: 0, cursor: 'pointer', fontWeight: 700 }}
                >
                  {copyOpen ? '▾' : '▸'} Storefront copy
                </button>
              </h4>
              {copyOpen && (
                <>
                  <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>
                    Override storefront text globally. Leave a field empty to keep the built-in default. These persist under settings.copy so future storefront wiring is trivial.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                    {([
                      ['heroTitle', 'Hero title (overrides the Hero Content headline)'],
                      ['heroSubtitle', 'Hero subtitle (overrides the Hero Content body)'],
                      ['entryCta', '"Enter allocation" button label'],
                      ['cartTitle', 'Cart drawer title ("Review items")'],
                      ['footerTagline', 'Footer tagline'],
                      ['supportEmail', 'Support email (footer link)'],
                      ['priorityDropsTitle', 'Home "Priority drops" section title'],
                      ['priorityDropsSubtitle', 'Home drops subtitle (default "Explore our creations")'],
                      ['urgencyInStock', 'Product page — normal-stock urgency line (default "Handmade allocation. Low supply by design.")'],
                      ['urgencySoldOut', 'Product page — sold-out urgency line (default "This release is fully spoken for.")'],
                      ['statusLive', 'Product page — status story for live releases (default "Reserved for collectors moving early, before the allocation tightens further.")'],
                      ['statusArchived', 'Product page — status story for archived releases (default "Archive placement preserves the release as proof of demand and collectability.")'],
                      ['mixedFormatRibbon', 'Product page — mixed-format ribbon (only when sizes mix raffle + instant-buy). Template with {raffle} and {fcfs} = size counts; default "This release mixes formats — {raffle} raffle size(s) and {fcfs} instant-buy size(s). Pick a size above to see its option."'],
                    ] as [string, string][]).map(([key, label]) => {
                      // Prose fields are textareas so line breaks can be typed;
                      // the storefront renders them with white-space: pre-line.
                      const isMultiLine = key === 'heroTitle' || key === 'heroSubtitle' || key === 'priorityDropsSubtitle' || key === 'footerTagline' || key === 'urgencyInStock' || key === 'urgencySoldOut' || key === 'statusLive' || key === 'statusArchived' || key === 'mixedFormatRibbon';
                      return (
                        <label key={key} style={{ fontSize: 11 }}>
                          {label}
                          {isMultiLine ? (
                            <textarea
                              rows={3}
                              value={String(copySettings[key as keyof typeof copySettings] || '')}
                              onChange={(e) => setCopySettings((prev) => ({ ...prev, [key]: e.target.value }))}
                              placeholder="Leave empty to use default"
                              style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, resize: 'vertical' }}
                            />
                          ) : (
                            <input
                              type="text"
                              value={String(copySettings[key as keyof typeof copySettings] || '')}
                              onChange={(e) => setCopySettings((prev) => ({ ...prev, [key]: e.target.value }))}
                              placeholder="Leave empty to use default"
                              style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                            />
                          )}
                        </label>
                      );
                    })}
                  </div>
                </>
              )}

              <h4 id="settings-catalog" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>
                <button
                  onClick={() => setCatalogOpen((v) => !v)}
                  style={{ background: 'none', border: 'none', color: '#aaa', fontSize: 11, textTransform: 'uppercase', padding: 0, cursor: 'pointer', fontWeight: 700 }}
                >
                  {catalogOpen ? '▾' : '▸'} Catalog (section order on /catalog)
                </button>
              </h4>
              {catalogOpen && (
                <>
                  <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px', lineHeight: 1.5 }}>
                    Choose the order the sections appear on the public /catalog page. Default keeps
                    &quot;Currently Available&quot; at the bottom so upcoming + past releases lead. Use the
                    up/down buttons to reorder, then Save All Settings.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {catalogSettings.sectionOrder.map((section, index) => {
                      const label = section === 'live' ? 'Currently Available' : section === 'upcoming' ? 'Upcoming Releases' : 'Past Archives';
                      return (
                        <div key={section} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#15151b', border: '1px solid #26262e' }}>
                          <span style={{ fontSize: 11, color: '#ddd', flex: 1, fontWeight: 700 }}>{index + 1}. {label}</span>
                          <button
                            onClick={() => setCatalogSettings((prev) => {
                              if (index === 0) return prev;
                              const next = [...prev.sectionOrder];
                              [next[index - 1], next[index]] = [next[index], next[index - 1]];
                              return { ...prev, sectionOrder: next };
                            })}
                            disabled={index === 0}
                            style={{ border: 'none', background: '#26262e', color: index === 0 ? '#555' : '#eee', borderRadius: 6, padding: '5px 10px', cursor: index === 0 ? 'not-allowed' : 'pointer', fontSize: 11 }}
                          >
                            ↑ Up
                          </button>
                          <button
                            onClick={() => setCatalogSettings((prev) => {
                              if (index === prev.sectionOrder.length - 1) return prev;
                              const next = [...prev.sectionOrder];
                              [next[index], next[index + 1]] = [next[index + 1], next[index]];
                              return { ...prev, sectionOrder: next };
                            })}
                            disabled={index === catalogSettings.sectionOrder.length - 1}
                            style={{ border: 'none', background: '#26262e', color: index === catalogSettings.sectionOrder.length - 1 ? '#555' : '#eee', borderRadius: 6, padding: '5px 10px', cursor: index === catalogSettings.sectionOrder.length - 1 ? 'not-allowed' : 'pointer', fontSize: 11 }}
                          >
                            ↓ Down
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Categories — the admin-managed product tag list. Createable /
                      deletable; products are tagged with any subset in the product
                      form, and the /catalog page shows a category filter. */}
                  <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: '#0b0b0d', border: '1px solid #1f2937' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                      Product categories
                    </div>
                    <p style={{ fontSize: 10, color: '#8b95a7', margin: '0 0 8px', lineHeight: 1.5 }}>
                      The categories buyers can tag products with — e.g. Perfume, Clothes, Shoes, Food, Tools, Tires, Pastries, Beanies, Winter, Summer, Men, Unisex, Women. Add or remove freely; customers filter the catalog by them. Products keep their tags even if a category is later deleted (the chip just stops being clickable).
                    </p>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                      <input
                        type="text"
                        value={categoryDraft}
                        onChange={(e) => setCategoryDraft(e.target.value)}
                        placeholder="New category (e.g. Accessories)"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCategory();
                          }
                        }}
                        style={{ ...inputStyle, flex: 1 }}
                      />
                      <button onClick={addCategory} style={{ ...buttonPrimary, padding: '8px 14px', fontSize: 11, margin: 0 }}>Add</button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(catalogSettings.categories || []).map((cat) => (
                        <span key={cat} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.35)', fontSize: 11, color: '#bfdbfe' }}>
                          {cat}
                          <button
                            onClick={() => removeCategory(cat)}
                            style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1 }}
                            title={`Delete "${cat}"`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      {(!catalogSettings.categories || catalogSettings.categories.length === 0) && (
                        <span style={{ fontSize: 10, color: '#666' }}>No categories yet — add the first one above.</span>
                      )}
                    </div>
                  </div>
                </>
              )}

              <h4 id="settings-checkout" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>
                <button
                  onClick={() => setCheckoutOpen((v) => !v)}
                  style={{ background: 'none', border: 'none', color: '#aaa', fontSize: 11, textTransform: 'uppercase', padding: 0, cursor: 'pointer', fontWeight: 700 }}
                >
                  {checkoutOpen ? '▾' : '▸'} Checkout & Orders
                </button>
              </h4>
              {checkoutOpen && (
                <>
                  <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px', lineHeight: 1.5 }}>
                    Entry/order reference codes and how strictly customer addresses are validated at checkout.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'start' }}>
                    <label style={{ fontSize: 11 }}>
                      Reference code prefix
                      <input
                        type="text"
                        value={refPrefix}
                        maxLength={4}
                        onChange={(e) => {
                          const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
                          setRefPrefix(raw || 'GU');
                        }}
                        placeholder="GU"
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                      />
                      <span style={{ fontSize: 10, color: '#8b95a7', display: 'block', marginTop: 4, lineHeight: 1.5 }}>
                        Every entry and order reference starts with this prefix (e.g. <code style={{ color: '#cbd5e1' }}>{refPrefix}-8F3K9Q2A</code>). Letters/numbers, up to 4 chars. Legacy <code style={{ color: '#cbd5e1' }}>GY-</code>/<code style={{ color: '#cbd5e1' }}>GOY-</code> refs are re-labelled to the new prefix automatically.
                      </span>
                    </label>
                    <div>
                      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <input
                          type="checkbox"
                          checked={checkoutSettings.requireAddressAutofill === true}
                          onChange={(e) => setCheckoutSettings((prev) => ({ ...prev, requireAddressAutofill: e.target.checked }))}
                        />
                        <span>Require full address dropdown at checkout</span>
                      </label>
                      <span style={{ fontSize: 10, color: '#8b95a7', display: 'block', lineHeight: 1.5 }}>
                        When ON, customers must pick the complete address from the Mapbox dropdown (a partial address can never be saved). Turn OFF to accept typed addresses. The admin portal always overrides this and can save any address.
                      </span>
                    </div>
                  </div>
                </>
              )}

              <h4 id="settings-legal" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>
                <button
                  onClick={() => setLegalOpen((v) => !v)}
                  style={{ background: 'none', border: 'none', color: '#aaa', fontSize: 11, textTransform: 'uppercase', padding: 0, cursor: 'pointer', fontWeight: 700 }}
                >
                  {legalOpen ? '▾' : '▸'} Legal & Policies (Terms / Privacy / Shipping)
                </button>
              </h4>
              {legalOpen && (
                <>
                  <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px', lineHeight: 1.5 }}>
                    The /terms, /privacy and /shipping pages are generated entirely from this content — no code changes needed when a buyer updates their policies. Format: lines starting with <code>## </code> become section headings, <code>- </code> becomes a bullet, and blank lines separate paragraphs. Use <code>{'{companyName}'}</code> and <code>{'{supportEmail}'}</code> tokens inside the text.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                    <label style={{ fontSize: 11 }}>
                      Company / legal entity name
                      <input
                        type="text"
                        value={legalSettings.companyName || ''}
                        onChange={(e) => setLegalSettings((prev) => ({ ...prev, companyName: e.target.value }))}
                        placeholder="Leave empty to use brand name"
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                      />
                    </label>
                    <label style={{ fontSize: 11 }}>
                      Support email (policy pages)
                      <input
                        type="email"
                        value={legalSettings.supportEmail || ''}
                        onChange={(e) => setLegalSettings((prev) => ({ ...prev, supportEmail: e.target.value }))}
                        placeholder="Leave empty to use footer support email"
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                      />
                    </label>
                  </div>
                  {([['terms', 'Terms of Service'], ['privacy', 'Privacy Policy'], ['shipping', 'Shipping & Sales Policy']] as [string, string][]).map(([key, label]) => (
                    <label key={key} style={{ fontSize: 11, display: 'block', marginBottom: 10 }}>
                      {label}
                      <textarea
                        rows={7}
                        value={String(legalSettings[key as keyof typeof legalSettings] || '')}
                        onChange={(e) => setLegalSettings((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder="## 1. Heading&#10;&#10;Paragraph text…"
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, resize: 'vertical' }}
                      />
                      <span style={{ fontSize: 10, color: '#666' }}>Leave empty to use the built-in default policy.</span>
                    </label>
                  ))}
                </>
              )}

              <h4 id="settings-branding" style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Branding & Share</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  Brand name (top bar / footer / emails)
                  <input
                    type="text"
                    value={brandingSettings.brandName || ''}
                    onChange={(e) => setBrandingSettings((prev) => ({ ...prev, brandName: e.target.value }))}
                    placeholder="Your Brand"
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                  />
                </label>
                <label style={{ fontSize: 11 }}>
                  Top bar shows
                  <select value={brandingSettings.headerMode || 'both'} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, headerMode: e.target.value }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}>
                    <option value="both">Logo + name</option>
                    <option value="logo">Logo only</option>
                    <option value="text">Name only</option>
                  </select>
                </label>
                <label style={{ fontSize: 11 }}>
                  Brand name size (px)
                  <input
                    type="number"
                    min={10}
                    max={40}
                    value={brandingSettings.brandFontSize ?? 14}
                    onChange={(e) => setBrandingSettings((prev) => ({ ...prev, brandFontSize: Math.max(10, Math.min(40, Number(e.target.value) || 14)) }))}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                  />
                  <span style={{ fontSize: 10, color: '#666' }}>14 default.</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Logo width (px)
                  <input type="number" min={16} max={160} value={brandingSettings.logoWidth || 28} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, logoWidth: Math.max(16, Number(e.target.value) || 28) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  <span style={{ fontSize: 10, color: '#666' }}>28 default · 44 default in logo-only mode.</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Logo height (px)
                  <input type="number" min={16} max={160} value={brandingSettings.logoHeight || 28} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, logoHeight: Math.max(16, Number(e.target.value) || 28) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                </label>
                <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={Boolean(brandingSettings.logoTransparent)} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, logoTransparent: e.target.checked }))} />
                  Transparent logo (keep corners, don&apos;t crop)
                </label>
                <label style={{ fontSize: 11 }}>
                  Top-bar name font (optional)
                  <input
                    type="text"
                    value={brandingSettings.brandFontFamily || ''}
                    onChange={(e) => setBrandingSettings((prev) => ({ ...prev, brandFontFamily: e.target.value }))}
                    placeholder="e.g. Georgia, serif (leave empty to inherit the site font)"
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                  />
                </label>
                <label style={{ fontSize: 11 }}>
                  Top-right action label
                  <select
                    value={brandingSettings.headerActionMode || 'cart'}
                    onChange={(e) => {
                      const next = e.target.value;
                      setBrandingSettings((prev) => ({ ...prev, headerActionMode: next }));
                      // Live-update the header preview (and the rest of the
                      // storefront in this browser) the instant the buyer
                      // toggles it — the header icon + wording switch before
                      // Save. SiteChrome listens for this event + storage key.
                      try { window.localStorage.setItem('goyunir-header-action-mode', next); } catch { /* noop */ }
                      window.dispatchEvent(new CustomEvent('goyunir-header-action-mode', { detail: { value: next } }));
                    }}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                  >
                    <option value="cart">Cart</option>
                    <option value="bag">Bag</option>
                  </select>
                  <span style={{ fontSize: 10, color: '#888', display: 'block', marginTop: 2 }}>
                    Changes the icon AND every word site-wide (top bar, drawer, product page, empty states). Updates live as you switch.
                  </span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Logo Upload or URL
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const dataUrl = await fileToDataURL(file);
                      setBrandingSettings((prev) => ({ ...prev, logoUrl: dataUrl }));
                    }}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: 6, height: 40 }}
                  />
                  <input
                    type="text"
                    value={brandingSettings.logoUrl || ''}
                    onChange={(e) => setBrandingSettings((prev) => ({ ...prev, logoUrl: e.target.value }))}
                    placeholder="Or paste a logo URL"
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                  />
                </label>
                {Object.entries({
                  shareTitle: brandingSettings.shareTitle,
                  shareDescription: brandingSettings.shareDescription,
                  shareTagline: brandingSettings.shareTagline,
                  shareUrl: brandingSettings.shareUrl,
                  shareImageUrl: brandingSettings.shareImageUrl,
                  shareBackground: brandingSettings.shareBackground,
                  shareAccent: brandingSettings.shareAccent,
                  shareText: brandingSettings.shareText,
                  iconBackground: brandingSettings.iconBackground,
                  iconText: brandingSettings.iconText,
                }).map(([key, value]) => {
                  const isColorField = key.includes('Background') || key.includes('Accent') || key.includes('Text');
                  const meta = SHARE_FIELD_META[key];
                  const label = meta?.label || key.replace(/([A-Z])/g, ' $1').trim();
                  const placeholder = meta?.placeholder || (isColorField ? 'Pick a color' : '');
                  const hint = meta?.hint || '';
                  return (
                    <label key={key} style={{ fontSize: 11 }}>
                      {label}
                      <input
                        type={isColorField ? 'color' : 'text'}
                        value={isColorField ? toHexColor(value) : String(value || '')}
                        onChange={(e) => setBrandingSettings((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder={placeholder}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: isColorField ? 4 : 10, height: isColorField ? 40 : undefined }}
                      />
                      {hint ? <span style={{ fontSize: 10, color: '#888', display: 'block', marginTop: 4, lineHeight: 1.5 }}>{hint}</span> : null}
                    </label>
                  );
                })}
              </div>

              {/* Card style — the share-card composition knobs. The preview below
                  updates live; the actual /og PNG re-renders after Save. */}
              <div style={{ marginBottom: 12, padding: 10, borderRadius: 10, background: '#0b0b0d', border: '1px solid #1f2937' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                  Share card style
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label style={{ fontSize: 11 }}>
                    Layout
                    <select value={brandingSettings.shareLayout || 'classic'} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, shareLayout: e.target.value }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}>
                      <option value="classic">Classic — brand row + big title</option>
                      <option value="split">Split — image left, text right</option>
                      <option value="minimal">Minimal — centered, no tagline/site</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Typeface
                    <select value={brandingSettings.shareFontFamily || 'system'} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, shareFontFamily: e.target.value }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}>
                      <option value="system">System UI</option>
                      <option value="serif">Serif (Georgia)</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Title size (px)
                    <input type="number" min={36} max={92} value={brandingSettings.shareTitleSize ?? 74} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, shareTitleSize: Math.max(36, Math.min(92, Number(e.target.value) || 74)) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Description size (px)
                    <input type="number" min={18} max={42} value={brandingSettings.shareDescriptionSize ?? 30} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, shareDescriptionSize: Math.max(18, Math.min(42, Number(e.target.value) || 30)) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Glow intensity (0–100)
                    <input type="range" min={0} max={100} value={brandingSettings.shareGlowIntensity ?? 40} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, shareGlowIntensity: Number(e.target.value) }))} style={{ display: 'block', width: '100%', marginTop: 4 }} />
                    <span style={{ fontSize: 10, color: '#666' }}>{brandingSettings.shareGlowIntensity ?? 40}/100 — accent glow behind the text.</span>
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Corner radius (px)
                    <input type="number" min={0} max={64} value={brandingSettings.shareCornerRadius ?? 0} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, shareCornerRadius: Math.max(0, Math.min(64, Number(e.target.value) || 0)) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Image darkness (0–100)
                    <input type="range" min={0} max={100} value={brandingSettings.shareImageOverlay ?? 60} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, shareImageOverlay: Number(e.target.value) }))} style={{ display: 'block', width: '100%', marginTop: 4 }} />
                    <span style={{ fontSize: 10, color: '#666' }}>{brandingSettings.shareImageOverlay ?? 60}/100 — darkens the share image for text contrast.</span>
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 14 }}>
                    {([
                      ['shareLogoVisible', 'Show logo'],
                      ['shareTaglineVisible', 'Show tagline'],
                      ['shareSiteVisible', 'Show site URL'],
                    ] as const).map(([key, label]) => (
                      <label key={key} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={brandingSettings[key] !== false} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, [key]: e.target.checked }))} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* Live preview: the top bar + footer rendered from the CURRENT
                  branding/footer state — updates as you type. */}
              <div style={{ margin: '4px 0 14px', borderRadius: 14, overflow: 'hidden', border: '1px solid #2a2a30' }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#888', padding: '10px 14px 0' }}>
                  ● Live preview — top bar & footer
                </div>
                {(() => {
                  const headerBase = String(themeSettings.headerBackground || themeSettings.cardBackground || '#ffffff').trim();
                  const chromeAlpha = Math.max(0, Math.min(100, Number(themeSettings.chromeTransparency ?? 94) || 94));
                  const headerBg = previewChromeBackground(headerBase, chromeAlpha, 'rgba(8,8,10,0.94)');
                  const headerText = previewHeaderText(headerBase, themeSettings.headerText);
                  const headerMode = String(brandingSettings.headerMode || 'both').toLowerCase();
                  const showBrandText = headerMode !== 'logo';
                  const showBrandLogo = headerMode !== 'text';
                  const logoW = Number(brandingSettings.logoWidth) > 0 ? Number(brandingSettings.logoWidth) : headerMode === 'logo' ? 44 : 28;
                  const logoH = Number(brandingSettings.logoHeight) > 0 ? Number(brandingSettings.logoHeight) : headerMode === 'logo' ? 44 : 28;
                  const action = String(brandingSettings.headerActionMode || 'cart').toLowerCase() === 'bag' ? 'Bag' : 'Cart';
                  const brandFont = String(brandingSettings.brandFontFamily || '').trim() || undefined;
                  const darkText = headerText === '#0a0a0c';
                  return (
                    <>
                    {/* Top bar — glass chrome, MORE pill, centered brand, account + bag/cart (same as SiteChrome) */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 10, padding: '12px 16px 14px', borderRadius: 12, background: headerBg, border: '1px solid rgba(255,255,255,0.08)', backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0) 38%)', position: 'relative', boxShadow: '0 8px 24px rgba(0,0,0,0.06)' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, justifyContent: 'flex-start' }}>
                        <span style={{ height: 42, padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 999, background: 'rgba(255,255,255,0.07)', border: `1px solid ${darkText ? 'rgba(10,10,12,0.18)' : 'rgba(255,255,255,0.12)'}`, color: headerText, fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>🔍 MORE</span>
                      </div>
                      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8, maxWidth: '38%', overflow: 'hidden' }}>
                        {showBrandLogo && brandingSettings.logoUrl ? (
                          <img src={brandingSettings.logoUrl} alt="logo" style={{ width: logoW, height: logoH, borderRadius: brandingSettings.logoTransparent ? 0 : 6, objectFit: brandingSettings.logoTransparent ? 'contain' : 'cover', display: 'block' }} />
                        ) : null}
                        {showBrandText ? (
                          <span style={{ fontFamily: brandFont, fontSize: `${Math.max(10, Math.min(40, Number(brandingSettings.brandFontSize) || 14))}px`, fontWeight: 800, letterSpacing: '3.5px', textTransform: 'uppercase', color: headerText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {brandingSettings.brandName || 'Your Brand'}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, justifyContent: 'flex-end' }}>
                        <span style={{ width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(255,255,255,0.07)', border: `1px solid ${darkText ? 'rgba(10,10,12,0.18)' : 'rgba(255,255,255,0.12)'}`, color: headerText, fontSize: 13 }}>👤</span>
                        <span style={{ width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(255,255,255,0.07)', border: `1px solid ${darkText ? 'rgba(10,10,12,0.18)' : 'rgba(255,255,255,0.12)'}`, color: headerText, fontSize: 13 }}>{action === 'Bag' ? '🛍️' : '🛒'}</span>
                      </div>
                    </div>
                    {/* Footer — same links/socials/tagline/copyright as the storefront */}
                    <div style={{ padding: '0 10px 10px' }}>
                      <div style={{ padding: '18px 14px 24px', borderRadius: 12, background: previewChromeBackground(String(themeSettings.primaryBackground || '#0e0e10'), Math.max(0, Math.min(100, Number(themeSettings.chromeTransparency ?? 94) || 94)), 'rgba(8,8,10,0.96)'), border: '1px solid rgba(255,255,255,0.06)', fontSize: 10, color: '#8b8b94', textAlign: 'center', lineHeight: 1.8 }}>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
                          {['Terms', 'Privacy', 'Shipping', 'Manage My Entry'].map((l) => (
                            <span key={l} style={{ color: '#9a9aa3' }}>{l}</span>
                          ))}
                        </div>
                        <div style={{ marginTop: 6, display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
                          {!String(footerSettings.instagramLink || '').trim() && !String(footerSettings.tiktokLink || '').trim() && !String(copySettings.supportEmail || footerSettings.supportEmail || '').trim() ? (
                            <span style={{ color: '#6b6b74' }}>no social links yet</span>
                          ) : (
                            <>
                              {String(footerSettings.instagramLink || '').trim() ? <span style={{ color: '#9a9aa3' }}>Instagram</span> : null}
                              {String(footerSettings.tiktokLink || '').trim() ? <span style={{ color: '#9a9aa3' }}>TikTok</span> : null}
                              {String(copySettings.supportEmail || footerSettings.supportEmail || '').trim() ? <span style={{ color: '#9a9aa3' }}>{String(copySettings.supportEmail || footerSettings.supportEmail || '')}</span> : null}
                            </>
                          )}
                        </div>
                        {String(copySettings.footerTagline || '').trim() ? (
                          <div style={{ marginTop: 6, color: '#9a9aa3', maxWidth: 420, marginLeft: 'auto', marginRight: 'auto', whiteSpace: 'pre-line' }}>{String(copySettings.footerTagline).trim()}</div>
                        ) : null}
                        <div style={{ marginTop: 6, color: '#6b6b74' }}>
                          © {new Date().getFullYear()} {String(footerSettings.corporateEntityCopyright || brandingSettings.brandName || brandingSettings.shareTitle || 'ALL RIGHTS RESERVED.')}
                        </div>
                      </div>
                    </div>
                    </>
                  );
                })()}
              </div>

              <LinkPreviewGallery branding={brandingSettings} themeColors={themeSettings} />

              <h4 id="settings-orbs" style={{ fontSize: 11, color: '#aaa', margin: '16px 0 4px', textTransform: 'uppercase' }}>Orb Glow</h4>
              <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>
                Animated glow orbs behind the storefront and inside the top bar. Saved changes apply on the next storefront load (public config is cached up to ~30s).
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={Boolean(orbSettings.enabled)} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, enabled: e.target.checked }))} />
                Enable glow orbs
              </label>

              {orbSettings.enabled && (
                <>
                  {(['primary', 'secondary', 'tertiary', 'fourth', 'fifth'] as const).map((key) => {
                    const orb = orbSettings[key] || {};
                    return (
                      <div key={key} style={{ border: `1px solid ${themeSettings.cardBorder || '#27272a'}`, borderRadius: 12, padding: 12, marginBottom: 10, background: 'rgba(255,255,255,0.02)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'capitalize' }}>{key} orb</div>
                          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <input type="checkbox" checked={Boolean(orb.enabled)} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], enabled: e.target.checked } }))} /> Enabled
                          </label>
                        </div>
                        {orb.enabled && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                            <label style={{ fontSize: 11 }}>
                              Color
                              <input type="color" value={toHexColor(orb.color, '#3b82f6')} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], color: e.target.value } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: 4, height: 40 }} />
                            </label>
                            <label style={{ fontSize: 11 }}>
                              Opacity
                              <input type="range" min={0} max={100} value={Number(orb.opacity) || 0} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], opacity: Number(e.target.value) } }))} style={{ display: 'block', width: '100%', marginTop: 10 }} />
                              <span style={{ fontSize: 10, color: '#888' }}>{Number(orb.opacity) || 0}%</span>
                            </label>
                            <label style={{ fontSize: 11 }}>
                              Size (vw)
                              <input type="number" min={10} max={120} value={Number(orb.size) || 40} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], size: Number(e.target.value) } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ border: `1px solid ${themeSettings.cardBorder || '#27272a'}`, borderRadius: 12, padding: 12, marginBottom: 10, background: 'rgba(255,255,255,0.02)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Motion</div>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
                      {([
                        ['idleEnabled', 'Idle drift'],
                        ['pointerEnabled', 'Follow cursor'],
                        ['scrollEnabled', 'Scroll reaction'],
                      ] as [string, string][]).map(([key, label]) => (
                        <label key={key} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="checkbox" checked={Boolean(orbSettings.motion?.[key])} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, motion: { ...prev.motion, [key]: e.target.checked } }))} />
                          {label}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      {([
                        ['intensity', 'Travel distance', 20, 200],
                        ['speed', 'Response speed', 30, 200],
                        ['momentum', 'Momentum / heaviness', 0, 100],
                      ] as [string, string, number, number][]).map(([key, label, min, max]) => (
                        <label key={key} style={{ fontSize: 11 }}>
                          {label}
                          <input type="range" min={min} max={max} value={Number(orbSettings.motion?.[key]) || 0} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, motion: { ...prev.motion, [key]: Number(e.target.value) } }))} style={{ display: 'block', width: '100%', marginTop: 8 }} />
                          <span style={{ fontSize: 10, color: '#888' }}>{Number(orbSettings.motion?.[key]) || 0}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <h4 id="settings-rewards" style={{ fontSize: 11, color: '#aaa', margin: '16px 0 8px', textTransform: 'uppercase' }}>Rewards &amp; Points</h4>
              <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>
                Customers earn points on every paid purchase and can redeem them for store credit. Welcome bonus and per-user balances stay editable in the Users tab.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
                <label style={{ fontSize: 11 }}>
                  Points earned per $1 spent
                  <input type="number" min={0} value={rewardsSettings.purchasePointsPerDollar} onChange={(e) => setRewardsSettings((prev) => ({ ...prev, purchasePointsPerDollar: Math.max(0, Number(e.target.value) || 0) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  <span style={{ fontSize: 10, color: '#666' }}>Default 10 = $1 purchase earns 10 pts.</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Points per $1 of credit when redeeming
                  <input type="number" min={1} value={rewardsSettings.pointsPerDollar} onChange={(e) => setRewardsSettings((prev) => ({ ...prev, pointsPerDollar: Math.max(1, Number(e.target.value) || 100) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  <span style={{ fontSize: 10, color: '#666' }}>Default 100 = 100 pts → $1 credit.</span>
                </label>
                {/* Smart math alert: the portal understands when the rewards
                    economy lets customers farm credit (earn ≥ redeem, gift ≥ face). */}
                {rewardsIssues.length > 0 && (
                  <div style={{ gridColumn: '1 / -1', marginTop: 8, padding: '9px 11px', borderRadius: 10, border: rewardsIssues.some((i) => i.severity === 'error') ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(245,158,11,0.35)', background: rewardsIssues.some((i) => i.severity === 'error') ? 'rgba(239,68,68,0.07)' : 'rgba(245,158,11,0.06)' }}>
                    {rewardsIssues.map((issue: SanityIssue, idx: number) => (
                      <div key={`${issue.code}-${idx}`} style={{ display: 'flex', gap: 7, fontSize: 10.5, lineHeight: 1.5, marginBottom: idx === rewardsIssues.length - 1 ? 0 : 5 }}>
                        <span style={{ color: issue.severity === 'error' ? '#f87171' : '#fbbf24' }}>{issue.severity === 'error' ? '✖' : '⚠'}</span>
                        <div>
                          <span style={{ color: issue.severity === 'error' ? '#fca5a5' : '#fde68a', fontWeight: 700 }}>{issue.message}</span>
                          {issue.detail && <div style={{ color: '#8b95a7' }}>{issue.detail}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <label style={{ fontSize: 11 }}>
                  Minimum points to redeem
                  <input type="number" min={1} value={rewardsSettings.minRedeemPoints} onChange={(e) => setRewardsSettings((prev) => ({ ...prev, minRedeemPoints: Math.max(1, Number(e.target.value) || 500) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                </label>
                <label style={{ fontSize: 11 }}>
                  Max points per redemption (0 = unlimited)
                  <input type="number" min={0} value={rewardsSettings.maxRedeemPoints} onChange={(e) => setRewardsSettings((prev) => ({ ...prev, maxRedeemPoints: Math.max(0, Number(e.target.value) || 0) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                </label>
                <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={Boolean(rewardsSettings.giftingEnabled)} onChange={(e) => setRewardsSettings((prev) => ({ ...prev, giftingEnabled: e.target.checked }))} />
                  Customers can gift/share their credits
                </label>
                <label style={{ fontSize: 11 }}>
                  Gift credit discount %
                  <input type="number" min={0} max={100} value={rewardsSettings.giftDiscountPercent ?? 10} onChange={(e) => setRewardsSettings((prev) => ({ ...prev, giftDiscountPercent: Math.max(0, Math.min(100, Number(e.target.value) || 10)) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  <span style={{ fontSize: 10, color: '#666' }}>Default 10 = a gifted credit is worth 10% less than face value.</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Redeem info message (shown under the redeem box in /account)
                  <textarea
                    rows={3}
                    value={String(rewardsSettings.redemptionInfoMessage || '')}
                    onChange={(e) => setRewardsSettings((prev) => ({ ...prev, redemptionInfoMessage: e.target.value }))}
                    placeholder="Every redemption issues a unique one-time promo code… (leave empty to use the built-in message that auto-includes the gift discount %)"
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, resize: 'vertical' }}
                  />
                  <span style={{ fontSize: 10, color: '#666' }}>Leave empty for the default copy. You can also use {`{giftPercent}`} to insert the gift-discount percentage.</span>
                </label>
              </div>

              <h4 id="settings-gallery" style={{ fontSize: 11, color: '#aaa', margin: '16px 0 8px', textTransform: 'uppercase' }}>Product Gallery</h4>
              <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>
                Product photos can auto-advance with a slow cinematic zoom (Ken Burns) — the way big fashion houses present a drop. Changes apply immediately to product pages.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
                <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={Boolean(gallerySettings.autoPlay)} onChange={(e) => setGallerySettings((prev) => ({ ...prev, autoPlay: e.target.checked }))} />
                  Auto-advance photos
                </label>
                <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={Boolean(gallerySettings.zoom)} onChange={(e) => setGallerySettings((prev) => ({ ...prev, zoom: e.target.checked }))} />
                  Slow zoom effect
                </label>
                <label style={{ fontSize: 11 }}>
                  Seconds per photo
                  <input type="number" min={2} max={30} value={gallerySettings.intervalSeconds} onChange={(e) => setGallerySettings((prev) => ({ ...prev, intervalSeconds: Math.max(2, Number(e.target.value) || 4) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                </label>
                <label style={{ fontSize: 11 }}>
                  Zoom duration (seconds)
                  <input type="number" min={4} max={60} value={gallerySettings.zoomDurationSeconds} onChange={(e) => setGallerySettings((prev) => ({ ...prev, zoomDurationSeconds: Math.max(4, Number(e.target.value) || 14) }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                </label>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={saveSettings} style={buttonPrimary} disabled={settingsLoading}>
                  {settingsLoading ? 'Saving…' : 'Save All Settings'}
                </button>
                {settingsDirty && (
                  <button onClick={discardSettings} style={buttonGhost}>Discard changes</button>
                )}
                {settingsDirty && <span style={{ fontSize: 10, color: '#edb210', fontWeight: 700 }}>● Unsaved changes</span>}
              </div>
              {settingsMsg && <p style={{ fontSize: 12, color: settingsMsg.includes('Failed') ? '#f87171' : '#34d399', marginTop: 10 }}>{settingsMsg}</p>}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}