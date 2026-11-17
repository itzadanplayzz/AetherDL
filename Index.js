const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    AttachmentBuilder,
    ActivityType,
    MessageFlags
} = require('discord.js');

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN || process.env.TOKEN || '';
const CLIENT_ID = '1555997672094302278';

// yt-dlp lokal (bin/yt-dlp), fallback ke yang ada di PATH
const YTDLP = (() => {
    const local = path.join(__dirname, 'bin', 'yt-dlp');
    const localExe = path.join(__dirname, 'bin', 'yt-dlp.exe');
    if (fs.existsSync(local)) return local;
    if (fs.existsSync(localExe)) return localExe;
    return 'yt-dlp';
})();

// Deno = JS runtime buat yt-dlp (tanpa ini, YouTube cuma ngasih format
// video-only dan `best` gagal "Requested format is not available").
// Hanya dipakai kalau bin/deno ada (di laptop user belum tentu ada).
const DENO = path.join(__dirname, 'bin', 'deno');
const jsRuntimeArgs = fs.existsSync(DENO) ? ['--js-runtimes', `deno:${DENO}`] : [];

// Situs yang boleh diproses bot (mencegah bot mendownload link web sembarangan)
const supportedDomains = ['tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'facebook.com', 'fb.watch', 'reddit.com', 'pinterest.com'];
// ID pesan yang sudah diproses — cegah proses ganda (mis. pesan masuk
// bersamaan dengan scan catch-up setelah restart).
const handledMessageIds = new Set();

// Tombol link Discord maksimal 512 karakter — URL CDN (IG scontent /
// googlevideo) sering 800+ karakter dan bikin crash 50035 kalau dipaksa
// jadi tombol. Pakai URL sumber (pendek) sebagai fallback, atau tanpa tombol.
function safeLinkRow(label, url, fallbackUrl) {
    const pick = [url, fallbackUrl].find((u) => typeof u === 'string' && u.length > 0 && u.length <= 512);
    if (!pick) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(pick)
    );
}

