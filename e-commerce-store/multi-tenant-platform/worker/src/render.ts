/**
 * Server-side rendering of the boilerplate HTML layout with the compiled
 * per-tenant payload injected.
 *
 * The page is fully data-driven: site name, theme tokens, nav links, every
 * section and every product come from the `CompiledSite` object (the KV-cached
 * JSON). A tiny inline script powers the product category filter chips.
 */
import type { CompiledSite, LayoutBlock, NavBlock, Product, ThemeConfig } from '../../shared/types.ts';

const SAFE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)$/;

function safeColor(value: string, fallback: string): string {
  const raw = value.trim();
  return SAFE_COLOR_RE.test(raw) ? raw : fallback;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function metaDescription(blocks: LayoutBlock[]): string {
  for (const block of blocks) {
    if (block.type === 'hero' && block.enabled !== false && block.props.subheadline.trim()) {
      return block.props.subheadline.trim().slice(0, 160);
    }
    if (block.type === 'text' && block.enabled !== false && block.props.body.trim()) {
      return block.props.body.trim().slice(0, 160);
    }
  }
  return 'A fully dynamic storefront built on Supabase + Cloudflare Workers.';
}

// ── stylesheet (theme tokens as CSS variables) ───────────────────────────────

const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--font-body);line-height:1.6;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{font-family:var(--font-heading);line-height:1.15;margin:0 0 .5em}
a{color:var(--primary);text-decoration:none}
img{max-width:100%;display:block}
.container{max-width:var(--maxw);margin:0 auto;padding:0 20px}
.site-header{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:60px}
.brand{font-family:var(--font-heading);font-weight:800;font-size:18px;color:var(--text)}
.nav{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.nav a{color:var(--muted);font-size:14px;font-weight:600}
.nav a:hover{color:var(--text)}
.hero{padding:88px 0 64px;text-align:center}
.hero h1{font-size:clamp(34px,6vw,58px);letter-spacing:-.02em}
.hero p{color:var(--muted);font-size:clamp(16px,2.2vw,20px);max-width:640px;margin:0 auto 28px}
.btn{display:inline-block;background:var(--primary);color:var(--primary-text);padding:12px 22px;border-radius:999px;font-weight:700;font-size:14px}
.section{padding:48px 0}
.section-title{font-size:clamp(22px,3vw,30px);margin-bottom:24px}
.text-block{max-width:720px;margin:0 auto}
.text-block p{color:var(--muted)}
.image-block img{border-radius:var(--radius)}
.image-block figcaption{color:var(--muted);font-size:13px;text-align:center;margin-top:8px}
.cta-block{text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);padding:56px 24px}
.cta-block p{color:var(--muted);margin:0 0 24px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.chip{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:999px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.chip.active{background:var(--primary);border-color:var(--primary);color:var(--primary-text)}
.product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px}
.product-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column}
.product-image{aspect-ratio:4/5;object-fit:cover;width:100%;background:var(--bg)}
.product-body{padding:14px 16px 18px;display:flex;flex-direction:column;gap:6px;flex:1}
.product-name{margin:0;font-size:16px}
.product-description{color:var(--muted);font-size:13px;margin:0;flex:1}
.product-price{font-weight:800;font-size:15px}
.site-footer{border-top:1px solid var(--border);margin-top:48px;padding:28px 0;color:var(--muted);font-size:13px}
.site-footer .container{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.html-block h2{margin-bottom:12px}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`.trim();

function buildCss(theme: ThemeConfig): string {
  const colors = theme.colors;
  const radius = Math.max(0, theme.radiusPx);
  const maxw = Math.max(320, theme.containerMaxWidthPx);
  return `:root{
--bg:${safeColor(colors.background, '#f7f7f8')};
--surface:${safeColor(colors.surface, '#ffffff')};
--text:${safeColor(colors.text, '#18181b')};
--muted:${safeColor(colors.mutedText, '#52525b')};
--primary:${safeColor(colors.primary, '#2563eb')};
--primary-text:${safeColor(colors.primaryText, '#ffffff')};
--border:${safeColor(colors.border, '#e4e4e7')};
--radius:${radius}px;
--maxw:${maxw}px;
--font-heading:${theme.fonts.heading};
--font-body:${theme.fonts.body};
}
${BASE_CSS}`;
}

// ── page shell ───────────────────────────────────────────────────────────────

export function renderSiteHtml(compiled: CompiledSite, siteKey: string): string {
  const settings = compiled.settings;
  const css = buildCss(settings.theme_config);
  const json = JSON.stringify(compiled).replace(/</g, '\\u003c');
  const description = metaDescription(settings.layout_blocks);
  const body = renderBody(settings.site_name, settings.layout_blocks, compiled.products, siteKey);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(settings.site_name)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="https://${escapeHtml(siteKey)}/">
<style>${css}</style>
<script id="__SITE_DATA__" type="application/json">${json}</script>
</head>
<body>
${body}
<script>${CLIENT_RENDERER}</script>
</body>
</html>`;
}

