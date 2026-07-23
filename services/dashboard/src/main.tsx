import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Web Push (bildirim sistemi parça 5): service worker'ı en baştan kaydediyoruz --
// kullanıcı bir kanala abone olmaya karar verdiğinde zaten hazır olsun diye
// (aboneliğin kendisi ayrı bir kullanıcı eylemiyle, bkz. WebPushSubscribeButton).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