// Perpendek URL panjang (CDN IG/YT sering 800+ karakter) supaya bisa jadi
// tombol download — is.gd dulu, tinyurl cadangan, kalau dua-duanya gagal
// kembalikan null (nanti tombol pakai URL sumber).
async function shortenUrl(longUrl) {
    const apis = [
        `https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`,
        `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
    ];
    for (const api of apis) {
        try {
            const res = await fetch(api, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(10000),
            });
            const text = (await res.text()).trim();
            if (res.ok && /^https?:\/\/\S+$/.test(text) && text.length <= 100) return text;
        } catch (e) {}
    }
    return null;
}

// Batas file Discord server ini: 25MB (bukan 10MB — angka 10MB sudah
// kedaluwarsa; dibuktikan 2026-11-17 dengan upload file 11,7MB yang
// diterima Discord). Video resolusi asli di bawah itu langsung dikirim
// sebagai file ke pesan; di atas itu kirim tombol link buat download web.
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

// Ukuran file dari URL remote (HEAD, fallback Range) — null kalau tidak bisa.
async function getRemoteSize(url) {
    try {
        let res = await fetch(url, {
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(10000),
        });
        const len = res.headers.get('content-length');
        if (len) return parseInt(len, 10);
        res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-0' },
            signal: AbortSignal.timeout(10000),
        });
        const cr = res.headers.get('content-range');
        if (cr) {
            const total = cr.split('/')[1];
            if (total) return parseInt(total, 10);
        }
    } catch (e) {}
    return null;
}

// Kirim video resolusi asli dengan aturan yang sama di semua platform:
// <= 25MB sebagai file langsung di pesan (+ tombol download),
// > 25MB hanya tombol link (diperpendek) buat download lewat web.
// `send` = fungsi kirim pesan, `cleanup` = hapus pesan loading / reply.
async function sendVideo({ captionText, videoUrl, sourceUrl, send, cleanup }) {
    const size = await getRemoteSize(videoUrl);
    const short = await shortenUrl(videoUrl);
    const row = safeLinkRow('View / Download Link', short, sourceUrl);
    const components = row ? [row] : [];
    let ok = false;
    try {
        if (size !== null && size > MAX_ATTACH_BYTES) {
            await send({ content: captionText, components });
            ok = true;
        } else {
            const attachment = new AttachmentBuilder(videoUrl, { name: 'video.mp4' });
            await send({ content: captionText, files: [attachment], components });
            ok = true;
        }
    } catch (err) {
        // Gagal kirim file (mis. ternyata di atas batas) — fallback ke link
        try { await send({ content: captionText, components }); ok = true; } catch (e) {}
    }
    if (cleanup) { try { await cleanup(); } catch (e) {} }
    return ok;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Jangan sampai error client (mis. gagal kirim pesan) mematikan proses
client.on('error', (err) => console.error('Client error:', err.message));
client.on('shardError', (err) => console.error('Shard error:', err.message));
client.on('shardDisconnect', (event, shardId) => console.log(`Shard ${shardId} disconnect (code ${event.code}), discord.js akan reconnect otomatis.`));

// Bot crash berulang karena WebSocket gateway Discord timeout saat handshake
// (lewat proxy sandbox) — error 'error' di ws tidak tertangkap discord.js dan
// mematikan proses (sudah 3x: 14:36, 16:36, ~18:13 WIB 2026-11-17, user dapat
// "The application did not respond"). Tangkap di level proses: kalau error
// WebSocket, coba reconnect gateway (destroy + login ulang); kalau error lain,
// keluar supaya keepalive restart.
let wsReconnecting = false;
process.on('uncaughtException', (err) => {
    const msg = String((err && err.message) || err);
    console.error('uncaughtException:', msg);
    const isWs = /websocket|handshake|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(msg);
    if (!isWs || wsReconnecting) { process.exit(1); return; }
    wsReconnecting = true;
    console.log('WebSocket gateway error — mencoba reconnect dalam 5 detik...');
    setTimeout(async () => {
        try { await client.destroy(); } catch (e) {}
        try {
            await client.login(BOT_TOKEN);
            wsReconnecting = false;
            console.log('Reconnect gateway berhasil.');
        } catch (e) {
            console.error('Reconnect gateway gagal:', e.message);
            process.exit(1);
        }
    }, 5000);
});

// Update deskripsi command agar user tahu ini support banyak platform
const commands = [
    new SlashCommandBuilder()
        .setName('use')
        .setDescription('Unduh Video (TikTok, IG, YT, X, FB, dll)')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Masukkan link media')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('resolusi')
                .setDescription('Pilih resolusi video (kosongkan = otomatis)')
                .setRequired(false)
                .addChoices(
                    { name: '360p', value: '360' },
                    { name: '480p', value: '480' },
                    { name: '720p', value: '720' },
                    { name: '1080p', value: '1080' },
                )),

    new SlashCommandBuilder()
        .setName('usemp4')
        .setDescription('Unduh Video MP4 (TikTok, IG, YT, X, FB, dll)')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Masukkan link media')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('resolusi')
                .setDescription('Pilih resolusi video (kosongkan = otomatis)')
                .setRequired(false)
                .addChoices(
                    { name: '360p', value: '360' },
                    { name: '480p', value: '480' },
                    { name: '720p', value: '720' },
                    { name: '1080p', value: '1080' },
                )),
    
    new SlashCommandBuilder()
        .setName('usemp3')
        .setDescription('Unduh Audio MP3 (TikTok, IG, YT, X, FB, dll)')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Masukkan link media')
                .setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

async function registerCommands() {
    // Daftar ke SEMUA server tempat bot berada (bukan 1 ID hardcode) —
    // dulu hardcode ke guild 1382229810335453206 tempat bot tidak ada,
    // makanya selalu 50001 Missing Access.
    const guilds = [...client.guilds.cache.values()];
    if (guilds.length === 0) {
        console.log('⚠️ Bot belum ada di server manapun, slash command tidak didaftarkan.');
        return;
    }
    for (const guild of guilds) {
        try {
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, guild.id),
                { body: commands }
            );
            console.log(`✅ Slash Commands terdaftar di server: ${guild.name} (${guild.id})`);
        } catch (error) {
            console.error(`❌ Gagal daftar slash command di ${guild.name} (${guild.id}):`, error.code || error.message);
        }
    }
}

// --- FUNGSI DOWNLOAD & RENDER FFMPEG (KHUSUS TIKTOK) ---
async function downloadFile(url, filepath) {
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function renderSingleTikTokSlide(imageUrl, audioPathUrl, uniqueId) {
    return new Promise(async (resolve, reject) => {
        const tempDir = path.join(__dirname, `temp_${uniqueId}`);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        try {
            const audioUrl = audioPathUrl.startsWith('http') ? audioPathUrl : `https://tikwm.com${audioPathUrl}`;
            const audioPath = path.join(tempDir, 'audio.mp3');
            await downloadFile(audioUrl, audioPath);

            const imagePath = path.join(tempDir, 'img.jpg');
            await downloadFile(imageUrl, imagePath);

            const outputPath = path.join(tempDir, 'output.mp4');
            const ffmpegCmd = `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${outputPath}"`;

            exec(ffmpegCmd, (error) => {
                if (error) return reject(error);
                resolve({ outputPath, tempDir });
            });
        } catch (err) {
            reject(err);
        }
    });
}

