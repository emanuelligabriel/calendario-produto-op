'use strict';
/*
 * Contas de usuário e convites (Vercel Function, Node.js).
 *   GET    /api/usuarios?acao=convite&token=TOKEN   público — valida um link de convite
 *   POST   /api/usuarios?acao=resgatar               público — cria a conta a partir de um convite e já loga
 *   GET    /api/usuarios                              exige admin — lista usuários
 *   POST   /api/usuarios?acao=convite                 exige admin — gera um link de convite { role }
 *   PUT    /api/usuarios?email=EMAIL                  exige admin — troca o papel { role }
 *   DELETE /api/usuarios?email=EMAIL                   exige admin — remove a conta
 *
 * Papéis: adm (edita eventos + gerencia usuários), editor (edita eventos), leitor (só vê).
 */
const crypto = require('crypto');
const lib = require('./_lib');

const KEY_USUARIOS = 'cal-usuarios:v1';
const KEY_CONVITES = 'cal-convites:v1';
const ROLES = ['adm', 'editor', 'leitor'];
const CONVITE_TTL_MS = 7 * 24 * 3600 * 1000;

function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function emailValido(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

async function listarUsuarios() {
  const flat = (await lib.redis(['HGETALL', KEY_USUARIOS])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push(JSON.parse(flat[i + 1])); } catch (e) { /* ignora registro corrompido */ }
  }
  return out;
}
function contarAdmins(usuarios) { return usuarios.filter((u) => u.role === 'adm').length; }

/* Cria o primeiro administrador a partir das variáveis de ambiente, se ainda não existir
 * NENHUM usuário cadastrado. Chamado pelo login — assim o primeiro acesso "se resolve sozinho"
 * sem precisar de um passo manual extra no deploy. */
