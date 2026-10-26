'use strict';
const crypto = require('node:crypto');
const { openDb } = require('./db');
const { createApp } = require('./app');

let secret = process.env.JWT_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET is not set; using a random secret. Tokens will be invalid after restart.');
}

const port = Number(process.env.PORT) || 3000;
createApp(openDb(), { secret }).listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Auth server listening on port ${port}`);
});
