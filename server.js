// --- モジュールのインポート ---
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

// --- 設定項目 ---
const PORT = process.env.PORT || 3000;
const FILE_LIFETIME = (parseInt(process.env.FILE_LIFETIME_MIN, 10) || 15) * 60 * 1000;
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE || '2g';
const PROCESS_TIMEOUT = (parseInt(process.env.PROCESS_TIMEOUT_SEC, 10) || 900) * 1000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// --- アプリケーションのセットアップ ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ★★★ ここに欠落していた行を追加します ★★★
// 接続してきたクライアントを管理するためのMapオブジェクト（名簿）を作成します。
const clients = new Map();

// --- Middleware ---
app.set('trust proxy', 1); // Renderのプロキシを信頼する設定
app.use(helmet({ contentSecurityPolicy: false }));
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/get-formats', limiter);
app.use('/download', limiter);

// --- 静的ファイルの提供とヘルスチェック ---
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.get('/', (req, res) => { res.status(200).send("Backend server is running."); });

// --- WebSocket 接続管理 ---
// WebSocketの接続が確立された時の処理
wss.on('connection', (ws) => {
    const { v4: uuidv4 } = require('uuid');
    const clientId = uuidv4();
    // このclientIdをキーとして、クライアントの名簿(clients)に登録します。
    clients.set(clientId, ws);
    console.log(`Client connected: ${clientId}`);
    // 接続したクライアントに、あなたのIDを教えます。
    ws.send(JSON.stringify({ type: 'connection_ack', clientId }));
    // 接続が切れた時の処理
    ws.on('close', () => {
        clients.delete(clientId); // 名簿から削除します
        console.log(`Client disconnected: ${clientId}`);
    });
    ws.on('error', (error) => console.error(`WebSocket Error for client ${clientId}:`, error));
});

// HTTPサーバーの 'upgrade' イベントを処理し、WebSocket接続を確立します。
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// --- APIエンドポイント ---
app.post('/get-formats', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: 'URLは必須です。' });
    try {
        const infoJson = await runCommand('yt-dlp', ['-J', url]);
        const videoInfo = JSON.parse(infoJson);
        res.json({ title: videoInfo.title, thumbnail: videoInfo.thumbnail, formats: videoInfo.formats });
    } catch (error) {
        console.error(`Error fetching formats for ${url}:`, error.message);
        res.status(500).json({ message: "情報の取得に失敗しました。URLが有効か、動画がプライベートでないか確認してください。" });
    }
});
app.post('/download', (req, res) => {
    console.log('Received /download request with body:', req.body);
    const { clientId, url, title, options } = req.body;
    let errorMessages = [];
    if (!clientId) errorMessages.push('clientIdがありません。');
    if (!url) errorMessages.push('urlがありません。');
    if (!title) errorMessages.push('titleがありません。');
    if (!options) errorMessages.push('optionsがありません。');
    // 名簿(clients)に、指定されたclientIdが存在するか確認します。
    if (clientId && !clients.has(clientId)) errorMessages.push(`サーバーがclientId '${clientId}'を認識できません。`);
    if (errorMessages.length > 0) {
        const fullErrorMessage = `無効なリクエストです: ${errorMessages.join(' ')}`;
        console.error(fullErrorMessage);
        return res.status(400).json({ message: fullErrorMessage });
    }
    res.status(202).json({ message: 'ダウンロードリクエストを受け付けました。' });
    processDownload(clientId, url, title, options);
});

// --- コアロジック ---
function getUniqueFilename(directory, filenameBase, extension) {
    let finalFilename = `${filenameBase}.${extension}`;
    let counter = 1;
    while (fs.existsSync(path.join(directory, finalFilename))) {
        finalFilename = `${filenameBase} (${counter}).${extension}`;
        counter++;
    }
    return finalFilename;
}
function sanitizeFilename(filename) {
    const sanitized = filename.replace(/[\\/:\*\?"<>\|]/g, '_');
    return sanitized.substring(0, 100);
}
function runCommand(command, args, clientId = null) {
    return new Promise((resolve, reject) => {
        console.log(`Executing: ${command} ${args.join(' ')}`);
        const process = spawn(command, args);
        // 名簿(clients)から正しいクライアントを探してメッセージを送ります。
        const sendToClient = (data) => { if (clientId && clients.has(clientId)) clients.get(clientId).send(JSON.stringify(data)) };
        let stdout = '';
        let stderr = '';
        const timeoutId = setTimeout(() => { process.kill('SIGKILL'); reject(new Error(`プロセスがタイムアウトしました`)); }, PROCESS_TIMEOUT);
        process.stdout.on('data', (data) => {
            const line = data.toString();
            stdout += line;
            const progressMatch = line.match(/\[download\]\s+([\d.]+)% of/);
            if (progressMatch) sendToClient({ type: 'progress', progress: parseFloat(progressMatch[1]) });
        });
        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        process.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0) {
                resolve(stdout);
            } else {
                console.error(`yt-dlp stderr: ${stderr}`);
                reject(new Error(`yt-dlpの実行に失敗しました。エラー: ${stderr.trim()}`));
            }
        });
        process.on('error', (err) => { clearTimeout(timeoutId); reject(new Error(`プロセスの起動に失敗: ${err.message}`)); });
    });
}
async function processDownload(clientId, url, title, options) {
    // 名簿(clients)から正しいクライアントを探してメッセージを送ります。
    const sendToClient = (data) => { if (clientId && clients.has(clientId)) clients.get(clientId).send(JSON.stringify(data)) };
    sendToClient({ type: 'status', message: 'ダウンロード準備中...' });
    try {
        const safeTitle = sanitizeFilename(title);
        const finalFilename = getUniqueFilename(DOWNLOADS_DIR, safeTitle, options.ext);
        const outputPath = path.join(DOWNLOADS_DIR, finalFilename);
        let downloadArgs = ['--no-playlist', '-o', outputPath];
        if (options.type === 'expert_video') {
            downloadArgs.push('-f', `${options.vcodec_id}+${options.acodec_id}`);
            downloadArgs.push('--merge-output-format', 'mp4');
        } else if (options.type === 'expert_audio') {
            downloadArgs.push('-f', options.acodec_id);
            downloadArgs.push('-x');
            downloadArgs.push('--audio-format', options.ext);
            if (options.audio_quality) {
                downloadArgs.push('--audio-quality', options.audio_quality);
            }
        } else {
            if (options.ext === 'mp3') {
                downloadArgs.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
            } else {
                downloadArgs.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
            }
        }
        downloadArgs.push(url);
        await runCommand('yt-dlp', downloadArgs, clientId);
        if (!fs.existsSync(outputPath)) {
            throw new Error('ダウンロードは完了しましたが、サーバー上でファイルが見つかりませんでした。');
        }
        sendToClient({
            type: 'completed',
            data: {
                downloadUrl: `/downloads/${finalFilename}`,
                filename: finalFilename
            }
        });
        setTimeout(() => fs.unlink(outputPath, (err) => { if (err && err.code !== 'ENOENT') console.error(`ファイル削除エラー: ${outputPath}`, err); else if (!err) console.log(`ファイル削除成功: ${outputPath}`); }), FILE_LIFETIME);
    } catch (error) {
        console.error(`Download failed for client ${clientId}:`, error.message);
        sendToClient({ type: 'failed', message: error.message });
    }
}

// --- サーバー起動 ---
server.listen(PORT, () => {
    console.log(`サーバーが http://localhost:${PORT} で起動しました`);
});