async function garantirAdminInicial() {
  const c = lib.config();
  if (!c.bootstrapEmail || !c.bootstrapSenha) return;
  const total = Number(await lib.redis(['HLEN', KEY_USUARIOS])) || 0;
  if (total > 0) return;
  const email = normEmail(c.bootstrapEmail);
  const novo = {
    email: email, nome: 'Administrador(a)', role: 'adm',
    senha: lib.hashSenha(c.bootstrapSenha), criadoEm: new Date().toISOString(), criadoPor: 'bootstrap'
  };
  await lib.redis(['HSET', KEY_USUARIOS, email, JSON.stringify(novo)]);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const c = lib.config();
    if (!c.url || !c.token) return res.status(503).json({ error: 'storage_not_configured' });
    const acao = req.query && req.query.acao;

    if (req.method === 'GET' && acao === 'convite') {
      const token = String((req.query && req.query.token) || '');
      if (!token) return res.status(400).json({ error: 'token_obrigatorio' });
      const raw = await lib.redis(['HGET', KEY_CONVITES, token]);
      if (!raw) return res.status(404).json({ error: 'convite_invalido' });
      let convite; try { convite = JSON.parse(raw); } catch (e) { return res.status(404).json({ error: 'convite_invalido' }); }
      if (convite.usadoEm) return res.status(410).json({ error: 'convite_usado' });
      if (Date.now() > convite.expiraEm) return res.status(410).json({ error: 'convite_expirado' });
      return res.status(200).json({ valido: true, role: convite.role });
    }

    if (req.method === 'POST' && acao === 'resgatar') {
      if (!c.secret) return res.status(503).json({ error: 'session_secret_missing' });
      if (!lib.csrfOk(req)) return res.status(403).json({ error: 'csrf' });
      const body = lib.corpo(req);
      if (!body) return res.status(400).json({ error: 'invalid_body' });
      const token = String(body.token || '');
      const nome = String(body.nome || '').trim().slice(0, 80);
      const email = normEmail(body.email);
      const senha = String(body.senha || '');
      if (!token) return res.status(400).json({ error: 'token_obrigatorio' });
      if (!nome) return res.status(400).json({ error: 'nome_obrigatorio' });
      if (!emailValido(email)) return res.status(400).json({ error: 'email_invalido' });
      if (senha.length < 8) return res.status(400).json({ error: 'senha_curta' });
      const rawConvite = await lib.redis(['HGET', KEY_CONVITES, token]);
      if (!rawConvite) return res.status(404).json({ error: 'convite_invalido' });
      let convite; try { convite = JSON.parse(rawConvite); } catch (e) { return res.status(404).json({ error: 'convite_invalido' }); }
      if (convite.usadoEm) return res.status(410).json({ error: 'convite_usado' });
      if (Date.now() > convite.expiraEm) return res.status(410).json({ error: 'convite_expirado' });
      const existente = await lib.redis(['HGET', KEY_USUARIOS, email]);
      if (existente) return res.status(409).json({ error: 'email_ja_cadastrado' });
      const agora = new Date().toISOString();
      const novo = { email: email, nome: nome, role: convite.role, senha: lib.hashSenha(senha), criadoEm: agora, criadoPor: convite.criadoPor || '' };
      await lib.redis(['HSET', KEY_USUARIOS, email, JSON.stringify(novo)]);
      convite.usadoEm = agora; convite.usadoPor = email;
      await lib.redis(['HSET', KEY_CONVITES, token, JSON.stringify(convite)]);
      lib.definirSessao(req, res, { email: novo.email, role: novo.role, nome: novo.nome });
      return res.status(201).json({ email: novo.email, role: novo.role, nome: novo.nome });
    }

    if (!lib.exigirPapel(req, res, ['adm'])) return undefined;

    if (req.method === 'GET') {
      const usuarios = await listarUsuarios();
      usuarios.sort((a, b) => String(a.email).localeCompare(String(b.email)));
      return res.status(200).json({ itens: usuarios.map((u) => ({ email: u.email, nome: u.nome, role: u.role, criadoEm: u.criadoEm })) });
    }

    if (req.method === 'POST' && acao === 'convite') {
      const body = lib.corpo(req) || {};
      const role = ROLES.indexOf(body.role) >= 0 ? body.role : 'leitor';
      const token = crypto.randomBytes(20).toString('hex');
      const quem = lib.sessao(req);
      const convite = { role: role, criadoPor: quem ? quem.email : '', criadoEm: new Date().toISOString(), expiraEm: Date.now() + CONVITE_TTL_MS };
      await lib.redis(['HSET', KEY_CONVITES, token, JSON.stringify(convite)]);
      return res.status(201).json({ token: token, role: role, expiraEm: convite.expiraEm });
    }

    if (req.method === 'PUT') {
      const email = normEmail(req.query && req.query.email);
      if (!email) return res.status(400).json({ error: 'email_obrigatorio' });
      const body = lib.corpo(req) || {};
      const role = ROLES.indexOf(body.role) >= 0 ? body.role : null;
      if (!role) return res.status(400).json({ error: 'role_invalido' });
      const raw = await lib.redis(['HGET', KEY_USUARIOS, email]);
      if (!raw) return res.status(404).json({ error: 'not_found' });
      let u; try { u = JSON.parse(raw); } catch (e) { return res.status(500).json({ error: 'corrompido' }); }
      if (u.role === 'adm' && role !== 'adm') {
        const usuarios = await listarUsuarios();
        if (contarAdmins(usuarios) <= 1) return res.status(400).json({ error: 'ultimo_admin' });
      }
      u.role = role;
      await lib.redis(['HSET', KEY_USUARIOS, email, JSON.stringify(u)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const email = normEmail(req.query && req.query.email);
      if (!email) return res.status(400).json({ error: 'email_obrigatorio' });
      const raw = await lib.redis(['HGET', KEY_USUARIOS, email]);
      if (!raw) return res.status(200).json({ ok: true });
      let u; try { u = JSON.parse(raw); } catch (e) { u = null; }
      if (u && u.role === 'adm') {
        const usuarios = await listarUsuarios();
        if (contarAdmins(usuarios) <= 1) return res.status(400).json({ error: 'ultimo_admin' });
      }
      await lib.redis(['HDEL', KEY_USUARIOS, email]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: String((e && e.message) || e) });
  }
};

module.exports.garantirAdminInicial = garantirAdminInicial;
