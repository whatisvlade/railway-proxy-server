// server.js — Railway Proxy с горячей перезагрузкой конфигурации
const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const { URL } = require('url');

const app = express();
app.use(express.json());

// ====== ГОРЯЧАЯ ПЕРЕЗАГРУЗКА КОНФИГУРАЦИИ ======

const CLIENTS_CONFIG_PATH = './clients-config.json';
let clientsConfig = {};
let users = {};
let clientProxies = {};
let allProxySets = {};
let currentProxies = {};
let rotationCounters = {};
const activeTunnels = {};

// Функция загрузки конфигурации
function loadClientsConfig() {
  try {
    if (fs.existsSync(CLIENTS_CONFIG_PATH)) {
      const data = fs.readFileSync(CLIENTS_CONFIG_PATH, 'utf8');
      const newConfig = JSON.parse(data);
      
      // Обновляем конфигурацию
      clientsConfig = newConfig;
      users = {};
      clientProxies = {};
      allProxySets = {};
      
      // Инициализируем новых клиентов
      Object.keys(clientsConfig).forEach(clientName => {
        const config = clientsConfig[clientName];
        users[clientName] = config.password;
        clientProxies[clientName] = [...config.proxies];
        allProxySets[clientName] = new Set(config.proxies);
        
        // Сохраняем текущее состояние ротации если клиент уже существовал
        if (!currentProxies[clientName]) {
          currentProxies[clientName] = [...config.proxies];
          rotationCounters[clientName] = 0;
          activeTunnels[clientName] = new Set();
        }
        
        console.log(`✅ Loaded/Updated client: ${clientName} with ${config.proxies.length} proxies`);
      });
      
      // Удаляем клиентов, которых больше нет в конфигурации
      Object.keys(currentProxies).forEach(clientName => {
        if (!clientsConfig[clientName]) {
          delete currentProxies[clientName];
          delete rotationCounters[clientName];
          delete activeTunnels[clientName];
          console.log(`🗑 Removed client: ${clientName}`);
        }
      });
      
      console.log('🔄 Configuration reloaded successfully');
      return true;
    } else {
      console.log('📝 No config file found, using empty configuration');
      clientsConfig = {};
      return false;
    }
  } catch (error) {
    console.error('❌ Error loading configuration:', error);
    return false;
  }
}

// Следим за изменениями файла конфигурации
if (fs.existsSync(CLIENTS_CONFIG_PATH)) {
  fs.watchFile(CLIENTS_CONFIG_PATH, (curr, prev) => {
    console.log('📁 Config file changed, reloading...');
    loadClientsConfig();
  });
}

// Загружаем конфигурацию при старте
loadClientsConfig();

// ====== API ДЛЯ ГОРЯЧЕЙ ПЕРЕЗАГРУЗКИ ======

app.post('/reload-config', (req, res) => {
  console.log('[API] POST /reload-config - Manual config reload requested');
  const success = loadClientsConfig();
  
  res.json({
    success,
    message: success ? 'Configuration reloaded successfully' : 'Failed to reload configuration',
    clients: Object.keys(clientsConfig),
    totalClients: Object.keys(clientsConfig).length,
    timestamp: new Date().toISOString()
  });
});

app.get('/config-status', (req, res) => {
  res.json({
    configFile: CLIENTS_CONFIG_PATH,
    exists: fs.existsSync(CLIENTS_CONFIG_PATH),
    clients: Object.keys(clientsConfig),
    totalClients: Object.keys(clientsConfig).length,
    lastModified: fs.existsSync(CLIENTS_CONFIG_PATH) ? 
      fs.statSync(CLIENTS_CONFIG_PATH).mtime : null,
    timestamp: new Date().toISOString()
  });
});

// ====== ОСТАЛЬНОЙ КОД ПРОКСИ СЕРВЕРА ======

const blockedProxies = new Set();
const lastRotationTime = new Map();

function parseProxyUrl(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    return { host: u.hostname, port: +u.port, username: u.username, password: u.password };
  } catch { return null; }
}

function getCurrentProxy(username) {
  const list = currentProxies[username];
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    if (!blockedProxies.has(list[i])) return list[i];
  }
  return list[0] || null;
}

function closeUserTunnels(username) {
  const set = activeTunnels[username];
  if (!set) return 0;
  let n = 0;
  for (const pair of set) {
    try { pair.clientSocket.destroy(); } catch {}
    try { pair.proxySocket.destroy(); } catch {}
    n++;
  }
  set.clear();
  return n;
}

