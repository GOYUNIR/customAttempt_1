import PlatformLegalPage from '@/components/platform/PlatformLegalPage';
import { platformTerms } from '@/lib/platform-legal';
import { getSupportEmail } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Terms of Service' };

export default function Page() {
  return <PlatformLegalPage title="Terms of Service" sections={platformTerms(process.env.PLATFORM_ROOT_DOMAIN || 'this site', getSupportEmail())} />;
}
