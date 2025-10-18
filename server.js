const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
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

// Статус сервера
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    clients: Object.keys(clientsConfig).length,
    timestamp: new Date().toISOString()
  });
});

// Получить IP клиента
app.get('/myip', (req, res) => {
  const clientIP = req.headers['x-forwarded-for'] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress;
  
  res.set({
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-cache'
  });
  res.send(clientIP);
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
  console.log(`🌐 Public Host: ${PUBLIC_HOST}`);
  console.log('✅ Server started successfully');
  
  // Загружаем конфигурацию при запуске
  loadConfig();
});