async function rotateProxy(username) {
  lastRotationTime.set(username, Date.now());

  const list = currentProxies[username];
  if (!list || list.length <= 1) return getCurrentProxy(username);

  const oldProxy = list.shift();
  list.push(oldProxy);
  rotationCounters[username]++;

  let attempts = 0;
  while (blockedProxies.has(list[0]) && attempts < list.length) {
    const blocked = list.shift();
    list.push(blocked);
    attempts++;
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  const newProxy = list[0];
  console.log(`🔄 ROTATE ${username}: ${oldProxy.split('@')[1]} -> ${newProxy.split('@')[1]} (#${rotationCounters[username]}) [CONCURRENT]`);
  return newProxy;
}

function authenticate(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const [u, p] = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    return users[u] === p ? u : null;
  } catch { return null; }
}

// ====== «Свои» API-запросы (чтобы не проксировать их наружу) ======
const PUBLIC_HOST = (process.env.PUBLIC_HOST || 'localhost:8080').toLowerCase();
const EXTRA_HOSTS = (process.env.EXTRA_HOSTS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const SELF_HOSTNAMES = new Set([
  PUBLIC_HOST.split(':')[0],
  ...EXTRA_HOSTS.map(h => h.split(':')[0]),
  ...(process.env.RAILWAY_STATIC_URL ? [String(process.env.RAILWAY_STATIC_URL).toLowerCase().split(':')[0]] : []),
  ...(process.env.RAILWAY_PUBLIC_DOMAIN ? [String(process.env.RAILWAY_PUBLIC_DOMAIN).toLowerCase().split(':')[0]] : [])
].filter(Boolean));

function isSelfApiRequest(req) {
  try {
    if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
      const u = new URL(req.url);
      if (SELF_HOSTNAMES.has(u.hostname.toLowerCase())) {
        const p = u.pathname;
        return p === '/' || p.startsWith('/status') || p.startsWith('/current') || p.startsWith('/rotate') ||
               p.startsWith('/block') || p.startsWith('/unblock') || p.startsWith('/blocked') || p.startsWith('/myip') ||
               p.startsWith('/reload-config') || p.startsWith('/config-status');
      }
    }
    const hostHeader = (req.headers.host || '').toLowerCase();
    const onlyHost = hostHeader.split(':')[0];
    if (SELF_HOSTNAMES.has(onlyHost)) {
      const p = (req.url || '').split('?')[0];
      return p === '/' || p.startsWith('/status') || p.startsWith('/current') || p.startsWith('/rotate') ||
             p.startsWith('/block') || p.startsWith('/unblock') || p.startsWith('/blocked') || p.startsWith('/myip') ||
             p.startsWith('/reload-config') || p.startsWith('/config-status');
    }
  } catch {}
  return false;
}

// Закрываем keep-alive на API (только для внутренних REST ручек)
app.use((req, res, next) => { res.setHeader('Connection', 'close'); next(); });

// ====== Агент для апстримов (KEEP-ALIVE ПУЛ) ======
const upstreamAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 256,
  maxFreeSockets: 32,
  timeout: 60000,
  keepAliveMsecs: 10000,
});

// ====== API ENDPOINTS ======

app.post('/rotate', async (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const oldProxy = getCurrentProxy(user);
  const newProxy = await rotateProxy(user);
  const killed = closeUserTunnels(user);

  console.log(`[API] POST /rotate user=${user} killed=${killed} ${oldProxy?.split('@')[1]} -> ${newProxy?.split('@')[1]} [CONCURRENT]`);

  res.json({
    success: true,
    message: 'Proxy rotated (concurrent mode)',
    oldProxy: oldProxy?.split('@')[1],
    newProxy: newProxy?.split('@')[1],
    rotationCount: rotationCounters[user],
    totalProxies: currentProxies[user]?.length || 0,
    blockedProxies: blockedProxies.size,
    closedTunnels: killed,
    concurrentMode: true,
    rotationTime: Date.now() - (lastRotationTime.get(user) || Date.now())
  });
});

app.get('/current', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const cur = getCurrentProxy(user);
  console.log(`[API] GET /current user=${user} -> ${cur?.split('@')[1]}`);

  res.json({
    user,
    currentProxy: cur?.split('@')[1],
    fullProxy: cur,
    totalProxies: currentProxies[user]?.length || 0,
    rotationCount: rotationCounters[user] || 0,
    activeTunnels: activeTunnels[user]?.size || 0,
    blockedProxies: blockedProxies.size,
    concurrentMode: true,
    lastRotation: lastRotationTime.get(user) || 0
  });
});

