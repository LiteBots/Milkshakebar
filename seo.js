'use strict';
// Podstrony dla klientów i Google: lokale, kategorie menu, MilkMi, dostawa, regulaminy, karty podarunkowe.
// HTML powstaje na serwerze, więc wyszukiwarka widzi treść bez uruchamiania JavaScriptu.
const fs = require('fs');
const path = require('path');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${Number(n || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const money0 = (n) => `${Number(n || 0).toLocaleString('pl-PL', { maximumFractionDigits: 2 })} zł`;

const SOCIAL = ['https://www.facebook.com/milkshakebar', 'https://www.instagram.com/milkshake_slupsk', 'https://www.tiktok.com/@milkshake.bar.sup'];
const LOCATIONS = {
  slupsk: {
    key: 'slupsk', slug: 'slupsk', name: 'Słupsk', street: 'ul. Szczecińska 17', streetSchema: 'Szczecińska 17', postal: '76-200', city: 'Słupsk',
    mapsQuery: 'Milkshakebar Szczecińska 17 Słupsk', seasonal: false,
    title: 'Milkshakebar Słupsk – shake, burgery i desery, ul. Szczecińska 17',
    description: 'Milkshakebar w Słupsku przy ul. Szczecińskiej 17: shake na włoskich lodach, burgery, tex-mex, desery i kawa. Godziny otwarcia, dojazd, zamówienia online i rezerwacje.'
  },
  rowy: {
    key: 'rowy', slug: 'rowy', name: 'Rowy', street: 'ul. Wydmowa 2 (deptak)', streetSchema: 'Wydmowa 2', postal: '76-212', city: 'Rowy',
    mapsQuery: 'Wydmowa 2 Rowy', seasonal: true,
    title: 'Milkshakebar Rowy – shake i lody nad morzem, ul. Wydmowa 2',
    description: 'Sezonowy Milkshakebar w Rowach, na deptaku przy ul. Wydmowej 2: shake na włoskich lodach, desery i coś na ciepło po plaży. Godziny w sezonie i dojazd.'
  }
};
const CATEGORIES = [
  { slug: 'shake', name: 'Shake', ids: ['shakes', 'shakes_klasyczne', 'shakes_owocowe', 'shakes_vip', 'shakes_best'], h1: 'Shake na włoskich lodach', intro: 'Klasyczne, owocowe, Best of i edycje dla VIP-ów, 300 ml. Shake wydajemy na miejscu i z odbiorem osobistym, bo w dostawie by się roztopiły.' },
  { slug: 'burgery', name: 'Burgery', ids: ['burgery'], h1: 'Burgery', intro: 'Mały (85 g) albo duży (160 g). Do każdego dobierzesz zestaw z frytkami, sałatką lub chilli.' },
  { slug: 'startery', name: 'Startery', ids: ['startery', 'lunch_startery'], h1: 'Startery i przekąski', intro: 'Frytki, nachos, krewetki w tempurze, skrzydełka: na początek albo do podzielenia się.' },
  { slug: 'hot-dogi', name: 'Hot-dogi', ids: ['hotdogi'], h1: 'Hot-dogi w bagietce brioche', intro: 'Hot-dogi w maślanej bagietce brioche, dostępne w zestawach.' },
  { slug: 'kanapki', name: 'Kanapki', ids: ['kanapki', 'lunch_kanapki'], h1: 'Kanapki', intro: 'Club sandwich, bagietki i kanapki na chlebie pszenno-żytnim, dostępne w zestawie.' },
  { slug: 'salaty', name: 'Sałaty', ids: ['salaty', 'mexico_salaty'], h1: 'Sałaty', intro: 'Cezar, Chica i Orient express.' },
  { slug: 'dania-glowne', name: 'Dania główne', ids: ['dania_glowne'], h1: 'Dania główne', intro: 'Tatar, stek z polędwicy argentyńskiej, rumsztyk, sznycel i żeberko.' },
  { slug: 'pasta', name: 'Pasta', ids: ['pasta', 'mexico_pasta'], h1: 'Pasta', intro: 'Arrabbiata, tagliatelle z krewetkami, Fisherman pasta i NY Chinatown.' },
  { slug: 'tex-mex', name: 'Tex-mex', ids: ['mexico', 'mexico_tapas', 'mexico_quesadillas', 'mexico_burrito', 'mexico_fajita'], h1: 'Tex-mex: tapas, quesadillas, burrito i fajita', intro: 'Tapas, quesadillas, burrito i fajita.' },
  { slug: 'desery', name: 'Desery', ids: ['desery', 'desery_wloskie', 'desery_lodowe', 'desery_gofry', 'desery_pancakes', 'desery_churros', 'mexico_churros'], h1: 'Desery: lody włoskie, gofry, pancakes i churros', intro: 'Lody włoskie, desery lodowe, gofry amerykańskie, pancakes i churros.' },
  { slug: 'kawa-i-napoje', name: 'Kawa i napoje', ids: ['napoje', 'kawa', 'kawa_mrozona', 'matcha', 'herbata', 'lemoniady', 'soki', 'smoothie', 'proteiny'], h1: 'Kawa, matcha i napoje', intro: 'Kawa, mrożona kawa, matcha i ube, herbata, lemoniady, świeże soki, smoothie i shake proteinowe.' }];
const DAYS = [['mon', 'Poniedziałek', 'Monday'], ['tue', 'Wtorek', 'Tuesday'], ['wed', 'Środa', 'Wednesday'], ['thu', 'Czwartek', 'Thursday'], ['fri', 'Piątek', 'Friday'], ['sat', 'Sobota', 'Saturday'], ['sun', 'Niedziela', 'Sunday']];
const WEEKDAY_NAMES = ['', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob', 'nd'];

module.exports = function registerSeo(app, ctx) {
  const { APP_URL, PUBLIC_DIR, asyncRoute } = ctx;
  const abs = (p) => `${APP_URL}${p}`;

  // --- układ strony ---
  function layout({ title, description, canonical, body, jsonld = [], active = '', noindex = false, extraHead = '' }) {
    const nav = [['/menu', 'Menu', 'menu'], ['/zamow', 'Zamów', 'zamow'], ['/slupsk', 'Słupsk', 'slupsk'], ['/rowy', 'Rowy', 'rowy'], ['/milkmi', 'MilkMi', 'milkmi'], ['/karty-podarunkowe', 'Karty podarunkowe', 'karty']];
    return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(abs(canonical))}">`}
<meta property="og:type" content="website">
<meta property="og:locale" content="pl_PL">
<meta property="og:site_name" content="Milkshakebar">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(abs(canonical))}">
<meta property="og:image" content="${esc(abs('/icons/icon-512.png'))}">
<meta name="theme-color" content="#F4F4F0">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
<link rel="stylesheet" href="/site.css">
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
${extraHead}
</head>
<body>
<header class="site">
  <div class="wrap nav">
    <a class="brand" href="/">Milkshakebar<b>.</b></a>
    <ul>${nav.map(([href, label, key]) => `<li><a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a></li>`).join('')}</ul>
    <span class="sp"></span>
    <a class="btn btn-w hide-sm" href="/app"><i class="fas fa-user"></i>MilkMi</a>
    <a class="btn btn-o" href="/zamow"><i class="fas fa-bag-shopping"></i>Zamów</a>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site">
  <div class="wrap">
    <div class="fgrid">
      <div><span class="brand" style="color:#fff">Milkshakebar<b>.</b></span><p>The Legendary Milkshake Bar. Słupsk, ul. Szczecińska 17, a latem także Rowy.</p>
        <div class="soc">
          <a href="${SOCIAL[0]}" target="_blank" rel="noopener" aria-label="Facebook"><i class="fab fa-facebook-f"></i></a>
          <a href="${SOCIAL[1]}" target="_blank" rel="noopener" aria-label="Instagram"><i class="fab fa-instagram"></i></a>
          <a href="${SOCIAL[2]}" target="_blank" rel="noopener" aria-label="TikTok"><i class="fab fa-tiktok"></i></a>
        </div></div>
      <div><h4>Menu</h4><ul>${CATEGORIES.slice(0, 6).map((c) => `<li><a href="/menu/${c.slug}">${esc(c.name)}</a></li>`).join('')}<li><a href="/menu">Całe menu</a></li></ul></div>
      <div><h4>Dla gości</h4><ul><li><a href="/zamow">Zamów online</a></li><li><a href="/dostawa">Dostawa i odbiór</a></li><li><a href="/slupsk">Lokal Słupsk</a></li><li><a href="/rowy">Lokal Rowy</a></li><li><a href="/milkmi">Program MilkMi</a></li><li><a href="/karty-podarunkowe">Karty podarunkowe</a></li></ul></div>
      <div><h4>Informacje</h4><ul><li><a href="/regulamin-milkmi">Regulamin MilkMi</a></li><li><a href="/privacypolicy.html">Polityka prywatności</a></li><li><a href="/cookies">Cookies</a></li><li><a href="/menu.pdf">Alergeny (PDF)</a></li></ul></div>
    </div>
    <div class="fb"><span>© ${new Date().getFullYear()} Milkshakebar</span><span>Słupsk, ul. Szczecińska 17</span><a class="velio" href="https://www.velioagency.pl" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:#92929C;text-decoration:none;"><svg viewBox="264 359 896 737" width="19" height="16" role="img" aria-label="VELIO" style="flex:none"><path fill="#F2F2F4" d="M264 359h211l237 500v237z"/><path fill="#755CFF" d="M948 359h212L712 1096V859z"/></svg><span>Designed &amp; Developed by VELIO</span></a></div>
  </div>
</footer>
</body>
</html>`;
  }
  const send = (res, html, status = 200) => { res.status(status).set('Cache-Control', 'no-cache').type('html').send(html); };
  const crumbs = (items) => `<ol class="crumbs" aria-label="Okruszki">${items.map(([href, label]) => `<li>${href ? `<a href="${href}">${esc(label)}</a>` : esc(label)}</li>`).join('')}</ol>`;
  const crumbsLd = (items) => ({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map(([href, label], i) => ({ '@type': 'ListItem', position: i + 1, name: label, item: abs(href || '/') }))
  });

  // --- dane z bazy ---
  async function hoursFor(key) {
    const { LocationHours } = ctx.models();
    const doc = await LocationHours.findOne({ location: key }).catch(() => null);
    return doc && doc.schedule ? doc.schedule : null;
  }
  function hoursLd(schedule) {
    if (!schedule) return undefined;
    return DAYS.filter(([d]) => schedule[d] && schedule[d].isOpen).map(([d, , en]) => ({
      '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${en}`, opens: schedule[d].from, closes: schedule[d].to
    }));
  }
  function restaurantLd(loc, schedule) {
    return {
      '@context': 'https://schema.org', '@type': 'Restaurant', '@id': abs(`/${loc.slug}#lokal`),
      name: `Milkshakebar ${loc.name}`, url: abs(`/${loc.slug}`), image: abs('/icons/icon-512.png'), logo: abs('/icons/icon-512.png'),
      address: { '@type': 'PostalAddress', streetAddress: loc.streetSchema, postalCode: loc.postal, addressLocality: loc.city, addressCountry: 'PL' },
      servesCuisine: ['Shake', 'Desery', 'Burgery', 'Tex-mex', 'Kawa'], hasMenu: abs('/menu'),
      acceptsReservations: 'True', sameAs: SOCIAL, openingHoursSpecification: hoursLd(schedule),
      potentialAction: { '@type': 'OrderAction', target: abs('/zamow') }
    };
  }
  async function productsFor(ids, location = 'slupsk') {
    const { Product } = ctx.models();
    return Product.find({
      categoryId: { $in: ids }, isAvailable: { $ne: false },
      $or: [{ location }, { location: { $exists: false } }, { location: null }, { location: '' }]
    }).sort({ isBestseller: -1, name: 1 }).lean().catch(() => []);
  }
  const priceText = (p) => (p.variants && p.variants.length ? `od ${money(Math.min(...p.variants.map((v) => Number(v.price) || 0)))}` : money(p.price));
  const itemCard = (p) => `<article class="mi">
      <img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy" decoding="async" width="400" height="300">
      <div class="in">
        <div class="tags">${p.isBestseller ? '<span class="tag">Polecane</span>' : ''}${p.pickupOnly ? '<span class="tag o">Tylko odbiór</span>' : ''}</div>
        <h3>${esc(p.name)}</h3>
        ${p.description ? `<p>${esc(p.description)}</p>` : '<p></p>'}
        ${p.variants && p.variants.length > 1 ? `<div class="vars">${p.variants.map((v) => `${esc(v.name)} ${money0(v.price)}`).join(' · ')}</div>` : ''}
        <div class="pr">${priceText(p)}</div>
      </div>
    </article>`;
  const hoursTable = (schedule, todayKey) => `<table class="hours">${DAYS.map(([d, pl]) => {
    const s = schedule && schedule[d];
    return `<tr${d === todayKey ? ' class="today"' : ''}><td>${pl}</td><td>${s && s.isOpen ? `${esc(s.from)}–${esc(s.to)}` : 'zamknięte'}</td></tr>`;
  }).join('')}</table>`;
  const todayKey = () => {
    const wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', weekday: 'short' }).format(new Date()).toLowerCase().slice(0, 3);
    return wd;
  };
  const catLinks = (activeSlug) => `<nav class="cats" aria-label="Kategorie menu">${CATEGORIES.map((c) => `<a href="/menu/${c.slug}"${c.slug === activeSlug ? ' aria-current="page"' : ''}>${esc(c.name)}</a>`).join('')}</nav>`;

  // --- strona główna: dane strukturalne obu lokali i znaczniki dla udostępniania ---
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  let indexHtml = null;
  app.get(['/', '/index.html'], asyncRoute(async (req, res) => {
    if (indexHtml === null) indexHtml = fs.readFileSync(indexFile, 'utf8');
    const [hs, hr] = await Promise.all([hoursFor('slupsk'), hoursFor('rowy')]);
    const ld = [
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Milkshakebar', url: abs('/'), logo: abs('/icons/icon-512.png'), sameAs: SOCIAL },
      restaurantLd(LOCATIONS.slupsk, hs), restaurantLd(LOCATIONS.rowy, hr)
    ];
    const head = `<link rel="canonical" href="${esc(abs('/'))}">
<meta property="og:type" content="website"><meta property="og:locale" content="pl_PL"><meta property="og:site_name" content="Milkshakebar">
<meta property="og:title" content="Milkshakebar Słupsk: shake, burgery i desery"><meta property="og:description" content="Shake na włoskich lodach, burgery, tex-mex i desery. Zamów online, zarezerwuj stolik, zbieraj Milkosy w MilkMi.">
<meta property="og:url" content="${esc(abs('/'))}"><meta property="og:image" content="${esc(abs('/icons/icon-512.png'))}">
${ld.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
</head>`;
    send(res, indexHtml.replace('</head>', head));
  }));

  // --- lokale ---
  async function locationPage(req, res, loc) {
    const schedule = await hoursFor(loc.key);
    const best = (await productsFor(CATEGORIES.flatMap((c) => c.ids), loc.key)).filter((p) => p.isBestseller).slice(0, 6);
    const tk = todayKey();
    const hasHours = schedule && DAYS.some(([d]) => schedule[d] && schedule[d].isOpen);
    const mapSrc = `https://maps.google.com/maps?q=${encodeURIComponent(loc.mapsQuery)}&output=embed`;
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.mapsQuery)}`;
    const items = [['/', 'Milkshakebar'], [null, loc.name]];
    const body = `
