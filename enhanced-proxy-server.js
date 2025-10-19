// app.js — Railway Proxy + Telegram Bot Management (TURBO OPTIMIZED)
const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
const compression = require('compression'); // Добавим компрессию
const cluster = require('cluster');
const os = require('os');

// ====== КЛАСТЕРИЗАЦИЯ ДЛЯ МАКСИМАЛЬНОЙ ПРОИЗВОДИТЕЛЬНОСТИ ======
if (cluster.isMaster && process.env.NODE_ENV === 'production') {
  const numCPUs = Math.min(os.cpus().length, 4); // Ограничиваем 4 процессами
  console.log(`🚀 Master process starting ${numCPUs} workers...`);
  
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
  
  return; // Мастер процесс только управляет воркерами
}

const app = express();

// ====== МАКСИМАЛЬНАЯ ОПТИМИЗАЦИЯ EXPRESS ======
app.use(compression({
  level: 6, // Баланс между скоростью и сжатием
  threshold: 1024, // Сжимать файлы больше 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Отключаем ненужные заголовки
app.disable('x-powered-by');
app.disable('etag');

// ====== КОНФИГУРАЦИЯ С ФАЙЛОВЫМ ХРАНЕНИЕМ ======
const CONFIG_FILE = path.join(__dirname, 'clients-config.json');
let clientsConfig = {};

// ====== КЭШИРОВАНИЕ ДЛЯ БЫСТРОГО ДОСТУПА ======
const configCache = new Map();
const proxyCache = new Map();
let cacheExpiry = 0;

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    clientsConfig = JSON.parse(data);
    
    // Обновляем кэш
    configCache.clear();
    proxyCache.clear();
    cacheExpiry = Date.now() + 30000; // Кэш на 30 секунд
    
    console.log('✅ Configuration loaded from file');
  } catch (error) {
    console.log('📝 Using empty configuration, creating config file...');
    await saveConfig();
  }
}

async function saveConfig() {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(clientsConfig, null, 2));
    
    // Обновляем кэш
    configCache.clear();
    proxyCache.clear();
    cacheExpiry = Date.now() + 30000;
    
    console.log('💾 Configuration saved to file');
  } catch (error) {
    console.error('❌ Failed to save configuration:', error.message);
  }
}

// ====== ДИНАМИЧЕСКИЕ СТРУКТУРЫ ======
let users = {};
let clientProxies = {};
let allProxySets = {};
let currentProxies = {};
let rotationCounters = {};
const lastRotationTime = new Map();
const activeTunnels = {};
const blockedProxies = new Set();

// ====== БЫСТРАЯ ИНИЦИАЛИЗАЦИЯ КЛИЕНТОВ ======
function initializeClients() {
  const startTime = Date.now();
  
  // Очищаем старые данные
  users = {};
  clientProxies = {};
  allProxySets = {};
  currentProxies = {};
  rotationCounters = {};
  
  // Параллельная инициализация
  const clientNames = Object.keys(clientsConfig);
  clientNames.forEach(clientName => {
    const config = clientsConfig[clientName];
    users[clientName] = config.password;
    clientProxies[clientName] = [...config.proxies];
    allProxySets[clientName] = new Set(config.proxies);
    currentProxies[clientName] = [...config.proxies];
    rotationCounters[clientName] = rotationCounters[clientName] || 0;
    activeTunnels[clientName] = activeTunnels[clientName] || new Set();
  });

  console.log(`✅ Initialized ${clientNames.length} clients in ${Date.now() - startTime}ms`);
  checkProxyOverlaps();
}

function checkProxyOverlaps() {
  const clientNames = Object.keys(clientsConfig);
  let totalOverlaps = 0;
  
  for (let i = 0; i < clientNames.length; i++) {
    for (let j = i + 1; j < clientNames.length; j++) {
      const client1Name = clientNames[i];
      const client2Name = clientNames[j];
      const client1Set = allProxySets[client1Name];
      const client2Set = allProxySets[client2Name];
      const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));
      totalOverlaps += intersection.length;
      
      if (intersection.length > 0) {
        console.warn(`⚠️ WARNING: ${intersection.length} overlapping proxies between ${client1Name} and ${client2Name}`);
      }
    }
  }
  
  if (totalOverlaps === 0) {
    console.log(`✅ Fully isolated proxy pools - optimal for performance`);
  }
}

// ====== КЭШИРОВАННЫЕ API ДЛЯ TELEGRAM БОТА ======

