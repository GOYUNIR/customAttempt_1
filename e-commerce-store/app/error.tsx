'use client';

/**
 * Route error boundary — rendered WITHIN the root layout, so it inherits the
 * layout's metadata (the brand favicon at /icon) automatically. This only
 * catches uncaught render errors from a route segment; the storefront
 * components already handle their own not-found/error states.
 */
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 48,
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Something went wrong.</h1>
      <p style={{ fontSize: 14, opacity: 0.7, margin: 0 }}>
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
  );
}
