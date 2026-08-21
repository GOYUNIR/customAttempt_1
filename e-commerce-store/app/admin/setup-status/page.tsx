import { redirect } from 'next/navigation';

/**
 * /admin/setup-status — DEPRECATED. The system configuration checklist was
 * folded into the unified /admin/setup dashboard. Any direct visit (old
 * bookmarks, stale deep-links) is redirected there. The middleware.ts mirror
 * of this redirect handles the edge-runtime path; this server component covers
 * the page itself.
 */
export default function SetupStatusPage() {
  redirect('/admin/setup');
}