// Support lines shown after a call. The country is guessed on the phone
// itself from its time zone (nothing is sent to the server) and can be changed.
//
// Numbers checked November 2026. Re-check them before launch and every few months:
// services change numbers and hours.

const RESOURCES = {
  us: {
    label: 'United States',
    crisis: {
      name: '988 Suicide & Crisis Lifeline',
      text: 'Free, 24/7. Call or text 988. Also for anyone in emotional distress, including grief.',
      actions: [['Call 988', 'tel:988'], ['Text 988', 'sms:988'], ['Website', 'https://988lifeline.org']],
    },
    grief: [
      { name: 'Crisis Text Line', text: 'Free, 24/7. Text HOME to 741741 to reach a trained volunteer.',
        actions: [['Text HOME to 741741', 'sms:741741?&body=HOME'], ['Website', 'https://www.crisistextline.org']] },
      { name: 'The Compassionate Friends', text: 'Support for families after the death of a child, sibling or grandchild.',
        actions: [['Website', 'https://www.compassionatefriends.org']] },
    ],
    note: 'The US has no single national grief helpline. These services can help.',
  },
  uk: {
    label: 'United Kingdom',
    crisis: {
      name: 'Samaritans',
      text: 'Free, 24/7. Call 116 123.',
      actions: [['Call 116 123', 'tel:116123'], ['Website', 'https://www.samaritans.org']],
    },
    grief: [
      { name: 'Cruse Bereavement Support', text: 'National bereavement helpline. Free. Call 0808 808 1677 (check opening hours).',
        actions: [['Call 0808 808 1677', 'tel:08088081677'], ['Website', 'https://www.cruse.org.uk']] },
    ],
  },
  ie: {
    label: 'Ireland',
    crisis: {
      name: 'Samaritans Ireland',
      text: 'Free, 24/7. Call 116 123.',
      actions: [['Call 116 123', 'tel:116123'], ['Website', 'https://www.samaritans.org/ireland']],
    },
    grief: [
      { name: 'Irish Hospice Foundation Bereavement Support Line', text: 'Free. Call 1800 80 70 77, weekdays 10am to 1pm.',
        actions: [['Call 1800 80 70 77', 'tel:1800807077'], ['Website', 'https://hospicefoundation.ie']] },
    ],
  },
  au: {
    label: 'Australia',
    crisis: {
      name: 'Lifeline',
      text: 'Free, 24/7. Call 13 11 14.',
      actions: [['Call 13 11 14', 'tel:131114'], ['Website', 'https://www.lifeline.org.au']],
    },
    grief: [
      { name: 'Griefline', text: 'National grief helpline. Free. Call 1300 845 745, 8am to 8pm every day.',
        actions: [['Call 1300 845 745', 'tel:1300845745'], ['Website', 'https://griefline.org.au']] },
    ],
  },
  other: {
    label: 'Another country',
    crisis: {
      name: 'Find a Helpline',
      text: 'Free, confidential crisis lines in your country, by phone, text or chat.',
      actions: [['Find a crisis line', 'https://findahelpline.com']],
    },
    grief: [],
    note: 'If you are in immediate danger, call your local emergency number.',
  },
};

function guessRegion() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const lang = navigator.language || '';
    if (tz === 'Europe/London' || tz === 'Europe/Belfast') return 'uk';
    if (tz === 'Europe/Dublin') return 'ie';
    if (tz.startsWith('Australia/')) return 'au';
    const usZones = /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Adak|Indiana|Kentucky|North_Dakota|Menominee|Nome|Sitka|Yakutat|Metlakatla)|^Pacific\/Honolulu/;
    if (usZones.test(tz) || lang === 'en-US') return 'us';
    if (tz) return 'other'; // a recognisable non-US time zone: show the international finder
  } catch {}
  return 'us'; // US launch: default when we can't tell
}

function renderResources(regionKey) {
  const r = RESOURCES[regionKey] || RESOURCES.other;
  const item = (x, crisis) => `
    <div class="help-item${crisis ? ' crisis-item' : ''}">
      <span class="tag">${crisis ? 'Feeling suicidal or unsafe?' : 'Support'}</span>
      <strong>${x.name}</strong>
      <p>${x.text}</p>
      <div class="actions">${x.actions.map(([label, href]) =>
        `<a href="${href}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`).join('')}</div>
    </div>`;
  const list = document.getElementById('help-list');
  list.innerHTML = item(r.crisis, true) + r.grief.map((g) => item(g, false)).join('')
    + (r.note ? `<p class="help-note">${r.note}</p>` : '')
    + (regionKey !== 'other' ? `<p class="help-note">Elsewhere? <a href="https://findahelpline.com" target="_blank" rel="noopener">Find a helpline in your country</a>.</p>` : '');
}

function initResources() {
  const select = document.getElementById('region');
  select.innerHTML = Object.entries(RESOURCES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  let region;
  try { region = localStorage.getItem('region'); } catch {}
  if (!RESOURCES[region]) region = guessRegion();
  select.value = region;
  renderResources(region);
  select.addEventListener('change', () => {
    try { localStorage.setItem('region', select.value); } catch {}
    renderResources(select.value);
  });
}
