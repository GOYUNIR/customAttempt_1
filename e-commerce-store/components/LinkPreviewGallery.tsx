'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ShareCard from '@/components/ShareCard';
import {
  cardSiteUrlDisplay,
  previewSiteUrl,
  resolveClientImageSource,
  safeCssColor,
} from '@/lib/share-card-config';

/**
 * /admin → Settings → Branding & Share → "Link preview" panel.
 *
 * Shows EXACTLY what the shared link will look like when pasted into WhatsApp,
 * iMessage, Discord, X/Twitter and Facebook — live from the CURRENT (possibly
 * unsaved) form state, so the buyer sees the real card before saving. Also
 * shows the actual generated PNG (`/og`) the apps fetch after save, the
 * copyable share link, and a short troubleshooting list.
 */

type GalleryProps = {
  branding: Record<string, any>;
  themeColors: Record<string, any>;
};

const DEFAULT_DESCRIPTION = 'Private releases, handled cleanly.';

function clampText(lineCount: number): CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lineCount,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
}

type CardData = {
  brandName: string;
  title: string;
  description: string;
  domain: string;
  accent: string;
};

/** Render the live ShareCard at a given display width (transform-scaled). */
function ScaledCard({
  data,
  logoUrl,
  shareImageUrl,
  background,
  accent,
  text,
  width,
}: {
  data: CardData;
  logoUrl: string;
  shareImageUrl: string;
  background: string;
  accent: string;
  text: string;
  width: number;
}) {
  const scale = width / 1200;
  return (
    <div style={{ width, height: Math.round(630 * scale), overflow: 'hidden', position: 'relative' }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: 1200, height: 630 }}>
        <ShareCard
          brandName={data.brandName}
          title={data.title}
          description={data.description}
          logoUrl={logoUrl}
          shareImageUrl={shareImageUrl}
          background={background}
          accent={accent}
          text={text}
          siteUrl={data.domain}
          preview
          scale={1}
        />
      </div>
    </div>
  );
}