export function renderNotFoundHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site not found</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f7f7f8;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}
  h1{font-size:28px;margin:0 0 8px}
  p{color:#52525b}
</style>
</head>
<body>
  <div>
    <h1>Site not found</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

function renderBody(brand: string, blocks: LayoutBlock[], products: Product[], siteKey: string): string {
  const navBlock = blocks.find((block): block is NavBlock => block.type === 'nav');
  const navLinks = navBlock && navBlock.enabled !== false ? navBlock.props.links : defaultNavLinks();
  const sections = blocks.filter((block) => block.type !== 'nav' && block.enabled !== false);

  return `<header class="site-header">
  <div class="container header-inner">
    <a class="brand" href="/">${escapeHtml(brand)}</a>
    <nav class="nav">${renderNavLinks(navLinks)}</nav>
  </div>
</header>
<main>
${sections.map((block) => renderBlock(block, products)).join('\n')}
</main>
<footer class="site-footer">
  <div class="container">
    <span>© ${new Date().getFullYear()} ${escapeHtml(brand)}</span>
    <span>${escapeHtml(siteKey)}</span>
  </div>
</footer>`;
}

function defaultNavLinks(): Array<{ label: string; href: string }> {
  return [
    { label: 'Home', href: '/' },
    { label: 'Shop', href: '/#shop' },
  ];
}

function renderNavLinks(links: Array<{ label: string; href: string }>): string {
  return links
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join('\n');
}


// ── block renderers ──────────────────────────────────────────────────────────

function renderBlock(block: LayoutBlock, products: Product[]): string {
  switch (block.type) {
    case 'hero': return renderHero(block.props);
    case 'products': return renderProducts(block.props, products);
    case 'text': return renderText(block.props);
    case 'image': return renderImage(block.props);
    case 'cta': return renderCta(block.props);
    case 'html': return renderHtmlBlock(block.props);
    case 'nav': return ''; // rendered once in the header
  }
  return ''; // unreachable — the switch above is exhaustive
}

function renderHero(props: Extract<LayoutBlock, { type: 'hero' }>['props']): string {
  const alignClass = props.align === 'center' ? 'hero' : props.align === 'right' ? 'hero hero-right' : 'hero hero-left';
  const image = props.imageUrl
    ? `<img src="${escapeHtml(props.imageUrl)}" alt="" style="max-width:820px;margin:0 auto;border-radius:var(--radius)">`
    : '';
  return `<section class="${alignClass}">
  <div class="container">
    <h1>${escapeHtml(props.headline)}</h1>
    <p>${escapeHtml(props.subheadline)}</p>
    ${props.ctaLabel ? `<a class="btn" href="${escapeHtml(props.ctaHref)}">${escapeHtml(props.ctaLabel)}</a>` : ''}
    ${image}
  </div>
</section>`;
}

function renderProducts(props: Extract<LayoutBlock, { type: 'products' }>['props'], products: Product[]): string {
  const visible = props.limit !== null && props.limit > 0 ? products.slice(0, props.limit) : products;
  const chips = renderChips(props.categories, products);
  return `<section class="section" id="shop">
  <div class="container">
    ${props.title ? `<h2 class="section-title">${escapeHtml(props.title)}</h2>` : ''}
    ${chips}
    <div class="product-grid">
      ${visible.map((product) => renderProductCard(product, props.showPrices)).join('\n')}
    </div>
  </div>
</section>`;
}

function renderChips(categories: string[], products: Product[]): string {
  const productTags = new Set(products.flatMap((product) => product.tags));
  const chips = categories.filter((category) => productTags.has(category));
  if (chips.length === 0) return '';
  return `<div class="chips">
  ${chips.map((category) => `<button type="button" class="chip" data-filter-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('')}
</div>`;
}

function renderProductCard(product: Product, showPrices: boolean): string {
  const image = product.image_url
    ? `<img class="product-image" src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : `<div class="product-image"></div>`;
  const price = showPrices ? `<span class="product-price">${formatPrice(product.price)}</span>` : '';
  return `<article class="product-card" data-category="${escapeHtml(product.tags.join(','))}">
  ${image}
  <div class="product-body">
    <h3 class="product-name">${escapeHtml(product.name)}</h3>
    <p class="product-description">${escapeHtml(product.description)}</p>
    ${price}
  </div>
</article>`;
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price);
}

