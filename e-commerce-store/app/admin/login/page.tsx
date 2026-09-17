import StaffLoginForm from '@/components/staff/StaffLoginForm';

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
  return <StaffLoginForm realm="admin" />;
}
