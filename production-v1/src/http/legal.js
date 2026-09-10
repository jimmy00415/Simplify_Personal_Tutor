import { readFileSync } from 'node:fs';
import express from 'express';

const privacyHtml = readFileSync(new URL('../../public/legal/privacy.html', import.meta.url), 'utf8');
const supportHtml = readFileSync(new URL('../../public/legal/support.html', import.meta.url), 'utf8');

export function createLegalRouter() {
  const router = express.Router();

  function page(html) {
    return (request, response) => {
      void request;
      response.set('Cache-Control', 'public, max-age=300');
      response.set('Content-Type', 'text/html; charset=utf-8');
      response.send(html);
    };
  }

  router.get('/privacy', page(privacyHtml));
  router.get('/support', page(supportHtml));
  return router;
}