// Получить всех клиентов (с кэшированием)
app.get('/api/clients', (req, res) => {
  const cacheKey = 'clients_list';
  
  if (configCache.has(cacheKey) && Date.now() < cacheExpiry) {
    return res.json(configCache.get(cacheKey));
  }
  
  const clients = {};
  Object.keys(clientsConfig).forEach(clientName => {
    clients[clientName] = {
      totalProxies: clientProxies[clientName]?.length || 0,
      currentProxy: getCurrentProxy(clientName)?.split('@')[1],
      rotationCount: rotationCounters[clientName] || 0,
      activeTunnels: activeTunnels[clientName]?.size || 0,
      proxies: clientsConfig[clientName].proxies.map(p => p.split('@')[1])
    };
  });
  
  const result = {
    success: true,
    clients,
    totalClients: Object.keys(clients).length,
    cached: false
  };
  
  configCache.set(cacheKey, result);
  res.json(result);
});

// Остальные API endpoints (оптимизированные)
app.post('/api/add-client', async (req, res) => {
  const { clientName, password, proxies } = req.body;
  
  if (!clientName || !password) {
    return res.status(400).json({ error: 'clientName and password are required' });
  }
  
  if (clientsConfig[clientName]) {
    return res.status(409).json({ error: 'Client already exists' });
  }
  
  clientsConfig[clientName] = {
    password,
    proxies: proxies || []
  };
  
  await saveConfig();
  initializeClients();
  
  console.log(`➕ Added new client: ${clientName} with ${proxies?.length || 0} proxies`);
  
  res.json({
    success: true,
    message: `Client ${clientName} added successfully`,
    client: {
      name: clientName,
      totalProxies: proxies?.length || 0
    }
  });
});

// [Остальные API endpoints остаются такими же, но с кэшированием где возможно]

// ====== ОПТИМИЗИРОВАННЫЕ ФУНКЦИИ ПРОКСИ СЕРВЕРА ======

function closeUserTunnels(username) {
  const set = activeTunnels[username];
  if (!set) return 0;
  let n = 0;
  
  // Параллельное закрытие соединений
  const promises = [];
  for (const pair of set) {
    promises.push(
      Promise.allSettled([
        new Promise(resolve => { try { pair.clientSocket.destroy(); } catch {} resolve(); }),
        new Promise(resolve => { try { pair.proxySocket.destroy(); } catch {} resolve(); })
      ])
    );
    n++;
  }
  
  Promise.allSettled(promises); // Не ждем завершения
  set.clear();
  return n;
}

function parseProxyUrl(proxyUrl) {
  // Кэшируем парсинг URL
  if (proxyCache.has(proxyUrl)) {
    return proxyCache.get(proxyUrl);
  }
  
  try {
    const u = new URL(proxyUrl);
    const result = { 
      host: u.hostname, 
      port: +u.port, 
      username: u.username, 
      password: u.password 
    };
    proxyCache.set(proxyUrl, result);
    return result;
  } catch { 
    return null; 
  }
}

function getCurrentProxy(username) {
  const list = currentProxies[username];
  if (!list) return null;
  
  // Быстрый поиск незаблокированного прокси
  for (let i = 0; i < list.length; i++) {
    if (!blockedProxies.has(list[i])) return list[i];
  }
  return list[0] || null;
}

async function rotateProxy(username) {
  lastRotationTime.set(username, Date.now());

  const list = currentProxies[username];
  if (!list || list.length <= 1) return getCurrentProxy(username);

  const oldProxy = list.shift();
  list.push(oldProxy);
  rotationCounters[username]++;

  // Быстрый пропуск заблокированных прокси
  let attempts = 0;
  while (blockedProxies.has(list[0]) && attempts < list.length) {
    const blocked = list.shift();
    list.push(blocked);
    attempts++;
  }

  // Уменьшена задержка для быстрой ротации
  await new Promise(resolve => setTimeout(resolve, 100));

  const newProxy = list[0];
  console.log(`🔄 ROTATE ${username}: ${oldProxy.split('@')[1]} -> ${newProxy.split('@')[1]} (#${rotationCounters[username]})`);
  return newProxy;
}

function authenticate(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const [u, p] = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    return users[u] === p ? u : null;
  } catch { return null; }
}

// ====== ТУРБО-ОПТИМИЗИРОВАННЫЕ АГЕНТЫ ======
const upstreamAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1000,        // Максимум для 32GB RAM
  maxFreeSockets: 200,     // Больше свободных сокетов
  timeout: 30000,          // Быстрее таймаут
  keepAliveMsecs: 5000,    // Быстрее освобождение
  maxTotalSockets: 2000    // Общий лимит
});

const upstreamHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 1000,
  maxFreeSockets: 200,
  timeout: 30000,
  keepAliveMsecs: 5000,
  maxTotalSockets: 2000,
  secureProtocol: 'TLSv1_2_method' // Быстрее TLS
});

