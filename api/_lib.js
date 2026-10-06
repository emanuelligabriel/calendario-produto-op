'use strict';
/*
 * Utilidades compartilhadas pelas funções da API (o "_" no nome impede que o Vercel
 * exponha este arquivo como endereço).
 *
 * Variáveis de ambiente:
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (ou KV_REST_API_URL / KV_REST_API_TOKEN)
 *   SESSION_SECRET          texto longo e aleatório, usado para assinar a sessão de login
 *   ADMIN_BOOTSTRAP_EMAIL   e-mail do primeiro administrador — só é usado se ainda não existir
 *   ADMIN_BOOTSTRAP_SENHA   nenhum usuário cadastrado (cria a conta automaticamente no primeiro login)
 *   CRON_SECRET             texto aleatório; o endpoint /api/lembretes só roda se o chamador souber esse valor
 *   GMAIL_USER / GMAIL_APP_PASSWORD   conta Gmail/Workspace usada para enviar os lembretes
 *   ALERTA_EMAIL            para onde os lembretes de feriado/data importante são enviados
 */
const crypto = require('crypto');

const SESSION_DAYS = 14;

function config() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '',
    secret: process.env.SESSION_SECRET || '',
    bootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL || '',
    bootstrapSenha: process.env.ADMIN_BOOTSTRAP_SENHA || ''
  };
}

/* ---------- senhas (hash com salt, sem dependências externas) ---------- */
function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verificarSenha(senha, armazenado) {
  const partes = String(armazenado || '').split(':');
  if (partes.length !== 2) return false;
  const hashArmazenado = Buffer.from(partes[1], 'hex');
  const hash = crypto.scryptSync(String(senha), partes[0], 64);
  if (hash.length !== hashArmazenado.length) return false;
  return crypto.timingSafeEqual(hash, hashArmazenado);
}

async function redis(cmd) {
  const c = config();
  const r = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* resposta sem corpo */ }
  if (!r.ok || j.error) throw new Error(j.error || 'redis ' + r.status);
  return j.result;
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

/* ---------- sessão (cookie assinado) ---------- */
function assinar(payload, secret) {
  const corpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(corpo).digest('base64url');
  return corpo + '.' + sig;
}

function verificar(token, secret) {
  const partes = String(token || '').split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const esperado = crypto.createHmac('sha256', secret).update(partes[0]).digest('base64url');
  if (!sameText(partes[1], esperado)) return null;
  try {
    const p = JSON.parse(Buffer.from(partes[0], 'base64url').toString());
    return p && p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}

function cookies(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach(function (par) {
    const i = par.indexOf('=');
    if (i > 0) { try { o[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim()); } catch (e) { /* ignora */ } }
  });
  return o;
}

/* dados: null para limpar a sessão (logout), ou { email, role, nome } pra logar. */
function definirSessao(req, res, dados) {
  const seguro = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  let valor = '';
  if (dados) {
    valor = assinar(Object.assign({}, dados, { exp: Date.now() + SESSION_DAYS * 86400000 }), config().secret);
  }
  res.setHeader('Set-Cookie', 'cal_session=' + valor + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + (dados ? SESSION_DAYS * 86400 : 0) + (seguro ? '; Secure' : ''));
}

/* Devolve { email, role, nome } da sessão assinada, ou null se não estiver logado. */
function sessao(req) {
  const c = config();
  if (!c.secret) return null;
  const p = verificar(cookies(req).cal_session, c.secret);
  return (p && p.email && p.role) ? p : null;
}

function csrfOk(req) {
  return req.method === 'GET' || req.headers['x-requested-with'] === 'cal';
}

/* Confere configuração, proteção contra requisições de outros sites e se a sessão logada
 * tem um dos papéis exigidos (ex.: ['adm','editor']). Devolve true ou responde com o erro
 * e devolve false. */
function exigirPapel(req, res, papeis) {
  const c = config();
  if (!c.secret) { res.status(503).json({ error: 'session_secret_missing' }); return false; }
  if (!c.url || !c.token) { res.status(503).json({ error: 'storage_not_configured' }); return false; }
  if (!csrfOk(req)) { res.status(403).json({ error: 'csrf' }); return false; }
  const s = sessao(req);
  if (!s || papeis.indexOf(s.role) < 0) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
}

function corpo(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b && typeof b === 'object' ? b : null;
}

module.exports = {
  config, redis, sameText, assinar, verificar, cookies, definirSessao, sessao, csrfOk, exigirPapel, corpo,
  hashSenha, verificarSenha
};
