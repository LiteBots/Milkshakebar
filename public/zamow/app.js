'use strict';
// Zamawiarka MilkMi. Menu, ceny, godziny i ustawienia przychodzą z serwera (panel lokalu),
// a zamówienie trafia do /api/orders, który liczy cenę od nowa.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Kwoty liczone w groszach, żeby uniknąć błędów zaokrągleń
const money = (g) => {
  const zl = Math.round(g) / 100;
  return `${Number.isInteger(zl) ? zl : zl.toFixed(2).replace('.', ',')} zł`;
};
const gr = (zl) => Math.round((Number(zl) || 0) * 100);
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* koszyk zostaje w pamięci strony */ } },
  raw(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
};
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const icon = {
  store: svg('<path d="M4 10v10h16V10"/><path d="M3 10l2-6h14l2 6a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z"/><path d="M10 20v-5h4v5"/>'),
  moto: svg('<circle cx="5.500" cy="17.500" r="3"/><circle cx="18.500" cy="17.500" r="3"/><path d="M8.500 17.500h7l2-6-2-5h-3M6 11h6l3 6.500M5.500 11c-1.500 0-2.500 1-3 2.500"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.500-3.500"/>')
};

const LOCATION = 'slupsk';
const VENUE = { venueName: 'MilkMi', address: 'ul. Szczecińska 17', city: 'Słupsk' };
const S = {
  menu: null,
  mode: store.get('msb.mode', null),
  cart: store.get('msb.cart', []),
  checkout: store.get('msb.checkout', {}),
  q: '',
  account: null // konto MilkMi (ta sama sesja co w aplikacji /app)
};
let items = new Map();
let pollTimer = null;
let spy = null;

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.auth && S.account) headers.Authorization = `Bearer ${S.account.token}`;
  const res = await fetch(path, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw Object.assign(new Error(data.message || 'Serwer nie odpowiada. Spróbuj ponownie.'), { data, status: res.status });
  return data;
}

/* --- menu z serwera w formacie zamawiarki --- */
// Kategorie z panelu łączymy w czytelne sekcje; podkategorie stają się nagłówkami w sekcji
const CATS = {
  burgery: ['burgery', 'Burgery', 'burger'], startery: ['startery', 'Startery', 'fries'], lunch_startery: ['startery', 'Startery', 'fries'],
  kanapki: ['kanapki', 'Kanapki', 'sandwich'], lunch_kanapki: ['kanapki', 'Kanapki', 'sandwich'],
  mexico_quesadillas: ['tex-mex', 'Tex-mex', 'quesadilla', 'Quesadillas'], mexico_fajita: ['tex-mex', 'Tex-mex', 'burrito', 'Fajita'],
  mexico_pasta: ['tex-mex', 'Tex-mex', 'pasta', 'Pasta'], mexico_salaty: ['tex-mex', 'Tex-mex', 'salad', 'Sałaty'],
  mexico: ['tex-mex', 'Tex-mex', 'quesadilla'], dania_glowne: ['dania-glowne', 'Dania główne', 'pasta'], sniadania: ['sniadania', 'Śniadania', 'pancake'],
  shakes_klasyczne: ['shake', 'Shake', 'shake', 'Klasyczne'], shakes_owocowe: ['shake', 'Shake', 'smoothie', 'Owocowe'],
  shakes_vip: ['shake', 'Shake', 'shake', 'Tylko dla VIP'], shakes_best: ['shake', 'Shake', 'shake', 'Best of'], shakes: ['shake', 'Shake', 'shake'],
  desery_wloskie: ['lody', 'Lody włoskie', 'cone'], desery_lodowe: ['desery', 'Desery lodowe', 'sundae'], desery_gofry: ['gofry', 'Gofry amerykańskie', 'waffle'],
  desery_pancakes: ['pancakes', 'Pancakes', 'pancake'], desery: ['desery', 'Desery', 'sundae'], mexico_churros: ['churros', 'Churros', 'churros'],
  napoje: ['napoje', 'Kawa i napoje', 'coffee']
};
const CAT_ORDER = ['burgery', 'startery', 'kanapki', 'tex-mex', 'dania-glowne', 'sniadania', 'shake', 'lody', 'desery', 'gofry', 'pancakes', 'churros', 'napoje'];
const SET_CATS = ['burgery', 'startery', 'kanapki', 'dania_glowne', 'lunch_startery', 'lunch_kanapki'];
const SET_DRINKS = ['Lemoniada', 'Coca-Cola 0,5 l', 'Woda 0,5 l'];

