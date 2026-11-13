import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../eventouch-pilot.css';
import './pilot.css';

export const metadata = {title: 'EVENTOUCH | 운영 현황 시범'};

export default function Layout({children}) {
  return <html lang="ko"><body>{children}</body></html>;
}