export default function LinkPreviewGallery({ branding, themeColors }: GalleryProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [savedCardTs, setSavedCardTs] = useState<number>(() => Date.now());
  const [pngError, setPngError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const host = typeof window !== 'undefined' ? window.location.host : 'example.com';

  const brandName = String(branding.brandName || branding.shareTitle || 'Your Brand');
  const title = String(branding.shareTitle || brandName);
  const description = String(branding.shareDescription || DEFAULT_DESCRIPTION);
  const tagline = String(branding.shareTagline || '');
  const logoUrl = resolveClientImageSource(branding.logoUrl, origin);
  const shareImageUrl = resolveClientImageSource(branding.shareImageUrl, origin);
  const background = safeCssColor(branding.shareBackground || themeColors.primaryBackground, '#0B0B0F');
  const accent = safeCssColor(
    branding.shareAccent || themeColors.checkoutCtaButton || themeColors.accentBlue || themeColors.accentPurple,
    '#D4AF37',
  );
  const text = safeCssColor(branding.shareText || themeColors.textMain, '#F5F2E9');

  // Match the server card URL priority (env site URL → current host → admin
  // Branding → Share URL). When the buyer HAS configured a Share URL we prefer
  // it in the preview so the card shows the REAL production domain even while
  // editing on localhost; otherwise the current host is what production will use.
  const publicEnvUrl = String(
    (typeof process !== 'undefined' && (process.env.NEXT_PUBLIC_URL || process.env.NEXT_PUBLIC_SITE_URL)) || '',
  ).replace(/\/+$/, '');
  const displaySite = cardSiteUrlDisplay(publicEnvUrl || branding.shareUrl || host, host || 'example.com');
  const copyLink = previewSiteUrl(
    branding.shareUrl || publicEnvUrl || host,
    origin || `https://${host || 'example.com'}`,
  );

  const scale = containerWidth > 0 ? Math.min(1, containerWidth / 1200) : 0;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(copyLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable — nothing to do.
    }
  };

  const data: CardData = { brandName, title, description, domain: displaySite, accent };
  const cardProps = { data, logoUrl, shareImageUrl, background, accent, text };

  return (
    <div
      style={{
        border: `1px solid ${themeColors.cardBorder || '#27272a'}`,
        borderRadius: 14,
        padding: 14,
        margin: '0 0 10px',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Link preview / share card</div>
      <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px', lineHeight: 1.5 }}>
        This is exactly what people see when you paste your store link in a chat or social post. It updates live as you
        edit the fields above — press Save All Settings at the bottom to publish it.
      </p>


      {/* Share link row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <code
          style={{
            flex: 1,
            minWidth: 180,
            padding: '8px 10px',
            borderRadius: 8,
            background: '#09090b',
            border: `1px solid ${themeColors.cardBorder || '#27272a'}`,
            color: '#e4e4e7',
            fontSize: 12,
            wordBreak: 'break-all',
          }}
        >
          {copyLink}
        </code>
        <button
          onClick={copyToClipboard}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: 'none',
            background: copied ? '#22c55e' : accent,
            color: '#fff',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {copied ? 'Copied ✓' : 'Copy link'}
        </button>
      </div>

      {/* The actual generated 1200×630 card (live) */}
      <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: '#aaa', margin: '0 0 6px' }}>
        The generated card
      </div>
      <div ref={wrapRef} style={{ width: '100%', marginBottom: 14 }}>
        {scale > 0 ? (
          <div
            style={{ width: Math.round(1200 * scale), height: Math.round(630 * scale), overflow: 'hidden', position: 'relative' }}
          >
            <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: 1200, height: 630 }}>
              <ShareCard
                brandName={data.brandName}
                title={data.title}
                description={data.description}
                tagline={tagline}
                logoUrl={logoUrl}
                shareImageUrl={shareImageUrl}
                background={background}
                accent={accent}
                text={text}
                siteUrl={data.domain}
                preview
                scale={1}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* As-shared platform previews */}
      <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: '#aaa', margin: '0 0 6px' }}>
        As it appears when the link is shared
      </div>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, marginBottom: 14 }}>
        <WhatsAppEmbed {...cardProps} />
        <IMessageEmbed {...cardProps} />
        <DiscordEmbed {...cardProps} />
        <XEmbed {...cardProps} />
        <FacebookEmbed {...cardProps} />
      </div>


      {/* Actually generated PNG (from last SAVED settings) */}
      <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: '#aaa', margin: '0 0 6px' }}>
        Generated card the apps fetch (last saved)
      </div>
      <div style={{ border: `1px solid ${themeColors.cardBorder || '#27272a'}`, borderRadius: 12, overflow: 'hidden', marginBottom: 8 }}>
        {pngError ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: '#f87171' }}>
            /og did not return an image. Check the server logs, then refresh.
          </div>
        ) : (
          <img
            src={`/og?v=${savedCardTs}`}
            alt="Generated share card"
            style={{ display: 'block', width: '100%' }}
            onError={() => setPngError(true)}
          />
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button
          onClick={() => {
            setSavedCardTs(Date.now());
            setPngError(false);
          }}
          style={{
            padding: '7px 12px',
            borderRadius: 8,
            border: `1px solid ${themeColors.cardBorder || '#27272a'}`,
            background: '#111',
            color: '#e4e4e7',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Refresh generated card
        </button>
        <span style={{ fontSize: 10, color: '#666' }}>
          This PNG comes from the last Save All Settings, not the unsaved edits above. Save, then refresh.
        </span>
      </div>

      {/* Troubleshooting */}
      <div style={{ fontSize: 11, color: '#666', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 700, color: '#999', marginBottom: 2 }}>Preview not showing when you send a link?</div>
        <div>
          • WhatsApp / iMessage / Discord cache previews aggressively — after editing, send the link again (add ?v=1 if
          the old preview sticks) and wait a few minutes.
        </div>
        <div>• The store must be publicly reachable — a localhost or password-protected site cannot be crawled.</div>
        <div>• Test /og in a browser — it should load a 1200×630 PNG.</div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Platform embeds — client-only mockups of how each app renders the shared card
// ---------------------------------------------------------------------------

type EmbedProps = {
  data: CardData;
  logoUrl: string;
  shareImageUrl: string;
  background: string;
  accent: string;
  text: string;
};

function PlatformFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ flex: '0 0 auto', width: 320 }}>
      <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', color: '#888', marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function WhatsAppEmbed(props: EmbedProps) {
  const { data } = props;
  return (
    <PlatformFrame label="WhatsApp">
      <div style={{ background: '#0b141a', borderRadius: 14, padding: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 8px' }}>
          <div style={{ width: 28, height: 28, borderRadius: 999, background: data.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#fff' }}>
            {data.brandName.charAt(0).toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e9edef' }}>You</div>
            <div style={{ fontSize: 10, color: '#8696a0' }}>online</div>
          </div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 9, color: '#8696a0', marginBottom: 6 }}>Today</div>
        <div style={{ background: '#005c4b', borderRadius: 12, borderTopLeftRadius: 4, overflow: 'hidden' }}>
          <ScaledCard {...props} width={300} />
          <div style={{ padding: '8px 12px 6px' }}>
            <div style={{ fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#7ba78d' }}>{data.domain}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e9edef', margin: '2px 0' }}>{data.title}</div>
            <div style={{ fontSize: 11, color: '#b6c7bf', lineHeight: 1.4, ...clampText(2) }}>{data.description}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3, marginTop: 4 }}>
              <span style={{ fontSize: 9, color: '#7ba78d' }}>10:24</span>
              <span style={{ fontSize: 9, color: '#53bdeb', letterSpacing: 1 }}>✓✓</span>
            </div>
          </div>
        </div>
      </div>
    </PlatformFrame>
  );
}

function IMessageEmbed(props: EmbedProps) {
  const { data } = props;
  return (
    <PlatformFrame label="iMessage">
      <div style={{ background: '#f2f2f7', borderRadius: 14, padding: 8 }}>
        <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#1c1c1e', padding: '4px 0 8px' }}>
          Messages
        </div>
        <div style={{ background: 'linear-gradient(135deg, #0a84ff, #0077e6)', borderRadius: 18, borderTopLeftRadius: 6, overflow: 'hidden' }}>
          <ScaledCard {...props} width={290} />
          <div style={{ padding: '8px 12px 6px' }}>
            <div style={{ fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)' }}>{data.domain}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', margin: '2px 0' }}>{data.title}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.92)', lineHeight: 1.4, ...clampText(2) }}>{data.description}</div>
            <div style={{ textAlign: 'right', fontSize: 9, color: 'rgba(255,255,255,0.75)', marginTop: 4 }}>10:24</div>
          </div>
        </div>
      </div>
    </PlatformFrame>
  );
}


function DiscordEmbed(props: EmbedProps) {
  const { data } = props;
  return (
    <PlatformFrame label="Discord">
      <div style={{ background: '#313338', borderRadius: 14, padding: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 2px 8px' }}>
          <div style={{ width: 26, height: 26, borderRadius: 999, background: data.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#fff' }}>
            {data.brandName.charAt(0).toUpperCase()}
          </div>
          <div style={{ fontSize: 11, color: '#dbdee1', fontWeight: 700 }}>{data.brandName}</div>
          <span style={{ fontSize: 10, color: '#949ba4' }}>sent a link</span>
        </div>
        <div style={{ background: '#2b2d31', borderRadius: 4, borderLeft: `4px solid ${data.accent}`, padding: '10px 12px' }}>
          <div style={{ fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#949ba4' }}>{data.domain}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#00a8fc', margin: '2px 0' }}>{data.title}</div>
          <div style={{ fontSize: 11, color: '#dbdee1', lineHeight: 1.4, ...clampText(2) }}>{data.description}</div>
        </div>
        <div style={{ marginTop: 6, borderRadius: 4, overflow: 'hidden' }}>
          <ScaledCard {...props} width={300} />
        </div>
      </div>
    </PlatformFrame>
  );
}

function XEmbed(props: EmbedProps) {
  const { data } = props;
  return (
    <PlatformFrame label="X / Twitter">
      <div style={{ background: '#ffffff', borderRadius: 14, border: '1px solid #e1e8ed', overflow: 'hidden' }}>
        <ScaledCard {...props} width={318} />
        <div style={{ padding: '10px 12px 12px' }}>
          <div style={{ fontSize: 11, color: '#536471' }}>{data.domain}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0f1419', margin: '2px 0' }}>{data.title}</div>
          <div style={{ fontSize: 12, color: '#536471', lineHeight: 1.4, ...clampText(2) }}>{data.description}</div>
        </div>
      </div>
    </PlatformFrame>
  );
}

function FacebookEmbed(props: EmbedProps) {
  const { data } = props;
  return (
    <PlatformFrame label="Facebook">
      <div style={{ background: '#ffffff', borderRadius: 10, border: '1px solid #e4e6eb', overflow: 'hidden' }}>
        <ScaledCard {...props} width={318} />
        <div style={{ padding: '10px 12px 12px' }}>
          <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: '#606770' }}>{data.domain}</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1c1e21', margin: '2px 0' }}>{data.title}</div>
          <div style={{ fontSize: 12, color: '#65676b', lineHeight: 1.4, ...clampText(2) }}>{data.description}</div>
        </div>
      </div>
    </PlatformFrame>
  );
}

