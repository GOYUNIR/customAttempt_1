'use client';

/**
 * Global error boundary — renders OUTSIDE the root layout as a complete
 * <html> document, so it has NO access to the layout's metadata/favicon. An
 * explicit brand favicon link (/icon) is required here: without it a top-level
 * crash would leave the browser requesting a fallback favicon (previously the
 * leaked Vercel/Next `favicon.ico`). This keeps the store's own favicon
 * on-screen during even the worst failure state. Nothing here is hardcoded —
 * the icon is the same dynamic `/icon` route the layout already advertises.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" style={{ background: '#0a0a0c', color: '#f5f5f7' }}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/icon" />
        <link rel="apple-touch-icon" href="/icon" />
        <title>Something went wrong</title>
      </head>
      <body
        style={{
          margin: 0,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          padding: 24,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 480 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>Something went wrong.</h1>
          <p style={{ fontSize: 14, opacity: 0.7, margin: '0 0 20px' }}>
            An unexpected error occurred. Please try again.
          </p>
          <button
            onClick={reset}
            style={{
              padding: '10px 18px',
              borderRadius: 999,
              border: 'none',
              background: '#fff',
              color: '#000',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
