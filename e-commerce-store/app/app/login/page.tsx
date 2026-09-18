import StaffLoginForm from '@/components/staff/StaffLoginForm';
import { platformHomeUrl, platformHomeLabel } from '@/lib/staff-realms';

/**
 * /app/login — sign-in for the MERCHANT hub (app.<root>).
 *
 * The merchant hub is served by the same route tree as the platform admin
 * portal today (the difference is the ROLE required, enforced in
 * app/admin/layout.tsx), but a store owner is not a platform administrator and
 * should not be told they are signing in as one.
 */
export default function MerchantLoginPage() {
  // A bare "/" here is the PORTAL root, which bounces an unauthenticated
  // visitor straight back to this page. See platformHomeUrl.
  return (
    <StaffLoginForm
      realm="merchant"
      backUrl={platformHomeUrl(process.env.PLATFORM_ROOT_DOMAIN)}
      backLabel={platformHomeLabel(process.env.PLATFORM_ROOT_DOMAIN)}
    />
  );
}