// --- ENGINE 1: TIKTOK (TIKWM) ---
async function getTikTok(url) {
    try {
        const response = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch (jsonErr) { return { success: false }; }

        if (result.code === 0 && result.data) {
            let videoPath = result.data.hdplay || result.data.play;
            const fullVideoUrl = videoPath ? (videoPath.startsWith('http') ? videoPath : `https://tikwm.com${videoPath}`) : null;

            if (result.data.images && result.data.images.length > 0) {
                return { 
                    success: true, 
                    isVideo: false, 
                    urls: result.data.images,
                    videoUrl: fullVideoUrl,
                    audioUrl: result.data.music
                };
            }

            if (fullVideoUrl) { return { success: true, isVideo: true, url: fullVideoUrl }; }
        }
    } catch (e) {}
    return { success: false };
}

async function getAudio(url) {
    try {
        const response = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (jsonErr) { return { success: false }; }

        if (data.code === 0 && data.data && data.data.music) {
            const musicUrl = data.data.music.startsWith('http') ? data.data.music : `https://tikwm.com${data.data.music}`;
            return { success: true, url: musicUrl, title: data.data.music_info?.title || 'audio' };
        }
    } catch (e) {}
    return { success: false };
}

// --- ENGINE 2: MULTI-DOWNLOADER 20+ SITUS (yt-dlp) ---
// Cobalt API (api.cobalt.tools/api/json) sudah mati — sekarang mengembalikan
// "Cannot POST /api/json", jadi semua download non-TikTok gagal. Diganti yt-dlp
// (sudah dites di VM ini: IG, YT jalan; pakai --no-check-certificate karena
// proxy sandbox mem-MITM TLS).
function ytdlpGetUrl(url) {
    return new Promise((resolve) => {
        execFile(YTDLP, ['--no-check-certificate', '--no-playlist', '--no-warnings',
            ...jsRuntimeArgs, '-f', 'best[ext=mp4]/best', '--get-url', url],
            { timeout: 60000, maxBuffer: 1024 * 1024 },
            (err, stdout) => {
                if (err) return resolve(null);
                const line = stdout.trim().split('\n').filter(Boolean)[0];
                resolve(line || null);
            });
    });
}

function ytdlpGetAudio(url, outPath) {
    return new Promise((resolve) => {
        execFile(YTDLP, ['--no-check-certificate', '--no-playlist', '--no-warnings',
            ...jsRuntimeArgs, '-f', 'bestaudio', '-x', '--audio-format', 'mp3', '-o', outPath, url],
            { timeout: 120000 },
            (err) => {
                resolve(!err && fs.existsSync(outPath));
            });
    });
}

async function getMultiMedia(url, isAudioOnly = false) {
    try {
        if (isAudioOnly) {
            const tmpDir = path.join(__dirname, `temp_audio_${Date.now()}`);
            fs.mkdirSync(tmpDir, { recursive: true });
            const outPath = path.join(tmpDir, 'audio.mp3');
            const ok = await ytdlpGetAudio(url, outPath);
            if (ok) return { success: true, file: outPath, tempDir: tmpDir };
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return { success: false };
        }
        const mediaUrl = await ytdlpGetUrl(url);
        if (mediaUrl) return { success: true, url: mediaUrl };
    } catch (err) {
        console.error('yt-dlp error:', err.message);
    }
    return { success: false };
}