function buildMenu(products, settings, hours) {
  const s = settings;
  // Zdjęcie użyte przy wielu produktach to zastępcze ujęcie; wtedy pokazujemy ilustrację kategorii
  const useCount = {};
  products.forEach((p) => { if (p.imageUrl) useCount[p.imageUrl] = (useCount[p.imageUrl] || 0) + 1; });
  const cats = new Map();
  const optionGroups = {
    set: { label: 'Zestaw', type: 'single', hint: 'Frytki i napój do dania, taniej niż osobno.', choices: [{ id: 'set', label: 'Zestaw: frytki i napój', price: gr(s.mealSetPrice) }] },
    set_drink: { label: 'Napój do zestawu', type: 'single', requires: 'set', choices: SET_DRINKS.map((d, i) => ({ id: `d${i}`, label: d, price: 0 })) }
  };
  const list = [];
  products.filter((p) => p.isAvailable !== false || true).forEach((p) => {
    const [catId, catName, art, group] = CATS[p.categoryId] || [p.categoryId || 'inne', String(p.categoryId || 'Inne').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase()), null];
    if (!cats.has(catId)) cats.set(catId, { id: catId, name: catName, img: art, note: null, sets: false });
    const cat = cats.get(catId);
    const variants = p.variants && p.variants.length
      ? p.variants.map((v, i) => ({ id: `v${i}`, label: String(v.name || '').trim(), raw: v.name, price: gr(v.price) }))
      : [{ id: 'v0', label: '', raw: null, price: gr(p.price) }];
    const options = [];
    const setOk = p.allowSet === true || (SET_CATS.includes(p.categoryId) && p.allowSet !== false);
    if (setOk) { options.push('set', 'set_drink'); cat.sets = true; }
    if (p.addons && p.addons.length) {
      const gid = `ad_${p._id}`;
      optionGroups[gid] = { label: 'Dodatki', type: 'multi', choices: p.addons.map((a, i) => ({ id: String(a.id || a._id || `a${i}`), label: a.name, price: gr(a.price) })) };
      options.push(gid);
    }
    const photo = p.imageUrl && useCount[p.imageUrl] < 3 ? p.imageUrl : null;
    list.push({
      id: String(p._id), name: String(p.name || '').trim(), description: p.description || '', category: catId, group: group || null,
      groupArt: art, variants, options, photo, available: p.isAvailable !== false, deliverable: !p.pickupOnly, best: Boolean(p.isBestseller)
    });
  });
  cats.forEach((c) => { if (c.sets) c.note = `Dostępne w zestawie: frytki i napój za ${money(gr(s.mealSetPrice))} więcej.`; });
  const categories = [...cats.values()].sort((a, b) => (CAT_ORDER.indexOf(a.id) + 1 || 99) - (CAT_ORDER.indexOf(b.id) + 1 || 99));
  // W sekcji najpierw bez podkategorii, potem grupami w stałej kolejności
  list.sort((a, b) => categories.findIndex((c) => c.id === a.category) - categories.findIndex((c) => c.id === b.category) || String(a.group || '').localeCompare(String(b.group || '')) || a.name.localeCompare(b.name, 'pl'));
  return {
    settings: {
      ...VENUE, orderingEnabled: s.ordersEnabled, deliveryEnabled: s.deliveryEnabled, pickupEnabled: s.pickupEnabled,
      deliveryFee: gr(s.deliveryFee), freeDeliveryFrom: gr(s.freeDeliveryThreshold), deliveryMinOrder: gr(s.minOrderDelivery), packagingFee: gr(s.packagingFee),
      pickupPrepMinutes: Number(s.pickupPrepMinutes) || 0, deliveryPrepMinutes: Number(s.deliveryPrepMinutes) || 0,
      pay: { online: s.payOnline, card: s.payCard, cash: s.payCash, wallet: s.payWallet }, closedMessage: s.closedMessage || '', cover: s.coverUrl || ''
    },
    status: computeStatus(s, hours),
    categories, items: list, optionGroups
  };
}

// Godziny z panelu („Godziny otwarcia”); terminy co 15 minut od najbliższej możliwej godziny do zamknięcia
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmtMin = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
function computeStatus(s, hours) {
  const now = new Date();
  const day = hours ? hours[DAYS[now.getDay()]] : { isOpen: true, from: '10:00', to: '22:00' };
  const range = day && day.isOpen ? [toMin(day.from), toMin(day.to)] : null;
  const cur = now.getHours() * 60 + now.getMinutes();
  const open = Boolean(range && cur >= range[0] && cur < range[1]);
  const slots = (mode) => {
    if (!range) return [];
    const prep = mode === 'delivery' ? Number(s.deliveryPrepMinutes) || 0 : Number(s.pickupPrepMinutes) || 0;
    const first = Math.ceil(Math.max(cur + prep, range[0] + prep) / 15) * 15;
    const out = [];
    for (let t = first; t <= range[1]; t += 15) out.push(fmtMin(t));
    return out;
  };
  const modes = {};
  [['delivery', s.deliveryEnabled], ['pickup', s.pickupEnabled]].forEach(([mode, on]) => {
    const list = on && s.ordersEnabled ? slots(mode) : [];
    modes[mode] = { enabled: Boolean(on && s.ordersEnabled && list.length), asap: open && list.length > 0, slots: list };
  });
  return { open, accepting: Object.values(modes).some((m) => m.enabled), modes, today: range ? range.map(fmtMin) : null };
}

async function loadMenu() {
  const get = (u) => fetch(u).then((r) => r.json()).catch(() => ({}));
  const [menu, settings, hours] = await Promise.all([get(`/api/menu?location=${LOCATION}`), get(`/api/settings?location=${LOCATION}`), get(`/api/hours?location=${LOCATION}`)]);
  if (!menu.success) throw new Error('Nie udało się wczytać menu. Odśwież stronę.');
  S.menu = buildMenu(menu.data || [], settings.data || {}, hours.success ? hours.data : null);
  items = new Map(S.menu.items.map((i) => [i.id, i]));
  S.cart = S.cart.filter((l) => {
    const item = items.get(l.itemId);
    return item && item.available && item.variants.some((v) => v.id === l.variantId);
  });
  saveCart();
  const st = S.menu.settings;
  if (S.mode === 'delivery' && !st.deliveryEnabled) S.mode = null;
  if (S.mode === 'pickup' && !st.pickupEnabled) S.mode = null;
  if (S.mode !== 'delivery' && S.mode !== 'pickup') S.mode = st.pickupEnabled || !st.deliveryEnabled ? 'pickup' : 'delivery';
}

// Konto MilkMi zalogowane w aplikacji: imię i telefon do formularza, saldo do zapłaty
async function loadAccount() {
  const token = store.raw('milkmi_token');
  let user = null;
  try { user = JSON.parse(store.raw('milkmi_user') || 'null'); } catch (e) { user = null; }
  if (!token || !user) return;
  S.account = { token, user };
  try {
    const d = await api('/api/me', { auth: true });
    S.account.user = { ...user, ...d.user };
  } catch (e) { if (e.status === 401 || e.status === 403) S.account = null; }
}