${crumbs(items)}
<div class="hero-s">
  <div>
    <span class="pill"><i class="fas fa-location-dot" style="color:var(--orange)"></i>${esc(loc.street)}, ${esc(loc.postal)} ${esc(loc.city)}</span>
    <h1>Milkshakebar <span>${esc(loc.name)}</span></h1>
    <p class="lead">${loc.seasonal ? 'Sezonowy lokal na deptaku w Rowach. Shake na włoskich lodach, desery i coś na ciepło po plaży.' : 'Shake na włoskich lodach, burgery, tex-mex, desery i kawa. Zjesz na miejscu, zamówisz online z odbiorem, zarezerwujesz stolik.'}</p>
    <div class="acts">
      <a class="btn btn-o" href="/zamow"><i class="fas fa-bag-shopping"></i>Zamów online</a>
      <a class="btn btn-w" href="${esc(mapsLink)}" target="_blank" rel="noopener"><i class="fas fa-diamond-turn-right"></i>Prowadź do lokalu</a>
      <a class="btn btn-w" href="/#rezerwacja"><i class="fas fa-calendar-check"></i>Rezerwacja</a>
    </div>
  </div>
  <div class="hero-art"><b>${esc(loc.name)}</b><span>${loc.seasonal ? 'Otwarte w sezonie letnim' : 'Otwarte cały rok'}</span></div>
