const express = require('express');
const cors = require('cors');
const config = require('./config/config.json');

// Environment overrides are applied before routes load the shared config object.
if (process.env.QUERY_TIMEOUT_MS) config.queryTimeout = Number(process.env.QUERY_TIMEOUT_MS);
else config.queryTimeout = 5000;
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_MD5) {
  config.admins = [{ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD_MD5 }];
}

const app = express();
app.set('trust proxy', 1);
const publicCors = cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
});
app.use((req, res, next) => {
  if (!/^\/(?:admin|login|update)(?:\/|$)/i.test(req.path)) {
    return publicCors(req, res, next);
  }

  res.vary('Origin');
  const origin = req.get('Origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ status: 'error', message: 'Cross-origin access to administrator APIs is forbidden' });
  }
  next();
});
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/status', require('./routes/status'));
app.use('/status_img', require('./routes/status_img'));
app.use('/app_img', require('./routes/appImage'));
app.use('/sync_app_img', require('./routes/sync_appImage'));
app.use('/screenshot', require('./routes/screenshot'));
app.use('/config', require('./routes/config'));
app.use('/login', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use((req, res) => res.status(404).json({ status: 'error', message: 'API not found' }));
app.use((error, req, res, next) => {
  console.error(error);
  if (!res.headersSent) {
    const status = ['STORAGE_CONFIGURATION_ERROR', 'STORAGE_UNAVAILABLE'].includes(error.code) ? 503 : 500;
    res.status(status).json({ status: 'error', message: error.message, code: error.code });
  }
});
module.exports = app;