/* --- koszyk --- */
function saveCart() { store.set('msb.cart', S.cart); store.set('msb.cartId', null); }
function selectedChoices(line) {
  const out = [];
  Object.entries(line.options || {}).forEach(([gid, ids]) => {
    const group = S.menu.optionGroups[gid];
    if (group) ids.forEach((id) => { const c = group.choices.find((x) => x.id === id); if (c) out.push(c); });
  });
  return out;
}
function unitPrice(line) {
  const variant = items.get(line.itemId).variants.find((v) => v.id === line.variantId);
  return variant.price + selectedChoices(line).reduce((sum, c) => sum + c.price, 0);
}
function totals() {
  const s = S.menu.settings;
  const subtotal = S.cart.reduce((sum, l) => sum + unitPrice(l) * l.qty, 0);
  const packaging = S.cart.length ? s.packagingFee : 0;
  let fee = 0;
  if (S.mode === 'delivery' && S.cart.length) fee = s.freeDeliveryFrom > 0 && subtotal >= s.freeDeliveryFrom ? 0 : s.deliveryFee;
  const missing = S.mode === 'delivery' ? Math.max(0, s.deliveryMinOrder - subtotal) : 0;
  const total = subtotal + packaging + fee;
  const balance = S.account && s.pay.wallet ? gr(S.account.user.walletBalance) : 0;
  const wallet = S.checkout.useWallet && balance > 0 ? Math.min(balance, total) : 0;
  return { subtotal, packaging, fee, total, missing, wallet, due: total - wallet, balance };
}
const blockedInCart = () => S.cart.filter((l) => !items.get(l.itemId).deliverable);
const qtyOf = (itemId) => S.cart.filter((l) => l.itemId === itemId).reduce((n, l) => n + l.qty, 0);
function addLine(itemId, variantId, options, qty) {
  const key = JSON.stringify([itemId, variantId, options]);
  const same = S.cart.find((l) => JSON.stringify([l.itemId, l.variantId, l.options]) === key);
  if (same) same.qty = Math.min(20, same.qty + qty);
  else S.cart.push({ itemId, variantId, options, qty });
  saveCart();
  renderCart();
  toast(`Dodano: ${items.get(itemId).name}`);
  const add = $(`.item-add[data-add="${CSS.escape(itemId)}"]`);
  if (add) { add.classList.add('bump'); setTimeout(() => add.classList.remove('bump'), 180); }
}
function setMode(mode) {
  S.mode = mode;
  store.set('msb.mode', mode);
  route();
}
function requestMode(mode) {
  if (mode === S.mode) return;
  if (mode === 'delivery' && blockedInCart().length) conflictSheet();
  else setMode(mode);
}

/* --- ekran startowy --- */
function statusPill() {
  const st = S.menu.status;
  if (!S.menu.settings.orderingEnabled) return `<span class="pill is-closed"><i></i>${esc(S.menu.settings.closedMessage || 'Zamówienia online są teraz wyłączone')}</span>`;
  if (st.open && st.accepting) return `<span class="pill"><i></i>Otwarte, zamówienia do ${esc(st.today[1])}</span>`;
  if (st.accepting && st.today) return `<span class="pill"><i></i>Otwieramy o ${esc(st.today[0])}</span>`;
  return '<span class="pill is-closed"><i></i>Dziś już nie przyjmujemy zamówień</span>';
}
const brand = () => `<a class="brand" href="#/" data-home>${esc(S.menu.settings.venueName)}<b>.</b></a>`;

