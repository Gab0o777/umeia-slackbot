// Vercel Edge Runtime — recibe el body sin parsear
export const config = { runtime: 'edge' };

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLACK_TOKEN     = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET  = process.env.SLACK_SIGNING_SECRET;

// ── Verificar firma con Web Crypto (disponible en Edge) ───────
async function verifySignature(rawBody, headers) {
  const timestamp = headers.get('x-slack-request-timestamp');
  const signature  = headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const enc     = new TextEncoder();
  const key     = await crypto.subtle.importKey('raw', enc.encode(SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${timestamp}:${rawBody}`));
  const hex      = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `v0=${hex}` === signature;
}

// ── Supabase ──────────────────────────────────────────────────
async function dbSelect(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return res.json();
}

async function dbInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
}

// ── Slack API ─────────────────────────────────────────────────
async function slack(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Modal ─────────────────────────────────────────────────────
function buildModal(sprints) {
  const sprintOptions = [
    { text: { type: 'plain_text', text: 'Backlog' }, value: '-1' },
    ...(sprints || []).map(s => ({
      text: { type: 'plain_text', text: (s.name + (s.title ? ` — ${s.title}` : '')).slice(0, 75) },
      value: String(s.id),
    })),
  ];
  return {
    type: 'modal', callback_id: 'crear_tarea',
    title:  { type: 'plain_text', text: 'Nueva Tarea'  },
    submit: { type: 'plain_text', text: 'Crear tarea'  },
    close:  { type: 'plain_text', text: 'Cancelar'     },
    blocks: [
      { type: 'input', block_id: 'titulo',
        label: { type: 'plain_text', text: 'Titulo' },
        element: { type: 'plain_text_input', action_id: 'titulo_input', placeholder: { type: 'plain_text', text: 'Ej: Fix bug en login' } } },
      { type: 'input', block_id: 'destino',
        label: { type: 'plain_text', text: 'Destino' },
        element: { type: 'static_select', action_id: 'destino_select', placeholder: { type: 'plain_text', text: 'Sprint o Backlog...' }, options: sprintOptions } },
      { type: 'input', block_id: 'prioridad',
        label: { type: 'plain_text', text: 'Prioridad' },
        element: { type: 'static_select', action_id: 'prioridad_select',
          initial_option: { text: { type: 'plain_text', text: 'Media' }, value: 'media' },
          options: [
            { text: { type: 'plain_text', text: 'Alta'  }, value: 'alta'  },
            { text: { type: 'plain_text', text: 'Media' }, value: 'media' },
            { text: { type: 'plain_text', text: 'Baja'  }, value: 'baja'  },
          ] } },
      { type: 'input', block_id: 'responsable', optional: true,
        label: { type: 'plain_text', text: 'Responsable' },
        element: { type: 'plain_text_input', action_id: 'responsable_input', placeholder: { type: 'plain_text', text: 'Ej: Lorenzo' } } },
    ],
  };
}

// ── Handler principal ─────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'GET')  return new Response('Umeia Bot running');
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const rawBody = await req.text(); // raw, sin parsear

  if (!await verifySignature(rawBody, req.headers)) {
    console.log('[umeia-bot] Signature mismatch');
    return new Response('Unauthorized', { status: 401 });
  }

  const body = Object.fromEntries(new URLSearchParams(rawBody));

  // ── Slash command /tarea ────────────────────────────────────
  if (body.command === '/tarea') {
    const sprints = await dbSelect('sprints', 'select=id,name,title&order=id');
    const result  = await slack('views.open', { trigger_id: body.trigger_id, view: buildModal(sprints) });
    console.log('[umeia-bot] views.open:', result.ok, result.error || '');
    return new Response('', { status: 200 });
  }

  // ── Modal submit ────────────────────────────────────────────
  if (body.payload) {
    const payload = JSON.parse(body.payload);
    if (payload.type === 'view_submission' && payload.view?.callback_id === 'crear_tarea') {
      const v           = payload.view.state.values;
      const titulo      = v.titulo.titulo_input.value?.trim();
      const sprintId    = parseInt(v.destino.destino_select.selected_option.value, 10);
      const prioridad   = v.prioridad.prioridad_select.selected_option.value;
      const responsable = v.responsable?.responsable_input?.value?.trim() || '';
      const userId      = payload.user.id;

      if (titulo) {
        const existing  = await dbSelect('tasks', `sprint_id=eq.${sprintId}&select=id`);
        const sortOrder = Array.isArray(existing) ? existing.length : 999;

        try {
          await dbInsert('tasks', {
            id: `t${Date.now()}`, sprint_id: sprintId, title: titulo,
            description: '', status: 'no_iniciado', priority: prioridad,
            responsible: responsable, sort_order: sortOrder, tags: '[]',
          });
          const destino = sprintId === -1 ? 'Backlog' : `Sprint ${sprintId}`;
          await slack('chat.postMessage', {
            channel: userId,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: `Tarea creada en *${destino}*\n*${titulo}*` } },
              { type: 'context', elements: [{ type: 'mrkdwn', text: `Prioridad: *${prioridad}*${responsable ? `  |  ${responsable}` : ''}` }] },
            ],
            text: `Tarea "${titulo}" creada en ${destino}`,
          });
        } catch (e) {
          console.error('[umeia-bot] error:', e.message);
          await slack('chat.postMessage', { channel: userId, text: 'Error al crear la tarea.' });
        }
      }

      return new Response(JSON.stringify({ response_action: 'clear' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('OK', { status: 200 });
}
