import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App.jsx';
import { applyChatTheme, readStoredChatTheme } from '@/app/themePreference';
import { preloadNotoEmojiThumbnails } from '@/features/emoji/notoEmojiThumbnails';
import { showConnectorCallbackPage } from '@web/runtime/browserConnectorCallbackPage';
import { isConnectorCallbackLocation } from '@web/runtime/browserConnectorOAuth';
import './index.css';

applyChatTheme(readStoredChatTheme());
const element = document.getElementById('root');
if (!element) throw new Error('The Kordi application root is missing.');
// A connector sign-in returns here only to hand its result to the tab that
// started it, so the application itself does not start.
if (isConnectorCallbackLocation(window.location)) {
  showConnectorCallbackPage(window, element);
} else {
  void preloadNotoEmojiThumbnails();
  createRoot(element).render(<StrictMode><App /></StrictMode>);
}
