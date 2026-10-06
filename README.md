# Calendário de Lançamentos

Página única (`index.html`) com uma API na pasta `api/` que guarda os eventos num Redis.
Qualquer pessoa com o link **vê** o calendário sem precisar de login. Para criar, editar ou excluir
eventos é preciso entrar com e-mail e senha — cada pessoa tem sua própria conta, com um papel
(admin, editor ou leitor).

## Arquivos

- `index.html`: a página.
- `api/eventos.js`: os eventos do calendário (criar, editar, excluir, listar, importar em lote).
- `api/auth.js`: entrar e sair da conta (e-mail + senha).
- `api/usuarios.js`: contas de usuário e convites (criar convite, resgatar convite, listar/promover/remover usuários).
- `api/lembretes.js`: roda uma vez por dia (Cron do Vercel) e manda e-mail quando falta X dias para um evento.
- `api/_lib.js`: utilidades compartilhadas (o `_` no nome é proposital).
- `vercel.json`: configura o horário do Cron de lembretes.
- `package.json`: dependência do envio de e-mail (`nodemailer`).

Todos ficam no repositório com `index.html` na raiz e os arquivos dentro da pasta `api`.

## Configurar no Vercel

1. **Banco:** em Storage, conecte o Upstash for Redis ao projeto (pode ser uma instância nova, separada da
   calculadora de campanhas). O Vercel cria `KV_REST_API_URL` e `KV_REST_API_TOKEN` (a API também aceita
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
2. **`SESSION_SECRET`:** em Settings → Environment Variables, um texto longo e aleatório (40+ caracteres).
   Assina a sessão de quem está logado. Não compartilhe.
3. **`ADMIN_BOOTSTRAP_EMAIL`** e **`ADMIN_BOOTSTRAP_SENHA`:** o e-mail e a senha da primeira conta
   administradora. Elas só são usadas uma vez, automaticamente, no primeiro login tentado depois do deploy
   (se ainda não existir nenhuma conta no banco) — não é preciso nenhum passo manual extra. Depois que essa
   conta existir, pode trocar essas variáveis para qualquer coisa ou remover: elas não são verificadas de
   novo. A senha da conta pode ser trocada criando uma nova conta admin e removendo a antiga pelo painel
   de Usuários (ver "Como editar" abaixo).
4. **Lembretes por e-mail (opcional, mas recomendado):**
   - `GMAIL_USER`: o e-mail da conta que envia (Gmail ou Google Workspace).
   - `GMAIL_APP_PASSWORD`: a senha de app dessa conta (não é a senha normal — veja "Gerar senha de app do Gmail").
   - `ALERTA_EMAIL`: para onde o aviso vai (pode ser o mesmo `GMAIL_USER`).
   - `CRON_SECRET`: um texto aleatório qualquer; protege o endereço `/api/lembretes` para que só o Cron do
     Vercel consiga chamá-lo (o Vercel manda esse valor sozinho quando a variável existe).
5. Faça um **Redeploy** — variáveis novas só valem em deploys novos.

Sem as variáveis de e-mail, o calendário funciona normalmente; só os lembretes automáticos ficam desligados
(o Cron roda, não encontra e-mail configurado e não faz nada).

## Como editar

1. Abra o site e clique em **Entrar**, no canto superior direito.
2. Digite seu e-mail e senha.
3. Se sua conta for `admin` ou `editor`, aparecem os botões **+ Novo** e, se o calendário ainda estiver
   vazio, **Importar planejamento** (importa de uma vez os eventos já levantados da planilha anterior —
   revise as categorias depois, porque a classificação inicial foi feita por aproximação).
4. Para sair da conta, clique em **Sair**.

Quem abrir o link sem estar logado só visualiza — não vê os botões de editar.

## Contas e papéis

Existem três papéis:

- **adm**: edita eventos e também gerencia usuários (convidar, trocar papel, remover) pelo botão
  **Usuários**, que só aparece para administradores.
- **editor**: edita eventos (criar, editar, excluir, importar), mas não vê o painel de Usuários.
- **leitor**: faz login, mas por enquanto tem o mesmo acesso de quem não está logado (só visualiza) —
  serve para quem deve ter uma conta própria (por exemplo, para fins de histórico/identificação) sem
  poder alterar nada.

Não existe cadastro aberto: toda conta nova nasce de um **convite**. Um administrador clica em
**Usuários → Convidar**, escolhe o papel (adm/editor/leitor) e copia o link gerado. Quem recebe o link
abre, preenche nome, e-mail e senha, e a conta já é criada e logada automaticamente. Cada link vale por
7 dias e só pode ser usado uma vez.

Pelo mesmo painel de Usuários um administrador pode trocar o papel de alguém ou remover uma conta — com
uma proteção: não é possível remover ou despromover o último administrador restante, para ninguém ficar
trancado fora do painel.

O histórico de cada evento (visível ao abrir o evento) agora também mostra o e-mail de quem fez cada
alteração, além do quê mudou e quando.

## Lembretes automáticos

Cada evento tem um campo opcional "Avisar por e-mail quantos dias antes?". Se preenchido (por exemplo, 5
para um feriado), o Cron do Vercel roda uma vez por dia e manda um e-mail quando faltar exatamente esse
número de dias para a data de início do evento. Cada evento só dispara o aviso uma vez.

## Segurança

- Cada conta tem sua própria senha, guardada no banco só como hash (nunca em texto puro).
- Sessão por cookie assinado (HttpOnly, SameSite, 14 dias), carregando e-mail e papel. Requisições que
  alteram dados exigem um cabeçalho próprio (proteção contra CSRF), inclusive para resgatar um convite.
- Só `adm` e `editor` conseguem alterar eventos; só `adm` gerencia usuários.
- A visualização (`GET`) é pública de propósito — é assim que o link funciona para o time inteiro.
- Sempre sirva o site por HTTPS (o Vercel já faz isso).

## Sem o servidor

Sem a API, o banco ou o `SESSION_SECRET`, a página funciona em modo local: salva só no navegador de quem usa
e avisa isso na barra do topo — útil para testar ou usar como rascunho antes de publicar de verdade.

## Ajustar categorias e listas

As categorias, canais, públicos e responsáveis ficam no início do script de `index.html`
(`CATS`, `CANAIS`, `PUBLICOS`, `RESPS`) e precisam bater com as mesmas listas em `api/eventos.js`
(`CATEGORIAS`, `CANAIS`, `PUBLICOS`, `RESPONSAVEIS`) — se adicionar uma categoria nova, mexa nos dois lugares.
