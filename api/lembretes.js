'use strict';
/*
 * Lembretes automáticos de datas que se aproximam (feriados, datas comemorativas, qualquer
 * evento com "avisar X dias antes" preenchido). Rodado 1x por dia pelo Cron do Vercel
 * (veja "crons" em vercel.json) — pode também ser chamado manualmente.
 *
 *   GET /api/lembretes
 *
 * Se a variável CRON_SECRET estiver configurada, o Vercel já envia automaticamente
 * "Authorization: Bearer <CRON_SECRET>" nas chamadas do Cron — este endpoint exige esse
 * cabeçalho quando a variável existir.
 *
 * Requer GMAIL_USER, GMAIL_APP_PASSWORD (conta que envia) e ALERTA_EMAIL (quem recebe).
 */
const lib = require('./_lib');

const KEY = 'cal-eventos:v1';
const TZ = 'America/Sao_Paulo';

function hojeISO() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const o = {}; partes.forEach(function (p) { o[p.type] = p.value; });
  return o.year + '-' + o.month + '-' + o.day;
}

function somarDias(iso, n) {
  const p = iso.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtBR(iso) {
  const p = iso.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

async function enviarEmail(assunto, texto) {
  const user = process.env.GMAIL_USER || '';
  const pass = process.env.GMAIL_APP_PASSWORD || '';
  const para = process.env.ALERTA_EMAIL || user;
  if (!user || !pass || !para) return { ok: false, motivo: 'gmail_nao_configurado' };
  const nodemailer = require('nodemailer');
  const transporte = nodemailer.createTransport({ service: 'gmail', auth: { user: user, pass: pass } });
  await transporte.sendMail({ from: user, to: para, subject: assunto, text: texto });
  return { ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const cronSecret = process.env.CRON_SECRET || '';
    if (cronSecret) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'unauthorized' });
    }
    const c = lib.config();
    if (!c.url || !c.token) return res.status(503).json({ error: 'storage_not_configured' });

    const hoje = hojeISO();
    const flat = (await lib.redis(['HGETALL', KEY])) || [];
    const itens = [];
    for (let i = 0; i < flat.length; i += 2) {
      try { itens.push(JSON.parse(flat[i + 1])); } catch (e) { /* ignora registro corrompido */ }
    }

    const pendentes = itens.filter(function (it) {
      if (it.lembreteDias == null || !it.dataInicio || it.lembreteEnviadoEm) return false;
      return somarDias(it.dataInicio, -it.lembreteDias) === hoje;
    });

    const enviados = [];
    for (const it of pendentes) {
      const assunto = 'Lembrete: ' + it.titulo + ' em ' + fmtBR(it.dataInicio);
      const texto = 'Faltam ' + it.lembreteDias + ' dia(s) para "' + it.titulo + '" (' + fmtBR(it.dataInicio) + ').\n\n'
        + (it.resumo ? it.resumo + '\n\n' : '')
        + 'Categoria: ' + it.categoria + (it.canal ? ' · Canal: ' + it.canal : '') + (it.responsavel ? ' · Responsável: ' + it.responsavel : '') + '\n\n'
        + 'Calendário de planejamento.';
      const r = await enviarEmail(assunto, texto);
      if (r.ok) {
        it.lembreteEnviadoEm = new Date().toISOString();
        await lib.redis(['HSET', KEY, it.id, JSON.stringify(it)]);
        enviados.push(it.id);
      } else {
        return res.status(503).json({ error: r.motivo, checados: itens.length, pendentes: pendentes.length, enviados: enviados });
      }
    }

    return res.status(200).json({ ok: true, hoje: hoje, checados: itens.length, enviados: enviados });
  } catch (e) {
    return res.status(500).json({ error: 'internal', detail: String((e && e.message) || e) });
  }
};
