export const config = { runtime: 'edge' };

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLACK_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const API_BASE       = 'https://umeia.space';

// ── Firma ─────────────────────────────────────────────────────
async function verifySignature(rawBody, headers) {
  const timestamp = headers.get('x-slack-request-timestamp');
  const signature = headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${timestamp}:${rawBody}`));
  const hex = 'v0=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === signature;
}

// ── Helpers ───────────────────────────────────────────────────
const dbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function dbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: dbHeaders });
  return res.ok ? res.json() : [];
}

async function dbInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...dbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── /projects status ──────────────────────────────────────────
// Retorna directo en la respuesta HTTP → no hay race con el Edge timeout
async function buildStatusResponse() {
  const [wh, infra, deps, logsData, settingsRows, allTasks, sprints] = await Promise.all([
    fetch(`${API_BASE}/api/metrics/webhooks?hours=1`).then(r => r.json()).catch(() => null),
    fetch(`${API_BASE}/api/metrics/infra`).then(r => r.json()).catch(() => null),
    fetch(`${API_BASE}/api/metrics/deploys?limit=1`).then(r => r.json()).catch(() => null),
    fetch(`${API_BASE}/api/metrics/logs?hours=1&limit=200`).then(r => r.json()).catch(() => null),
    dbGet('settings', 'key=eq.active_sprint_id&select=value'),
    dbGet('tasks', 'select=status,sprint_id'),
    dbGet('sprints', 'select=id,name,title'),
  ]);

  // RPM y avg latency desde logs
  const logs = logsData?.logs ?? [];
  const processed = logs.filter(l => l.line?.includes('inbound_webhook_processed')).length;
  const rpm = (processed / 60).toFixed(2);
  const durations = logs.map(l => { const m = l.line?.match(/duration_ms=(\d+)/); return m ? Number(m[1]) : null; }).filter(Boolean);
  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  // Sprint activo
  const activeId = settingsRows?.[0]?.value ? Number(settingsRows[0].value) : null;
  const sprint   = activeId ? (sprints ?? []).find(s => s.id === activeId) : null;
  const tasks    = Array.isArray(allTasks) ? allTasks : [];
  const st       = sprint ? tasks.filter(t => t.sprint_id === sprint.id) : [];
  const done     = st.filter(t => t.status === 'completado').length;
  const progress = st.length ? Math.round((done / st.length) * 100) : 0;
  const bar      = '█'.repeat(Math.round(progress / 10)) + '░'.repeat(10 - Math.round(progress / 10));

  // Infra
  const cpu    = infra?.cpu_pct  != null ? `${infra.cpu_pct.toFixed(1)}%`  : '—';
  const ram    = infra?.ram_pct  != null ? `${infra.ram_pct.toFixed(1)}%`  : '—';
  const disk   = infra?.disk_pct != null ? `${infra.disk_pct.toFixed(1)}%` : '—';
  const uptime = infra?.uptime_hours != null ? `${infra.uptime_hours}h` : '—';

  // Último deploy
  const dep = deps?.deploys?.[0];
  const depLine = dep
    ? `${dep.conclusion === 'success' ? '✅' : dep.conclusion === 'failure' ? '❌' : '🔄'} ${dep.name ?? 'Deploy'} — @${dep.actor}`
    : '—';

  return {
    response_type: 'in_channel',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📊 Status de Umeia' } },

      { type: 'section', text: { type: 'mrkdwn', text: sprint
        ? `*⚡ Sprint activo: ${sprint.title || sprint.name}*\n${bar} *${progress}%* completado  ·  ✅ ${done}/${st.length} tareas`
        : '*Sprint activo:* ninguno configurado' } },

      { type: 'divider' },

      { type: 'section',
        text: { type: 'mrkdwn', text: '*🌐 API — últimos 60 min*' },
        fields: [
          { type: 'mrkdwn', text: `*Webhooks*\n${wh?.total ?? '—'}` },
          { type: 'mrkdwn', text: `*RPM*\n${rpm}` },
          { type: 'mrkdwn', text: `*Avg response*\n${avgMs != null ? `${avgMs}ms` : '—'}` },
          { type: 'mrkdwn', text: `*Errores*\n${wh?.errors != null ? (wh.errors > 0 ? `⚠️ ${wh.errors}` : '0') : '—'}` },
        ] },

      { type: 'divider' },

      { type: 'section',
        text: { type: 'mrkdwn', text: '*🖥️ Infraestructura*' },
        fields: [
          { type: 'mrkdwn', text: `*CPU*\n${cpu}` },
          { type: 'mrkdwn', text: `*RAM*\n${ram}` },
          { type: 'mrkdwn', text: `*Disco*\n${disk}` },
          { type: 'mrkdwn', text: `*Uptime*\n${uptime}` },
        ] },

      { type: 'context', elements: [
        { type: 'mrkdwn', text: `*Último deploy:* ${depLine}` },
        { type: 'mrkdwn', text: `<https://umeia.grafana.net/d/ga4sq8v/umeia-core-e28094-produccion|Ver Grafana →>` },
      ]},
    ],
  };
}