// Download video pada resolusi yang dipilih user (video+audio digabung
// ffmpeg jadi satu file mp4). Dipakai kalau user isi opsi `resolusi` di
// /use atau /usemp4 — format gabungan (mis. YT format 18) mentok di
// 360p/720p, jadi resolusi lebih tinggi harus download + gabung.
// `maxBytes` = batas ukuran hasil (default 25MB = batas attach Discord).
// Kembalikan { file, tempDir, size } kalau hasil <= maxBytes,
// { tooBig: true, size } kalau di atas batas, atau null kalau gagal.
async function ytdlpGetVideoMerged(url, height, maxBytes = MAX_ATTACH_BYTES) {
    const fmt = `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}][ext=mp4]/b[height<=${height}]`;
    const maxMB = Math.floor(maxBytes / 1048576);
    // 1) Cek ukuran dulu via -j (tanpa download) — jangan download video
    // panjang yang hasilnya pasti di atas batas.
    const estSize = await new Promise((resolve) => {
        execFile(YTDLP, ['--no-check-certificate', '--no-playlist', '--no-warnings', ...jsRuntimeArgs, '-f', fmt, '-j', '--skip-download', url], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve(null);
            try {
                const d = JSON.parse(stdout);
                const formats = d.requested_formats || [d];
                const sum = formats.reduce((a, f) => a + (f.filesize || f.filesize_approx || 0), 0);
                resolve(sum > 0 ? sum : null);
            } catch (e) { resolve(null); }
        });
    });
    if (estSize !== null && estSize > maxBytes) return { tooBig: true, size: estSize };
    // 2) Download + gabung (dibatasi maxBytes — yt-dlp berhenti sendiri kalau
    // ternyata lebih besar, jadi tidak ada download raksasa).
    const tmpDir = path.join(__dirname, `temp_video_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPath = path.join(tmpDir, 'video.mp4');
    const ok = await new Promise((resolve) => {
        execFile(YTDLP, ['--no-check-certificate', '--no-playlist', '--no-warnings', ...jsRuntimeArgs, '-f', fmt, '--merge-output-format', 'mp4', '--max-filesize', `${maxMB}M`, '-o', outPath, url], { timeout: maxBytes > MAX_ATTACH_BYTES ? 600000 : 300000 }, (err) => {
            resolve(!err && fs.existsSync(outPath));
        });
    });
    if (!ok) { fs.rmSync(tmpDir, { recursive: true, force: true }); return null; }
    const size = fs.statSync(outPath).size;
    if (size > maxBytes) { fs.rmSync(tmpDir, { recursive: true, force: true }); return { tooBig: true, size }; }
    return { file: outPath, tempDir: tmpDir, size };
}

// Batas file hosting (Gofile gratis ~10GB, tapi download+upload video
// raksasa lewat proxy lambat — batasi 512MB supaya tetap selesai).
const HOST_MAX_BYTES = 512 * 1024 * 1024;

// Upload file ke Gofile (gratis, tanpa API key). Return URL halaman
// download (https://gofile.io/d/xxxx), atau null kalau gagal.
// Dipakai kalau hasil merge resolusi pilihan user di atas batas Discord.
async function uploadToHost(filePath) {
    try {
        if (fs.statSync(filePath).size > HOST_MAX_BYTES) return null;
        const server = await new Promise((resolve) => {
            execFile('curl', ['-s', '--max-time', '30', 'https://api.gofile.io/servers'], (err, stdout) => {
                if (err) return resolve(null);
                try { resolve(JSON.parse(stdout).data.servers[0].name); } catch (e) { resolve(null); }
            });
        });
        if (!server) return null;
        const url = await new Promise((resolve) => {
            execFile('curl', ['-s', '--max-time', '600', '-F', `file=@${filePath}`, `https://${server}.gofile.io/uploadFile`], (err, stdout) => {
                if (err) return resolve(null);
                try {
                    const d = JSON.parse(stdout);
                    resolve(d.status === 'ok' && d.data && d.data.downloadPage ? d.data.downloadPage : null);
                } catch (e) { resolve(null); }
            });
        });
        return url;
    } catch (e) { return null; }
}