function renderText(props: Extract<LayoutBlock, { type: 'text' }>['props']): string {
  return `<section class="section text-block" style="text-align:${props.align}">
  ${props.title ? `<h2>${escapeHtml(props.title)}</h2>` : ''}
  <p>${escapeHtml(props.body)}</p>
</section>`;
}

function renderImage(props: Extract<LayoutBlock, { type: 'image' }>['props']): string {
  const radius = props.borderRadiusPx !== null && props.borderRadiusPx !== undefined ? `${Math.max(0, props.borderRadiusPx)}px` : 'var(--radius)';
  const caption = props.caption ? `<figcaption>${escapeHtml(props.caption)}</figcaption>` : '';
  return `<section class="section image-block">
  <div class="container" style="text-align:center">
    <figure style="margin:0">
      <img src="${escapeHtml(props.imageUrl)}" alt="${escapeHtml(props.altText)}" style="border-radius:${radius}" loading="lazy">
      ${caption}
    </figure>
  </div>
</section>`;
}

function renderCta(props: Extract<LayoutBlock, { type: 'cta' }>['props']): string {
  return `<section class="section cta-block">
  <div class="container">
    <h2>${escapeHtml(props.headline)}</h2>
    <p>${escapeHtml(props.subheadline)}</p>
    <a class="btn" href="${escapeHtml(props.buttonHref)}">${escapeHtml(props.buttonLabel)}</a>
  </div>
</section>`;
}

function renderHtmlBlock(props: Extract<LayoutBlock, { type: 'html' }>['props']): string {
  // Raw HTML is admin-authored for their own site — intentionally unescaped.
  return `<section class="section html-block">
  <div class="container">
    ${props.title ? `<h2>${escapeHtml(props.title)}</h2>` : ''}
    ${props.html}
  </div>
</section>`;
}


// ── inline client script (product filter chips) ──────────────────────────────
// NOTE: this string must never contain a literal "</script>" sequence.
const CLIENT_RENDERER = `
(function () {
  var dataEl = document.getElementById('__SITE_DATA__');
  if (!dataEl) return;
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-filter-category]'));
  if (!chips.length) return;
  var active = '';
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var value = chip.getAttribute('data-filter-category');
      active = active === value ? '' : value;
      chips.forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-filter-category') === active);
      });
      var grid = chip.closest('.section').querySelector('.product-grid');
      if (!grid) return;
      Array.prototype.slice.call(grid.querySelectorAll('.product-card')).forEach(function (card) {
        var tags = (card.getAttribute('data-category') || '').split(',').filter(Boolean);
        card.style.display = !active || tags.indexOf(active) !== -1 ? '' : 'none';
      });
    });
  });
})();
`.trim();