// ── Modal create-task ─────────────────────────────────────────
function buildModal(sprints, activeId, channelId) {
  const active = (sprints || []).find(s => s.id === activeId);
  const rest   = (sprints || []).filter(s => s.id !== activeId);

  const sprintOptions = [
    ...(active ? [{ text: { type: 'plain_text', text: `⚡ Sprint activo — ${active.title || active.name}` }, value: String(active.id) }] : []),
    { text: { type: 'plain_text', text: '📥 Backlog' }, value: '-1' },
    ...rest.map(s => ({
      text: { type: 'plain_text', text: (s.name + (s.title ? ` — ${s.title}` : '')).slice(0, 75) },
      value: String(s.id),
    })),
  ];

  return {
    type: 'modal', callback_id: 'crear_tarea',
    private_metadata: channelId,
    title:  { type: 'plain_text', text: 'Nueva Tarea' },
    submit: { type: 'plain_text', text: 'Crear tarea' },
    close:  { type: 'plain_text', text: 'Cancelar'   },
    blocks: [
      { type: 'input', block_id: 'titulo',
        label: { type: 'plain_text', text: 'Título' },
        element: { type: 'plain_text_input', action_id: 'titulo_input',
          placeholder: { type: 'plain_text', text: 'Ej: Fix bug en login' } } },
      { type: 'input', block_id: 'destino',
        label: { type: 'plain_text', text: 'Destino' },
        element: { type: 'static_select', action_id: 'destino_select',
          placeholder: { type: 'plain_text', text: 'Sprint o Backlog...' },
          options: sprintOptions,
          ...(sprintOptions[0] ? { initial_option: sprintOptions[0] } : {}) } },
      { type: 'input', block_id: 'prioridad',
        label: { type: 'plain_text', text: 'Prioridad' },
        element: { type: 'static_select', action_id: 'prioridad_select',
          initial_option: { text: { type: 'plain_text', text: '🟡 Media' }, value: 'media' },
          options: [
            { text: { type: 'plain_text', text: '🔴 Alta'  }, value: 'alta'  },
            { text: { type: 'plain_text', text: '🟡 Media' }, value: 'media' },
            { text: { type: 'plain_text', text: '🟢 Baja'  }, value: 'baja'  },
          ] } },
      { type: 'input', block_id: 'responsable', optional: true,
        label: { type: 'plain_text', text: 'Responsable' },
        element: { type: 'plain_text_input', action_id: 'responsable_input',
          placeholder: { type: 'plain_text', text: 'Ej: Lorenzo' } } },
    ],
  };
}