client.once('clientReady', async () => {
    console.log(`🤖 Bot Multi-Downloader Online: ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: '/use /usemp3 (TikTok, IG, YT, X) ✨', type: ActivityType.Custom }],
        status: 'online',
    });
    await registerCommands();
    // Link yang dikirim saat bot mati/restart tidak sampai ke messageCreate —
    // proses yang belum terjawab (30 menit terakhir) supaya tidak hilang.
    try { await catchUpMissedLinks(); } catch (e) { console.error('catch-up error:', e.message); }
});

// --- FITUR AUTO-DETECT LINK DARI CHAT ---
// Pesan user BARU dihapus setelah hasilnya berhasil terkirim — kalau proses
// gagal / bot crash di tengah jalan, linknya tetap ada dan bisa dicoba lagi.
// (Dihapus juga supaya tidak kelihatan siapa yang minta — privasi user.)
async function handleMediaMessage(message) {
    if (message.author.bot) return false;
    const match = message.content.match(/(https?:\/\/[^\s]+)/);
    if (!match) return false;
    const targetUrl = match[1];
    if (!supportedDomains.some((domain) => targetUrl.includes(domain))) return false;
    if (handledMessageIds.has(message.id)) return false;
    handledMessageIds.add(message.id);

    const captionText = `🔗 <${targetUrl}>`;
    const loadingMsg = await message.channel.send({ content: '⏳ Sedang memproses media... (Estimasi: 2-5 detik)' });
    const isTikTok = targetUrl.includes('tiktok.com');
    let sent = false;

    // JIKA LINK TIKTOK -> Eksekusi pakai Engine 1 (TikWM)
    if (isTikTok) {
        const result = await getTikTok(targetUrl);
        if (result.success) {
            if (!result.isVideo) {
                if (result.urls.length === 1) {
                    await loadingMsg.edit({ content: '⏳ menyatukan foto & musik...' });
                    try {
                        const renderData = await renderSingleTikTokSlide(result.urls[0], result.audioUrl, message.id);
                        const attachment = new AttachmentBuilder(renderData.outputPath, { name: 'slide_video.mp4' });
                        await message.channel.send({ content: captionText, files: [attachment] });
                        await loadingMsg.delete();
                        fs.rmSync(renderData.tempDir, { recursive: true, force: true });
                        sent = true;
                    } catch (renderErr) {
                        await loadingMsg.edit({ content: `❌ Gagal merender foto menjadi video.\n${captionText}` });
                    }
                } else {
                    const attachments = result.urls.slice(0, 10).map((url, i) =>
                        new AttachmentBuilder(url, { name: `foto_${i + 1}.jpg` })
                    );
                    await message.channel.send({ content: captionText, files: attachments });
                    await loadingMsg.delete();
                    sent = true;
                }
            } else {
                sent = await sendVideo({
                    captionText,
                    videoUrl: result.url,
                    sourceUrl: targetUrl,
                    send: (msg) => message.channel.send(msg),
                    cleanup: () => loadingMsg.delete(),
                });
            }
        } else {
            await loadingMsg.edit({ content: `❌ Gagal memproses media. Server down atau link tidak valid.\n${captionText}` });
        }
    }

    // JIKA BUKAN TIKTOK (IG, YT, TWITTER, DLL) -> Engine 2 (yt-dlp).
    // Aturan sama seperti TikTok: resolusi asli, <= 25MB kirim file
    // langsung ke pesan, > 25MB kirim tombol link buat download web.
    else {
        const result = await getMultiMedia(targetUrl, false);
        if (result.success) {
            sent = await sendVideo({
                captionText,
                videoUrl: result.url,
                sourceUrl: targetUrl,
                send: (msg) => message.channel.send(msg),
                cleanup: () => loadingMsg.delete(),
            });
        } else {
            await loadingMsg.edit({ content: `❌ Gagal memproses media. Server down atau link tidak valid.\n${captionText}` });
        }
    }

    // Hapus pesan user HANYA setelah hasilnya sudah keluar & terlihat:
    // beri jeda singkat supaya hasil (video/link) sempat tampil di layar
    // dulu sebelum pesan perintahnya dihapus (privasi).
    if (sent) {
        await new Promise((r) => setTimeout(r, 1500));
        try { await message.delete(); } catch (e) {}
    }
    return sent;
}

client.on('messageCreate', (message) => {
    handleMediaMessage(message).catch((e) => console.error('handleMediaMessage error:', e.message));
});

// Link yang terlewat saat bot mati/restart: proses yang belum terjawab
// (30 menit terakhir) supaya tidak hilang begitu saja.
async function catchUpMissedLinks() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const guild of client.guilds.cache.values()) {
        const channels = guild.channels.cache.filter((c) => c.isTextBased() && c.viewable);
        for (const channel of channels.values()) {
            let messages;
            try { messages = await channel.messages.fetch({ limit: 5 }); } catch (e) { continue; }
            const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            for (const msg of sorted) {
                if (msg.author.bot || msg.createdTimestamp < cutoff) continue;
                if (handledMessageIds.has(msg.id)) continue;
                const match = msg.content.match(/(https?:\/\/[^\s]+)/);
                if (!match) continue;
                const targetUrl = match[1];
                if (!supportedDomains.some((d) => targetUrl.includes(d))) continue;
                const answered = sorted.some((m) => m.author.id === client.user.id && m.createdTimestamp > msg.createdTimestamp && m.content.includes(targetUrl));
                if (answered) continue;
                try { await handleMediaMessage(msg); } catch (e) { console.error('catch-up error:', e.message); }
            }
        }
    }
}

// --- FITUR SLASH COMMANDS ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const targetUrl = interaction.options.getString('link');
    const captionText = `<${targetUrl}>`;

    // Hilangkan batasan TikTok only agar user bisa naruh link IG, YT, X
    const isSupported = supportedDomains.some(domain => targetUrl.includes(domain));

    if (!isSupported) {
        return interaction.reply({ content: '❌ Harap masukkan URL link media (TikTok, IG, YT, X, FB) yang valid!', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const isTikTok = targetUrl.includes('tiktok.com');

    // HANDLER /usemp3
    if (commandName === 'usemp3') {
        const result = isTikTok ? await getAudio(targetUrl) : await getMultiMedia(targetUrl, true);

        if (result.success) {
            const dlUrl = result.url || targetUrl;
            const row = safeLinkRow('View / Download MP3', dlUrl, targetUrl);

            try {
                if (result.file) {
                    // Audio dari yt-dlp: file mp3 lokal, hapus folder temp sesudah kirim
                    const attachment = new AttachmentBuilder(result.file, { name: 'audio.mp3' });
                    await interaction.channel.send({ content: captionText, files: [attachment], components: row ? [row] : [] });
                    await interaction.deleteReply();
                    if (result.tempDir) fs.rmSync(result.tempDir, { recursive: true, force: true });
                } else {
                    const attachment = new AttachmentBuilder(result.url, { name: `${isTikTok ? (result.title || 'audio') : 'audio'}.mp3` });
                    await interaction.channel.send({ content: captionText, files: [attachment], components: row ? [row] : [] });
                    await interaction.deleteReply();
                }
            } catch (err) {
                await interaction.channel.send({ content: captionText });
                await interaction.deleteReply();
                if (result.tempDir) fs.rmSync(result.tempDir, { recursive: true, force: true });
            }
        } else {
            await interaction.editReply({ content: '❌ Gagal memproses media. Server down atau link tidak valid.' });
        }
        return;
    }

    // HANDLER /use DAN /usemp4
    if (commandName === 'use' || commandName === 'usemp4') {
        if (isTikTok) {
            const result = await getTikTok(targetUrl);
            if (result.success) {
                if (!result.isVideo) {
                    if (result.urls.length === 1) {
                        await interaction.editReply({ content: '⏳ Menyatukan foto & musik...' });
                        try {
                            const renderData = await renderSingleTikTokSlide(result.urls[0], result.audioUrl, interaction.id);
                            const attachment = new AttachmentBuilder(renderData.outputPath, { name: 'slide_video.mp4' });

                            await interaction.channel.send({ content: captionText, files: [attachment] });
                            await interaction.deleteReply(); 
                            fs.rmSync(renderData.tempDir, { recursive: true, force: true });
                        } catch (renderErr) {
                            await interaction.editReply({ content: '❌ Gagal merender foto menjadi video.' });
                        }
                    } else {
                        const attachments = result.urls.slice(0, 10).map((url, i) => 
                            new AttachmentBuilder(url, { name: `foto_${i + 1}.jpg` })
                        );
                        await interaction.channel.send({ content: captionText, files: attachments });
                        await interaction.deleteReply();
                    }
                } else {
                    await sendVideo({
                        captionText,
                        videoUrl: result.url,
                        sourceUrl: targetUrl,
                        send: (msg) => interaction.channel.send(msg),
                        cleanup: () => interaction.deleteReply(),
                    });
                }
            } else {
                await interaction.editReply({ content: '❌ Gagal memproses media. Server down atau link tidak valid.' });
            }
        } else {
            // EKSEKUSI MULTI-MEDIA (IG, YT, DLL) — aturan sama seperti TikTok.
            // Kalau user isi opsi `resolusi`, download + gabung di resolusi
            // itu (TikTok tidak kena opsi ini — videonya sudah resolusi asli).
            const resolusi = interaction.options.getString('resolusi');
            if (resolusi) {
                const height = parseInt(resolusi, 10);
                const merged = await ytdlpGetVideoMerged(targetUrl, height);
                if (merged && merged.file) {
                    const row = safeLinkRow('View / Download Link', targetUrl);
                    const attachment = new AttachmentBuilder(merged.file, { name: 'video.mp4' });
                    await interaction.channel.send({ content: `${captionText}\n📹 Resolusi ${resolusi}p`, files: [attachment], components: row ? [row] : [] });
                    await interaction.deleteReply();
                    fs.rmSync(merged.tempDir, { recursive: true, force: true });
                } else {
                    // Terlalu besar buat Discord (>25MB) atau ukuran tidak
                    // diketahui — download + gabung, upload ke file hosting
                    // (Gofile), kirim link HD sebagai pesan baru.
                    try { await interaction.editReply({ content: `⏳ Download ${resolusi}p & upload ke file hosting...` }); } catch (e) {}
                    const hosted = await ytdlpGetVideoMerged(targetUrl, height, HOST_MAX_BYTES);
                    let hostUrl = null;
                    if (hosted && hosted.file) {
                        hostUrl = await uploadToHost(hosted.file);
                        fs.rmSync(hosted.tempDir, { recursive: true, force: true });
                    }
                    if (hostUrl) {
                        const row = safeLinkRow('View / Download Link', hostUrl, targetUrl);
                        const sizeMB = (hosted.size / 1048576).toFixed(0);
                        await interaction.channel.send({ content: `${captionText}\n📹 Resolusi ${resolusi}p • ${sizeMB}MB\n⬇️ Download HD: ${hostUrl}`, components: row ? [row] : [] });
                        try { await interaction.deleteReply(); } catch (e) {}
                    } else {
                        // Upload gagal / hasil di atas batas host — fallback ke link biasa.
                        const result = await getMultiMedia(targetUrl, false);
                        if (result.success) {
                            await sendVideo({
                                captionText,
                                videoUrl: result.url,
                                sourceUrl: targetUrl,
                                send: (msg) => interaction.channel.send(msg),
                                cleanup: () => interaction.deleteReply(),
                            });
                        } else {
                            await interaction.editReply({ content: '❌ Gagal memproses media. Server down atau link tidak valid.' });
                        }
                    }
                }
                return;
            }
            const result = await getMultiMedia(targetUrl, false);
            if (result.success) {
                await sendVideo({
                    captionText,
                    videoUrl: result.url,
                    sourceUrl: targetUrl,
                    send: (msg) => interaction.channel.send(msg),
                    cleanup: () => interaction.deleteReply(),
                });
            } else {
                await interaction.editReply({ content: '❌ Gagal memproses media. Server down atau link tidak valid.' });
            }
        }
    }
});

client.login(BOT_TOKEN);