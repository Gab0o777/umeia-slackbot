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
async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Active sprint ─────────────────────────────────────────────
async function getActiveSprint() {
  const settings = await dbSelect('settings', 'key=eq.active_sprint_id&select=value');
  const id = Array.isArray(settings) && settings[0]?.value ? Number(settings[0].value) : null;
  if (!id) return null;
  const sprints = await dbSelect('sprints', `id=eq.${id}&select=id,name,title,start_date,target_end`);
  return Array.isArray(sprints) ? sprints[0] : null;
}

// ── /projects status ──────────────────────────────────────────
async function handleStatus(channelId, userId) {
  // Fetch en paralelo
  const [webhookData, infraData, deploysData, logsData, activeSprint, taskRows] = await Promise.allSettled([
    fetch(`${API_BASE}/api/metrics/webhooks?hours=1`).then(r => r.json()).catch(() => null),
    fetch(`${API_BASE}/api/metrics/infra`).then(r => r.json()).catch(() => null),
    fetch(`${API_BASE}/api/metrics/deploys?limit=3`).then(r => r.json()).catch(() => null),
    fetch(`${API_BASE}/api/metrics/logs?hours=1&limit=200`).then(r => r.json()).catch(() => null),
    getActiveSprint(),
    dbSelect('tasks', 'select=status,sprint_id'),
  ]);

  const wh     = webhookData.value;
  const infra  = infraData.value;
  const deps   = deploysData.value?.deploys ?? [];
  const logs   = logsData.value?.logs ?? [];
  const sprint = activeSprint.value;
  const tasks  = Array.isArray(taskRows.value) ? taskRows.value : [];

  // RPM (últimos 60 min)
  const processed = logs.filter(l => l.line?.includes('inbound_webhook_processed')).length;
  const rpm = (processed / 60).toFixed(2);

  // Avg response time
  const durations = logs.map(l => { const m = l.line?.match(/duration_ms=(\d+)/); return m ? Number(m[1]) : null; }).filter(Boolean);
  const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  // Tareas del sprint activo
  const sprintTasks = sprint ? tasks.filter(t => t.sprint_id === sprint.id) : [];
  const byStatus = {
    completado:  sprintTasks.filter(t => t.status === 'completado').length,
    en_proceso:  sprintTasks.filter(t => t.status === 'en_proceso').length,
    bloqueado:   sprintTasks.filter(t => t.status === 'bloqueado').length,
    no_iniciado: sprintTasks.filter(t => t.status === 'no_iniciado').length,
  };
  const progress = sprintTasks.length ? Math.round((byStatus.completado / sprintTasks.length) * 100) : 0;
  const progressBar = '█'.repeat(Math.round(progress / 10)) + '░'.repeat(10 - Math.round(progress / 10));

  // CPU / RAM
  const cpu  = infra?.cpu_pct != null  ? `${infra.cpu_pct.toFixed(1)}%`  : '—';
  const ram  = infra?.ram_pct != null  ? `${infra.ram_pct.toFixed(1)}%`  : '—';
  const disk = infra?.disk_pct != null ? `${infra.disk_pct.toFixed(1)}%` : '—';
  const uptime = infra?.uptime_hours != null ? `${infra.uptime_hours}h`  : '—';

  // Último deploy
  const lastDeploy = deps[0];
  const deployStatus = lastDeploy
    ? `${lastDeploy.conclusion === 'success' ? '✅' : lastDeploy.conclusion === 'failure' ? '❌' : '🔄'} ${lastDeploy.name ?? 'Deploy'} — @${lastDeploy.actor}`
    : '—';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📊 Status de Umeia' },
    },

    // ── Sprint activo ───────────────────────────────────────
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sprint
          ? `*⚡ Sprint activo: ${sprint.title || sprint.name}*\n${progressBar} *${progress}%* completado\n✅ ${byStatus.completado}  🔄 ${byStatus.en_proceso}  🚫 ${byStatus.bloqueado}  ⏳ ${byStatus.no_iniciado}`
          : '*Sprint activo:* ninguno configurado',
      },
    },

    { type: 'divider' },

    // ── API metrics ─────────────────────────────────────────
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*🌐 API — últimos 60 min*' },
      fields: [
        { type: 'mrkdwn', text: `*Webhooks*\n${wh?.total ?? '—'}` },
        { type: 'mrkdwn', text: `*RPM*\n${rpm}` },
        { type: 'mrkdwn', text: `*Avg response*\n${avgMs != null ? `${avgMs}ms` : '—'}` },
        { type: 'mrkdwn', text: `*Errores*\n${wh?.errors != null ? (wh.errors > 0 ? `⚠️ ${wh.errors}` : '0') : '—'}` },
      ],
    },

    { type: 'divider' },

    // ── Infra ────────────────────────────────────────────────
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*🖥️ Infraestructura*' },
      fields: [
        { type: 'mrkdwn', text: `*CPU*\n${cpu}` },
        { type: 'mrkdwn', text: `*RAM*\n${ram}` },
        { type: 'mrkdwn', text: `*Disco*\n${disk}` },
        { type: 'mrkdwn', text: `*Uptime*\n${uptime}` },
      ],
    },

    { type: 'divider' },

    // ── Último deploy ─────────────────────────────────────────
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Último deploy:* ${deployStatus}` },
        { type: 'mrkdwn', text: `Grafana: <https://umeia.grafana.net/d/ga4sq8v/umeia-core-e28094-produccion|Ver dashboard>` },
      ],
    },
  ];

  await slackApi('chat.postMessage', {
    channel: channelId || userId,
    blocks,
    text: `📊 Status Umeia — ${progress}% sprint completado | RPM: ${rpm} | CPU: ${cpu} | RAM: ${ram}`,
  });
}

