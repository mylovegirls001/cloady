const http = require('http');
const { Buffer } = require('buffer');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const net = require('net');
const { exec, execSync, spawn } = require('child_process'); // 添加了 spawn
const { WebSocket, createWebSocketStream } = require('ws');

const logcb = (...args) => () => {};  // 注释保留：日志占位函数
const errcb = (...args) => () => {};  // 注释保留：错误日志占位函数

const UUID = process.env.UUID || '0ff0350e-c001-495b-a6a1-13b962590375';
const uuid = UUID.replace(/-/g, "");
const DOMAIN = process.env.DOMAIN || 'cloady.1854.kdns.fr';  // 项目域名或已反代的域名，不带前缀，建议填已反代的域名
const NAME = process.env.NAME || 'cloady';
const port = process.env.PORT || 8888;  // 不要3000, 应该被占用了

// ================= 新增：Cloudflare Tunnel 配置 =================
const cftuntoken = process.env.CFTUN_TOKEN || 'eyJhIjoiYThjZjVmNTY5MDVkZGY4MzcwYmQ2MTdhYTI2YmM4NzEiLCJ0IjoiOTMxMmZhOGYtYjMzNC00ZDU0LTgyYTEtMGQ2NjllZWMzZjUzIiwicyI6Ik1XUTNNamhoWWpFdFlqQTJOaTAwWXpVd0xUZzJObU10TVdabE1qbG1NRGcyT1RNdyJ9'; // 支持环境变量传入，默认为空
// ===============================================================

// 创建HTTP路由
const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello, World\n');
  } else if (req.url === '/sub') {
    const vlessURL = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&type=ws&host=${DOMAIN}&path=%2F#${NAME}`;
    
    const base64Content = Buffer.from(vlessURL).toString('base64');

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(base64Content + '\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

httpServer.listen(port);  // 启动 HTTP 服务
console.log(`[Server] HTTP & WebSocket server listening on port ${port}`);

// WebSocket 服务器
const wss = new WebSocket.Server({ server: httpServer });
wss.on('connection', ws => {
  // WebSocket 连接成功
  ws.on('message', msg => {
    if (msg.length < 18) {
      // 数据长度无效
      return;
    }
    try {
      const [VERSION] = msg;
      const id = msg.slice(1, 17);
      if (!id.every((v, i) => v == parseInt(uuid.substr(i * 2, 2), 16))) {
        // UUID 验证失败
        return;
      }
      let i = msg.slice(17, 18).readUInt8() + 19;
      const port = msg.slice(i, i += 2).readUInt16BE(0);
      const ATYP = msg.slice(i, i += 1).readUInt8();
      const host = ATYP === 1 ? msg.slice(i, i += 4).join('.') :
        (ATYP === 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) :
          (ATYP === 3 ? msg.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));
      // 建立连接成功，发送回应
      ws.send(new Uint8Array([VERSION, 0]));
      const duplex = createWebSocketStream(ws);
      net.connect({ host, port }, function () {
        this.write(msg.slice(i));
        duplex.on('error', () => {}).pipe(this).on('error', () => {}).pipe(duplex);
      }).on('error', () => {});
    } catch {
      // 处理消息时出错
    }
  }).on('error', () => {
    // WebSocket 错误
  });
});

// ================= 新增：Cloudflare Tunnel 自动下载与启动逻辑 =================
async function setupAndRunCloudflared(token) {
  const platform = process.platform;
  const arch = process.arch;
  let downloadUrl = '';
  let binName = 'cloudflared';
  let isTgz = false;

  // 1. 判断当前系统并获取对应的下载链接
  if (platform === 'linux') {
    if (arch === 'x64') downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
    else if (arch === 'arm64') downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
    else if (arch === 'arm') downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm';
    else throw new Error(`[Cloudflared] Unsupported Linux arch: ${arch}`);
  } else if (platform === 'win32') {
    downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    binName = 'cloudflared.exe';
  } else if (platform === 'darwin') {
    if (arch === 'x64') { downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz'; isTgz = true; }
    else if (arch === 'arm64') { downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz'; isTgz = true; }
    else throw new Error(`[Cloudflared] Unsupported Darwin arch: ${arch}`);
  } else {
    console.error(`[Cloudflared] Unsupported platform: ${platform}`);
    return;
  }

  const binPath = path.join(__dirname, binName);
  
  // 2. 检查是否已存在有效的二进制文件 (简单校验大小 > 1MB 避免重复下载)
  let needDownload = true;
  if (fs.existsSync(binPath)) {
    const stats = fs.statSync(binPath);
    if (stats.size > 1024 * 1024) {
      needDownload = false;
      console.log('[Cloudflared] Binary already exists, skipping download.');
    }
  }

  // 3. 下载并解压(如果需要)
  if (needDownload) {
    console.log(`[Cloudflared] Downloading from ${downloadUrl}...`);
    try {
      if (isTgz) {
        const tgzPath = path.join(__dirname, 'cloudflared.tgz');
        const writer = fs.createWriteStream(tgzPath);
        const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        console.log('[Cloudflared] Extracting archive...');
        execSync(`tar -xzf ${tgzPath} -C ${__dirname}`);
        fs.unlinkSync(tgzPath); // 清理压缩包
        if (platform !== 'win32') fs.chmodSync(binPath, 0o755);
      } else {
        const writer = fs.createWriteStream(binPath);
        const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        if (platform !== 'win32') fs.chmodSync(binPath, 0o755); // 赋予执行权限
      }
      console.log('[Cloudflared] Download and setup complete.');
    } catch (err) {
      console.error('[Cloudflared] Download failed:', err.message);
      return;
    }
  }

  // 4. 启动 Cloudflare Tunnel
  console.log('[Cloudflared] Starting tunnel in background...');
  const logPath = path.join(__dirname, 'cloudflared.log');
  const outStream = fs.openSync(logPath, 'a');
  const errStream = fs.openSync(logPath, 'a');
  
  // 使用 spawn 在后台独立运行，并将日志追加到 cloudflared.log
  const child = spawn(binPath, ['tunnel', '--no-autoupdate', 'run', '--token', token], {
    detached: true,
    stdio: ['ignore', outStream, errStream]
  });
  
  child.unref(); // 允许 Node.js 主进程退出而不影响隧道进程
  console.log(`[Cloudflared] Tunnel started successfully. PID: ${child.pid}. Logs are being written to: ${logPath}`);
}

// 5. 判断变量是否为空并执行
if (cftuntoken && cftuntoken.trim() !== '') {
  setupAndRunCloudflared(cftuntoken).catch(err => {
    console.error('[Cloudflared] Setup error:', err);
  });
} else {
  console.log('[Cloudflared] Token is empty, skipping tunnel setup.');
}
// ===========================================================================