/* --- menu --- */
function priceLabel(item) {
  const prices = item.variants.map((v) => v.price);
  const min = Math.min(...prices);
  if (prices.length > 1 && Math.max(...prices) !== min) return `od ${money(min)}`;
  return min === 0 ? 'Gratis' : money(min);
}
const isBlocked = (item) => S.mode === 'delivery' && !item.deliverable;
function tagsHtml(item) {
  const tags = [];
  if (!item.available) tags.push('<span class="tag">Chwilowo brak</span>');
  if (isBlocked(item)) tags.push('<span class="tag">Tylko odbiór</span>');
  if (item.best) tags.push('<span class="tag tag-new">Polecane</span>');
  return tags.join('');
}
// Miniatura: zdjęcie z panelu, a gdy go brak albo się nie wczyta, ilustracja kategorii
function itemArt(item) {
  const name = item.groupArt || (S.menu.categories.find((c) => c.id === item.category) || {}).img;
  return name ? `/img/zamow/${name}.png` : null;
}
function itemHtml(item) {
  const blocked = isBlocked(item);
  const qty = qtyOf(item.id);
  const art = itemArt(item);
  const thumb = item.photo || art;
  return `<article class="item ${thumb ? 'has-thumb' : ''} ${blocked ? 'is-blocked' : ''} ${item.available ? '' : 'is-out'}">
    <button type="button" class="item-main" data-sheet="${esc(item.id)}" ${item.available ? '' : 'disabled'}>
      <span class="item-text">
        <span class="item-name">${esc(item.name)}</span>
        ${item.description ? `<span class="item-desc">${esc(item.description)}</span>` : ''}
        <span class="item-meta"><span class="price">${priceLabel(item)}</span>${tagsHtml(item)}</span>
      </span>
      ${thumb ? `<span class="item-thumb ${item.photo ? '' : 'is-art'}"><img src="${esc(thumb)}" alt="" loading="lazy" ${item.photo && art ? `data-art="${esc(art)}"` : ''}></span>` : ''}
    </button>
    <button type="button" class="item-add" data-add="${esc(item.id)}" aria-label="${blocked ? `${esc(item.name)}: tylko odbiór osobisty` : `Dodaj: ${esc(item.name)}`}" ${item.available ? '' : 'disabled'}>${blocked ? icon.store : (qty || icon.plus)}</button>
  </article>`;
}
const groupHtml = (list) => `<div class="items">${list.map(itemHtml).join('')}</div>`;
function categoryHtml(cat, query) {
  const list = S.menu.items.filter((i) => i.category === cat.id && (!query || `${i.name} ${i.description}`.toLowerCase().includes(query)));
  if (!list.length) return '';
  const groups = [];
  list.forEach((i) => {
    const last = groups[groups.length - 1];
    if (last && last.name === i.group) last.items.push(i);
    else groups.push({ name: i.group, items: [i] });
  });
  return `<section class="cat" id="cat-${esc(cat.id)}" data-cat="${esc(cat.id)}">
    <div class="cat-head"><h2>${esc(cat.name)}</h2>${cat.note ? `<p class="cat-note">${esc(cat.note)}</p>` : ''}</div>
    ${groups.map((g) => `${g.name ? `<h3 class="group-title">${esc(g.name)}</h3>` : ''}${groupHtml(g.items)}`).join('')}
  </section>`;
}
// Przy dostawie najpierw to, co można zamówić; kategorie tylko z odbiorem lądują na końcu
function orderedCategories() {
  const onlyPickup = (c) => S.menu.items.filter((i) => i.category === c.id).every((i) => !i.deliverable);
  if (S.mode !== 'delivery') return { first: S.menu.categories, rest: [] };
  return { first: S.menu.categories.filter((c) => !onlyPickup(c)), rest: S.menu.categories.filter(onlyPickup) };
}
function menuListHtml() {
  const query = S.q.trim().toLowerCase();
  const { first, rest } = orderedCategories();
  const main = first.map((c) => categoryHtml(c, query)).join('');
  const tail = rest.map((c) => categoryHtml(c, query)).join('');
  const divider = tail ? `<div class="pickup-divider"><div><h2>Tylko z odbiorem osobistym</h2><p>Tych pozycji nie dowozimy, bo źle znoszą transport. Odbierzesz je w lokalu.</p></div>
    ${S.menu.settings.pickupEnabled ? '<button type="button" class="btn btn-ghost" data-switch-pickup>Zmień na odbiór</button>' : ''}</div>` : '';
  if (!main && !tail) return S.q ? `<p class="empty">Nic nie pasuje do „${esc(S.q)}”. Spróbuj innej nazwy, np. burger albo shake.</p>` : '<p class="empty">Menu jest chwilowo puste. Zajrzyj za chwilę.</p>';
  return main + divider + tail;
}
function navLabels() {
  const { first, rest } = orderedCategories();
  return [...first, ...rest];
}
function factsHtml() {
  const s = S.menu.settings;
  const parts = [statusPill()];
  if (S.mode === 'delivery') {
    parts.push(`<span class="pill">Dostawa ${s.deliveryFee ? money(s.deliveryFee) : 'gratis'}</span>`);
    if (s.freeDeliveryFrom > 0 && s.deliveryFee) parts.push(`<span class="pill">Gratis od ${money(s.freeDeliveryFrom)}</span>`);
    if (s.deliveryMinOrder > 0) parts.push(`<span class="pill">Minimum ${money(s.deliveryMinOrder)}</span>`);
    if (s.deliveryPrepMinutes) parts.push(`<span class="pill">Około ${s.deliveryPrepMinutes} min</span>`);
  } else if (s.pickupPrepMinutes) {
    parts.push(`<span class="pill">Gotowe w około ${s.pickupPrepMinutes} min</span>`);
  }
  return parts.join('');
}
// Okładka: zdjęcie ustawione w panelu, a bez niego sam pomarańczowy pas
const coverHtml = (s) => (s.cover ? `<img src="${esc(s.cover)}" alt="">` : '');
function renderShop() {
  const s = S.menu.settings;
  const nav = navLabels();
  $('#app').innerHTML = `<div class="page">
    <div class="cover">${coverHtml(s)}</div>
    <section class="venue">
      <div>
        <div class="venue-top">
          <img class="venue-logo" src="/img/zamow/logo.png" alt="">
          <div><h1>${esc(s.venueName)}</h1><p class="venue-addr">${esc(`${s.address}, ${s.city}`)}</p></div>
        </div>
        <div class="facts">${factsHtml()}</div>
      </div>
      <div class="seg" role="group" aria-label="Sposób odbioru">
        <button type="button" data-mode="delivery" aria-pressed="${S.mode === 'delivery'}" ${s.deliveryEnabled ? '' : 'disabled'}>${icon.moto}Dostawa</button>
        <button type="button" data-mode="pickup" aria-pressed="${S.mode === 'pickup'}" ${s.pickupEnabled ? '' : 'disabled'}>${icon.store}Odbiór</button>
      </div>
    </section>
    <div class="chipbar"><nav class="chips" aria-label="Kategorie">${nav.map((c) => `<button type="button" class="chip" data-goto="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</nav></div>
    <div class="shop">
      <nav class="rail" aria-label="Kategorie">${nav.map((c) => `<button type="button" data-goto="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</nav>
      <main>
        <label class="search">${icon.search}<input id="q" type="search" value="${esc(S.q)}" placeholder="Szukaj w menu" aria-label="Szukaj w menu"></label>
        <div id="menu">${menuListHtml()}</div>
        <p class="fineprint">${s.packagingFee ? `Do zamówienia doliczamy ${money(s.packagingFee)} za opakowania. ` : ''}Informacje o alergenach znajdziesz w <a href="/menu.pdf">menu w PDF</a>. Zamawiając, zbierasz Milkosy w <a href="/app">aplikacji MilkMi</a>.</p>
      </main>
      <aside class="cartwrap" id="cartwrap" aria-label="Twoje zamówienie"></aside>
    </div>
  </div>`;
  $('#q').addEventListener('input', (e) => {
    S.q = e.target.value;
    $('#menu').innerHTML = menuListHtml();
    watchCategories();
  });
  renderCart();
  watchCategories();
}
function refreshBadges() {
  $$('.item:not(.is-blocked) .item-add').forEach((add) => {
    add.innerHTML = qtyOf(add.dataset.add) || icon.plus;
  });
}
// Podświetla w nawigacji kategorię widoczną na ekranie
function watchCategories() {
  if (spy) spy.disconnect();
  spy = new IntersectionObserver((entries) => {
    entries.filter((e) => e.isIntersecting).forEach((e) => {
      const id = e.target.dataset.cat;
      $$('[data-goto]').forEach((b) => b.classList.toggle('is-on', b.dataset.goto === id));
      const chip = $(`.chip[data-goto="${CSS.escape(id)}"]`);
      if (chip && getComputedStyle(chip.parentElement).display !== 'none') {
        chip.parentElement.scrollTo({ left: chip.offsetLeft - 16, behavior: 'smooth' });
      }
    });
  }, { rootMargin: '-25% 0px -70% 0px' });
  $$('.cat').forEach((el) => spy.observe(el));
}

/* --- koszyk: widok --- */
function cartHtml({ editable, closable, withWallet }) {
  const t = totals();
  const st = S.menu.status.modes[S.mode];
  const lines = S.cart.map((l, idx) => {
    const item = items.get(l.itemId);
    const variant = item.variants.find((v) => v.id === l.variantId);
    const subs = [variant.label, ...selectedChoices(l).map((c) => `+ ${c.label}`)].filter(Boolean);
    return `<li class="cart-line">
      <div>
        <div class="cart-name">${editable ? '' : `${l.qty} × `}${esc(item.name)}</div>
        ${subs.length ? `<div class="cart-sub">${subs.map(esc).join('<br>')}</div>` : ''}
        ${editable ? `<div class="stepper"><button type="button" data-dec="${idx}" aria-label="Odejmij: ${esc(item.name)}">−</button><span>${l.qty}</span><button type="button" data-inc="${idx}" aria-label="Dodaj: ${esc(item.name)}">+</button></div>` : ''}
      </div>
      <div class="cart-price">${money(unitPrice(l) * l.qty)}</div>
    </li>`;
  }).join('');
  const closedNote = !S.menu.settings.orderingEnabled
    ? (S.menu.settings.closedMessage || 'Zamówienia online są teraz wyłączone. Menu możesz przeglądać.')
    : (st.enabled ? '' : `${S.mode === 'delivery' ? 'Dostawy' : 'Odbioru'} na dziś już nie przyjmujemy. Menu możesz przeglądać.`);
  const body = S.cart.length ? `<ul class="cart-lines">${lines}</ul>
    <div class="sums">
      <div><span>Produkty</span><span>${money(t.subtotal)}</span></div>
      ${t.packaging ? `<div><span>Opakowania</span><span>${money(t.packaging)}</span></div>` : ''}
      ${S.mode === 'delivery' ? `<div><span>Dostawa</span><span>${t.fee ? money(t.fee) : 'gratis'}</span></div>` : ''}
      ${withWallet && t.wallet ? `<div class="wallet-row"><span>Saldo MilkMi</span><span>−${money(t.wallet)}</span></div>` : ''}
      <div class="total"><span>${withWallet && t.wallet ? 'Do zapłaty' : 'Razem'}</span><span>${money(withWallet ? t.due : t.total)}</span></div>
    </div>
    ${t.missing ? `<p class="min-note">Do minimum na dostawę brakuje ${money(t.missing)}.</p>` : ''}
    ${closedNote ? `<p class="min-note">${esc(closedNote)}</p>` : ''}
    ${editable ? `<button type="button" class="btn btn-block" data-go-checkout ${t.missing || closedNote ? 'disabled' : ''}>Przejdź dalej</button>` : ''}`
    : '<p class="cart-empty">Koszyk jest pusty. Dotknij pozycji w menu, żeby ją dodać.</p>';
  return `<div class="cart">
    <div class="cart-head"><h2>Twoje zamówienie</h2>${closable ? '<button type="button" class="sheet-x" data-close aria-label="Zamknij">×</button>' : ''}</div>
    <p class="cart-mode">${S.mode === 'delivery' ? 'Dostawa' : 'Odbiór osobisty'}</p>
    ${body}
  </div>`;
}
function renderCart() {
  const wrap = $('#cartwrap');
  if (wrap) { wrap.innerHTML = cartHtml({ editable: true }); refreshBadges(); }
  const bar = $('#cartbar');
  const count = S.cart.reduce((n, l) => n + l.qty, 0);
  bar.hidden = !(wrap && count);
  if (count) bar.innerHTML = `<b>${count}</b><span>Zobacz zamówienie</span><span>${money(totals().total)}</span>`;
  const dlg = $('#dlg');
  if (dlg.open && dlg.dataset.kind === 'cart') {
    if (!count) dlg.close();
    else dlg.innerHTML = cartHtml({ editable: true, closable: true });
  }
}

/* --- okna --- */
function openSheet(html, kind) {
  const dlg = $('#dlg');
  dlg.dataset.kind = kind;
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
}
const sheetHead = (title) => `<div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="sheet-x" data-close aria-label="Zamknij">×</button></div>`;
function itemSheet(item) {
  const draft = { variantId: item.variants[0].id, options: {}, qty: 1 };
  const draw = () => {
    const line = { itemId: item.id, variantId: draft.variantId, options: draft.options };
    const variants = item.variants.length > 1 ? `<fieldset><legend>Wybierz wariant</legend>${item.variants.map((v) => `
      <label class="opt"><input type="radio" name="variant" value="${esc(v.id)}" ${v.id === draft.variantId ? 'checked' : ''}><span>${esc(v.label)}</span><small>${money(v.price)}</small></label>`).join('')}</fieldset>` : '';
    const groups = item.options.map((gid) => {
      const g = S.menu.optionGroups[gid];
      const locked = g.requires && !(draft.options[g.requires] || []).length;
      const none = g.type === 'single' ? `<label class="opt ${locked ? 'is-off' : ''}"><input type="radio" name="${esc(gid)}" value="" ${(draft.options[gid] || []).length ? '' : 'checked'} ${locked ? 'disabled' : ''}><span>${gid === 'set' ? 'Bez zestawu' : (gid === 'set_drink' ? 'Bez napoju' : 'Bez dodatku')}</span></label>` : '';
      return `<fieldset><legend>${esc(g.label)}</legend>${g.hint ? `<p class="hint">${esc(g.hint)}</p>` : ''}${none}${g.choices.map((c) => `
        <label class="opt ${locked ? 'is-off' : ''}"><input type="${g.type === 'single' ? 'radio' : 'checkbox'}" name="${esc(gid)}" value="${esc(c.id)}" ${(draft.options[gid] || []).includes(c.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${esc(c.label)}</span>${c.price ? `<small>+${money(c.price)}</small>` : ''}</label>`).join('')}</fieldset>`;
    }).join('');
    const dlg = $('#dlg');
    const scroll = dlg.scrollTop;
    const art = itemArt(item);
    openSheet(`<form id="itemform">
      ${item.photo
        ? `<button type="button" class="sheet-photo" data-zoom="${esc(item.id)}" aria-label="Pokaż zdjęcie na pełnym ekranie"><img src="${esc(item.photo)}" alt="${esc(item.name)}" ${art ? `data-art="${esc(art)}"` : ''}><span class="zoom-ic">${icon.expand}</span></button>`
        : (art ? `<img class="sheet-art" src="${esc(art)}" alt="">` : '')}
      ${sheetHead(item.name)}
      <div class="sheet-body">${item.description ? `<p>${esc(item.description)}</p>` : ''}${variants}${groups}</div>
      <div class="sheet-foot">${isBlocked(item)
        ? `<button type="button" class="btn" data-switch-add="${esc(item.id)}">Tylko odbiór: zmień na odbiór</button>`
        : `<span class="qty"><button type="button" data-q="-1" aria-label="Mniej">−</button><output>${draft.qty}</output><button type="button" data-q="1" aria-label="Więcej">+</button></span>
        <button type="submit" class="btn">Dodaj za ${money(unitPrice(line) * draft.qty)}</button>`}
      </div></form>`, 'item');
    dlg.scrollTop = scroll;
    const form = $('#itemform');
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'variant') draft.variantId = t.value;
      else if (t.type === 'radio') {
        draft.options[t.name] = t.value ? [t.value] : [];
        if (!t.value) Object.keys(draft.options).forEach((k) => { if (S.menu.optionGroups[k] && S.menu.optionGroups[k].requires === t.name) draft.options[k] = []; });
      } else draft.options[t.name] = $$(`input[name="${t.name}"]:checked`, form).map((x) => x.value);
      draw();
    });
    form.addEventListener('click', (e) => {
      const q = e.target.closest('[data-q]');
      if (!q) return;
      draft.qty = Math.min(20, Math.max(1, draft.qty + Number(q.dataset.q)));
      draw();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const options = Object.fromEntries(Object.entries(draft.options).filter(([, v]) => v.length));
      addLine(item.id, draft.variantId, options, draft.qty);
      dlg.close();
    });
  };
  draw();
}
function openItem(item) {
  if (item.variants.length > 1 || item.options.length) itemSheet(item);
  else addLine(item.id, item.variants[0].id, {}, 1);
}
function openZoom(item) {
  const dlg = $('#zoom');
  dlg.innerHTML = `<img src="${esc(item.photo)}" alt="${esc(item.name)}" data-close-zoom>
    <button type="button" class="zoom-x" data-close-zoom aria-label="Zamknij zdjęcie">×</button>
    <div class="zoom-bar"><strong>${esc(item.name)}</strong><span>${priceLabel(item)}</span></div>`;
  dlg.showModal();
}
function pickupOnlySheet(item) {
  const can = S.menu.settings.pickupEnabled;
  openSheet(`${sheetHead(`${item.name}: tylko odbiór`)}
    <div class="sheet-body"><p>Tej pozycji nie dowozimy. Zmień na odbiór osobisty, a resztę koszyka zachowamy.</p></div>
    <div class="sheet-foot">
      ${can ? `<button type="button" class="btn" data-switch-add="${esc(item.id)}">Zmień na odbiór</button>` : ''}
      <button type="button" class="btn btn-ghost" data-close>Zostaw dostawę</button>
    </div>`, 'pickup');
}
function conflictSheet() {
  const blocked = blockedInCart();
  openSheet(`${sheetHead('Tego nie dowozimy')}
    <div class="sheet-body"><p>Te pozycje z koszyka są tylko z odbiorem osobistym:</p>
      <ul class="block-list">${blocked.map((l) => `<li>${l.qty} × ${esc(items.get(l.itemId).name)}</li>`).join('')}</ul>
    </div>
    <div class="sheet-foot">
      <button type="button" class="btn" data-close>Zostań przy odbiorze</button>
      <button type="button" class="btn btn-ghost" data-remove-blocked>Usuń je i wybierz dostawę</button>
    </div>`, 'conflict');
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), 1800);
}

