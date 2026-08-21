/**
 * Slow path: build the compiled per-tenant payload from Supabase.
 *
 * Uses `@supabase/supabase-js` (a fetch-based client that runs fine on
 * Cloudflare Workers with the `nodejs_compat` compatibility flag). The anon
 * key is used — RLS only lets through PUBLISHED sites and their rows.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  CompiledSite,
  Database,
  LayoutBlock,
  Product,
  SiteSettings,
  ThemeConfig,
  ThemeSpacing,
} from '../../shared/types.ts';
import type { ResolvedSite } from '../../shared/hostname.ts';
import type { Env } from './env';

export function createSupabaseClient(env: Env): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface SiteLookup {
  /** The KV siteKey (subdomain for platform hosts, hostname for custom domains). */
  siteKey: string;
  /** The full request hostname (also queried against custom_domain). */
  hostname: string;
}

export async function loadCompiledSite(
  client: SupabaseClient<Database>,
  lookup: ResolvedSite,
  cacheVersion: number,
): Promise<CompiledSite | null> {
  const { data: site, error } = await client
    .from('sites')
    .select('*')
    .eq('is_published', true)
    .or(`subdomain.eq.${lookup.siteKey},custom_domain.eq.${lookup.hostname}`)
    .maybeSingle();
  if (error) throw new Error(`sites query failed: ${error.message}`);
  if (!site) return null;

  const { data: settings, error: settingsError } = await client
    .from('site_settings')
    .select('*')
    .eq('site_id', site.id)
    .maybeSingle();
  if (settingsError) throw new Error(`site_settings query failed: ${settingsError.message}`);

  const { data: products, error: productsError } = await client
    .from('products')
    .select('*')
    .eq('site_id', site.id)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (productsError) throw new Error(`products query failed: ${productsError.message}`);

  return {
    cacheVersion,
    site,
    settings: normalizeSettings(settings),
    products: normalizeProducts(products),
    compiledAt: new Date().toISOString(),
  };
}


const DEFAULT_THEME: ThemeConfig = {
  colors: {
    background: '#f7f7f8',
    surface: '#ffffff',
    text: '#18181b',
    mutedText: '#52525b',
    primary: '#2563eb',
    primaryText: '#ffffff',
    border: '#e4e4e7',
  },
  fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' },
  radiusPx: 16,
  containerMaxWidthPx: 1120,
  spacing: 'comfortable',
};

const SPACINGS: ReadonlySet<string> = new Set(['compact', 'comfortable', 'spacious']);

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeTheme(input: unknown): ThemeConfig {
  if (typeof input !== 'object' || input === null) return DEFAULT_THEME;
  const theme = input as Record<string, unknown>;
  const colors = (typeof theme.colors === 'object' && theme.colors !== null ? theme.colors : {}) as Record<string, unknown>;
  const fonts = (typeof theme.fonts === 'object' && theme.fonts !== null ? theme.fonts : {}) as Record<string, unknown>;
  const spacing = SPACINGS.has(String(theme.spacing)) ? (String(theme.spacing) as ThemeSpacing) : DEFAULT_THEME.spacing;

  return {
    colors: {
      background: asString(colors.background, DEFAULT_THEME.colors.background),
      surface: asString(colors.surface, DEFAULT_THEME.colors.surface),
      text: asString(colors.text, DEFAULT_THEME.colors.text),
      mutedText: asString(colors.mutedText, DEFAULT_THEME.colors.mutedText),
      primary: asString(colors.primary, DEFAULT_THEME.colors.primary),
      primaryText: asString(colors.primaryText, DEFAULT_THEME.colors.primaryText),
      border: asString(colors.border, DEFAULT_THEME.colors.border),
    },
    fonts: {
      heading: asString(fonts.heading, DEFAULT_THEME.fonts.heading),
      body: asString(fonts.body, DEFAULT_THEME.fonts.body),
    },
    radiusPx: asNumber(theme.radiusPx, DEFAULT_THEME.radiusPx),
    containerMaxWidthPx: asNumber(theme.containerMaxWidthPx, DEFAULT_THEME.containerMaxWidthPx),
    spacing,
  };
}

const BLOCK_TYPES: ReadonlySet<string> = new Set(['hero', 'products', 'text', 'image', 'cta', 'html', 'nav']);

export function normalizeBlocks(input: unknown): LayoutBlock[] {
  if (!Array.isArray(input)) return [];
  const blocks: LayoutBlock[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    const type = block.type;
    if (typeof type !== 'string' || !BLOCK_TYPES.has(type)) continue;
    const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : `block-${blocks.length + 1}`;
    const enabled = block.enabled !== false;
    const props = typeof block.props === 'object' && block.props !== null ? block.props : {};
    // The Admin Portal (our writer) is the only producer of these shapes, so a
    // lightweight structural check above is the right trust boundary here.
    blocks.push({ id, type, enabled, props } as LayoutBlock);
  }
  return blocks;
}

export function normalizeProducts(input: unknown): Product[] {
  if (!Array.isArray(input)) return [];
  const products: Product[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.site_id !== 'string') continue;
    products.push({
      id: p.id as string,
      site_id: p.site_id as string,
      name: asString(p.name, 'Untitled'),
      description: asString(p.description, ''),
      price: asNumber(p.price, 0),
      image_url: typeof p.image_url === 'string' ? (p.image_url as string) : null,
      is_active: p.is_active !== false,
      sort_order: asNumber(p.sort_order, 0),
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      created_at: asString(p.created_at, ''),
      updated_at: asString(p.updated_at, ''),
    });
  }
  return products.sort((a, b) => a.sort_order - b.sort_order);
}

export function normalizeSettings(input: SiteSettings | null): SiteSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    site_id: asString(raw.site_id, ''),
    site_name: asString(raw.site_name, 'My Store'),
    theme_config: normalizeTheme(raw.theme_config),
    layout_blocks: normalizeBlocks(raw.layout_blocks),
    updated_at: asString(raw.updated_at, ''),
  };
}

// ── Runtime normalizers (the DB defaults are `{}` / `[]`; never trust JSONB) ─