// ====== /myip (параллельно, через keep-alive агент) ======
app.get('/myip', async (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const proxyUrl = getCurrentProxy(user);
  if (!proxyUrl) return res.status(502).json({ error: 'No proxy available' });

  const up = parseProxyUrl(proxyUrl);
  if (!up) return res.status(502).json({ error: 'Invalid proxy config' });

  console.log(`[API] GET /myip user=${user} via ${up.host}:${up.port}`);

  const ipServices = [
    { url: 'http://api.ipify.org?format=json', type: 'json' },
    { url: 'http://ifconfig.me/ip',           type: 'text' },
    { url: 'http://icanhazip.com',            type: 'text' },
    { url: 'http://ident.me',                 type: 'text' }
  ];

  function fetchViaProxy(service) {
    return new Promise((resolve, reject) => {
      const serviceUrlObj = new URL(service.url);
      const proxyOptions = {
        hostname: up.host,
        port: up.port,
        path: service.url,
        method: 'GET',
        headers: {
          'Proxy-Authorization': `Basic ${Buffer.from(`${up.username}:${up.password}`).toString('base64')}`,
          'Host': serviceUrlObj.hostname,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        agent: upstreamAgent,
        timeout: 20000
      };

      const proxyReq = http.request(proxyOptions, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            let ip = null;
            if (service.type === 'json') {
              try { ip = JSON.parse(data).ip; } catch {}
            }
            if (!ip) {
              ip = data.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ||
                   data.match(/(?:[0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}/)?.[0] ||
                   data.trim();
            }
            if (ip && /^[\d.:]+$/.test(ip)) return resolve({ ip, service: service.url });
            return reject(new Error('Bad IP parse'));
          } else {
            return reject(new Error(`HTTP ${proxyRes.statusCode}`));
          }
        });
      });

      proxyReq.on('socket', s => { try { s.setNoDelay(true); s.setKeepAlive(true, 10000); } catch {} });
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('Timeout')));
      proxyReq.on('error', reject);
      proxyReq.end();
    });
  }

  try {
    const result = await Promise.any(ipServices.map(fetchViaProxy));
    console.log(`[API] /myip result for ${user}: ${result.ip} via ${result.service}`);
    return res.json({ ip: result.ip, proxy: `${up.host}:${up.port}`, service: result.service });
  } catch (err) {
    console.error(`[API] /myip all services failed for ${user}: ${err?.message}`);
    return res.status(502).json({ error: 'Failed to get IP from all services', lastError: err?.message });
  }
});

// ====== Блокировка/Разблокировка/Список ======
app.post('/block', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { proxyUrl } = req.body;
  if (!proxyUrl || typeof proxyUrl !== 'string') return res.status(400).json({ error: 'proxyUrl is required' });

  const userProxies = currentProxies[user];
  if (!userProxies || !userProxies.includes(proxyUrl)) return res.status(403).json({ error: 'Proxy does not belong to user' });

  blockedProxies.add(proxyUrl);
  console.log(`🚫 BLOCKED proxy for ${user}: ${proxyUrl.split('@')[1]}`);
  res.json({ success: true, message: 'Proxy blocked', blockedProxy: proxyUrl.split('@')[1], totalBlocked: blockedProxies.size });
});

app.post('/unblock', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { proxyUrl } = req.body;
  if (!proxyUrl || typeof proxyUrl !== 'string') return res.status(400).json({ error: 'proxyUrl is required' });

  if (blockedProxies.delete(proxyUrl)) {
    console.log(`✅ UNBLOCKED proxy for ${user}: ${proxyUrl.split('@')[1]}`);
    res.json({ success: true, message: 'Proxy unblocked', unblockedProxy: proxyUrl.split('@')[1], totalBlocked: blockedProxies.size });
  } else {
    res.status(404).json({ error: 'Proxy not found in blocklist' });
  }
});

app.get('/blocked', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const userProxies = currentProxies[user];
  const userBlocked = Array.from(blockedProxies).filter(p => userProxies.includes(p));

  res.json({
    user,
    blockedProxies: userBlocked.map(p => p.split('@')[1]),
    totalBlocked: userBlocked.length
  });
});

