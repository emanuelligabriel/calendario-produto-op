'use strict';
/*
 * API dos eventos do calendário (Vercel Function, Node.js).
 *   GET    /api/eventos            público, sem login — todo mundo com o link vê o calendário
 *   POST   /api/eventos            cria (exige sessão de edição)
 *   PUT    /api/eventos?id=ID      edita (exige sessão de edição)
 *   DELETE /api/eventos?id=ID      remove (exige sessão de edição)
 */
const crypto = require('crypto');
const lib = require('./_lib');

const KEY = 'cal-eventos:v1';
const MAX_ITEMS = 2000;
const MAX_BYTES = 20 * 1024;

const CATEGORIAS = ['feriado', 'aviso-geral', 'aviso-segmentado', 'promocao', 'lancamento-sistema', 'disparo-nps', 'periodo-importante'];
const CANAIS = ['', 'beamer', 'email', 'comunidade', 'outro'];
const PUBLICOS = ['', 'clientes', 'funcionarios', 'cs', 'segmentado'];
const RESPONSAVEIS = ['', 'marketing', 'cs', 'suporte', 'produto'];
const MAX_HIST = 15;
// campos que entram no histórico de alterações quando mudam (não inclui controle interno)
const CAMPOS_HIST = ['titulo', 'categoria', 'dataInicio', 'dataFim', 'canal', 'publico', 'responsavel', 'grupo', 'resumo', 'link', 'lembreteDias'];

function registrarHistorico(historico, acao, campos, quando, por) {
  const lista = Array.isArray(historico) ? historico.slice() : [];
  const entrada = { em: quando, acao: acao };
  if (campos && campos.length) entrada.campos = campos;
  if (por) entrada.por = por;
  lista.push(entrada);
  return lista.slice(-MAX_HIST);
}

function limpar(b) {
  const txt = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const data = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const di = data(b.dataInicio);
  const df = data(b.dataFim) || di;
  const lembreteDias = (typeof b.lembreteDias === 'number' && isFinite(b.lembreteDias)) ? Math.max(0, Math.min(30, Math.round(b.lembreteDias))) : null;
  return {
    titulo: txt(b.titulo, 120),
    categoria: CATEGORIAS.indexOf(b.categoria) >= 0 ? b.categoria : 'aviso-geral',
    dataInicio: di,
    dataFim: df,
    canal: CANAIS.indexOf(b.canal) >= 0 ? b.canal : '',
    publico: PUBLICOS.indexOf(b.publico) >= 0 ? b.publico : '',
    responsavel: RESPONSAVEIS.indexOf(b.responsavel) >= 0 ? b.responsavel : '',
    grupo: txt(b.grupo, 60),
    resumo: txt(b.resumo, 2000),
    link: txt(b.link, 500),
    lembreteDias: lembreteDias
  };
}

async function ler(id) {
  const raw = await lib.redis(['HGET', KEY, id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const c = lib.config();
    if (!c.url || !c.token) return res.status(503).json({ error: 'storage_not_configured' });
    const id = req.query && req.query.id ? String(req.query.id).slice(0, 40) : '';

    if (req.method === 'GET') {
      const flat = (await lib.redis(['HGETALL', KEY])) || [];
      const items = [];
      for (let i = 0; i < flat.length; i += 2) {
        try { items.push(JSON.parse(flat[i + 1])); } catch (e) { /* ignora registro corrompido */ }
      }
      items.sort((a, b) => String(a.dataInicio).localeCompare(String(b.dataInicio)));
      return res.status(200).json({ items: items, categorias: CATEGORIAS, canais: CANAIS, publicos: PUBLICOS, responsaveis: RESPONSAVEIS });
    }

    if (!lib.exigirPapel(req, res, ['adm', 'editor'])) return undefined;
    const quem = lib.sessao(req);
    const porEmail = quem ? quem.email : '';

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id_required' });
      await lib.redis(['HDEL', KEY, id]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = lib.corpo(req);
      if (!body) return res.status(400).json({ error: 'invalid_body' });
      const agora = new Date().toISOString();

      if (req.method === 'POST' && req.query && req.query.acao === 'importar') {
        const lista = Array.isArray(body.itens) ? body.itens.slice(0, 300) : [];
        const total = Number(await lib.redis(['HLEN', KEY])) || 0;
        if (total + lista.length > MAX_ITEMS) return res.status(400).json({ error: 'limit_reached' });
        const criados = [];
        for (const raw of lista) {
          const limpo = limpar(raw || {});
          if (!limpo.titulo || !limpo.dataInicio) continue;
          const novo = Object.assign(limpo, {
            id: Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + criados.length,
            rev: 1, lembreteEnviadoEm: '', createdAt: agora, updatedAt: agora,
            historico: registrarHistorico([], 'importado', null, agora, porEmail)
          });
          await lib.redis(['HSET', KEY, novo.id, JSON.stringify(novo)]);
          criados.push(novo);
        }
        return res.status(201).json({ itens: criados });
      }

      if (JSON.stringify(body).length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

      if (req.method === 'POST') {
        const total = Number(await lib.redis(['HLEN', KEY])) || 0;
        if (total >= MAX_ITEMS) return res.status(400).json({ error: 'limit_reached' });
        const limpo = limpar(body);
        if (!limpo.titulo || !limpo.dataInicio) return res.status(400).json({ error: 'titulo_e_data_obrigatorios' });
        const novo = Object.assign(limpo, {
          id: Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
          rev: 1,
          lembreteEnviadoEm: '',
          createdAt: agora,
          updatedAt: agora,
          historico: registrarHistorico([], 'criado', null, agora, porEmail)
        });
        await lib.redis(['HSET', KEY, novo.id, JSON.stringify(novo)]);
        return res.status(201).json({ item: novo });
      }

      if (!id) return res.status(400).json({ error: 'id_required' });
      const atual = await ler(id);
      if (!atual) return res.status(404).json({ error: 'not_found' });
      if (body.force !== true && body.rev != null && Number(body.rev) !== atual.rev) {
        return res.status(409).json({ error: 'conflict', item: atual });
      }
      const limpo = limpar(Object.assign({}, atual, body));
      // reseta o controle de lembrete se a data ou o prazo de aviso mudou
      const lembreteEnviadoEm = (limpo.dataInicio === atual.dataInicio && limpo.lembreteDias === atual.lembreteDias) ? atual.lembreteEnviadoEm : '';
      const camposMudados = CAMPOS_HIST.filter((k) => JSON.stringify(limpo[k]) !== JSON.stringify(atual[k]));
      const historico = camposMudados.length ? registrarHistorico(atual.historico, 'editado', camposMudados, agora, porEmail) : (atual.historico || []);
      const novo = Object.assign({}, atual, limpo, { id: atual.id, rev: atual.rev + 1, lembreteEnviadoEm: lembreteEnviadoEm, updatedAt: agora, historico: historico });
      await lib.redis(['HSET', KEY, novo.id, JSON.stringify(novo)]);
      return res.status(200).json({ item: novo });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: String((e && e.message) || e) });
  }
};
