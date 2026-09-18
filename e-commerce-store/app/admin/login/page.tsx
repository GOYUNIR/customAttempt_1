import StaffLoginForm from '@/components/staff/StaffLoginForm';
import { platformHomeUrl, platformHomeLabel } from '@/lib/staff-realms';

/**
 * /admin/login — sign-in for the PLATFORM ADMIN portal (admin.<root>).
 *
 * The form itself is shared with /app/login and /sales/login; only the copy and
 * the destination differ. See lib/staff-realms.ts.
 *
 * This path stays the fallback login for a single-domain deployment
 * (PLATFORM_ROOT_DOMAIN unset), where every host classifies as 'storefront' and
 * there are no portal subdomains to tell apart.
 */
export default function AdminLoginPage() {
  // A bare "/" here is the PORTAL root, which bounces an unauthenticated
  // visitor straight back to this page. See platformHomeUrl.
  return (
    <StaffLoginForm
      realm="admin"
      backUrl={platformHomeUrl(process.env.PLATFORM_ROOT_DOMAIN)}
      backLabel={platformHomeLabel(process.env.PLATFORM_ROOT_DOMAIN)}
    />
  );
}
