/**
 * /sitemap.xml — none yet, on purpose: public/robots.txt keeps every crawler
 * out until launch, so there is nothing to map. Without this route the path
 * fell through to the store's product page ("sitemap.xml" as a product slug)
 * and answered 200 with an HTML page wearing the default store's name.
 * At launch (RELEASE-PLAN, BLOCKED ON NAME): open robots.txt and serve a real,
 * host-aware sitemap here.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response('No sitemap: this site is not open to search engines yet.\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