/* --- finalizacja --- */
const PAYMENTS = [
  ['online', 'Online', 'BLIK, przelew, karta'],
  ['card', 'Kartą', 'przy odbiorze'],
  ['cash', 'Gotówką', 'przy odbiorze']
];
function renderCheckout(error, fieldError) {
  if (!S.cart.length || !S.mode) { location.hash = '#/'; return; }
  const c = S.checkout;
  const delivery = S.mode === 'delivery';
  if (delivery && blockedInCart().length) { setMode('pickup'); return; }
  if (S.account && !c.name) c.name = S.account.user.name || S.account.user.username || '';
  if (S.account && !c.phone) c.phone = S.account.user.phone || '';
  const slotInfo = S.menu.status.modes[S.mode];
  const time = c.time && (slotInfo.slots.includes(c.time) || (c.time === 'asap' && slotInfo.asap)) ? c.time : (slotInfo.asap ? 'asap' : slotInfo.slots[0]);
  const pays = PAYMENTS.filter(([id]) => S.menu.settings.pay[id]);
  const payment = pays.some(([id]) => id === c.payment) ? c.payment : (pays[0] || [])[0];
  const t = totals();
  const f = (name, label, attrs = '') => `<label class="field ${fieldError === name ? 'has-error' : ''}"><span>${label}</span><input name="${name}" value="${esc(c[name] || '')}" ${attrs}>${fieldError === name ? `<div class="field-error">${esc(error)}</div>` : ''}</label>`;
  const venue = S.menu.settings;
  const walletBox = t.balance > 0 ? `<label class="wallet-pick"><input type="checkbox" name="useWallet" ${c.useWallet ? 'checked' : ''}><span><b>Zapłać saldem MilkMi</b><small>Masz ${money(t.balance)} do wydania</small></span></label>` : '';
  const fullWallet = t.wallet > 0 && t.due === 0;
  $('#app').innerHTML = `<header class="top"><div class="page-top"><a class="icon-btn" href="#/" aria-label="Wróć do menu">${icon.back}</a><h1>${delivery ? 'Zamówienie z dostawą' : 'Zamówienie z odbiorem'}</h1></div></header>
    <div class="checkout">
    <form id="orderform" novalidate>
      <section class="panel"><h2>Twoje dane</h2>
        <div class="grid2">${f('name', 'Imię', 'autocomplete="given-name" required')}${f('phone', 'Telefon', 'type="tel" autocomplete="tel" inputmode="tel" required')}</div>
        <p class="hint">${S.account ? `Zamawiasz jako ${esc(S.account.user.name || '')} z MilkMi: Milkosy dopiszemy po wydaniu zamówienia.` : 'Masz konto MilkMi na ten numer? Milkosy dopiszemy po wydaniu zamówienia.'}</p>
      </section>
      ${delivery ? `<section class="panel"><h2>Adres dostawy</h2>
        ${f('street', 'Ulica i numer domu', 'autocomplete="address-line1" required')}
        <div class="grid2">${f('flat', 'Mieszkanie (opcjonalnie)', 'autocomplete="address-line2"')}${f('city', 'Miejscowość', 'autocomplete="address-level2" required')}</div>
      </section>` : ''}
      <section class="panel"><h2>${delivery ? 'Kiedy dowieźć' : `Kiedy odbierzesz: ${esc(venue.address)}`}</h2>
        <label class="field"><select name="time" aria-label="Godzina">
          ${slotInfo.asap ? `<option value="asap" ${time === 'asap' ? 'selected' : ''}>Jak najszybciej</option>` : ''}
          ${slotInfo.slots.map((x) => `<option value="${x}" ${time === x ? 'selected' : ''}>Dziś, ${x}</option>`).join('')}
        </select></label>
      </section>
      <section class="panel"><h2>Płatność</h2>
        ${walletBox}
        ${fullWallet ? '<p class="hint">Całość zapłacisz saldem MilkMi.</p>' : `<div class="tiles">${pays.map(([id, label, sub]) => `<label class="tile"><input type="radio" name="payment" value="${id}" ${payment === id ? 'checked' : ''}><span>${label}<small>${id === 'online' ? sub : (delivery ? 'u kuriera' : sub)}</small></span></label>`).join('')}</div>`}
        ${!pays.length && !fullWallet ? '<p class="min-note">Płatności są chwilowo wyłączone. Zadzwoń do lokalu.</p>' : ''}
      </section>
      <section class="panel"><h2>Uwagi</h2>
        <label class="field"><textarea name="note" rows="2" maxlength="500" placeholder="Alergie, kod do domofonu (opcjonalnie)" aria-label="Uwagi do zamówienia">${esc(c.note || '')}</textarea></label>
      </section>
      ${error && !fieldError ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
      <button class="btn btn-block" type="submit" ${!pays.length && !fullWallet ? 'disabled' : ''}>${payment === 'online' && !fullWallet ? 'Zamawiam i płacę' : 'Złóż zamówienie'} ${money(t.due)}</button>
      <p class="privacy">Dane wykorzystamy tylko do realizacji tego zamówienia. <a href="/privacypolicy.html">Polityka prywatności</a></p>
    </form>
    <aside>${cartHtml({ editable: false, withWallet: true })}</aside>
  </div>`;
  $('#cartbar').hidden = true;
  const form = $('#orderform');
  form.addEventListener('submit', submitOrder);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'useWallet') { S.checkout = { ...S.checkout, ...Object.fromEntries(new FormData(form)), useWallet: e.target.checked }; renderCheckout(); }
    if (e.target.name === 'payment') { S.checkout.payment = e.target.value; const b = $('[type=submit]', form); b.textContent = `${e.target.value === 'online' ? 'Zamawiam i płacę' : 'Złóż zamówienie'} ${money(totals().due)}`; }
  });
  if (fieldError) { const el = $(`[name="${fieldError}"]`); if (el) el.focus(); }
}

