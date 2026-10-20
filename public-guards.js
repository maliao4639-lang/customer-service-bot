'use strict';
module.exports = function installPublicGuards(app, publicBaseUrl) {
  app.set('trust proxy', 'loopback');
  app.use('/api/billing', (req,res,next) => {
    if (process.env.CSB_FREE_ONLY === '1' || (process.env.NODE_ENV === 'production' && process.env.PADDLE_ENVIRONMENT === 'live')) return res.status(403).json({error:'Paid plans are not available'});
    next();
  });
  app.use('/api/chat', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.set('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const expectedOrigin = new URL(publicBaseUrl).origin;
  app.use(['/api/admin', '/api/auth', '/api/billing'], (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/webhook') return next();
    if (req.get('Origin') && req.get('Origin') !== expectedOrigin) {
      return res.status(403).json({ error: 'Untrusted origin' });
    }
    next();
  });
  const buckets = new Map();
  const cleanup = setInterval(() => {
    for (const [key, value] of buckets) if (value.until <= Date.now()) buckets.delete(key);
  }, 60000);
  cleanup.unref();
  app.use('/api/auth', (req, res, next) => {
    if (req.method !== 'POST' || !['/login','/signup'].includes(req.path)) return next();
    const now = Date.now();
    const key = req.ip + ':' + req.path;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 10000) return res.status(429).json({ error: 'Please try again later' });
      bucket = {count: 0, until: now + (req.path === '/signup' ? 3600000 : 60000)};
      buckets.set(key, bucket);
    }
    if (++bucket.count > (req.path === '/signup' ? 5 : 20)) {
      res.set('Retry-After', String(Math.ceil((bucket.until-now)/1000)));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  });
};
