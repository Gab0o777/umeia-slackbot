const crypto   = require('crypto');
const { WebClient } = require('@slack/web-api');
const { createClient } = require('@supabase/supabase-js');

// ── Clientes ──────────────────────────────────────────────────
const slack    = new WebClient(process.env.SLACK_BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Leer raw body (soporta stream y body pre-leido por Vercel) ─
async function getRawBody(req) {
  // Vercel a veces pre-lee el body y lo pone en req.body
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body);
    // objeto parseado → reconstruir como query string
    const qs = require('querystring');
    return Buffer.from(qs.stringify(req.body));
  }
  // Leer desde stream
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Verificar firma de Slack ──────────────────────────────────
function verifySignature(rawBody, headers) {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];

  console.log('[umeia-bot] verify debug:', {
    rawBodyLength:   rawBody.length,
    rawBodyPreview:  rawBody.toString().slice(0, 80),
    timestamp,
    slackSig:        signature?.slice(0, 20) + '...',
    secretPrefix:    process.env.SLACK_SIGNING_SECRET?.slice(0, 6) + '...',
  });

  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
  hmac.update(`v0:${timestamp}:${rawBody.toString()}`);
  const expected = `v0=${hmac.digest('hex')}`;

  console.log('[umeia-bot] expected sig prefix:', expected.slice(0, 20) + '...');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Parsear body URL-encoded ──────────────────────────────────
function parseForm(raw) {
  const params = new URLSearchParams(raw.toString());
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

// ── Supabase helpers ──────────────────────────────────────────
async function getSprints() {
  const { data } = await supabase
    .from('sprints').select('id, name, title').order('id');
  return data || [];
}

// ── Modal ─────────────────────────────────────────────────────
function buildModal(sprints) {
  const sprintOptions = [
    { text: { type: 'plain_text', text: '📥 Backlog' }, value: '-1' },
    ...sprints.map((s) => ({
      text: {
        type: 'plain_text',
        text: (s.name + (s.title ? ` — ${s.title}` : '')).slice(0, 75),
      },
      value: String(s.id),
    })),
  ];

  return {
    type: 'modal',
    callback_id: 'crear_tarea',
    title:  { type: 'plain_text', text: 'Nueva Tarea'  },
    submit: { type: 'plain_text', text: 'Crear tarea'  },
    close:  { type: 'plain_text', text: 'Cancelar'     },
    blocks: [
      {
        type: 'input', block_id: 'titulo',
        label:   { type: 'plain_text', text: 'Titulo' },
        element: {
          type: 'plain_text_input', action_id: 'titulo_input',
          placeholder: { type: 'plain_text', text: 'Ej: Fix bug en login' },
        },
      },
      {
        type: 'input', block_id: 'destino',
        label:   { type: 'plain_text', text: 'Destino' },
        element: {
          type: 'static_select', action_id: 'destino_select',
          placeholder: { type: 'plain_text', text: 'Elegí un sprint o Backlog...' },
          options: sprintOptions,
        },
      },
      {
        type: 'input', block_id: 'prioridad',
        label:   { type: 'plain_text', text: 'Prioridad' },
        element: {
          type: 'static_select', action_id: 'prioridad_select',
          initial_option: { text: { type: 'plain_text', text: 'Media' }, value: 'media' },
          options: [
            { text: { type: 'plain_text', text: 'Alta'  }, value: 'alta'  },
            { text: { type: 'plain_text', text: 'Media' }, value: 'media' },
            { text: { type: 'plain_text', text: 'Baja'  }, value: 'baja'  },
          ],
        },
      },
      {
        type: 'input', block_id: 'responsable', optional: true,
        label:   { type: 'plain_text', text: 'Responsable' },
        element: {
          type: 'plain_text_input', action_id: 'responsable_input',
          placeholder: { type: 'plain_text', text: 'Ej: Lorenzo' },
        },
      },
    ],
  };
}

// ── Slash command ─────────────────────────────────────────────
async function handleCommand(body) {
  const sprints = await getSprints();
  await slack.views.open({ trigger_id: body.trigger_id, view: buildModal(sprints) });
}

// ── Submit modal ──────────────────────────────────────────────
async function handleViewSubmission(payload) {
  const v           = payload.view.state.values;
  const titulo      = v.titulo.titulo_input.value?.trim();
  const sprintId    = parseInt(v.destino.destino_select.selected_option.value, 10);
  const prioridad   = v.prioridad.prioridad_select.selected_option.value;
  const responsable = v.responsable?.responsable_input?.value?.trim() || '';
  const userId      = payload.user.id;

  if (!titulo) return;

  const { count } = await supabase
    .from('tasks').select('*', { count: 'exact', head: true }).eq('sprint_id', sprintId);

  const { error } = await supabase.from('tasks').insert({
    id: `t${Date.now()}`, sprint_id: sprintId, title: titulo,
    description: '', status: 'no_iniciado', priority: prioridad,
    responsible: responsable, sort_order: count ?? 999, tags: '[]',
  });

  const destino   = sprintId === -1 ? 'Backlog' : `Sprint ${sprintId}`;
  const prioEmoji = { alta: 'Alta', media: 'Media', baja: 'Baja' }[prioridad] || '';

  if (error) {
    console.error('[umeia-bot] insert error:', error.message);
    await slack.chat.postMessage({ channel: userId, text: 'Error al crear la tarea.' });
    return;
  }

  await slack.chat.postMessage({
    channel: userId,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Tarea creada en ${destino}*\n${titulo}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Prioridad: *${prioEmoji}*${responsable ? `  |  Responsable: ${responsable}` : ''}` }] },
    ],
    text: `Tarea "${titulo}" creada en ${destino}`,
  });
}

// ── Handler principal ─────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method === 'GET')  return res.status(200).send('Umeia Bot running');
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch (e) { return res.status(500).send('Error reading body'); }

  if (!verifySignature(rawBody, req.headers)) {
    console.warn('[umeia-bot] Signature mismatch');
    return res.status(401).send('Unauthorized');
  }

  const body = parseForm(rawBody);

  if (body.command === '/tarea') {
    res.status(200).send('');
    try { await handleCommand(body); } catch (e) { console.error('[umeia-bot] command error:', e); }
    return;
  }

  if (body.payload) {
    let payload;
    try { payload = JSON.parse(body.payload); } catch { return res.status(400).send('Bad payload'); }

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'crear_tarea') {
      res.status(200).json({ response_action: 'clear' });
      try { await handleViewSubmission(payload); } catch (e) { console.error('[umeia-bot] view error:', e); }
      return;
    }
  }

  res.status(200).send('OK');
};