// Pozycja koszyka w formacie serwera (cena liczona i sprawdzana po stronie serwera)
function serverLine(l) {
  const item = items.get(l.itemId);
  const variant = item.variants.find((v) => v.id === l.variantId);
  const opts = l.options || {};
  const set = opts.set && opts.set.length ? { side: 'Frytki', drink: ((S.menu.optionGroups.set_drink.choices.find((c) => c.id === (opts.set_drink || [])[0]) || {}).label) || 'Bez napoju' } : null;
  const addonGroup = `ad_${item.id}`;
  const addonIds = opts[addonGroup] || [];
  const subs = [set ? `Zestaw: frytki${set.drink !== 'Bez napoju' ? `, ${set.drink}` : ''}` : '', ...selectedChoices(l).filter((c) => S.menu.optionGroups[addonGroup] && S.menu.optionGroups[addonGroup].choices.includes(c)).map((c) => `+ ${c.label}`)].filter(Boolean);
  return {
    id: `${item.id}|${l.variantId}|${JSON.stringify(opts)}`, productId: item.id, type: 'product',
    name: variant.label ? `${item.name} (${variant.label})` : item.name, variant: variant.raw,
    price: unitPrice(l) / 100, quantity: l.qty, desc: subs.join(', '), addonIds, set
  };
}
async function submitOrder(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  data.useWallet = Boolean(form.useWallet && form.useWallet.checked);
  S.checkout = { ...S.checkout, ...data };
  store.set('msb.checkout', { name: data.name, phone: data.phone, street: data.street, flat: data.flat, city: data.city, payment: data.payment, useWallet: data.useWallet });
  const delivery = S.mode === 'delivery';
  if (String(data.name || '').trim().length < 2) return renderCheckout('Podaj imię.', 'name');
  if (String(data.phone || '').replace(/\D/g, '').length < 9) return renderCheckout('Podaj numer telefonu z 9 cyframi.', 'phone');
  if (delivery && String(data.street || '').trim().length < 3) return renderCheckout('Podaj ulicę i numer domu.', 'street');
  if (delivery && String(data.city || '').trim().length < 2) return renderCheckout('Podaj miejscowość.', 'city');
  const t = totals();
  const button = $('[type=submit]', form);
  button.disabled = true;
  button.textContent = 'Wysyłam zamówienie…';
  // Ten sam identyfikator przy ponownej próbie: serwer nie utworzy duplikatu
  let clientOrderId = store.get('msb.cartId', null);
  if (!clientOrderId) { clientOrderId = (crypto.randomUUID ? crypto.randomUUID() : `o-${Date.now()}-${Math.random().toString(36).slice(2)}`); store.set('msb.cartId', clientOrderId); }
  try {
    const order = await api('/api/orders', { method: 'POST', auth: true, body: {
      clientOrderId, location: LOCATION, source: 'web',
      customerName: data.name.trim(), customerPhone: data.phone.trim(),
      deliveryMethod: S.mode,
      deliveryAddress: delivery ? [data.street, data.flat ? `m. ${data.flat}` : '', data.city].filter(Boolean).join(', ') : '',
      pickupTime: data.time === 'asap' ? 'jak najszybciej' : data.time, pickupDay: 'today',
      paymentMethod: t.wallet > 0 && t.due === 0 ? 'cash' : (data.payment || 'cash'),
      walletAmount: t.wallet / 100, notes: String(data.note || '').trim(),
      items: S.cart.map(serverLine), totalAmount: t.total / 100
    } });
    store.set('msb.lastOrder', order.orderId);
    S.cart = [];
    saveCart();
    S.checkout.note = '';
    if (order.redirectUrl) { location.href = order.redirectUrl; return; }
    location.hash = `#/status/${order.orderId}`;
  } catch (err) {
    const code = err.data && err.data.code;
    if (['price_changed', 'closed', 'pickup_only', 'payment', 'wallet_low', 'min_order'].includes(code) || err.status === 409) { await loadMenu(); await loadAccount(); }
    renderCheckout(err.message);
  }
}

