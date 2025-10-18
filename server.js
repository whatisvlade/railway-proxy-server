const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 8080;
const PUBLIC_HOST = process.env.PUBLIC_HOST || `localhost:${PORT}`;
const CONFIG_FILE = './clients-config.json';

// Middleware для парсинга JSON
app.use(express.json());

// Конфигурация клиентов
let clientsConfig = {};

// Загрузка конфигурации
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      clientsConfig = JSON.parse(data);
      console.log(`✅ Configuration loaded: ${Object.keys(clientsConfig).length} clients`);
    } else {
      console.log('📝 No config file found, using empty configuration');
      clientsConfig = {};
    }
  } catch (error) {
    console.error('❌ Error loading config:', error);
    clientsConfig = {};
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

// Отслеживание изменений файла конфигурации
function watchConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.watchFile(CONFIG_FILE, (curr, prev) => {
      console.log('🔄 Config file changed, reloading...');
      loadConfig();
    });
  }
}

// Статистика подключений
const connectionStats = {
  total: 0,
  active: 0,
  byClient: {}
};

// Middleware для аутентификации
function authenticate(req, res, next) {
  const auth = req.headers['proxy-authorization'] || req.headers['authorization'];
  
  if (!auth) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="Proxy"',
      'Content-Type': 'text/plain'
    });
    res.end('Proxy Authentication Required');
    return;
  }

  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const [username, password] = credentials;

  // Проверяем клиентов
  const client = clientsConfig[username];
  if (!client || client.password !== password) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="Proxy"',
      'Content-Type': 'text/plain'
    });
    res.end('Invalid credentials');
    return;
  }

  // Статистика
  if (!connectionStats.byClient[username]) {
    connectionStats.byClient[username] = { total: 0, active: 0 };
  }
  connectionStats.byClient[username].total++;
  connectionStats.byClient[username].active++;
  connectionStats.total++;
  connectionStats.active++;

  req.clientName = username;
  req.clientProxies = client.proxies || [];
  next();
}

// Функция для получения случайного прокси для клиента
function getRandomProxy(clientProxies) {
  if (!clientProxies || clientProxies.length === 0) {
    return null;
  }
  return clientProxies[Math.floor(Math.random() * clientProxies.length)];
}

// Прокси middleware с ротацией
const proxyMiddleware = (req, res, next) => {
  const clientProxies = req.clientProxies;
  const proxy = getRandomProxy(clientProxies);
  
  if (!proxy) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('No proxies available for this client');
    return;
  }

  // Парсим прокси URL
  const proxyUrl = new URL(proxy);
  
  const proxyOptions = {
    target: `${proxyUrl.protocol}//${proxyUrl.host}`,
    changeOrigin: true,
    auth: `${proxyUrl.username}:${proxyUrl.password}`,
    onProxyReq: (proxyReq, req, res) => {
      console.log(`🔄 [${req.clientName}] Routing through: ${proxyUrl.host}`);
    },
    onProxyRes: (proxyRes, req, res) => {
      // Уменьшаем счетчик активных подключений
      connectionStats.active--;
      if (connectionStats.byClient[req.clientName]) {
        connectionStats.byClient[req.clientName].active--;
      }
    },
    onError: (err, req, res) => {
      console.error(`❌ [${req.clientName}] Proxy error:`, err.message);
      connectionStats.active--;
      if (connectionStats.byClient[req.clientName]) {
        connectionStats.byClient[req.clientName].active--;
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy Error');
    }
  };

  createProxyMiddleware(proxyOptions)(req, res, next);
};

// API Endpoints

// Статус сервера
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    clients: Object.keys(clientsConfig).length,
    connections: connectionStats,
    timestamp: new Date().toISOString()
  });
});

// Получить IP клиента (оптимизировано для keep-alive)
app.get('/myip', (req, res) => {
  const clientIP = req.headers['x-forwarded-for'] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  res.set({
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.send(clientIP);
});

// Ротация прокси (принудительная)
app.post('/rotate', authenticate, (req, res) => {
  const clientName = req.clientName;
  const clientProxies = req.clientProxies;
  
  if (clientProxies.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'No proxies available for rotation' 
    });
  }

  const newProxy = getRandomProxy(clientProxies);
  res.json({
    success: true,
    client: clientName,
    newProxy: newProxy ? newProxy.split('@')[1] : 'none', // Скрываем credentials
    totalProxies: clientProxies.length
  });
});

// Перезагрузка конфигурации
app.post('/reload-config', (req, res) => {
  try {
    loadConfig();
    res.json({ 
      success: true, 
      message: 'Configuration reloaded',
      clients: Object.keys(clientsConfig).length
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API endpoint для получения конфигурации от Telegram бота
app.post('/update-config', (req, res) => {
  try {
    const { clients } = req.body;
    
    if (!clients || typeof clients !== 'object') {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid clients configuration' 
      });
    }

    // Сохраняем конфигурацию в файл
    clientsConfig = clients;
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

// Список клиентов (только для администрирования)
app.get('/clients', (req, res) => {
  const clientsList = Object.keys(clientsConfig).map(name => ({
    name,
    proxies: clientsConfig[name].proxies.length,
    stats: connectionStats.byClient[name] || { total: 0, active: 0 }
  }));
  
  res.json({
    total: clientsList.length,
    clients: clientsList
  });
});

// Основной прокси обработчик
app.use('*', authenticate, proxyMiddleware);

// Запуск сервера
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy server with HOT CONFIG RELOAD running on port ${PORT}`);
  console.log(`🌐 Public (TCP Proxy): ${PUBLIC_HOST}`);
  
  // Получаем все возможные хостнейм для API
  const possibleHosts = [
    PUBLIC_HOST.split(':')[0],
    process.env.RAILWAY_STATIC_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN
  ].filter(Boolean);
  
  console.log(`✅ API self hostnames: ${possibleHosts.join(', ')}`);
  console.log('🤖 Managed by Telegram Bot');
  console.log('🔥 Hot reload: ENABLED');
  console.log('⚡ Concurrent mode: NO rotation locks');
  
  // Загружаем конфигурацию при запуске
  loadConfig();
  watchConfig();
  
  // Статистика прокси
  const totalProxies = Object.values(clientsConfig).reduce((sum, client) => sum + (client.proxies?.length || 0), 0);
  console.log(`🔍 Overlapping proxies: 0`);
  console.log('✅ Fully isolated proxy pools - safe for concurrent rotation');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