app.get('/status', (req, res) => {
  // Динамически подсчитываем пересечения между всеми клиентами
  let totalOverlapping = 0;
  const overlappingList = [];
  const clientNames = Object.keys(clientsConfig);
  
  for (let i = 0; i < clientNames.length; i++) {
    for (let j = i + 1; j < clientNames.length; j++) {
      const client1Name = clientNames[i];
      const client2Name = clientNames[j];
      const client1Set = allProxySets[client1Name];
      const client2Set = allProxySets[client2Name];
      if (client1Set && client2Set) {
        const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));
        totalOverlapping += intersection.length;
        overlappingList.push(...intersection.map(p => p.split('@')[1]));
      }
    }
  }

  // Динамически генерируем информацию о клиентах
  const clients = {};
  Object.keys(clientsConfig).forEach(clientName => {
    clients[clientName] = {
      totalProxies: clientProxies[clientName]?.length || 0,
      currentProxy: getCurrentProxy(clientName)?.split('@')[1],
      rotationCount: rotationCounters[clientName] || 0,
      activeTunnels: activeTunnels[clientName]?.size || 0,
      lastRotation: lastRotationTime.get(clientName) || 0
    };
  });

  res.json({
    status: 'running',
    platform: 'Railway TCP Proxy - Concurrent Rotation Mode (Hot Config Reload)',
    port: PORT,
    publicHost: PUBLIC_HOST,
    selfHostnames: [...SELF_HOSTNAMES],
    totalBlockedProxies: blockedProxies.size,
    concurrentMode: true,
    hotReload: true,
    proxyIsolation: {
      overlappingProxies: totalOverlapping,
      overlappingList: [...new Set(overlappingList)],
      fullyIsolated: totalOverlapping === 0
    },
    clients,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  // Динамически подсчитываем пересечения
  let totalOverlapping = 0;
  const clientNames = Object.keys(clientsConfig);
  
  for (let i = 0; i < clientNames.length; i++) {
    for (let j = i + 1; j < clientNames.length; j++) {
      const client1Name = clientNames[i];
      const client2Name = clientNames[j];
      const client1Set = allProxySets[client1Name];
      const client2Set = allProxySets[client2Name];
      if (client1Set && client2Set) {
        const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));
        totalOverlapping += intersection.length;
      }
    }
  }

  // Динамически генерируем список клиентов для аутентификации
  const authInfo = Object.keys(clientsConfig).map(clientName => 
    `${clientName}/${clientsConfig[clientName].password}`
  ).join(' или ');

  res.send(`
    <h1>🚀 Railway Proxy Rotator - Concurrent Mode (Hot Config Reload)</h1>
    <pre>
Public host: ${PUBLIC_HOST}
Known hostnames: ${[...SELF_HOSTNAMES].join(', ')}

Auth: Basic (${authInfo || 'No clients configured'})

⚡ Concurrent Features:
- No rotation locks - clients can rotate simultaneously
- Separate proxy pools (overlapping: ${totalOverlapping})
- Fast rotation with minimal delays
- Independent operation per client
- 🔥 HOT CONFIG RELOAD - no restart needed!
    </pre>
    <ul>
      <li>GET /status - показывает режим concurrent + hot reload</li>
      <li>GET /config-status - статус конфигурации</li>
      <li>POST /reload-config - принудительная перезагрузка</li>
      <li>GET /current (requires Basic)</li>
      <li>GET /myip (requires Basic) - получить IP текущего прокси</li>
      <li>POST /rotate (requires Basic) - быстрая ротация</li>
      <li>POST /block (requires Basic) - блокировка прокси</li>
      <li>POST /unblock (requires Basic) - разблокировка прокси</li>
      <li>GET /blocked (requires Basic) - список заблокированных</li>
    </ul>
    <p>После /rotate сервер разрывает активные CONNECT-туннели пользователя.</p>
    <p>Заблокированные прокси: ${blockedProxies.size}</p>
    <p>Режим: Concurrent (без блокировок) + Hot Reload</p>
    <p>Пересекающиеся прокси: ${totalOverlapping}</p>
    <p>🤖 Управляется через Telegram Bot</p>
    <p>🔥 Конфигурация обновляется автоматически!</p>
  `);
});

// ====== Прокси-сервер ======
const server = http.createServer();

// -------- HTTP (origin/absolute-form) ----------
async function handleHttpProxy(req, res, user) {
  const up = parseProxyUrl(getCurrentProxy(user));
  if (!up) { res.writeHead(502); return res.end('502 No upstream'); }

  console.log(`HTTP: ${user} -> ${up.host}:${up.port} -> ${req.url}`);

  const options = {
    hostname: up.host,
    port: up.port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'Proxy-Authorization': `Basic ${Buffer.from(`${up.username}:${up.password}`).toString('base64')}`,
    },
    agent: upstreamAgent,
    timeout: 45000
  };
  delete options.headers['proxy-authorization'];

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('socket', s => { try { s.setNoDelay(true); s.setKeepAlive(true, 10000); } catch {} });
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('Upstream timeout')));
  proxyReq.on('error', (err) => {
    console.error(`HTTP upstream error (${user}):`, err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('502 Bad Gateway - Proxy error');
  });

  req.pipe(proxyReq);
}