/* --- śledzenie zamówienia --- */
async function renderStatus(id) {
  $('#cartbar').hidden = true;
  const draw = async () => {
    let o;
    try { o = (await api(`/api/orders/${id}`)).data; } catch (err) {
      $('#app').innerHTML = '<div class="status-page"><h1>Nie znaleziono zamówienia</h1><p class="lead">Sprawdź link albo <a href="#/">wróć do menu</a>.</p></div>';
      clearInterval(pollTimer);
      return;
    }
    const delivery = o.deliveryMethod === 'delivery';
    const v = S.menu.settings;
    const where = `${v.address}, ${v.city}`;
    const steps = [
      ['pending', 'Zamówienie wysłane', 'Lokal zaraz je potwierdzi.'],
      ['preparing', 'Przygotowujemy', ''],
      ['ready', delivery ? 'W drodze do Ciebie' : 'Gotowe do odbioru', delivery ? '' : where],
      ['completed', delivery ? 'Dostarczone' : 'Odebrane', '']
    ];
    const at = steps.findIndex((s) => s[0] === o.status);
    const when = !o.pickupTime || o.pickupTime === 'jak najszybciej' ? 'jak najszybciej' : `${o.pickupDay === 'tomorrow' ? 'jutro' : 'dziś'}, ${o.pickupTime}`;
    const payLabel = { online: 'online', cash: 'gotówką', card: 'kartą', prepaid: 'saldem w lokalu', wallet: 'saldem MilkMi' }[o.paymentMethod] || '';
    const due = o.amountDue !== undefined && o.amountDue !== null ? o.amountDue : o.totalAmount;
    let progress;
    if (o.status === 'cancelled') progress = '<div class="form-error">Zamówienie zostało anulowane. Jeśli płaciłeś saldem MilkMi, wróciło na konto.</div>';
    else if (o.status === 'awaiting_payment') progress = `<section class="panel"><h2>Czekamy na potwierdzenie płatności</h2><p class="lead">To zwykle trwa chwilę. Strona odświeży się sama.</p></section>`;
    else progress = `<section class="panel"><ol class="steps">${steps.map((s, i) => `<li class="${i < at ? 'done' : (i === at ? 'now' : '')}" ${i === at ? 'aria-current="step"' : ''}>${esc(s[1])}${s[2] && i === at ? `<small>${esc(s[2])}</small>` : ''}</li>`).join('')}</ol></section>`;
    $('#app').innerHTML = `<div class="status-page">
      <div class="gate-top" style="margin-bottom:20px">${brand()}</div>
      <h1>Zamówienie ${esc(o.orderNumber)}</h1>
      <p class="lead" style="margin-bottom:18px">${delivery ? 'Dostawa' : `Odbiór: ${esc(where)}`}, ${esc(when)}. ${o.walletUsed ? `Saldem MilkMi zapłacono ${money(gr(o.walletUsed))}. ` : ''}${due > 0 ? `Do zapłaty ${money(gr(due))}${payLabel && o.paymentMethod !== 'online' ? ` ${payLabel}` : ''}.` : ''}</p>
      ${progress}
      <section class="panel"><h2>Zamówione</h2><ul class="block-list">${(o.items || []).map((l) => `<li>${l.quantity} × ${esc(l.name)}${l.desc ? `<div class="cart-sub">${esc(l.desc)}</div>` : ''}</li>`).join('')}</ul></section>
      ${o.pointsAwarded > 0 ? `<p class="lead" style="margin-bottom:14px">Za to zamówienie dostałeś ${o.pointsAwarded} Milkosów w <a href="/app">MilkMi</a>.</p>` : ''}
      <a class="btn btn-ghost btn-block" href="#/">Wróć do menu</a>
    </div>`;
    if (['completed', 'cancelled'].includes(o.status)) clearInterval(pollTimer);
  };
  await draw();
  pollTimer = setInterval(draw, 10000);
}

