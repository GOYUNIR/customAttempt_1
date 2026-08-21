-- =============================================================================
-- 00002_seed_demo_site.sql (optional)
-- Creates a published demo tenant (`demo.yourplatform.com`) owned by the
-- OLDEST existing profile so the Worker fast/slow paths are testable the
-- moment the schema is up. Safe to re-run (upserts).
--
-- Requires: 00001_initial_schema.sql AND at least one real user to exist
-- (the site FK points at profiles.id). If no profile exists yet, the site
-- insert simply matches zero rows and nothing is created — sign up first.
-- =============================================================================

-- ── demo site ────────────────────────────────────────────────────────────────
with demo_owner as (
  select id from public.profiles order by created_at asc limit 1
)
insert into public.sites (id, owner_id, subdomain, custom_domain, is_published)
select '00000000-0000-0000-0000-000000000001', id, 'demo', null, true
from demo_owner
on conflict (subdomain) do update set is_published = true;

-- ── demo site settings (theme + layout blocks) ───────────────────────────────
insert into public.site_settings (site_id, site_name, theme_config, layout_blocks)
values (
  '00000000-0000-0000-0000-000000000001',
  'Demo Store',
  '{
    "colors": {
      "background": "#f7f7f8",
      "surface": "#ffffff",
      "text": "#18181b",
      "mutedText": "#52525b",
      "primary": "#2563eb",
      "primaryText": "#ffffff",
      "border": "#e4e4e7"
    },
    "fonts": {
      "heading": "system-ui, -apple-system, sans-serif",
      "body": "system-ui, -apple-system, sans-serif"
    },
    "radiusPx": 16,
    "containerMaxWidthPx": 1120,
    "spacing": "comfortable"
  }'::jsonb,
  '[
    {
      "id": "nav-1", "type": "nav", "enabled": true,
      "props": {
        "links": [
          { "label": "Shop", "href": "/#shop" },
          { "label": "About", "href": "/#about" },
          { "label": "Contact", "href": "mailto:hello@example.com" }
        ],
        "align": "right"
      }
    },
    {
      "id": "hero-1", "type": "hero", "enabled": true,
      "props": {
        "headline": "Products, not pages.",
        "subheadline": "Every block on this page is rendered from JSON served by Cloudflare KV.",
        "ctaLabel": "Shop the drop",
        "ctaHref": "/#shop",
        "imageUrl": null,
        "align": "center"
      }
    },
    {
      "id": "products-1", "type": "products", "enabled": true,
      "props": {
        "title": "Featured releases",
        "limit": 8,
        "categories": ["New", "Classic"],
        "showPrices": true
      }
    },
    {
      "id": "text-1", "type": "text", "enabled": true,
      "props": {
        "title": "Built on Supabase + Workers + KV",
        "body": "Supabase is the source of truth. The Worker caches a compiled JSON snapshot per hostname for 24 hours and purges it the instant you hit Save.",
        "align": "center"
      }
    },
    {
      "id": "cta-1", "type": "cta", "enabled": true,
      "props": {
        "headline": "Want your own site?",
        "subheadline": "Claim a subdomain and start building in minutes.",
        "buttonLabel": "Get started",
        "buttonHref": "https://yourplatform.com/signup"
      }
    }
  ]'::jsonb
)
on conflict (site_id) do update set
  site_name     = excluded.site_name,
  theme_config  = excluded.theme_config,
  layout_blocks = excluded.layout_blocks;

-- ── demo products ────────────────────────────────────────────────────────────
insert into public.products (
  id, site_id, name, description, price, image_url, is_active, sort_order, tags
)
values
  (
    '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001',
    'Aurora Tee', 'Soft heavyweight cotton, boxy fit, printed in small batches.',
    45.00, 'https://picsum.photos/seed/aurora-tee/800/1000', true, 0,
    '{New,Classic}'
  ),
  (
    '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001',
    'Field Mug', 'Stoneware with a speckled glaze — holds exactly one proper coffee.',
    24.00, 'https://picsum.photos/seed/field-mug/800/1000', true, 1,
    '{Classic}'
  ),
  (
    '00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001',
    'Wayfarer Cap', 'Five-panel, washed cotton twill, adjustable brass buckle.',
    32.00, 'https://picsum.photos/seed/wayfarer-cap/800/1000', true, 2,
    '{New}'
  ),
  (
    '00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001',
    'North Candle', 'Cedar + vetiver. 40 hours of burn, poured in-house.',
    38.00, 'https://picsum.photos/seed/north-candle/800/1000', true, 3,
    '{Classic}'
  )
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  price       = excluded.price,
  image_url   = excluded.image_url,
  is_active   = excluded.is_active,
  sort_order  = excluded.sort_order,
  tags        = excluded.tags;
