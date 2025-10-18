const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const http = require('http');
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

// ✅ ИСПРАВЛЕННАЯ аутентификация для CONNECT запросов
function authenticateConnect(req) {
  // Проверяем все возможные заголовки аутентификации
  const auth = req.headers['proxy-authorization'] || 
               req.headers['authorization'] ||
               req.headers['Proxy-Authorization'] ||
               req.headers['Authorization'];
               
  console.log(`🔍 CONNECT Auth attempt for: ${req.url}`);
  console.log(`🔍 Available headers:`, Object.keys(req.headers).filter(h => h.toLowerCase().includes('auth')));
  
  if (!auth) {
    console.log('❌ CONNECT: No auth header found');
    return null;
  }

  let credentials;
  if (auth.startsWith('Basic ')) {
    credentials = Buffer.from(auth.slice(6), 'base64').toString();
  } else {
    // Возможно auth уже декодирован или в другом формате
    credentials = auth;
  }

  const [username, password] = credentials.split(':');
  console.log(`🔍 CONNECT: Trying user: ${username}`);

  if (!clientsConfig[username] || clientsConfig[username].password !== password) {
    console.log(`❌ CONNECT: Invalid credentials for ${username}`);
    console.log(`🔍 Available clients:`, Object.keys(clientsConfig));
    return null;
  }

  console.log(`✅ CONNECT: Success for ${username}`);
  return username;
}

// Получение следующего прокси для клиента (автоматическая ротация)
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

