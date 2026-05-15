const { App, ExpressReceiver } = require('@slack/bolt');
const { createClient } = require('@supabase/supabase-js');

// ── Debug: verificar variables de entorno ─────────────────────
console.log('[umeia-bot] ENV CHECK:', {
  SLACK_BOT_TOKEN:        process.env.SLACK_BOT_TOKEN        ? `${process.env.SLACK_BOT_TOKEN.slice(0,10)}...` : 'MISSING',
  SLACK_SIGNING_SECRET:   process.env.SLACK_SIGNING_SECRET   ? 'OK' : 'MISSING',
  SUPABASE_URL:           process.env.SUPABASE_URL           ? 'OK' : 'MISSING',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'OK' : 'MISSING',
});

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET) {
  throw new Error('Faltan variables de entorno: SLACK_BOT_TOKEN y/o SLACK_SIGNING_SECRET');
}

// ── Supabase ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Slack Bolt con ExpressReceiver (compatible con Vercel) ────
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
  endpoints: '/api/slack',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ── Helpers ───────────────────────────────────────────────────

async function getSprints() {
  const { data, error } = await supabase
    .from('sprints')
    .select('id, name, title')
    .order('id');
  if (error) {
    console.error('[umeia-bot] getSprints:', error.message);
    return [];
  }
  return data || [];
}

function buildModal(sprintOptions) {
  return {
    type: 'modal',
    callback_id: 'crear_tarea',
    title: { type: 'plain_text', text: '✏️ Nueva Tarea' },
    submit: { type: 'plain_text', text: 'Crear tarea' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'input',
        block_id: 'titulo',
        label: { type: 'plain_text', text: 'Título' },
        element: {
          type: 'plain_text_input',
          action_id: 'titulo_input',
          placeholder: { type: 'plain_text', text: 'Ej: Fix bug en login' },
        },
      },
      {
        type: 'input',
        block_id: 'destino',
        label: { type: 'plain_text', text: 'Destino' },
        element: {
          type: 'static_select',
          action_id: 'destino_select',
          placeholder: { type: 'plain_text', text: 'Elegí un sprint o Backlog...' },
          options: sprintOptions,
        },
      },
      {
        type: 'input',
        block_id: 'prioridad',
        label: { type: 'plain_text', text: 'Prioridad' },
        element: {
          type: 'static_select',
          action_id: 'prioridad_select',
          initial_option: {
            text: { type: 'plain_text', text: '🟡 Media' },
            value: 'media',
          },
          options: [
            { text: { type: 'plain_text', text: '🔴 Alta' },  value: 'alta'  },
            { text: { type: 'plain_text', text: '🟡 Media' }, value: 'media' },
            { text: { type: 'plain_text', text: '🟢 Baja' },  value: 'baja'  },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'responsable',
        label: { type: 'plain_text', text: 'Responsable' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'responsable_input',
          placeholder: { type: 'plain_text', text: 'Ej: Lorenzo' },
        },
      },
    ],
  };
}

// ── /tarea → abre modal ───────────────────────────────────────

app.command('/tarea', async ({ ack, client, body }) => {
  await ack();

  const sprints = await getSprints();

  const sprintOptions = [
    {
      text: { type: 'plain_text', text: '📥 Backlog' },
      value: '-1',
    },
    ...sprints.map((s) => ({
      text: {
        type: 'plain_text',
        text: `${s.name}${s.title ? ` — ${s.title}` : ''}`.slice(0, 75),
      },
      value: String(s.id),
    })),
  ];

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal(sprintOptions),
    });
  } catch (err) {
    console.error('[umeia-bot] views.open:', err.message);
  }
});

// ── Submit del modal → inserta en Supabase ────────────────────

app.view('crear_tarea', async ({ ack, view, body, client }) => {
  await ack();

  const values    = view.state.values;
  const titulo    = values.titulo.titulo_input.value?.trim();
  const sprintId  = parseInt(values.destino.destino_select.selected_option.value, 10);
  const prioridad = values.prioridad.prioridad_select.selected_option.value;
  const responsable = values.responsable?.responsable_input?.value?.trim() || '';

  if (!titulo) return;

  // sort_order al final de las tareas existentes en ese sprint
  const { count } = await supabase
    .from('tasks')
    .select('*', { count: 'exact', head: true })
    .eq('sprint_id', sprintId);

  const taskRow = {
    id:          `t${Date.now()}`,
    sprint_id:   sprintId,
    title:       titulo,
    description: '',
    status:      'no_iniciado',
    priority:    prioridad,
    responsible: responsable,
    sort_order:  count ?? 999,
    tags:        '[]',
  };

  const { error } = await supabase.from('tasks').insert(taskRow);

  const userId  = body.user.id;
  const destino = sprintId === -1 ? 'Backlog' : `Sprint ${sprintId}`;
  const prioEmoji = { alta: '🔴', media: '🟡', baja: '🟢' }[prioridad] || '';

  if (error) {
    console.error('[umeia-bot] insert task:', error.message);
    await client.chat.postMessage({
      channel: userId,
      text: `❌ Hubo un error al crear la tarea. Revisá los logs de Vercel.`,
    });
    return;
  }

  await client.chat.postMessage({
    channel: userId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *Tarea creada en ${destino}*\n*${titulo}*`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${prioEmoji} Prioridad: *${prioridad}*${responsable ? `  ·  👤 ${responsable}` : ''}`,
          },
        ],
      },
    ],
    text: `✅ Tarea "${titulo}" creada en ${destino}`,
  });
});

// ── Export para Vercel ────────────────────────────────────────
// Wrapper necesario para que Vercel no parsee el body antes que Bolt
// (si Vercel parsea primero, la verificación de firma de Slack falla)
const handler = (req, res) => receiver.app(req, res);
handler.config = { api: { bodyParser: false } };
module.exports = handler;
