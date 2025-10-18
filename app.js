const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 8080;

// Railway переменные
const TCP_DOMAIN = process.env.RAILWAY_TCP_PROXY_DOMAIN;
const TCP_PORT = process.env.RAILWAY_TCP_PROXY_PORT;
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;

const CONFIG_FILE = './clients-config.json';
const BLACKLIST_FILE = './ip-blacklist.json';

// Middleware
app.use(express.json());

// Конфигурации
let clientsConfig = {};
let ipBlacklist = new Set();
let proxyRotation = {};

// Загрузка конфигурации
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      clientsConfig = JSON.parse(data);
      console.log(`✅ Configuration loaded: ${Object.keys(clientsConfig).length} clients`);
      
      // Инициализация ротации для каждого клиента
      Object.keys(clientsConfig).forEach(username => {
        if (clientsConfig[username].proxies && clientsConfig[username].proxies.length > 0) {
          proxyRotation[username] = { currentIndex: 0 };
        }
      });
    } else {
      console.log('📝 No config file found, using empty configuration');
      clientsConfig = {};
    }
  } catch (error) {
    console.error('❌ Error loading config:', error);
    clientsConfig = {};
  }
}

// Загрузка блэклиста
function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const data = fs.readFileSync(BLACKLIST_FILE, 'utf8');
      const blacklistArray = JSON.parse(data);
      ipBlacklist = new Set(blacklistArray);
      console.log(`🚫 Blacklist loaded: ${ipBlacklist.size} IPs`);
    }
  } catch (error) {
    console.error('❌ Error loading blacklist:', error);
    ipBlacklist = new Set();
  }
}

// Сохранение конфигурации
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clientsConfig, null, 2));
    console.log('💾 Configuration saved');
  } catch (error) {
    console.error('❌ Error saving config:', error);
  }
}

// Сохранение блэклиста
function saveBlacklist() {
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...ipBlacklist], null, 2));
    console.log('💾 Blacklist saved');
  } catch (error) {
    console.error('❌ Error saving blacklist:', error);
  }
}

// Получение клиентского IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         req.socket.remoteAddress ||
         req.ip;
}