// ── Modal submit ──────────────────────────────────────────────
async function handleViewSubmission(payload) {
  const v           = payload.view.state.values;
  const titulo      = v.titulo.titulo_input.value?.trim();
  const sprintId    = parseInt(v.destino.destino_select.selected_option.value, 10);
  const prioridad   = v.prioridad.prioridad_select.selected_option.value;
  const responsable = v.responsable?.responsable_input?.value?.trim() || '';
  const userId      = payload.user.id;
  const channelId   = payload.view.private_metadata;
  if (!titulo) return;

  const [sprintRows, existing] = await Promise.all([
    sprintId !== -1 ? dbGet('sprints', `id=eq.${sprintId}&select=name,title`) : Promise.resolve([]),
    dbGet('tasks', `sprint_id=eq.${sprintId}&select=id`),
  ]);

  const sp           = sprintRows?.[0];
  const destinoNombre = sprintId === -1 ? 'Backlog' : (sp?.title || sp?.name || `Sprint ${sprintId}`);
  const sortOrder     = Array.isArray(existing) ? existing.length : 999;
  const prioEmoji     = { alta: '🔴', media: '🟡', baja: '🟢' }[prioridad] || '';

  try {
    await dbInsert('tasks', {
      id: `t${Date.now()}`, sprint_id: sprintId, title: titulo,
      description: '', status: 'no_iniciado', priority: prioridad,
      responsible: responsable, sort_order: sortOrder, tags: '[]',
    });

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `✅ *Nueva tarea creada*\n*${titulo}*` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Destino*\n${sprintId === -1 ? '📥 Backlog' : `⚡ ${destinoNombre}`}` },
        { type: 'mrkdwn', text: `*Prioridad*\n${prioEmoji} ${prioridad}` },
        ...(responsable ? [{ type: 'mrkdwn', text: `*Responsable*\n👤 ${responsable}` }] : []),
        { type: 'mrkdwn', text: `*Creada por*\n<@${userId}>` },
      ]},
    ];

    const promises = [slackApi('chat.postMessage', { channel: userId, text: `✅ *${titulo}* creada en ${destinoNombre}` })];
    if (channelId && channelId !== userId) {
      promises.push(slackApi('chat.postMessage', { channel: channelId, blocks, text: `✅ Tarea "${titulo}" creada en ${destinoNombre}` }));
    }
    await Promise.all(promises);
  } catch (e) {
    console.error('[umeia-bot] insert error:', e.message);
    await slackApi('chat.postMessage', { channel: userId, text: 'Error al crear la tarea. Revisá los logs.' });
  }
}

// ── Handler principal ─────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'GET')  return new Response('Umeia Bot running 🚀');
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const rawBody = await req.text();
  if (!await verifySignature(rawBody, req.headers))
    return new Response('Unauthorized', { status: 401 });

  const body = Object.fromEntries(new URLSearchParams(rawBody));

  // ── /projects ───────────────────────────────────────────────
  if (body.command === '/projects') {
    const sub = (body.text || '').trim().toLowerCase();

    // status → respuesta directa en el cuerpo HTTP (evita race con timeout de Edge)
    if (sub === 'status') {
      try {
        const data = await buildStatusResponse();
        return jsonResp(data);
      } catch (e) {
        console.error('[umeia-bot] status error:', e);
        return jsonResp({ response_type: 'ephemeral', text: '❌ Error al obtener métricas.' });
      }
    }

    // create-task → fetch en paralelo + abrir modal
    if (sub === 'create-task' || sub === '') {
      try {
        const [sprints, settings] = await Promise.all([
          dbGet('sprints', 'select=id,name,title&order=id'),
          dbGet('settings', 'key=eq.active_sprint_id&select=value'),
        ]);
        const activeId = settings?.[0]?.value ? Number(settings[0].value) : null;
        const result = await slackApi('views.open', {
          trigger_id: body.trigger_id,
          view: buildModal(sprints, activeId, body.channel_id),
        });
        if (!result.ok) console.error('[umeia-bot] views.open error:', result.error);
      } catch (e) {
        console.error('[umeia-bot] create-task error:', e);
      }
      return new Response('', { status: 200 });
    }

    // ayuda
    return jsonResp({
      response_type: 'ephemeral',
      text: '*Comandos disponibles:*\n• `/projects create-task` — crear nueva tarea\n• `/projects status` — métricas de API e infra',
    });
  }

  // ── Modal submit ────────────────────────────────────────────
  if (body.payload) {
    let payload;
    try { payload = JSON.parse(body.payload); } catch { return new Response('Bad payload', { status: 400 }); }

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'crear_tarea') {
      // ACK inmediato a Slack, procesar en paralelo
      const submitPromise = handleViewSubmission(payload).catch(e => console.error('[umeia-bot]', e));
      await submitPromise; // Edge necesita que terminemos antes de responder
      return jsonResp({ response_action: 'clear' });
    }
  }

  return new Response('OK');
}
