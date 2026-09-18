import StaffLoginForm from '@/components/staff/StaffLoginForm';
import { platformHomeUrl, platformHomeLabel } from '@/lib/staff-realms';

/**
 * /sales/login — sign-in for the SALES portal (sales.<root>).
 *
 * Before this existed, a sales rep was redirected to /admin/login — which both
 * read as the wrong permission level and, on success, sent them to /admin,
 * which the path fence 404s on the sales host. See lib/staff-realms.ts.
 */
export default function SalesLoginPage() {
  // A bare "/" here is the PORTAL root, which bounces an unauthenticated
  // visitor straight back to this page. See platformHomeUrl.
  return (
    <StaffLoginForm
      realm="sales"
      backUrl={platformHomeUrl(process.env.PLATFORM_ROOT_DOMAIN)}
      backLabel={platformHomeLabel(process.env.PLATFORM_ROOT_DOMAIN)}
    />
  );
}