</div>
<section class="s grid2">
  <div class="box">
    <h2 style="font-size:1.6rem">Godziny otwarcia</h2>
    ${hasHours ? hoursTable(schedule, tk) : `<p style="margin:10px 0 18px">${loc.seasonal ? 'Lokal działa w sezonie letnim. Godziny podamy przed startem sezonu na tej stronie i w aplikacji MilkMi.' : 'Godziny otwarcia aktualizujemy. Sprawdź nasz profil w Google.'}</p>`}
    <h3>Adres</h3>
    <p>${esc(loc.street)}<br>${esc(loc.postal)} ${esc(loc.city)}</p>
    <p style="margin-top:12px"><a href="${esc(mapsLink)}" target="_blank" rel="noopener" style="font-weight:800;color:var(--orange-deep)">Otwórz w Mapach Google</a></p>
  </div>
  <iframe class="map" title="Mapa: Milkshakebar ${esc(loc.name)}" src="${esc(mapSrc)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
</section>
${best.length ? `<section class="s"><div class="sh"><div><h2>Najczęściej wybierane</h2><p>Pozycje polecane przez obsługę.</p></div><a href="/zamow">Zamów online</a></div><div class="menu-list">${best.map(itemCard).join('')}</div></section>` : ''}
<section class="s"><div class="sh"><div><h2>Menu</h2><p>Wybierz kategorię, żeby zobaczyć pozycje i ceny.</p></div></div>${catLinks('')}</section>
<section class="s grid3">
  <div class="box"><div class="ic"><i class="fas fa-bag-shopping"></i></div><h3>Zamów z odbiorem</h3><p>Złóż zamówienie online, wybierz godzinę i odbierz bez czekania.</p></div>
  <div class="box"><div class="ic"><i class="fas fa-star"></i></div><h3>Zbieraj Milkosy</h3><p>Podaj przy kasie numer telefonu z aplikacji MilkMi i wymieniaj Milkosy na saldo do wydania.</p></div>
  <div class="box"><div class="ic"><i class="fas fa-gift"></i></div><h3>Karta podarunkowa</h3><p>Prezent do wydania w Milkshakebar. <a href="/karty-podarunkowe" style="font-weight:800">Kup online</a>.</p></div>
</section>`;
    send(res, layout({ title: loc.title, description: loc.description, canonical: `/${loc.slug}`, body, active: loc.slug, jsonld: [restaurantLd(loc, schedule), crumbsLd(items)] }));
  }
  app.get('/slupsk', asyncRoute((req, res) => locationPage(req, res, LOCATIONS.slupsk)));
  app.get('/rowy', asyncRoute((req, res) => locationPage(req, res, LOCATIONS.rowy)));

  // --- kategorie menu ---
  app.get('/menu/:slug', asyncRoute(async (req, res, next) => {
    const cat = CATEGORIES.find((c) => c.slug === req.params.slug);
    if (!cat) return next();
    const products = await productsFor(cat.ids);
    const items = [['/', 'Milkshakebar'], ['/menu', 'Menu'], [null, cat.name]];
    const menuLd = {
      '@context': 'https://schema.org', '@type': 'Menu', name: `Menu Milkshakebar: ${cat.name}`, url: abs(`/menu/${cat.slug}`),
      hasMenuSection: [{
        '@type': 'MenuSection', name: cat.name,
        hasMenuItem: products.map((p) => ({
          '@type': 'MenuItem', name: p.name, description: p.description || undefined, image: p.imageUrl && /^https?:/.test(p.imageUrl) ? p.imageUrl : (p.imageUrl ? abs(p.imageUrl) : undefined),
          offers: (p.variants && p.variants.length ? p.variants : [{ name: '', price: p.price }]).map((v) => ({ '@type': 'Offer', name: v.name || undefined, price: Number(v.price || 0).toFixed(2), priceCurrency: 'PLN' }))
        }))
      }]
    };
    const body = `
