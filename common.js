// Shared data loading for the Hong Kong metered parking viewers.
// Source: Transport Department, data.gov.hk dataset "hk-td-msd_1-metered-parking-spaces-data"
const SPACES_URL = 'https://resource.data.one.gov.hk/td/psiparkingspaces/spaceinfo/parkingspaces.csv';
const OCC_URL = 'https://resource.data.one.gov.hk/td/psiparkingspaces/occupancystatus/occupancystatus.csv';
const REFRESH_MS = 5 * 60 * 1000; // occupancy file is refreshed about every 5 minutes

// First visit opens on Sai Kung; afterwards the last chosen area is remembered
const DEFAULT_AREA = { region: 'NEW TERRITORIES', district: 'SAI KUNG', subDistrict: '' };
const AREA_KEY = 'hk_parking_area';

const VEHICLE = { A: '私家車 Private car', G: '貨車 Goods vehicle', C: '旅遊巴 Coach' };

const STATUS = {
  V: { tc: '空置', en: 'Vacant', color: '#1a9850' },
  O: { tc: '已佔用', en: 'Occupied', color: '#d73027' },
  X: { tc: '暫停使用', en: 'Not in service', color: '#7f7f7f' },
  U: { tc: '沒有資料', en: 'No data', color: '#b0a8d8' },
};

// Minimal RFC 4180 CSV parser (handles quoted fields and CRLF)
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
    i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toObjects(rows) {
  const h = rows.findIndex(r => r.includes('ParkingSpaceId'));
  const head = rows[h];
  return rows.slice(h + 1).filter(r => r.length >= head.length).map(r => {
    const o = {};
    head.forEach((k, j) => (o[k] = r[j]));
    return o;
  });
}

let spacesCache = null;

