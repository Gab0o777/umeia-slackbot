# Umeia Slack Bot

Bot de Slack para crear tareas en Umeia directamente desde un canal.

## Uso

```
/tarea
```
Se abre un modal para completar: título, sprint destino (o backlog), prioridad y responsable.

---

## Deploy en Vercel

### 1. Subir el repositorio a GitHub

Crear un repo en GitHub y pushear este proyecto.

### 2. Importar en Vercel

- Ir a vercel.com → **Add New Project** → importar el repo
- Framework: **Other**
- Vercel detecta automáticamente el `vercel.json`

### 3. Variables de entorno en Vercel

En **Settings → Environment Variables** del proyecto, agregar:

| Variable | Descripción |
|---|---|
| `SLACK_BOT_TOKEN` | Empieza con `xoxb-` · OAuth & Permissions en Slack |
| `SLACK_SIGNING_SECRET` | Basic Information → App Credentials en Slack |
| `SUPABASE_URL` | Settings → API en Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API en Supabase (service_role, no anon) |

### 4. Hacer el deploy

Click en **Deploy**. Una vez completado, copiar la URL del proyecto.
Ejemplo: `https://umeia-slack-bot.vercel.app`

---

## Actualizar el Slack App (paso obligatorio post-deploy)

Una vez que tenés la URL de Vercel, hay que actualizar la app de Slack para usar HTTP en lugar de Socket Mode.

### Deshabilitar Socket Mode

En api.slack.com → tu app → **Settings → Socket Mode** → desactivar.

### Configurar la URL del Slash Command

**Features → Slash Commands** → editar `/tarea` → pegar:
```
https://TU-URL.vercel.app/api/slack
```

### Configurar Interactivity (para el modal)

**Features → Interactivity & Shortcuts** → activar → Request URL:
```
https://TU-URL.vercel.app/api/slack
```

Guardar cambios.

---

## Agregar el bot a un canal

En Slack, ir al canal → click en el nombre del canal → **Integrations** → **Add apps** → buscar **Umeia Bot**.

---

## Estructura del proyecto

```
umeia-slack-bot/
├── api/
│   └── slack.js       # Handler principal (Slack Bolt + Supabase)
├── vercel.json        # Configuración de rutas Vercel
├── package.json
├── .gitignore
└── README.md
```
