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

// Batas file Discord server ini: 10MB. Video resolusi asli di bawah itu
// langsung dikirim sebagai file ke pesan; di atas itu kirim tombol link
// (diperpendek) buat download lewat web.
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

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
// <= 10MB sebagai file langsung di pesan (+ tombol download),
// > 10MB hanya tombol link (diperpendek) buat download lewat web.
// `send` = fungsi kirim pesan, `cleanup` = hapus pesan loading / reply.
async function sendVideo({ captionText, videoUrl, sourceUrl, send, cleanup }) {
    const size = await getRemoteSize(videoUrl);
    const short = await shortenUrl(videoUrl);
    const row = safeLinkRow('View / Download Link', short, sourceUrl);
    const components = row ? [row] : [];
    try {
        if (size !== null && size > MAX_ATTACH_BYTES) {
            await send({ content: captionText, components });
        } else {
            const attachment = new AttachmentBuilder(videoUrl, { name: 'video.mp4' });
            await send({ content: captionText, files: [attachment], components });
        }
    } catch (err) {
        // Gagal kirim file (mis. ternyata di atas batas) — fallback ke link
        try { await send({ content: captionText, components }); } catch (e) {}
    }
    if (cleanup) { try { await cleanup(); } catch (e) {} }
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

// Update deskripsi command agar user tahu ini support banyak platform
const commands = [
    new SlashCommandBuilder()
        .setName('use')
        .setDescription('Unduh Video (TikTok, IG, YT, X, FB, dll)')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Masukkan link media')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('usemp4')
        .setDescription('Unduh Video MP4 (TikTok, IG, YT, X, FB, dll)')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Masukkan link media')
                .setRequired(true)),
    
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

client.once('clientReady', async () => {
    console.log(`🤖 Bot Multi-Downloader Online: ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: '/use /usemp3 (TikTok, IG, YT, X) ✨', type: ActivityType.Custom }],
        status: 'online',
    });
    await registerCommands();
});

// --- FITUR AUTO-DETECT LINK DARI CHAT ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Mendeteksi semua jenis link (bukan cuma TikTok)
    const urlRegex = /(https?:\/\/[^\s]+)/;
    const match = message.content.match(urlRegex);

    if (match) {
        const targetUrl = match[1];
        
        // Filter agar bot hanya memproses situs yang didukung (mencegah bot mendownload link web sembarangan)
        const supportedDomains = ['tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'facebook.com', 'fb.watch', 'reddit.com', 'pinterest.com'];
        const isSupported = supportedDomains.some(domain => targetUrl.includes(domain));
        
        if (!isSupported) return;
        
        try { await message.delete(); } catch (err) {}

        const captionText = `🔗 <${targetUrl}>`;
        const loadingMsg = await message.channel.send({ content: '⏳ Sedang memproses media... (Estimasi: 2-5 detik)' });
        
        const isTikTok = targetUrl.includes('tiktok.com');

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
                        } catch (renderErr) {
                            await loadingMsg.edit({ content: `❌ Gagal merender foto menjadi video.\n${captionText}` });
                        }
                    } else {
                        const attachments = result.urls.slice(0, 10).map((url, i) => 
                            new AttachmentBuilder(url, { name: `foto_${i + 1}.jpg` })
                        );
                        await message.channel.send({ content: captionText, files: attachments });
                        await loadingMsg.delete(); 
                    }
                } else {
                    await sendVideo({
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
        // Aturan sama seperti TikTok: resolusi asli, <= 10MB kirim file
        // langsung ke pesan, > 10MB kirim tombol link buat download web.
        else {
            const result = await getMultiMedia(targetUrl, false);

            if (result.success) {
                await sendVideo({
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
    }
});

// --- FITUR SLASH COMMANDS ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const targetUrl = interaction.options.getString('link');
    const captionText = `<${targetUrl}>`;

    // Hilangkan batasan TikTok only agar user bisa naruh link IG, YT, X
    const supportedDomains = ['tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'facebook.com', 'fb.watch', 'reddit.com', 'pinterest.com'];
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