${crumbs(items)}
<div class="hero-s" style="grid-template-columns:1fr">
  <div>
    <h1>${esc(cat.h1)} <span>w Słupsku</span></h1>
    <p class="lead">${esc(cat.intro)}${products.length ? ` W tej kategorii: ${products.length} ${products.length === 1 ? 'pozycja' : products.length < 5 ? 'pozycje' : 'pozycji'}.` : ''}</p>
    <div class="acts"><a class="btn btn-o" href="/zamow"><i class="fas fa-bag-shopping"></i>Zamów online</a><a class="btn btn-w" href="/menu.pdf"><i class="fas fa-file-pdf"></i>Alergeny (PDF)</a></div>
  </div>
</div>
<section class="s">${catLinks(cat.slug)}</section>
<section class="s">${products.length ? `<div class="menu-list">${products.map(itemCard).join('')}</div>` : '<div class="box"><p>Pozycje z tej kategorii pojawią się tu wkrótce. Pełne menu znajdziesz w <a href="/menu">karcie menu</a>.</p></div>'}</section>
<section class="s cta"><div><h2>Zbieraj Milkosy za każde zamówienie</h2><p>Za każde ${esc(ctx.loyalty().zlotyPerPoint)} zł dostajesz 1 Milkos. Wymieniasz je na saldo do wydania w lokalu i online.</p></div><a class="btn btn-o" href="/milkmi">Jak działa MilkMi</a></section>`;
    send(res, layout({
      title: `${cat.name} – menu i ceny | Milkshakebar Słupsk`,
      description: `${cat.h1} w Milkshakebar w Słupsku. ${cat.intro} Ceny, zdjęcia i zamówienie online.`.slice(0, 300),
      canonical: `/menu/${cat.slug}`, body, active: 'menu', noindex: !products.length, jsonld: [menuLd, crumbsLd(items)]
    }));
  }));

  // --- program MilkMi ---
  app.get('/milkmi', asyncRoute(async (req, res) => {
    const p = ctx.program();
    const l = ctx.loyalty();
    const { Mission } = ctx.models();
    const now = new Date();
    const missions = await Mission.find({ active: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }).sort({ createdAt: 1 }).limit(12).lean().catch(() => []);
    const hh = (p.happyHours || []).filter((h) => h.active !== false);
    const faq = [
      ['Ile kosztuje MilkMi?', 'Nic. Zakładasz konto numerem telefonu i od razu zbierasz Milkosy.'],
      ['Jak dostaję Milkosy w lokalu?', `Przy kasie podajesz numer telefonu z konta. Za każde ${l.zlotyPerPoint} zł dostajesz 1 Milkos.`],
      ['Na co wymienię Milkosy?', `Na saldo vPLN: 1 Milkos = ${l.vplnPerPoint} vPLN, a 1 vPLN = 1 zł w Milkshakebar i w zamówieniach online.`],
      ...(p.expiry.enabled ? [['Czy Milkosy wygasają?', `Tak, każde Milkosy są ważne ${p.expiry.months} miesięcy od zdobycia. ${p.expiry.warnDays} dni wcześniej przypomnimy o tym w aplikacji.`]] : []),
      ['Czy potrzebuję aplikacji ze sklepu?', 'Nie. MilkMi działa w przeglądarce. Możesz dodać ją do ekranu telefonu jak zwykłą aplikację.']
    ];
    const body = `
${crumbs([['/', 'Milkshakebar'], [null, 'MilkMi']])}
<div class="hero-s">
  <div>
    <span class="pill"><i class="fas fa-star" style="color:var(--orange)"></i>Program lojalnościowy</span>
    <h1>Jedz, zbieraj, <span>płać punktami.</span></h1>
    <p class="lead">${l.zlotyPerPoint} zł wydane w Milkshakebar to 1 Milkos. Każdy Milkos wymienisz na ${money0(l.vplnPerPoint)} do wydania w lokalu i w zamówieniach online.</p>
    <div class="acts"><a class="btn btn-o" href="/app"><i class="fas fa-mobile-screen"></i>Załóż konto</a><a class="btn btn-w" href="/regulamin-milkmi">Regulamin</a></div>
  </div>
  <div class="hero-art"><b>1000 zł → ${money0(Math.floor(1000 / l.zlotyPerPoint) * l.vplnPerPoint)}</b><span>tyle odzyskujesz w saldzie vPLN</span></div>
</div>
<section class="s"><div class="sh"><div><h2>Jak to działa</h2></div></div>
  <div class="steps">
    <div class="box"><h3>Załóż konto numerem telefonu</h3><p>Imię, numer i hasło. Bez e-maila i bez pobierania ze sklepu.</p></div>
    <div class="box"><h3>Podawaj numer przy kasie</h3><p>Za każde ${l.zlotyPerPoint} zł dostajesz 1 Milkos. Zamówienia online liczą się same.</p></div>
    <div class="box"><h3>Wymieniaj na saldo vPLN</h3><p>Płacisz saldem w lokalu albo w zamówieniu online.</p></div>
  </div>
