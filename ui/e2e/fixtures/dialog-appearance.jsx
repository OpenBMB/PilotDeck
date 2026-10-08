import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ImageLightbox from '../../src/components/chat/view/subcomponents/ImageLightbox';
import { ConfirmDialog } from '../../src/components/ui/ConfirmDialog';
import { applyLightAppearance } from '../../src/lib/appearanceRuntime';
import { LIGHT_PRESETS, normalizeLightAppearance } from '../../src/lib/lightAppearance';
import i18n from '../../src/i18n/config';
import '../../src/index.css';
import '../../src/light-appearance.css';

await i18n.changeLanguage('en');
const images = ['#386ab4', '#187c65'].map((color, index) => ({
  name: `Preview ${index + 1}`,
  data: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="${color}"/><text x="240" y="175" text-anchor="middle" font-size="40" fill="white">Preview ${index + 1}</text></svg>`)}`,
}));
window.dialogAppearancePresets = Object.keys(LIGHT_PRESETS);
window.setDialogAppearance = (value, dark = false) => {
  document.documentElement.classList.toggle('dark', dark);
  applyLightAppearance(normalizeLightAppearance(value), dark, images[0].data);
};
window.setDialogAppearance();

function App() {
  const [preview, setPreview] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [confirmed, setConfirmed] = useState(0);
  return <main className="app-root" style={{ minHeight: '100vh', padding: 32 }}>
    <div style={{ display: 'flex', gap: 24 }}>
      <button onClick={() => setPreview(2)}>Open images</button>
      <button onClick={() => setPreview(1)}>Open single image</button>
      <button onClick={() => setConfirm(true)}>Open confirmation</button>
      <output aria-label="Confirmed count">{confirmed}</output>
    </div>
    {preview > 0 && <ImageLightbox images={images.slice(0, preview)} onClose={() => setPreview(0)} />}
    {confirm && <ConfirmDialog title="Appearance confirmation" confirmLabel="Proceed"
      onCancel={() => setConfirm(false)} onConfirm={() => { setConfirmed(count => count + 1); setConfirm(false); }}>
      A normal dialog panel must keep its theme surface and dim backdrop.
    </ConfirmDialog>}
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
