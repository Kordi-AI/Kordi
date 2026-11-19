import './previewChatTheme';
import { createRoot } from 'react-dom/client';
import { KordiAppRoot } from '../../src/KordiApp';
import '../../src/index.css';

localStorage.setItem('kordi.themeMode.v1', new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
createRoot(document.getElementById('root')!).render(
  <KordiAppRoot cloudSession={{
    status: new URLSearchParams(location.search).has('loading') ? 'loading' : 'signed-out', account: null,
  }} />,
);
