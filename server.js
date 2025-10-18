const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

// Railway переменные
const TCP_DOMAIN = process.env.RAILWAY_TCP_PROXY_DOMAIN;
const TCP_PORT = process.env.RAILWAY_TCP_PROXY_PORT;
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;

app.use(express.json());

let clientsConfig = {};

app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    port: PORT,
    tcp_proxy: `${TCP_DOMAIN}:${TCP_PORT}`,
    public_domain: PUBLIC_DOMAIN,
    uptime: process.uptime(),
    clients: Object.keys(clientsConfig).length,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post('/update-config', (req, res) => {
  const { clients } = req.body;
  clientsConfig = clients || {};
  console.log(`📥 Config updated: ${Object.keys(clientsConfig).length} clients`);
  res.json({ success: true, clients: Object.keys(clientsConfig).length });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 TCP Proxy: ${TCP_DOMAIN}:${TCP_PORT}`);
  console.log(`🌐 Public Domain: ${PUBLIC_DOMAIN}`);
  console.log('✅ Server started successfully');
});
