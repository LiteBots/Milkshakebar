'use strict';
// Nagłówki bezpieczeństwa i CORS.
// Strony mają skrypty w treści HTML (onclick itd.), więc CSP dopuszcza 'unsafe-inline', ale blokuje skrypty
// i połączenia z obcych domen, osadzanie strony w cudzych ramkach i wysyłanie formularzy poza nasze domeny.

function cspHeader(extraImg = '') {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    `img-src 'self' data: blob: https:${extraImg ? ` ${extraImg}` : ''}`,
    "connect-src 'self'",
    'frame-src https://www.google.com https://maps.google.com https://docs.google.com',
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self' https://*.payu.com",
    "object-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'"
  ].join('; ');
}

function securityHeaders({ env = process.env } = {}) {
  const csp = env.CSP === 'off' ? null : cspHeader();
  const cspName = env.CSP === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  const https = String(env.APP_URL || 'https://').startsWith('https://') && env.NODE_ENV === 'production';
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    if (csp) res.setHeader(cspName, csp);
    next();
  };
}

// Dozwolone domeny dla zapytań z przeglądarki z innej strony (CORS). Domyślnie tylko nasza domena (z www i bez).
function corsOptions({ env = process.env } = {}) {
  const base = String(env.APP_URL || 'https://www.milkshakebar.pl').replace(/\/$/, '');
  const list = new Set(String(env.CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean));
  list.add(base);
  try {
    const u = new URL(base);
    const host = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
    list.add(`${u.protocol}//${host}`);
  } catch (e) { /* zły APP_URL: zostaje sama lista */ }
  if (env.NODE_ENV !== 'production') { list.add('http://localhost:3000'); list.add('http://127.0.0.1:3000'); }
  return {
    origin(origin, cb) {
      // Bez nagłówka Origin (ta sama strona, aplikacje, PayU) zapytanie przechodzi normalnie
      if (!origin || list.has(origin)) return cb(null, true);
      return cb(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600
  };
}

module.exports = { securityHeaders, corsOptions, cspHeader };
