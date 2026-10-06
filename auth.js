'use strict';
/*
 * Login (e-mail + senha, contas individuais) e logout.
 *   GET    /api/auth            -> { logged, email, role, nome }
 *   POST   /api/auth  { email, senha }  -> entra
 *   DELETE /api/auth            -> sai
 */
const lib = require('./_lib');
const usuarios = require('./usuarios');

const KEY_USUARIOS = 'cal-usuarios:v1';

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const c = lib.config();
    if (req.method === 'GET') {
      const s = lib.sessao(req);
      res.status(200).json({ logged: !!s, email: s ? s.email : null, role: s ? s.role : null, nome: s ? s.nome : null });
      return;
    }
    if (!lib.csrfOk(req)) { res.status(403).json({ error: 'csrf' }); return; }
    if (req.method === 'POST') {
      if (!c.secret) { res.status(503).json({ error: 'session_secret_missing' }); return; }
      if (!c.url || !c.token) { res.status(503).json({ error: 'storage_not_configured' }); return; }
      await usuarios.garantirAdminInicial();
      const b = lib.corpo(req);
      const email = String((b && b.email) || '').trim().toLowerCase();
      const senha = String((b && b.senha) || '');
      if (!email || !senha) { res.status(401).json({ error: 'credenciais_invalidas' }); return; }
      const raw = await lib.redis(['HGET', KEY_USUARIOS, email]);
      if (!raw) { res.status(401).json({ error: 'credenciais_invalidas' }); return; }
      let u; try { u = JSON.parse(raw); } catch (e) { res.status(401).json({ error: 'credenciais_invalidas' }); return; }
      if (!lib.verificarSenha(senha, u.senha)) { res.status(401).json({ error: 'credenciais_invalidas' }); return; }
      lib.definirSessao(req, res, { email: u.email, role: u.role, nome: u.nome });
      res.status(200).json({ logged: true, email: u.email, role: u.role, nome: u.nome });
      return;
    }
    if (req.method === 'DELETE') {
      lib.definirSessao(req, res, null);
      res.status(200).json({ logged: false });
      return;
    }
    res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    res.status(500).json({ error: 'internal', detail: String((e && e.message) || e) });
  }
};