async function loadSpaces() {
  if (spacesCache) return spacesCache;
  const res = await fetch(SPACES_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Parking space info HTTP ' + res.status);
  const rows = parseCSV(await res.text());
  const dataDate = (rows[0] && rows[0][0]) || '';
  const spaces = toObjects(rows)
    .filter(o => o.District !== 'INTERNAL TEST')
    .map(o => ({
      id: o.ParkingSpaceId,
      pole: o.PoleId,
      region: o.Region,
      regionTc: o.Region_tc,
      district: o.District,
      districtTc: o.District_tc,
      subDistrict: o.SubDistrict,
      subDistrictTc: o.SubDistrict_tc,
      street: o.Street,
      streetTc: o.Street_tc,
      section: o.SectionOfStreet,
      sectionTc: o.SectionOfStreet_tc,
      lat: parseFloat(o.Latitude),
      lng: parseFloat(o.Longitude),
      vehicle: (o.VehicleType || '').toUpperCase(),
      maxMinutes: o.LPP,
      timeUnit: o.TimeUnit,
      payment: o.PaymentUnit,
    }));
  // A few rows have blank Chinese area names; borrow them from other rows of the same area
  const tc = new Map();
  for (const s of spaces) {
    if (s.regionTc) tc.set('r|' + s.region, s.regionTc);
    if (s.districtTc) tc.set('d|' + s.district, s.districtTc);
    if (s.subDistrictTc) tc.set('s|' + s.district + '|' + s.subDistrict, s.subDistrictTc);
  }
  for (const s of spaces) {
    s.regionTc ||= tc.get('r|' + s.region) || '';
    s.districtTc ||= tc.get('d|' + s.district) || '';
    s.subDistrictTc ||= tc.get('s|' + s.district + '|' + s.subDistrict) || '';
  }
  spacesCache = { dataDate, spaces };
  return spacesCache;
}

async function loadOccupancy() {
  const res = await fetch(OCC_URL + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('Occupancy HTTP ' + res.status);
  const map = new Map();
  for (const o of toObjects(parseCSV(await res.text()))) map.set(o.ParkingSpaceId, o);
  return map;
}

// Returns every metered space in Hong Kong merged with its live status
async function loadParking() {
  const [{ dataDate, spaces }, occ] = await Promise.all([loadSpaces(), loadOccupancy()]);
  const list = spaces.map(s => {
    const o = occ.get(s.id);
    let status = 'U';
    if (o) status = o.ParkingMeterStatus === 'NU' ? 'X' : o.OccupancyStatus === 'V' ? 'V' : 'O';
    return { ...s, status, changed: o ? o.OccupancyDateChanged : '' };
  });
  return { dataDate, list, fetchedAt: new Date() };
}

// Builds Region → District → Sub-district dropdowns inside `el`.
// Calls onChange(area) whenever the choice changes; area = { key, label, match(space) }.
function areaPicker(el, list, onChange) {
  const tree = new Map();
  for (const s of list) {
    if (!tree.has(s.region)) tree.set(s.region, { tc: s.regionTc, kids: new Map() });
    const r = tree.get(s.region).kids;
    if (!r.has(s.district)) r.set(s.district, { tc: s.districtTc, kids: new Map() });
    const d = r.get(s.district).kids;
    if (!d.has(s.subDistrict)) d.set(s.subDistrict, { tc: s.subDistrictTc });
  }

  el.innerHTML = '<select aria-label="地域 Region"></select><select aria-label="地區 District"></select><select aria-label="分區 Sub-district"></select>';
  const [rSel, dSel, sSel] = el.querySelectorAll('select');

  let saved = DEFAULT_AREA;
  try { saved = JSON.parse(localStorage.getItem(AREA_KEY)) || DEFAULT_AREA; } catch (e) {}

  const label = (k, v) => `${v.tc} ${titleCase(k)}`;
  function fill(sel, allText, nodes, value) {
    sel.innerHTML = '';
    sel.add(new Option(allText, ''));
    [...nodes].sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => sel.add(new Option(label(k, v), k)));
    sel.value = nodes.has(value) ? value : '';
  }
  function districts() {
    const out = new Map();
    for (const [rk, r] of tree) if (!rSel.value || rk === rSel.value) r.kids.forEach((v, k) => out.set(k, v));
    return out;
  }
  function fillDistricts(value) { fill(dSel, '全部地區 All districts', districts(), value); }
  function fillSubs(value) {
    const d = districts().get(dSel.value);
    fill(sSel, '全部分區 All sub-districts', d ? d.kids : new Map(), value);
    sSel.disabled = !d;
  }

  function current() {
    const R = rSel.value, D = dSel.value, S = sSel.value;
    const pick = sel => sel.value ? sel.selectedOptions[0].text : '';
    return {
      key: [R, D, S].join('|'),
      label: pick(sSel) || pick(dSel) || pick(rSel) || '全港 All Hong Kong',
      match: x => (!R || x.region === R) && (!D || x.district === D) && (!S || x.subDistrict === S),
    };
  }
  function changed() {
    try { localStorage.setItem(AREA_KEY, JSON.stringify({ region: rSel.value, district: dSel.value, subDistrict: sSel.value })); } catch (e) {}
    onChange(current());
  }

  fill(rSel, '全港 All Hong Kong', tree, saved.region);
  fillDistricts(saved.district);
  fillSubs(saved.subDistrict);
  rSel.addEventListener('change', () => { fillDistricts(''); fillSubs(''); changed(); });
  dSel.addEventListener('change', () => {
    // Picking a district while "All Hong Kong" is selected also sets its region
    if (!rSel.value) for (const [rk, r] of tree) if (r.kids.has(dSel.value)) { rSel.value = rk; fillDistricts(dSel.value); }
    fillSubs(''); changed();
  });
  sSel.addEventListener('change', changed);
  return { current };
}

function addressTc(s) {
  return `${s.districtTc} ${s.subDistrictTc} ${s.streetTc}（${s.sectionTc}）`;
}
function addressEn(s) {
  return `${titleCase(s.section)}, ${titleCase(s.street)}, ${titleCase(s.subDistrict)}, ${titleCase(s.district)}`;
}
function titleCase(t) {
  return (t || '').toLowerCase().replace(/(^|[\s(\-\/&])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}
function feeText(s) {
  return s.payment ? `$${s.payment} / ${s.timeUnit} 分鐘 min` : '';
}
function maxText(s) {
  if (!s.maxMinutes) return '';
  const m = +s.maxMinutes;
  return m >= 60 && m % 60 === 0 ? `${m / 60} 小時 hr` : `${m} 分鐘 min`;
}
function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function countStatus(list) {
  const c = { V: 0, O: 0, X: 0, U: 0 };
  list.forEach(s => c[s.status]++);
  return c;
}