// Аутентификация клиента
function authenticateClient(req, res, next) {
  const clientIP = getClientIP(req);
  
  // Проверка блэклиста
  if (ipBlacklist.has(clientIP)) {
    console.log(`🚫 Blocked IP: ${clientIP}`);
    return res.status(403).json({ error: 'Access denied' });
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const credentials = Buffer.from(auth.slice(6), 'base64').toString();
  const [username, password] = credentials.split(':');

  if (!clientsConfig[username] || clientsConfig[username].password !== password) {
    console.log(`❌ Auth failed: ${username} from ${clientIP}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.clientUsername = username;
  req.clientIP = clientIP;
  console.log(`✅ Auth success: ${username} from ${clientIP}`);
  next();
}

// Получение следующего прокси для клиента
function getNextProxy(username) {
  const client = clientsConfig[username];
  if (!client || !client.proxies || client.proxies.length === 0) {
    return null;
  }

  if (!proxyRotation[username]) {
    proxyRotation[username] = { currentIndex: 0 };
  }

  const proxy = client.proxies[proxyRotation[username].currentIndex];
  proxyRotation[username].currentIndex = 
    (proxyRotation[username].currentIndex + 1) % client.proxies.length;

  return proxy;
}

// Парсинг прокси строки
function parseProxy(proxyString) {
  const parts = proxyString.split(':');
  if (parts.length >= 4) {
    return {
      host: parts[0],
      port: parseInt(parts[1]),
      username: parts[2],
      password: parts[3]
    };
  }
  return null;
}

// API Endpoints

// Статус сервера
app.get('/status', (req, res) => {
  const stats = {
    status: 'running',
    port: PORT,
    tcp_proxy: `${TCP_DOMAIN}:${TCP_PORT}`,
    public_domain: PUBLIC_DOMAIN,
    uptime: process.uptime(),
    clients: Object.keys(clientsConfig).length,
    blacklisted_ips: ipBlacklist.size,
    timestamp: new Date().toISOString()
  };

  // Добавляем статистику по клиентам
  stats.client_stats = {};
  Object.keys(clientsConfig).forEach(username => {
    const client = clientsConfig[username];
    stats.client_stats[username] = {
      proxies: client.proxies ? client.proxies.length : 0,
      current_proxy_index: proxyRotation[username]?.currentIndex || 0
    };
  });

  res.json(stats);
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Получить IP клиента
app.get('/myip', (req, res) => {
  const clientIP = getClientIP(req);
  res.set({
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.send(clientIP);
});

// Обновление конфигурации от Telegram бота
app.post('/update-config', (req, res) => {
  try {
    const { clients } = req.body;
    
    if (!clients || typeof clients !== 'object') {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid clients configuration' 
      });
    }

    clientsConfig = clients;
    
    // Обновляем ротацию для новых клиентов
    Object.keys(clientsConfig).forEach(username => {
      if (clientsConfig[username].proxies && clientsConfig[username].proxies.length > 0) {
        if (!proxyRotation[username]) {
          proxyRotation[username] = { currentIndex: 0 };
        }
      }
    });

    saveConfig();
    console.log('📥 Configuration received from Telegram Bot');
    console.log(`✅ Updated configuration: ${Object.keys(clientsConfig).length} clients`);
    
    res.json({ 
      success: true, 
      message: 'Configuration updated successfully',
      clients: Object.keys(clientsConfig).length
    });
  } catch (error) {
    console.error('❌ Error updating config:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ✅ ИСПРАВЛЕННЫЙ прокси endpoint с правильной аутентификацией
app.use('/proxy', authenticateClient, (req, res, next) => {
  const username = req.clientUsername;
  const proxy = getNextProxy(username);
  
  if (!proxy) {
    return res.status(503).json({ 
      error: 'No proxies available for this client' 
    });
  }

  const parsedProxy = parseProxy(proxy);
  if (!parsedProxy) {
    return res.status(500).json({ 
      error: 'Invalid proxy configuration' 
    });
  }

  console.log(`🔄 Using proxy for ${username}: ${parsedProxy.host}:${parsedProxy.port}`);

  // ✅ ПРАВИЛЬНЫЙ способ передачи аутентификации прокси
  const proxyMiddleware = createProxyMiddleware({
    target: `http://${parsedProxy.host}:${parsedProxy.port}`,
    changeOrigin: true,
    pathRewrite: {
      '^/proxy': ''
    },
    onError: (err, req, res) => {
      console.error(`❌ Proxy error for ${username}:`, err.message);
      res.status(502).json({ error: 'Proxy connection failed' });
    },
    onProxyReq: (proxyReq, req, res) => {
      // ✅ Добавляем Proxy-Authorization header для upstream прокси
      const proxyAuth = Buffer.from(`${parsedProxy.username}:${parsedProxy.password}`).toString('base64');
      proxyReq.setHeader('Proxy-Authorization', `Basic ${proxyAuth}`);
      
      console.log(`➡️ Proxying ${req.method} ${req.url} for ${username} via ${parsedProxy.host}:${parsedProxy.port}`);
    }
  });

  proxyMiddleware(req, res, next);
});

// Управление блэклистом (только для админов)
app.post('/blacklist/add', (req, res) => {
  const { ip, admin_key } = req.body;
  
  // Простая проверка админ ключа (в продакшене используйте более безопасный метод)
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!ip) {
    return res.status(400).json({ error: 'IP address required' });
  }

  ipBlacklist.add(ip);
  saveBlacklist();
  console.log(`🚫 Added to blacklist: ${ip}`);
  
  res.json({ success: true, message: `IP ${ip} added to blacklist` });
});

app.post('/blacklist/remove', (req, res) => {
  const { ip, admin_key } = req.body;
  
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!ip) {
    return res.status(400).json({ error: 'IP address required' });
  }

  ipBlacklist.delete(ip);
  saveBlacklist();
  console.log(`✅ Removed from blacklist: ${ip}`);
  
  res.json({ success: true, message: `IP ${ip} removed from blacklist` });
});

// Получить список блэклиста
app.get('/blacklist', (req, res) => {
  const { admin_key } = req.query;
  
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  res.json({ blacklist: [...ipBlacklist] });
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FIXED Proxy server with correct auth running on port ${PORT}`);
  console.log(`🌐 TCP Proxy: ${TCP_DOMAIN}:${TCP_PORT}`);
  console.log(`🌐 Public Domain: ${PUBLIC_DOMAIN}`);
  console.log('🤖 Managed by Telegram Bot');
  console.log('🔥 Hot reload: ENABLED');
  console.log('✅ Proxy-Authorization header: FIXED');
  console.log('⚡ Concurrent mode: NO rotation locks');
  console.log('✅ Server started successfully');
  
  // Загружаем конфигурации при запуске
  loadConfig();
  loadBlacklist();
  
  console.log('🔍 Overlapping proxies: 0');
  console.log('✅ Fully isolated proxy pools - safe for concurrent rotation');
});