// ── Modal create-task ─────────────────────────────────────────
function buildModal(sprints, activeSprint) {
  const active = activeSprint;
  const rest   = (sprints || []).filter(s => !active || s.id !== active.id);

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
    title:  { type: 'plain_text', text: 'Nueva Tarea'  },
    submit: { type: 'plain_text', text: 'Crear tarea'  },
    close:  { type: 'plain_text', text: 'Cancelar'     },
    blocks: [
      { type: 'input', block_id: 'titulo',
        label: { type: 'plain_text', text: 'Título' },
        element: { type: 'plain_text_input', action_id: 'titulo_input', placeholder: { type: 'plain_text', text: 'Ej: Fix bug en login' } } },
      { type: 'input', block_id: 'destino',
        label: { type: 'plain_text', text: 'Destino' },
        element: { type: 'static_select', action_id: 'destino_select',
          placeholder: { type: 'plain_text', text: 'Sprint o Backlog...' },
          options: sprintOptions,
          ...(sprintOptions[0] ? { initial_option: sprintOptions[0] } : {}),
        } },
      { type: 'input', block_id: 'prioridad',
        label: { type: 'plain_text', text: 'Prioridad' },
        element: { type: 'static_select', action_id: 'prioridad_select',
          initial_option: { text: { type: 'plain_text', text: 'Media' }, value: 'media' },
          options: [
            { text: { type: 'plain_text', text: '🔴 Alta'  }, value: 'alta'  },
            { text: { type: 'plain_text', text: '🟡 Media' }, value: 'media' },
            { text: { type: 'plain_text', text: '🟢 Baja'  }, value: 'baja'  },
          ] } },
      { type: 'input', block_id: 'responsable', optional: true,
        label: { type: 'plain_text', text: 'Responsable' },
        element: { type: 'plain_text_input', action_id: 'responsable_input', placeholder: { type: 'plain_text', text: 'Ej: Lorenzo' } } },
    ],
  };
}

// ── Ayuda ─────────────────────────────────────────────────────
async function handleHelp(channelId) {
  await slackApi('chat.postMessage', {
    channel: channelId,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*📚 Comandos disponibles de /projects*' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '`/projects create-task`\nCrea una nueva tarea con modal' },
        { type: 'mrkdwn', text: '`/projects status`\nMétricas de API e infra en tiempo real' },
      ]},
    ],
    text: 'Comandos: /projects create-task | /projects status',
  });
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

  let destinoNombre = 'Backlog';
  if (sprintId !== -1) {
    const sp = await dbSelect('sprints', `id=eq.${sprintId}&select=name,title`);
    const s  = Array.isArray(sp) ? sp[0] : null;
    destinoNombre = s ? (s.title || s.name) : `Sprint ${sprintId}`;
  }

  const existing  = await dbSelect('tasks', `sprint_id=eq.${sprintId}&select=id`);
  const sortOrder = Array.isArray(existing) ? existing.length : 999;
  const prioEmoji = { alta: '🔴', media: '🟡', baja: '🟢' }[prioridad] || '';

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

    if (channelId) await slackApi('chat.postMessage', { channel: channelId, blocks, text: `✅ Tarea "${titulo}" creada en ${destinoNombre}` });
    await slackApi('chat.postMessage', { channel: userId, text: `✅ *${titulo}* creada en ${destinoNombre}` });
  } catch (e) {
    console.error('[umeia-bot] insert error:', e.message);
    await slackApi('chat.postMessage', { channel: userId, text: 'Error al crear la tarea. Revisá los logs de Vercel.' });
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

  // ── Slash command /projects ─────────────────────────────────
  if (body.command === '/projects') {
    const sub = (body.text || '').trim().toLowerCase();

    if (sub === 'status') {
      // ACK inmediato, proceso en background
      const channelId = body.channel_id;
      const userId    = body.user_id;
      const resp = new Response('', { status: 200 });
      // Edge permite seguir procesando después del return implícito
      handleStatus(channelId, userId).catch(e => console.error('[umeia-bot] status error:', e));
      return resp;
    }

    if (sub === 'create-task' || sub === '') {
      const channelId    = body.channel_id;
      const [sprints, activeSprint] = await Promise.all([
        dbSelect('sprints', 'select=id,name,title&order=id'),
        getActiveSprint(),
      ]);
      const result = await slackApi('views.open', {
        trigger_id: body.trigger_id,
        view: { ...buildModal(sprints, activeSprint), private_metadata: channelId },
      });
      console.log('[umeia-bot] views.open:', result.ok, result.error || '');
      return new Response('', { status: 200 });
    }

    // Comando desconocido → ayuda
    handleHelp(body.channel_id).catch(console.error);
    return new Response('', { status: 200 });
  }

  // ── Modal submit ────────────────────────────────────────────
  if (body.payload) {
    let payload;
    try { payload = JSON.parse(body.payload); } catch { return new Response('Bad payload', { status: 400 }); }

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'crear_tarea') {
      handleViewSubmission(payload).catch(e => console.error('[umeia-bot] view error:', e));
      return new Response(JSON.stringify({ response_action: 'clear' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('OK', { status: 200 });
}