// Получение текущего прокси без ротации
function getCurrentProxy(username) {
  const client = clientsConfig[username];
  if (!client || !client.proxies || client.proxies.length === 0) {
    return null;
  }

  if (!proxyRotation[username]) {
    proxyRotation[username] = { currentIndex: 0 };
  }

  return client.proxies[proxyRotation[username].currentIndex];
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

// 🔄 РУЧНАЯ РОТАЦИЯ ПРОКСИ (для Tampermonkey скрипта)
app.post('/rotate-proxy', (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username is required' 
      });
    }

    if (!clientsConfig[username]) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }

    const client = clientsConfig[username];
    if (!client.proxies || client.proxies.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No proxies available for this client' 
      });
    }

    // Инициализируем ротацию если не существует
    if (!proxyRotation[username]) {
      proxyRotation[username] = { currentIndex: 0 };
    }

    // Переходим к следующему прокси
    proxyRotation[username].currentIndex = 
      (proxyRotation[username].currentIndex + 1) % client.proxies.length;
    
    const newProxy = client.proxies[proxyRotation[username].currentIndex];
    const currentIndex = proxyRotation[username].currentIndex;
    
    console.log(`🔄 Manual proxy rotation for ${username}: ${newProxy} (index: ${currentIndex})`);
    
    res.json({ 
      success: true, 
      message: 'Proxy rotated successfully',
      username: username,
      current_proxy: newProxy,
      current_index: currentIndex,
      total_proxies: client.proxies.length
    });
    
  } catch (error) {
    console.error('❌ Error rotating proxy:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 📋 ПОЛУЧИТЬ ТЕКУЩИЙ ПРОКСИ (без ротации)
app.get('/current-proxy/:username', (req, res) => {
  try {
    const { username } = req.params;
    
    if (!clientsConfig[username]) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }

    const client = clientsConfig[username];
    if (!client.proxies || client.proxies.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No proxies available for this client' 
      });
    }

    if (!proxyRotation[username]) {
      proxyRotation[username] = { currentIndex: 0 };
    }

    const currentIndex = proxyRotation[username].currentIndex;
    const currentProxy = client.proxies[currentIndex];
    
    res.json({ 
      success: true,
      username: username,
      current_proxy: currentProxy,
      current_index: currentIndex,
      total_proxies: client.proxies.length
    });
    
  } catch (error) {
    console.error('❌ Error getting current proxy:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 🎯 УСТАНОВИТЬ КОНКРЕТНЫЙ ПРОКСИ ПО ИНДЕКСУ
app.post('/set-proxy-index', (req, res) => {
  try {
    const { username, index } = req.body;
    
    if (!username) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username is required' 
      });
    }

    if (index === undefined || index === null) {
      return res.status(400).json({ 
        success: false, 
        error: 'Index is required' 
      });
    }

    if (!clientsConfig[username]) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }

    const client = clientsConfig[username];
    if (!client.proxies || client.proxies.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No proxies available for this client' 
      });
    }

    const proxyIndex = parseInt(index);
    if (proxyIndex < 0 || proxyIndex >= client.proxies.length) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid index. Must be between 0 and ${client.proxies.length - 1}` 
      });
    }

    // Устанавливаем конкретный индекс
    if (!proxyRotation[username]) {
      proxyRotation[username] = { currentIndex: 0 };
    }
    
    proxyRotation[username].currentIndex = proxyIndex;
    const selectedProxy = client.proxies[proxyIndex];
    
    console.log(`🎯 Set proxy index for ${username}: ${selectedProxy} (index: ${proxyIndex})`);
    
    res.json({ 
      success: true, 
      message: 'Proxy index set successfully',
      username: username,
      current_proxy: selectedProxy,
      current_index: proxyIndex,
      total_proxies: client.proxies.length
    });
    
  } catch (error) {
    console.error('❌ Error setting proxy index:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 📊 ПОЛУЧИТЬ ВСЕ ПРОКСИ КЛИЕНТА
app.get('/proxies/:username', (req, res) => {
  try {
    const { username } = req.params;
    
    if (!clientsConfig[username]) {
      return res.status(404).json({ 
        success: false, 
        error: 'Client not found' 
      });
    }

    const client = clientsConfig[username];
    if (!client.proxies || client.proxies.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No proxies available for this client' 
      });
    }

    if (!proxyRotation[username]) {
      proxyRotation[username] = { currentIndex: 0 };
    }

    res.json({ 
      success: true,
      username: username,
      proxies: client.proxies,
      current_index: proxyRotation[username].currentIndex,
      total_proxies: client.proxies.length
    });
    
  } catch (error) {
    console.error('❌ Error getting proxies:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ✅ ИСПРАВЛЕННЫЙ HTTP прокси endpoint
app.use('/proxy', authenticateClient, (req, res, next) => {
  const username = req.clientUsername;
  const proxy = getCurrentProxy(username); // Используем текущий прокси без автоматической ротации
  
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

  console.log(`🔄 HTTP Proxy for ${username}: ${parsedProxy.host}:${parsedProxy.port}`);

  // Создаем прокси middleware для HTTP запросов
  const proxyMiddleware = createProxyMiddleware({
    target: `http://${parsedProxy.host}:${parsedProxy.port}`,
    changeOrigin: true,
    pathRewrite: {
      '^/proxy': ''
    },
    onError: (err, req, res) => {
      console.error(`❌ HTTP Proxy error for ${username}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy connection failed', details: err.message });
      }
    },
    onProxyReq: (proxyReq, req, res) => {
      // Добавляем аутентификацию для upstream прокси
      const proxyAuth = Buffer.from(`${parsedProxy.username}:${parsedProxy.password}`).toString('base64');
      proxyReq.setHeader('Proxy-Authorization', `Basic ${proxyAuth}`);
      
      console.log(`➡️ HTTP Proxying ${req.method} ${req.url} for ${username} via ${parsedProxy.host}:${parsedProxy.port}`);
    },
    onProxyRes: (proxyRes, req, res) => {
      console.log(`⬅️ HTTP Response ${proxyRes.statusCode} for ${req.clientUsername}`);
    }
  });

  proxyMiddleware(req, res, next);
});

// Управление блэклистом (только для админов)
app.post('/blacklist/add', (req, res) => {
  const { ip, admin_key } = req.body;
  
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

// ✅ ДОБАВЛЯЕМ TCP ПРОКСИ ФУНКЦИОНАЛЬНОСТЬ
const server = http.createServer(app);

// Обработка CONNECT запросов для TCP/HTTPS прокси
server.on('connect', (req, clientSocket, head) => {
  console.log(`🔌 CONNECT request: ${req.url}`);
  console.log(`🔍 CONNECT headers:`, req.headers);
  
  const username = authenticateConnect(req);
  if (!username) {
    console.log('❌ CONNECT: Authentication failed');
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n');
    clientSocket.end();
    return;
  }

  const proxy = getCurrentProxy(username); // Используем текущий прокси без автоматической ротации
  if (!proxy) {
    console.log(`❌ CONNECT: No proxy available for ${username}`);
    clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    clientSocket.end();
    return;
  }

  const parsedProxy = parseProxy(proxy);
  if (!parsedProxy) {
    console.log(`❌ CONNECT: Invalid proxy config for ${username}`);
    clientSocket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    clientSocket.end();
    return;
  }

  console.log(`🔄 TCP Proxy for ${username}: ${parsedProxy.host}:${parsedProxy.port} -> ${req.url}`);

  // Подключаемся к upstream прокси
  const proxySocket = net.createConnection(parsedProxy.port, parsedProxy.host);
  
  proxySocket.on('connect', () => {
    // Отправляем CONNECT запрос к upstream прокси
    const proxyAuth = Buffer.from(`${parsedProxy.username}:${parsedProxy.password}`).toString('base64');
    const connectRequest = `CONNECT ${req.url} HTTP/1.1\r\nProxy-Authorization: Basic ${proxyAuth}\r\n\r\n`;
    
    console.log(`📤 Sending CONNECT to upstream: ${parsedProxy.host}:${parsedProxy.port}`);
    proxySocket.write(connectRequest);
  });

  let headersParsed = false;
  proxySocket.on('data', (data) => {
    if (!headersParsed) {
      const response = data.toString();
      console.log(`📥 Upstream response: ${response.split('\r\n')[0]}`);
      
      if (response.includes('200 Connection established') || response.includes('200 OK')) {
        console.log(`✅ TCP Tunnel established for ${username}`);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        headersParsed = true;
        
        // Начинаем туннелирование данных
        clientSocket.pipe(proxySocket);
        proxySocket.pipe(clientSocket);
      } else {
        console.log(`❌ TCP Proxy connection failed for ${username}: ${response.split('\r\n')[0]}`);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
        proxySocket.end();
      }
    }
  });

  proxySocket.on('error', (err) => {
    console.error(`❌ TCP Proxy error for ${username}:`, err.message);
    if (!headersParsed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
    clientSocket.end();
  });

  clientSocket.on('error', (err) => {
    console.error(`❌ Client socket error for ${username}:`, err.message);
    proxySocket.end();
  });
});

// Запуск сервера
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FULL Proxy server (HTTP + TCP) running on port ${PORT}`);
  console.log(`🌐 TCP Proxy: ${TCP_DOMAIN}:${TCP_PORT}`);
  console.log(`🌐 Public Domain: ${PUBLIC_DOMAIN}`);
  console.log('🤖 Managed by Telegram Bot');
  console.log('🔄 Manual proxy rotation: ENABLED');
  console.log('⚡ Tampermonkey control: READY');
  console.log('✅ Server started successfully');
  
  // Загружаем конфигурации при запуске
  loadConfig();
  loadBlacklist();
  
});