</section>
${p.tiers.enabled ? `<section class="s"><div class="sh"><div><h2>Poziomy</h2><p>Im więcej wydajesz w ciągu ${p.tiers.windowMonths} miesięcy, tym więcej Milkosów dostajesz za każde zakupy.</p></div></div>
  <table class="tiers"><thead><tr><th>Poziom</th><th>Wydatki w ${p.tiers.windowMonths} mies.</th><th>Milkosy za zakupy</th></tr></thead><tbody>
  ${[...p.tiers.levels].sort((a, b) => a.minSpent - b.minSpent).map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${t.minSpent > 0 ? `od ${money0(t.minSpent)}` : 'na start'}</td><td>${Number(t.multiplier) > 1 ? `×${String(t.multiplier).replace('.', ',')}` : 'standard'}</td></tr>`).join('')}
  </tbody></table></section>` : ''}
<section class="s grid3">
  ${p.referral.enabled ? `<div class="box"><div class="ic"><i class="fas fa-user-plus"></i></div><h3>Polecaj znajomym</h3><p>Znajomy wpisuje Twój kod przy zakładaniu konta. Po jego pierwszych zakupach od ${money0(p.referral.minSpent)} Ty dostajesz ${p.referral.referrerPoints}, a on ${p.referral.refereePoints} Milkosów.</p></div>` : ''}
  ${p.birthday.enabled ? `<div class="box"><div class="ic"><i class="fas fa-cake-candles"></i></div><h3>Prezent na urodziny</h3><p>Zapisz datę urodzin w aplikacji, a w swoje święto dostaniesz ${[p.birthday.vpln > 0 ? money0(p.birthday.vpln) + ' vPLN' : '', p.birthday.points > 0 ? p.birthday.points + ' Milkosów' : ''].filter(Boolean).join(' i ') || 'prezent'}.</p></div>` : ''}
  <div class="box"><div class="ic"><i class="fas fa-medal"></i></div><h3>Misje i odznaki</h3><p>Wykonuj misje, np. kilka wizyt w miesiącu, zdobywaj odznaki i dodatkowe nagrody.</p></div>
</section>
${missions.length ? `<section class="s"><div class="sh"><div><h2>Aktualne misje</h2></div></div><div class="grid3">${missions.map((m) => `<div class="box"><div style="font-size:2rem;margin-bottom:8px">${esc(m.icon || '🏅')}</div><h3>${esc(m.title)}</h3><p>${esc(m.description || '')}</p><p style="margin-top:10px;font-weight:800;color:var(--orange-deep)">${[m.rewardPoints ? `+${m.rewardPoints} Milkosów` : '', m.rewardVpln ? `+${money0(m.rewardVpln)} vPLN` : '', m.badge ? `odznaka „${esc(m.badge)}”` : ''].filter(Boolean).join(' · ')}</p></div>`).join('')}</div></section>` : ''}
${hh.length ? `<section class="s"><div class="sh"><div><h2>Happy hours</h2><p>W tych godzinach dostajesz więcej Milkosów za zakupy.</p></div></div><div class="grid3">${hh.map((h) => `<div class="box dark"><h3>${esc(h.name)}</h3><p><b style="color:#fff;font-size:1.6rem">×${String(h.multiplier).replace('.', ',')}</b><br>${h.days.map((d) => WEEKDAY_NAMES[d]).join(', ')} · ${esc(h.from)}–${esc(h.to)}${h.location && h.location !== 'all' ? ` · ${h.location === 'rowy' ? 'Rowy' : 'Słupsk'}` : ''}</p></div>`).join('')}</div></section>` : ''}
<section class="s grid2">
  <div class="box"><div class="ic"><i class="fab fa-apple"></i></div><h3>iPhone</h3><p>Otwórz <b>milkshakebar.pl/app</b> w Safari, stuknij <b>Udostępnij</b>, potem <b>Do ekranu początkowego</b>. Powiadomienia działają po dodaniu do ekranu (iOS 16.4 lub nowszy).</p></div>
  <div class="box"><div class="ic"><i class="fab fa-android"></i></div><h3>Android</h3><p>Otwórz <b>milkshakebar.pl/app</b> w Chrome i wybierz <b>Zainstaluj aplikację</b> albo <b>Dodaj do ekranu głównego</b>.</p></div>
</section>
<section class="s"><div class="sh"><div><h2>Pytania</h2></div></div><div class="faq">${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>`;
    const faqLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };
    send(res, layout({
      title: 'MilkMi – program lojalnościowy Milkshakebar | Milkosy i vPLN',
      description: `Zbieraj Milkosy w Milkshakebar: ${l.zlotyPerPoint} zł = 1 Milkos, 1 Milkos = ${l.vplnPerPoint} vPLN. Poziomy, polecenia, prezent urodzinowy, misje i odznaki.`,
      canonical: '/milkmi', body, active: 'milkmi', jsonld: [faqLd]
    }));
  }));

  // --- dostawa i odbiór ---
  app.get('/dostawa', asyncRoute(async (req, res) => {
    const { StoreSettings } = ctx.models();
    const st = await StoreSettings.findOne({ location: 'slupsk' }).lean().catch(() => null);
    // Kwoty z panelu (Zamówienia → ustawienia zamawiarki), a gdy ich nie ustawiono, domyślne
    const c = { ...ctx.orderConfig() };
    for (const k of ['deliveryFee', 'freeDeliveryThreshold', 'packagingFee']) if (st && st[k] !== undefined && st[k] !== null) c[k] = st[k];
    const deliveryOn = Boolean(st && st.deliveryEnabled);
    const body = `
${crumbs([['/', 'Milkshakebar'], [null, 'Dostawa i odbiór']])}
<div class="hero-s" style="grid-template-columns:1fr"><div>
  <h1>Dostawa i <span>odbiór osobisty</span></h1>
  <p class="lead">Zamawiasz online, wybierasz godzinę i odbierasz w lokalu albo czekasz na dostawę. Shake i lody wydajemy tylko z odbiorem osobistym.</p>
  <div class="acts"><a class="btn btn-o" href="/zamow"><i class="fas fa-bag-shopping"></i>Zamów online</a></div>
</div></div>
<section class="s grid3">
  <div class="box"><div class="ic"><i class="fas fa-store"></i></div><h3>Odbiór osobisty</h3><p>Słupsk, ul. Szczecińska 17. Wybierasz godzinę odbioru przy zamówieniu, możesz też zamówić na jutro.</p></div>
  <div class="box"><div class="ic"><i class="fas fa-motorcycle"></i></div><h3>Dostawa</h3><p>${deliveryOn ? `Dostawa kosztuje ${money0(c.deliveryFee)}, a od ${money0(c.freeDeliveryThreshold)} jest za darmo.` : `Dostawa jest teraz wyłączona. Gdy ją włączymy: ${money0(c.deliveryFee)}, a od ${money0(c.freeDeliveryThreshold)} za darmo.`}</p></div>
  <div class="box"><div class="ic"><i class="fas fa-box"></i></div><h3>Opakowania</h3><p>Do każdego zamówienia online doliczamy ${money0(c.packagingFee)} za opakowania.</p></div>
</section>
<section class="s grid2">
  <div class="box dark"><h3>Dlaczego shake tylko z odbiorem?</h3><p>Shake i lody włoskie roztopiłyby się w drodze. Takie pozycje mają w zamawiarce oznaczenie „Tylko odbiór” i nie da się ich dodać do dostawy.</p></div>
  <div class="box"><h3>Płatność</h3><p>Gotówka lub karta przy odbiorze, płatność online (BLIK, przelew) albo saldo vPLN z konta MilkMi. Saldo vPLN możesz połączyć z inną metodą płatności.</p></div>
</section>`;
    send(res, layout({
      title: 'Dostawa i odbiór osobisty | Milkshakebar Słupsk',
      description: `Zamów online w Milkshakebar Słupsk: odbiór osobisty przy ul. Szczecińskiej 17 lub dostawa (${money0(c.deliveryFee)}, darmowa od ${money0(c.freeDeliveryThreshold)}). Shake tylko z odbiorem.`,
      canonical: '/dostawa', body
    }));
  }));

  // --- regulamin programu: liczby zawsze zgodne z ustawieniami w panelu ---
  app.get('/regulamin-milkmi', asyncRoute(async (req, res) => {
    const p = ctx.program();
    const l = ctx.loyalty();
    const co = p.company || {};
    const organizer = [co.name || 'Milkshakebar', co.address || 'ul. Szczecińska 17, 76-200 Słupsk', co.nip ? `NIP ${co.nip}` : ''].filter(Boolean).join(', ');
    const contact = co.email ? `e-mailem na adres ${co.email} albo` : '';
    const levels = [...p.tiers.levels].sort((a, b) => a.minSpent - b.minSpent);
    let n = 0;
    const h = (t) => `<h2>§${++n}. ${t}</h2>`;
    const body = `
${crumbs([['/', 'Milkshakebar'], ['/milkmi', 'MilkMi'], [null, 'Regulamin']])}
<article class="prose" style="padding:20px 0 40px">
<h1 style="font-size:clamp(2rem,4vw,3rem);font-weight:900;letter-spacing:-.04em;line-height:1.05;margin:10px 0 6px">Regulamin programu MilkMi</h1>
<p style="color:var(--sub)">Obowiązuje od ${new Date().toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' })}. Liczby w regulaminie są zawsze aktualne.</p>
${h('Organizator')}
<p>Organizatorem programu lojalnościowego MilkMi jest ${esc(organizer)} („Organizator”), prowadzący lokale Milkshakebar w Słupsku i w Rowach.</p>
${h('Uczestnictwo')}
<ol><li>Udział w programie jest bezpłatny i dobrowolny.</li><li>Uczestnikiem zostaje osoba, która założy konto w aplikacji MilkMi (milkshakebar.pl/app), podając imię, numer telefonu i hasło.</li><li>Jeden numer telefonu może mieć jedno konto.</li><li>Uczestnik może w każdej chwili zrezygnować z udziału, prosząc obsługę o usunięcie konta. Niewykorzystane Milkosy i saldo vPLN przepadają z chwilą usunięcia konta.</li></ol>
${h('Milkosy')}
<ol><li>Za każde pełne ${l.zlotyPerPoint} zł wydane w lokalach Milkshakebar uczestnik otrzymuje 1 Milkos. Końcówki poniżej ${l.zlotyPerPoint} zł nie są liczone.</li><li>W lokalu Milkosy nalicza obsługa po podaniu numeru telefonu przypisanego do konta. Za zamówienia online Milkosy są naliczane po wydaniu zamówienia.</li><li>Część zamówienia opłacona saldem vPLN nie daje Milkosów.</li><li>Organizator może cofnąć Milkosy naliczone omyłkowo albo za zakupy, które zostały zwrócone.</li></ol>
${p.tiers.enabled ? `${h('Poziomy')}<ol><li>Poziom zależy od kwoty wydanej w ostatnich ${p.tiers.windowMonths} miesiącach (zakupy w lokalu i zamówienia online).</li><li>Poziomy: ${levels.map((t) => `<b>${esc(t.name)}</b> ${t.minSpent > 0 ? `od ${money0(t.minSpent)}` : 'na start'}${Number(t.multiplier) > 1 ? `, Milkosy ×${String(t.multiplier).replace('.', ',')}` : ''}`).join('; ')}.</li><li>Mnożnik poziomu dotyczy Milkosów za zakupy i jest zaokrąglany w dół do pełnych Milkosów.</li></ol>` : ''}
${h('Happy hours')}
<p>Organizator może ogłaszać godziny, w których za zakupy przysługuje więcej Milkosów („happy hours”). Aktualne happy hours są widoczne w aplikacji i na stronie milkshakebar.pl/milkmi. Mnożnik happy hour łączy się z mnożnikiem poziomu.</p>
${h('Wymiana na saldo vPLN')}
<ol><li>Milkosy można wymienić w aplikacji na saldo vPLN według kursu 1 Milkos = ${l.vplnPerPoint} vPLN, w pakietach: ${l.exchangeOptions.join(', ')} Milkosów.</li><li>1 vPLN odpowiada 1 zł przy płatności w lokalach Milkshakebar i w zamówieniach online na milkshakebar.pl.</li><li>Saldo vPLN nie podlega wymianie na gotówkę ani zwrotowi w pieniądzu.</li></ol>
${p.expiry.enabled ? `${h('Ważność Milkosów')}<ol><li>Milkosy są ważne ${p.expiry.months} miesięcy od dnia ich otrzymania. Po tym czasie niewykorzystane Milkosy wygasają.</li><li>Przy wymianie i korektach w pierwszej kolejności wykorzystywane są Milkosy, które wygasają najwcześniej.</li><li>Na ${p.expiry.warnDays} dni przed wygaśnięciem aplikacja przypomina o Milkosach, które wkrótce przepadną (o ile uczestnik włączył powiadomienia).</li></ol>` : ''}
${p.referral.enabled ? `${h('Polecenia')}<ol><li>Każdy uczestnik ma własny kod polecenia, widoczny w aplikacji.</li><li>Nowy uczestnik może wpisać kod przy zakładaniu konta albo w ciągu 14 dni od jego założenia, przed pierwszymi zakupami.</li><li>Po pierwszych zakupach nowego uczestnika na kwotę co najmniej ${money0(p.referral.minSpent)} polecający otrzymuje ${p.referral.referrerPoints}, a nowy uczestnik ${p.referral.refereePoints} Milkosów.</li><li>Nie można polecić samego siebie ani konta z tym samym numerem telefonu.</li></ol>` : ''}
${p.birthday.enabled ? `${h('Prezent urodzinowy')}<ol><li>Uczestnik może raz zapisać w aplikacji dzień i miesiąc urodzin. Zmianę daty wykonuje obsługa lokalu.</li><li>W dniu urodzin uczestnik otrzymuje ${[p.birthday.vpln > 0 ? `${money0(p.birthday.vpln)} vPLN` : '', p.birthday.points > 0 ? `${p.birthday.points} Milkosów` : ''].filter(Boolean).join(' i ') || 'prezent'}, raz w roku.</li><li>Prezent przysługuje, jeśli data urodzin była zapisana co najmniej 30 dni wcześniej.</li></ol>` : ''}
${h('Misje i odznaki')}
<p>Organizator może ogłaszać misje (np. określona liczba wizyt lub zamówień w danym czasie). Warunki, czas trwania i nagrody każdej misji są opisane w aplikacji. Za wykonanie misji uczestnik otrzymuje nagrodę i odznakę, raz na misję.</p>
${h('Karty podarunkowe')}
<ol><li>Kartę podarunkową można kupić online na milkshakebar.pl/karty-podarunkowe albo w lokalu.</li><li>Karta jest ważna 12 miesięcy od zakupu. Można nią płacić w lokalu (także częściowo) albo dodać ją do salda vPLN w aplikacji MilkMi.</li><li>Karta nie podlega wymianie na gotówkę. Za kartę utraconą lub udostępnioną osobom trzecim Organizator nie odpowiada.</li></ol>
${h('Reklamacje i zmiany regulaminu')}
<ol><li>Reklamacje dotyczące programu można zgłaszać ${esc(contact)} w lokalu. Organizator odpowiada w ciągu 14 dni.</li><li>Organizator może zmienić regulamin lub zakończyć program. O zmianach informuje w aplikacji z co najmniej 14-dniowym wyprzedzeniem; Milkosy zdobyte przed zmianą zachowują ważność.</li></ol>
${h('Dane osobowe')}
<p>Zasady przetwarzania danych osobowych opisuje <a href="/privacypolicy.html">polityka prywatności</a>.</p>
</article>`;
    send(res, layout({ title: 'Regulamin programu MilkMi | Milkshakebar', description: 'Regulamin programu lojalnościowego MilkMi: Milkosy, saldo vPLN, poziomy, polecenia, prezent urodzinowy, misje, ważność i karty podarunkowe.', canonical: '/regulamin-milkmi', body }));
  }));

  // --- cookies ---
  app.get('/cookies', (req, res) => {
    const body = `
${crumbs([['/', 'Milkshakebar'], [null, 'Cookies']])}
<article class="prose" style="padding:20px 0 40px">
<h1 style="font-size:clamp(2rem,4vw,3rem);font-weight:900;letter-spacing:-.04em;line-height:1.05;margin:10px 0 16px">Cookies i pamięć przeglądarki</h1>
<p>Strona milkshakebar.pl nie używa ciasteczek reklamowych ani narzędzi śledzących firm zewnętrznych.</p>
<h2>Co zapisujemy w Twojej przeglądarce</h2>
<ul><li><b>Koszyk i dane zamówienia</b> w zamawiarce, żeby nie zniknęły po odświeżeniu strony.</li><li><b>Logowanie do MilkMi</b>: token sesji, żeby nie trzeba było logować się przy każdym otwarciu.</li><li><b>Ustawienia</b>: motyw jasny/ciemny, język, wybrany lokal, ulubione produkty.</li></ul>
<p>Te dane leżą w pamięci Twojej przeglądarki (localStorage) i są potrzebne do działania strony. Usuniesz je, czyszcząc dane witryny w ustawieniach przeglądarki.</p>
<h2>Statystyki</h2>
<p>Liczymy, ile razy otwierane są nasze strony, bez ciasteczek i bez zapisywania danych, które pozwalają Cię rozpoznać.</p>
<h2>Usługi zewnętrzne</h2>
<p>Czcionki ładujemy z Google Fonts, ikony z cdnjs, a mapy lokali z Map Google. Te usługi mogą otrzymać adres IP Twojego urządzenia. Płatności online obsługuje PayU na swojej stronie.</p>
<p>Więcej w <a href="/privacypolicy.html">polityce prywatności</a>.</p>
</article>`;
    send(res, layout({ title: 'Cookies | Milkshakebar', description: 'Jak milkshakebar.pl korzysta z pamięci przeglądarki: koszyk, logowanie do MilkMi i ustawienia. Bez ciasteczek reklamowych.', canonical: '/cookies', body }));
  });

  // --- karty podarunkowe ---
  app.get('/karty-podarunkowe', (req, res) => {
    const body = `
${crumbs([['/', 'Milkshakebar'], [null, 'Karty podarunkowe']])}
<div id="gc-result" hidden style="padding:30px 0 60px"></div>
<div id="gc-shop">
<div class="hero-s">
  <div>
    <span class="pill"><i class="fas fa-gift" style="color:var(--orange)"></i>Prezent w 2 minuty</span>
    <h1>Karta podarunkowa <span>Milkshakebar</span></h1>
    <p class="lead">Wybierz kwotę, zapłać online i od razu dostań kod. Wyślij go SMS-em albo wydrukuj kartę. Ważna 12 miesięcy.</p>
  </div>
  <div class="giftcard" aria-hidden="true"><small>Milkshakebar · karta podarunkowa</small><div class="gv" id="gc-preview">100 zł</div><div class="gc">MILK-••••-••••</div></div>
</div>
<section class="s grid2">
  <form class="box" id="gc-form" novalidate>
    <h2 style="font-size:1.5rem;margin-bottom:14px">Kup kartę</h2>
    <div class="amounts" id="gc-amounts"></div>
    <label class="field"><span>Inna kwota (zł)</span><input class="input" name="custom" type="number" inputmode="numeric" min="20" max="1000" step="1" placeholder="np. 70"></label>
    <div class="grid2" style="gap:12px">
      <label class="field"><span>Twoje imię</span><input class="input" name="buyerName" autocomplete="name" required></label>
      <label class="field"><span>Twój e-mail</span><input class="input" name="buyerEmail" type="email" autocomplete="email" required></label>
    </div>
    <label class="field"><span>Dla kogo (opcjonalnie)</span><input class="input" name="recipientName" maxlength="40" placeholder="np. Ola"></label>
    <label class="field"><span>Życzenia na karcie (opcjonalnie)</span><textarea class="input" name="message" rows="2" maxlength="200" placeholder="np. Wszystkiego najlepszego!"></textarea></label>
    <label class="check"><input type="checkbox" name="consent" required><span>Akceptuję <a href="/regulamin-milkmi">regulamin</a> (karta ważna 12 miesięcy, bez wymiany na gotówkę).</span></label>
    <button class="btn btn-o" type="submit" style="width:100%"><i class="fas fa-lock"></i><span id="gc-pay">Zapłać</span></button>
    <div class="msg err" id="gc-err" hidden></div>
  </form>
  <div>
    <div class="box" style="margin-bottom:16px"><div class="ic"><i class="fas fa-store"></i></div><h3>Płacenie kartą w lokalu</h3><p>Podaj kod przy kasie. Możesz płacić częściami, aż saldo karty się skończy.</p></div>
    <div class="box" style="margin-bottom:16px"><div class="ic"><i class="fas fa-mobile-screen"></i></div><h3>Albo do portfela MilkMi</h3><p>W aplikacji MilkMi: Portfel → Dodaj kartę podarunkową. Kwota trafia na saldo vPLN i działa też w zamówieniach online.</p></div>
    <div class="box"><div class="ic"><i class="fas fa-cash-register"></i></div><h3>Wolisz kupić na miejscu?</h3><p>Kartę sprzedamy też przy kasie w lokalu.</p></div>
  </div>
</section>
</div>
<script>
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var form = $('#gc-form');
  var amount = 100;
  var opts = { amounts: [50, 100, 150, 200], min: 20, max: 1000, online: true };
  function setAmount(a) {
    amount = a;
    document.querySelectorAll('#gc-amounts button').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.a) === a)); });
    $('#gc-preview').textContent = a + ' zł';
    $('#gc-pay').textContent = 'Zapłać ' + a + ' zł';
  }
  function renderAmounts() {
    $('#gc-amounts').innerHTML = opts.amounts.map(function (a) { return '<button type="button" data-a="' + a + '">' + a + ' zł</button>'; }).join('');
    setAmount(opts.amounts.indexOf(100) >= 0 ? 100 : opts.amounts[0]);
  }
  $('#gc-amounts').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { form.custom.value = ''; setAmount(Number(b.dataset.a)); } });
  form.custom.addEventListener('input', function () { var v = Math.floor(Number(form.custom.value)); if (v >= opts.min && v <= opts.max) setAmount(v); });
  function err(msg) { var el = $('#gc-err'); el.textContent = msg; el.hidden = !msg; }
  form.addEventListener('submit', function (e) {
    e.preventDefault(); err('');
    if (!opts.online) return err('Płatność online jest chwilowo niedostępna. Kartę kupisz w lokalu.');
    if (form.buyerName.value.trim().length < 2 || !/^\\S+@\\S+\\.\\S+$/.test(form.buyerEmail.value.trim())) return err('Podaj imię i e-mail.');
    if (!form.consent.checked) return err('Zaakceptuj regulamin.');
    var btn = form.querySelector('[type=submit]'); btn.disabled = true;
    fetch('/api/gift-cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amount, buyerName: form.buyerName.value.trim(), buyerEmail: form.buyerEmail.value.trim(), recipientName: form.recipientName.value.trim(), message: form.message.value.trim(), consent: true }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.success && d.redirectUrl) location.href = d.redirectUrl; else { err(d.message || 'Nie udało się rozpocząć płatności.'); btn.disabled = false; } })
      .catch(function () { err('Brak połączenia. Spróbuj ponownie.'); btn.disabled = false; });
  });
  fetch('/api/gift-cards/options').then(function (r) { return r.json(); }).then(function (d) { if (d.data) { opts = d.data; } renderAmounts(); }).catch(renderAmounts);

  // Powrót z płatności: pokaż kartę z kodem
  var q = new URLSearchParams(location.search);
  var id = q.get('karta'), t = q.get('t');
  if (!id || !t) return;
  $('#gc-shop').hidden = true;
  var box = $('#gc-result'); box.hidden = false;
  var tries = 0;
  function show(c) {
    if (c.status === 'awaiting_payment') {
      box.innerHTML = '<div class="box" style="max-width:560px"><h2 style="font-size:1.6rem">Czekamy na potwierdzenie płatności…</h2><p>To zwykle trwa kilka sekund. Strona odświeży się sama.</p></div>';
      if (tries++ < 30) setTimeout(load, 3000);
      else box.innerHTML = '<div class="box" style="max-width:560px"><h2 style="font-size:1.6rem">Płatność jeszcze się nie potwierdziła</h2><p>Zachowaj ten link i otwórz go za kilka minut. Jeśli płatność została anulowana, karta nie powstanie.</p></div>';
      return;
    }
    if (c.status === 'cancelled') { box.innerHTML = '<div class="box" style="max-width:560px"><h2 style="font-size:1.6rem">Płatność anulowana</h2><p>Karta nie została utworzona. <a href="/karty-podarunkowe">Spróbuj ponownie</a>.</p></div>'; return; }
    var exp = c.expiresAt ? new Date(c.expiresAt).toLocaleDateString('pl-PL') : '';
    box.innerHTML = '<h1 style="font-size:clamp(2rem,4vw,3rem);font-weight:900;letter-spacing:-.04em;margin-bottom:8px" class="no-print">Gotowe! Oto Twoja karta</h1>'
      + '<p class="lead no-print">Zapisz kod albo wydrukuj kartę. Ten link działa tylko dla Ciebie, nie udostępniaj go publicznie.</p>'
      + '<div class="giftcard" style="margin:20px 0"><small>Milkshakebar · karta podarunkowa' + (c.recipientName ? ' · dla ' + esc(c.recipientName) : '') + '</small><div class="gv">' + esc(c.amount) + ' zł</div>'
      + (c.message ? '<small style="font-size:1rem">„' + esc(c.message) + '”</small>' : '') + '<div class="gc">' + esc(c.code) + '</div><small>Ważna do ' + esc(exp) + ' · milkshakebar.pl</small></div>'
      + '<div class="acts no-print"><button class="btn btn-o" type="button" id="gc-print"><i class="fas fa-print"></i>Drukuj kartę</button><button class="btn btn-w" type="button" id="gc-copy"><i class="fas fa-copy"></i>Kopiuj kod</button>'
      + (navigator.share ? '<button class="btn btn-w" type="button" id="gc-share"><i class="fas fa-share"></i>Wyślij</button>' : '') + '</div>'
      + (c.status === 'used' ? '<p class="msg ok no-print">Ta karta została już wykorzystana.</p>' : '');
    $('#gc-print').onclick = function () { window.print(); };
    $('#gc-copy').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(c.code).then(function () { $('#gc-copy').innerHTML = '<i class="fas fa-check"></i>Skopiowano'; }); };
    if ($('#gc-share')) $('#gc-share').onclick = function () { navigator.share({ title: 'Karta podarunkowa Milkshakebar', text: 'Karta podarunkowa Milkshakebar ' + c.amount + ' zł. Kod: ' + c.code + ' (ważna do ' + exp + '). Podaj kod przy kasie albo dodaj w aplikacji MilkMi: milkshakebar.pl/app' }).catch(function () {}); };
  }
  function load() {
    fetch('/api/gift-cards/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(t)).then(function (r) { return r.json(); })
      .then(function (d) { if (d.success) show(d.data); else box.innerHTML = '<div class="box"><h2>Nie znaleziono karty</h2><p>Sprawdź link z potwierdzenia płatności.</p></div>'; })
      .catch(function () { setTimeout(load, 4000); });
  }
  load();
})();
</script>`;
    send(res, layout({
      title: 'Karty podarunkowe Milkshakebar – kup online',
      description: 'Karta podarunkowa do Milkshakebar w Słupsku i Rowach. Kwota od 20 do 1000 zł, płatność online, kod od razu. Ważna 12 miesięcy, działa też w aplikacji MilkMi.',
      canonical: '/karty-podarunkowe', body, active: 'karty'
    }));
  });

  // --- mapa strony i robots ---
  app.get('/sitemap.xml', asyncRoute(async (req, res) => {
    const { Product } = ctx.models();
    const latest = await Product.findOne({}, 'createdAt').sort({ createdAt: -1 }).lean().catch(() => null);
    const lastmod = (latest && latest.createdAt ? new Date(latest.createdAt) : new Date()).toISOString().slice(0, 10);
    const urls = ['/', '/menu', '/zamow', '/slupsk', '/rowy', '/milkmi', '/dostawa', '/karty-podarunkowe', '/regulamin-milkmi', '/app', ...CATEGORIES.map((c) => `/menu/${c.slug}`)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${abs(u)}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>`);
  }));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${abs('/sitemap.xml')}\n`));

  return { CATEGORIES, LOCATIONS };
};
