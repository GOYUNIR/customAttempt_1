import PlatformLegalPage from '@/components/platform/PlatformLegalPage';
import { platformPrivacy } from '@/lib/platform-legal';
import { getSupportEmail } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Privacy Policy' };

export default function Page() {
  return <PlatformLegalPage title="Privacy Policy" sections={platformPrivacy(process.env.PLATFORM_ROOT_DOMAIN || 'this site', getSupportEmail())} />;
}