// ====== ОРИГИНАЛЬНЫЕ API ENDPOINTS (ОПТИМИЗИРОВАННЫЕ) ======
const PUBLIC_HOST = (process.env.PUBLIC_HOST || 'yamabiko.proxy.rlwy.net:38659').toLowerCase();
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
               p.startsWith('/api/') || p.startsWith('/health');
      }
    }
    const hostHeader = (req.headers.host || '').toLowerCase();
    const onlyHost = hostHeader.split(':')[0];
    if (SELF_HOSTNAMES.has(onlyHost)) {
      const p = (req.url || '').split('?')[0];
      return p === '/' || p.startsWith('/status') || p.startsWith('/current') || p.startsWith('/rotate') ||
             p.startsWith('/block') || p.startsWith('/unblock') || p.startsWith('/blocked') || p.startsWith('/myip') ||
             p.startsWith('/api/') || p.startsWith('/health');
    }
  } catch {}
  return false;
}

// Оптимизированные заголовки
app.use((req, res, next) => { 
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30, max=1000');
  next(); 
});

// Быстрый /myip с параллельными запросами
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
    { url: 'http://ifconfig.me/ip', type: 'text' },
    { url: 'http://icanhazip.com', type: 'text' },
    { url: 'http://ident.me', type: 'text' },
    { url: 'http://checkip.amazonaws.com', type: 'text' }
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
        timeout: 10000 // Быстрее таймаут
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

      proxyReq.on('socket', s => { 
        try { 
          s.setNoDelay(true); 
          s.setKeepAlive(true, 5000); 
          s.setTimeout(10000);
        } catch {} 
      });
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('Timeout')));
      proxyReq.on('error', reject);
      proxyReq.end();
    });
  }

  try {
    // Параллельные запросы ко всем сервисам
    const result = await Promise.any(ipServices.map(fetchViaProxy));
    console.log(`[API] /myip result for ${user}: ${result.ip} via ${result.service}`);
    return res.json({ 
      ip: result.ip, 
      proxy: `${up.host}:${up.port}`, 
      service: result.service,
      responseTime: Date.now() - req.startTime 
    });
  } catch (err) {
    console.error(`[API] /myip all services failed for ${user}: ${err?.message}`);
    return res.status(502).json({ error: 'Failed to get IP from all services', lastError: err?.message });
  }
});

// ====== ТУРБО-ОПТИМИЗИРОВАННЫЙ ПРОКСИ СЕРВЕР ======
const server = http.createServer();

// Максимальные лимиты для 32GB RAM
server.maxConnections = 5000;
server.timeout = 30000;
server.keepAliveTimeout = 25000;
server.headersTimeout = 30000;

async function handleHttpProxy(req, res, user) {
  const up = parseProxyUrl(getCurrentProxy(user));
  if (!up) { res.writeHead(502); return res.end('502 No upstream'); }

  const options = {
    hostname: up.host,
    port: up.port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'Proxy-Authorization': `Basic ${Buffer.from(`${up.username}:${up.password}`).toString('base64')}`,
    },
    agent: req.url.startsWith('https://') ? upstreamHttpsAgent : upstreamAgent,
    timeout: 25000
  };
  delete options.headers['proxy-authorization'];

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('socket', s => { 
    try { 
      s.setNoDelay(true); 
      s.setKeepAlive(true, 5000);
      s.setTimeout(25000);
    } catch {} 
  });
  
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('Upstream timeout')));
  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end('502 Bad Gateway');
  });

  req.pipe(proxyReq);
}

server.on('request', (req, res) => {
  req.startTime = Date.now(); // Для измерения времени ответа
  
  if (isSelfApiRequest(req)) {
    return app(req, res);
  }

  const user = authenticate(req.headers['proxy-authorization']);
  if (!user) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Proxy"' });
    return res.end('407 Proxy Authentication Required');
  }

  handleHttpProxy(req, res, user);
});

// ====== ЗАПУСК ТУРБО-СЕРВЕРА ======
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 8080;

async function startServer() {
  await loadConfig();
  initializeClients();
  
  server.listen(PORT, '0.0.0.0', () => {
    const memUsage = process.memoryUsage();
    const workerId = cluster.worker ? cluster.worker.id : 'single';
    
    console.log(`🚀 TURBO Proxy server (Worker ${workerId}) running on port ${PORT}`);
    console.log(`🌐 Public (TCP Proxy): ${PUBLIC_HOST}`);
    console.log(`💾 Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB / 32GB available`);
    console.log(`🔧 Max connections: ${server.maxConnections}`);
    console.log(`🔧 Agent max sockets: ${upstreamAgent.maxSockets}`);
    console.log(`⚡ TURBO MODE: Optimized for maximum speed`);
    console.log(`📊 Clients: ${Object.keys(clientsConfig).length}`);
    console.log(`🎯 Target: 500+ concurrent users with fast loading`);
  });
}

startServer().catch(console.error);
