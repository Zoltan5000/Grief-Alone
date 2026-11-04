// Photos behind every screen, the opening "step inside" zoom, and photo credits.
//
// Photos are listed in public/img/photos.json. ONLY add photos you have
// confirmed are public domain, and fill in every credit field. Example:
// {
//   "file": "booth-street.jpg",
//   "screens": ["street"],          // which screens use it (see SCREENS below); "*" = any screen without its own
//   "title": "Phone booth, Main Street",
//   "author": "Carol M. Highsmith",
//   "date": "1985",
//   "source": "https://www.loc.gov/pictures/item/...",
//   "license": "Public domain",
//   "focus": "50% 55%"              // where the phone is; the zoom and cropping head there
// }
// Screens: street, welcome, about-loss, home, calling, in-call, after-call

const Scene = (() => {
  let photos = [];
  let front = 'a';
  let currentFile = null;

  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const photoFor = (screen) =>
    photos.find((p) => p.screens?.includes(screen)) || photos.find((p) => p.screens?.includes('*'));

  async function init() {
    try {
      const res = await fetch('img/photos.json', { cache: 'no-cache' });
      if (res.ok) photos = (await res.json()).filter((p) => p && p.file && p.license);
    } catch { photos = []; }

    const street = photoFor('street');
    if (street) {
      const img = $('scene-photo');
      img.onload = () => (img.hidden = false);
      img.src = `img/${encodeURIComponent(street.file)}`;
      if (street.focus) { img.style.objectPosition = street.focus; $('scene').style.transformOrigin = street.focus; }
    }

    if (photos.length) {
      $('credits-link').hidden = false;
      $('credits-list').innerHTML = photos.map((p) => `
        <li><strong>${esc(p.title || p.file)}</strong>
          <span>${esc(p.author || 'Unknown photographer')}${p.date ? `, ${esc(p.date)}` : ''}</span>
          <span>${esc(p.license)}${p.source ? ` · <a href="${esc(p.source)}" target="_blank" rel="noopener">Source</a>` : ''}</span>
        </li>`).join('');
    }
    $('credits-link').addEventListener('click', () => ($('credits').hidden = false));
    $('credits-close').addEventListener('click', () => ($('credits').hidden = true));
    setScreen(document.querySelector('.screen:not([hidden])')?.id || 'street');
  }

  // Cross-fade the backdrop to this screen's photo.
  function setScreen(screen) {
    const p = photoFor(screen);
    const file = p ? `img/${encodeURIComponent(p.file)}` : null;
    if (file === currentFile) return;
    currentFile = file;
    const next = $(front === 'a' ? 'backdrop-b' : 'backdrop-a');
    const prev = $(front === 'a' ? 'backdrop-a' : 'backdrop-b');
    if (!file) { prev.classList.remove('on'); next.classList.remove('on'); return; }
    next.onload = () => { next.classList.add('on'); prev.classList.remove('on'); };
    next.style.objectPosition = p.focus || '50% 50%';
    next.src = file;
    front = front === 'a' ? 'b' : 'a';
  }

  // Zoom from the street into the booth, then call done().
  function stepInside(done) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
    const street = $('street');
    street.classList.add('zooming');
    setTimeout(() => { done(); street.classList.remove('zooming'); }, 1300);
  }

  return { init, setScreen, stepInside };
})();
