/**
 * Strict, shared TypeScript contracts for the multi-tenant template platform.
 *
 * Every database row, theme token, layout block, product and cache payload is
 * explicitly typed here so the Cloudflare Worker, the Admin Portal and the
 * Supabase migrations can never drift. No `any` anywhere.
 */

// ── Database rows (map 1:1 to supabase/migrations/00001_initial_schema.sql) ──

/**
 * One row per authenticated user — tied 1:1 to Supabase Auth's auth.users.
 * NOTE: Row types are `type` aliases, NOT interfaces — supabase-js requires
 * rows to be assignable to `Record<string, unknown>`, and TS only gives object
 * type aliases an implicit index signature (interfaces never have one).
 */
export type Profile = {
  id: string;
  display_name: string | null;
  created_at: string;
};

/** A tenant site. `subdomain` (demo.yourplatform.com) or `custom_domain`. */
export type Site = {
  id: string;
  owner_id: string;
  subdomain: string;
  custom_domain: string | null;
  is_published: boolean;
  created_at: string;
  updated_at: string;
};

/** Layout + branding configuration for one tenant. One row per site. */
export type SiteSettings = {
  site_id: string;
  site_name: string;
  theme_config: ThemeConfig;
  layout_blocks: LayoutBlock[];
  updated_at: string;
};

/** Dynamic product catalog entry for a tenant site. */
export type Product = {
  id: string;
  site_id: string;
  name: string;
  description: string;
  /** Decimal currency amount (e.g. 45.00). PostgREST may return a string. */
  price: number;
  image_url: string | null;
  is_active: boolean;
  sort_order: number;
  /** Category tags used by the storefront filter chips. */
  tags: string[];
  created_at: string;
  updated_at: string;
};

// ── Theme configuration (site_settings.theme_config) ─────────────────────────

export interface ThemeColors {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  primary: string;
  primaryText: string;
  border: string;
}

export interface ThemeFonts {
  heading: string;
  body: string;
}

export type ThemeSpacing = 'compact' | 'comfortable' | 'spacious';

export interface ThemeConfig {
  colors: ThemeColors;
  fonts: ThemeFonts;
  radiusPx: number;
  containerMaxWidthPx: number;
  spacing: ThemeSpacing;
}

// ── Layout blocks (site_settings.layout_blocks) ─────────────────────────────

export interface BaseLayoutBlock {
  /** Stable id so the admin can reorder/update blocks. */
  id: string;
  /** `false` hides the block on the storefront without deleting it. */
  enabled: boolean;
}

export interface NavLink {
  label: string;
  href: string;
}

export interface HeroBlock extends BaseLayoutBlock {
  type: 'hero';
  props: HeroBlockProps;
}
export interface HeroBlockProps {
  headline: string;
  subheadline: string;
  ctaLabel: string;
  ctaHref: string;
  imageUrl: string | null;
  align: 'left' | 'center' | 'right';
}

export interface ProductsBlock extends BaseLayoutBlock {
  type: 'products';
  props: ProductsBlockProps;
}
export interface ProductsBlockProps {
  title: string;
  limit: number | null;
  /** Optional tags shown as filter chips (intersected with product.tags). */
  categories: string[];
  showPrices: boolean;
}

export interface TextBlock extends BaseLayoutBlock {
  type: 'text';
  props: TextBlockProps;
}
export interface TextBlockProps {
  title: string;
  body: string;
  align: 'left' | 'center' | 'right';
}

export interface ImageBlock extends BaseLayoutBlock {
  type: 'image';
  props: ImageBlockProps;
}
export interface ImageBlockProps {
  imageUrl: string;
  altText: string;
  caption: string | null;
  borderRadiusPx: number | null;
}

export interface CtaBlock extends BaseLayoutBlock {
  type: 'cta';
  props: CtaBlockProps;
}
export interface CtaBlockProps {
  headline: string;
  subheadline: string;
  buttonLabel: string;
  buttonHref: string;
}

export interface HtmlBlock extends BaseLayoutBlock {
  type: 'html';
  props: HtmlBlockProps;
}
export interface HtmlBlockProps {
  title: string;
  /** Raw, admin-supplied HTML — trust boundary (the admin owns their site). */
  html: string;
}

export interface NavBlock extends BaseLayoutBlock {
  type: 'nav';
  props: NavBlockProps;
}
export interface NavBlockProps {
  links: NavLink[];
  align: 'left' | 'center' | 'right';
}

export type LayoutBlock =
  | HeroBlock
  | ProductsBlock
  | TextBlock
  | ImageBlock
  | CtaBlock
  | HtmlBlock
  | NavBlock;

export type LayoutBlockType = LayoutBlock['type'];

// ── Compiled site payload (what Cloudflare KV caches per hostname) ───────────

export interface CompiledSite {
  /** Bump this when the cache envelope shape changes → stale keys self-invalidate. */
  cacheVersion: number;
  site: Site;
  settings: SiteSettings;
  products: Product[];
  compiledAt: string;
}

// ── Admin Portal drafts (what "Save/Publish" sends from the dashboard) ───────

export interface ProductDraft {
  name: string;
  description: string;
  price: number;
  imageUrl: string | null;
  isActive: boolean;
  tags: string[];
}

export interface PublishSiteInput {
  siteId: string;
  /** The tenant's subdomain (no domain suffix, e.g. "demo"). */
  subdomain: string;
  /** The tenant's custom domain (e.g. "shop.acme.com"), if any. */
  customDomain: string | null;
  siteName: string;
  themeConfig: ThemeConfig;
  layoutBlocks: LayoutBlock[];
  products: ProductDraft[];
  isPublished: boolean;
}

// ── Supabase typed client (`createClient<Database>`) ─────────────────────────

export interface ProfileRelationship {
  foreignKeyName: string;
  columns: ['id'];
  isOneToOne: true;
  referencedRelation: 'auth.users';
  referencedColumns: ['id'];
}
export interface SiteRelationship {
  foreignKeyName: string;
  columns: ['owner_id'];
  isOneToOne: false;
  referencedRelation: 'profiles';
  referencedColumns: ['id'];
}
export interface SiteSettingsRelationship {
  foreignKeyName: string;
  columns: ['site_id'];
  isOneToOne: true;
  referencedRelation: 'sites';
  referencedColumns: ['id'];
}
export interface ProductRelationship {
  foreignKeyName: string;
  columns: ['site_id'];
  isOneToOne: false;
  referencedRelation: 'sites';
  referencedColumns: ['id'];
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, 'created_at'> & { created_at?: string };
        Update: Partial<Profile>;
        Relationships: ProfileRelationship[];
      };
      sites: {
        Row: Site;
        Insert: Omit<Site, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string };
        Update: Partial<Site>;
        Relationships: SiteRelationship[];
      };
      site_settings: {
        Row: SiteSettings;
        Insert: Omit<SiteSettings, 'updated_at'> & { updated_at?: string };
        Update: Partial<SiteSettings>;
        Relationships: SiteSettingsRelationship[];
      };
      products: {
        Row: Product;
        Insert: Omit<Product, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Product>;
        Relationships: ProductRelationship[];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