server.on('request', (req, res) => {
  if (isSelfApiRequest(req)) {
    const host = req.headers.host || '(no-host)';
    console.log(`[SELF-API] ${req.method} ${req.url} Host:${host}`);
    return app(req, res);
  }

  const user = authenticate(req.headers['proxy-authorization']);
  if (!user) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Proxy"' });
    return res.end('407 Proxy Authentication Required');
  }

  handleHttpProxy(req, res, user);
});

// -------- CONNECT (HTTPS) ----------
function tryConnect(req, clientSocket, user) {
  const up = parseProxyUrl(getCurrentProxy(user));
  if (!up) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    return clientSocket.end();
  }

  console.log(`CONNECT: ${user} -> ${up.host}:${up.port} -> ${req.url}`);
  const proxySocket = net.createConnection(up.port, up.host);

  const pair = { clientSocket, proxySocket };
  activeTunnels[user]?.add(pair);

  const cleanup = () => activeTunnels[user]?.delete(pair);
  proxySocket.on('close', cleanup);
  clientSocket.on('close', cleanup);

  try { proxySocket.setNoDelay(true); proxySocket.setKeepAlive(true, 10000); } catch {}
  try { clientSocket.setNoDelay(true); clientSocket.setKeepAlive(true, 10000); } catch {}

  proxySocket.setTimeout(45000, () => proxySocket.destroy(new Error('upstream timeout')));
  clientSocket.setTimeout(45000, () => clientSocket.destroy(new Error('client timeout')));

  proxySocket.on('connect', () => {
    const auth = Buffer.from(`${up.username}:${up.password}`).toString('base64');
    const connectReq =
      `CONNECT ${req.url} HTTP/1.1\r\n` +
      `Host: ${req.url}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      `Proxy-Connection: keep-alive\r\n` +
      `Connection: keep-alive\r\n\r\n`;
    proxySocket.write(connectReq);
  });

  let established = false;
  proxySocket.on('data', (data) => {
    if (!established) {
      const line = data.toString('utf8').split('\r\n')[0];
      if (/^HTTP\/1\.[01]\s+200/i.test(line)) {
        established = true;
        try { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch {}
        clientSocket.pipe(proxySocket);
        proxySocket.pipe(clientSocket);
      } else {
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        clientSocket.end();
        proxySocket.end();
      }
    }
  });

  proxySocket.on('error', (err) => {
    console.error(`CONNECT upstream error (${user}):`, err.message);
    try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
    clientSocket.end();
  });

  clientSocket.on('error', () => { try { proxySocket.destroy(); } catch {} });
}

server.on('connect', (req, clientSocket) => {
  const user = authenticate(req.headers['proxy-authorization']);
  if (!user) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n');
    return clientSocket.end();
  }
  tryConnect(req, clientSocket, user);
});

// ====== Запуск ======
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  // Динамически подсчитываем пересечения
  let totalOverlapping = 0;
  const clientNames = Object.keys(clientsConfig);
  
  for (let i = 0; i < clientNames.length; i++) {
    for (let j = i + 1; j < clientNames.length; j++) {
      const client1Name = clientNames[i];
      const client2Name = clientNames[j];
      const client1Set = allProxySets[client1Name];
      const client2Set = allProxySets[client2Name];
      if (client1Set && client2Set) {
        const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));
        totalOverlapping += intersection.length;
      }
    }
  }

  console.log(`🚀 Proxy server with HOT CONFIG RELOAD running on port ${PORT}`);
  console.log(`🌐 Public (TCP Proxy): ${PUBLIC_HOST}`);
  console.log(`✅ API self hostnames: ${[...SELF_HOSTNAMES].join(', ')}`);
  console.log(`🤖 Managed by Telegram Bot`);
  console.log(`🔥 Hot reload: ENABLED`);
  
  // Динамически выводим информацию о всех клиентах
  Object.keys(clientsConfig).forEach(clientName => {
    console.log(`📊 ${clientName}: ${clientProxies[clientName]?.length || 0} proxies`);
  });
  
  console.log(`⚡ Concurrent mode: NO rotation locks`);
  console.log(`🔍 Overlapping proxies: ${totalOverlapping}`);

  if (totalOverlapping > 0) {
    console.warn(`⚠️  WARNING: ${totalOverlapping} overlapping proxies may cause interference`);
  } else {
    console.log(`✅ Fully isolated proxy pools - safe for concurrent rotation`);
  }
});
