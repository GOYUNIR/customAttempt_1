import { headers } from 'next/headers';
import React from 'react';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const activeHeaders = await headers();
  const authorizationHeader = activeHeaders.get('authorization');
  
  const masterUser = process.env.ADMIN_BASIC_AUTH_USERNAME;
  const masterPass = process.env.ADMIN_BASIC_AUTH_PASSWORD;

  // SYSTEM SECURITY CUTOFF: If keys are missing in Vercel settings, block entry immediately
  if (!masterUser || !masterPass) {
    console.error("CRITICAL SECURITY FAULT: Portal login blocked because Vercel basic auth environment variables are missing.");
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060606', color: '#f87171', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center', padding: '24px', border: '1px dashed #f87171', borderRadius: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>🔒 CONFIGURATION LOCK</h2>
          <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: '#888' }}>Operations center offline. Vercel environment variables unconfigured.</p>
        </div>
      </main>
    );
  }
  
  const validAuthBuffer = Buffer.from(`${masterUser}:${masterPass}`).toString('base64');
  const expectedAuthToken = `Basic ${validAuthBuffer}`;

  // INTERCEPT: If headers do not match, return a restricted visual shield block layout
  if (authorizationHeader !== expectedAuthToken) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center', padding: '32px', background: '#111', border: '1px solid #27272a', borderRadius: '24px', maxWidth: '400px' }}>
          <h2 style={{ margin: '0 0 8px 0', fontSize: '1.5rem', fontWeight: '800', letterSpacing: '-0.02em' }}>🔒 ACCESS RESTRICTED</h2>
          <p style={{ margin: 0, fontSize: '13px', color: '#888', lineHeight: '1.5' }}>
            This interface requires an authenticated administrative connection. Close this page or enter matching keys via your login prompt.
          </p>
          <div style={{ marginTop: '20px', fontSize: '11px', color: '#555', fontFamily: 'monospace' }}>
            HTTP_STATUS_CODE_401_UNAUTHORIZED
          </div>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