/* --- nawigacja i zdarzenia --- */
function route() {
  clearInterval(pollTimer);
  if (spy) spy.disconnect();
  const status = location.hash.match(/^#\/status\/([a-f0-9]{24})$/);
  if (status) return renderStatus(status[1]);
  if (location.hash === '#/zamowienie') { window.scrollTo(0, 0); return renderCheckout(); }
  return renderShop();
}

// Zdjęcie, które się nie wczytało, zamieniamy na ilustrację kategorii
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.dataset.art && !img.dataset.fallback) {
    img.dataset.fallback = '1';
    img.src = img.dataset.art;
    const box = img.closest('.item-thumb');
    if (box) box.classList.add('is-art');
  }
}, true);

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-close-zoom]') || t.id === 'zoom') { $('#zoom').close(); return; }
  const zoom = t.closest('[data-zoom]');
  if (zoom) { openZoom(items.get(zoom.dataset.zoom)); return; }
  const modeBtn = t.closest('[data-mode]');
  if (modeBtn) { requestMode(modeBtn.dataset.mode); return; }
  if (t.closest('[data-switch-pickup]')) { setMode('pickup'); return; }
  const go = t.closest('[data-goto]');
  if (go) { const sec = $(`#cat-${CSS.escape(go.dataset.goto)}`); if (sec) sec.scrollIntoView({ behavior: 'smooth' }); return; }
  const add = t.closest('[data-add]');
  if (add) {
    const item = items.get(add.dataset.add);
    if (isBlocked(item)) pickupOnlySheet(item);
    else openItem(item);
    return;
  }
  const sheet = t.closest('[data-sheet]');
  if (sheet) { itemSheet(items.get(sheet.dataset.sheet)); return; }
  const inc = t.closest('[data-inc]');
  const dec = t.closest('[data-dec]');
  if (inc || dec) {
    const line = S.cart[Number((inc || dec).dataset[inc ? 'inc' : 'dec'])];
    line.qty = Math.min(20, line.qty + (inc ? 1 : -1));
    if (line.qty < 1) S.cart.splice(S.cart.indexOf(line), 1);
    saveCart();
    renderCart();
    return;
  }
  if (t.closest('[data-go-checkout]')) {
    if ($('#dlg').open) $('#dlg').close();
    location.hash = '#/zamowienie';
    return;
  }
  const switchAdd = t.closest('[data-switch-add]');
  if (switchAdd) {
    const item = items.get(switchAdd.dataset.switchAdd);
    $('#dlg').close();
    setMode('pickup');
    itemSheet(item);
    return;
  }
  if (t.closest('[data-remove-blocked]')) {
    S.cart = S.cart.filter((l) => items.get(l.itemId).deliverable);
    saveCart();
    $('#dlg').close();
    setMode('delivery');
    return;
  }
  if (t.closest('[data-close]')) { $('#dlg').close(); return; }
  if (t.id === 'dlg') $('#dlg').close();
});
$('#cartbar').addEventListener('click', () => openSheet(cartHtml({ editable: true, closable: true }), 'cart'));
window.addEventListener('hashchange', route);

// Powrót z płatności PayU: /zamow?zamowienie=<id> pokazuje status tego zamówienia
(function backFromPayment() {
  const id = new URLSearchParams(location.search).get('zamowienie');
  if (id && /^[a-f0-9]{24}$/.test(id)) {
    history.replaceState(null, '', `/zamow#/status/${id}`);
  }
})();
try { fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 'zamow' }) }); } catch (e) { /* bez statystyk */ }

Promise.all([loadMenu(), loadAccount()]).then(route).catch((err) => {
  $('#app').innerHTML = `<p class="loading">${esc(err.message)}</p>`;
});
