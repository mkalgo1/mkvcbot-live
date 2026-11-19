const { 
  Client, 
  GatewayIntentBits, 
  PermissionsBitField,
  ChannelType
} = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  StreamType,
  AudioPlayerStatus, 
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  NoSubscriberBehavior
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
require('dotenv').config();

// Built-in HTTP Ping & Keep-Alive Server (for UptimeRobot, Render, Railway, cloud hosts)
const HTTP_PORT = process.env.PORT || 8080;
const httpServer = http.createServer((req, res) => {
  if (req.url === '/ping' || req.url === '/' || req.url === '/health') {
    const statusData = {
      status: 'ok',
      message: 'MKVCBot is active and awake!',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      discordUser: client.user ? client.user.tag : 'initializing',
      inVoice: Boolean(currentConnection)
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusData, null, 2));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});
httpServer.listen(HTTP_PORT, () => {
  console.log(`[MKVCBot] 🌐 HTTP Keep-Alive server listening on port ${HTTP_PORT} (Ping URL path: /ping)`);
});

// Ensure single-instance lock across the operating system
const MUTEX_PORT = 45888;
const lockServer = net.createServer();
lockServer.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[CRITICAL] Another instance of MKVCBot is already running on port ${MUTEX_PORT}! Exiting immediately to prevent duplicate processes and conflicts.`);
    process.exit(0);
  }
});
lockServer.listen(MUTEX_PORT, '127.0.0.1', () => {
  console.log(`[MKVCBot] Single-instance mutex acquired on 127.0.0.1:${MUTEX_PORT}`);
});

const { startPolling, notifyDisconnect, notifyReconnect } = require('./telegram');

// Persistent channel configuration
const stateFilePath = path.join(__dirname, 'channel.json');

function saveChannel(channelId) {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify({ channelId }), 'utf8');
  } catch (e) {}
}

function loadSavedChannel() {
  try {
    if (fs.existsSync(stateFilePath)) {
      const data = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (data && data.channelId) return data.channelId;
    }
  } catch (e) {}
  return process.env.TARGET_CHANNEL_ID || '1512028925721841725';
}

let TARGET_CHANNEL_ID = loadSavedChannel();
const FAST_RECONNECT_DELAY_MS = 5 * 1000; // Fast 5 seconds auto-reconnect!

// File paths
const logFile = path.join(__dirname, 'bot_live.log');

// Multiplatform FFmpeg resolver (Windows local ffmpeg.exe, Linux/Docker ffmpeg, or ffmpeg-static)
let ffmpegBinary = 'ffmpeg';
try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    ffmpegBinary = ffmpegStatic;
  }
} catch (_) {}
const localFfmpeg = path.join(__dirname, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
if (fs.existsSync(localFfmpeg)) {
  ffmpegBinary = localFfmpeg;
}
process.env.FFMPEG_PATH = ffmpegBinary;
const audioPath = path.join(__dirname, 'audio.mp3');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {}
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play
  }
});

let currentConnection = null;
let currentFFmpeg = null;
let isIntentionalDisconnect = false;
let reconnectTimer = null;
let isConnecting = false;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function stopCurrentStream() {
  if (currentFFmpeg) {
    try {
      currentFFmpeg.kill();
    } catch (e) {}
    currentFFmpeg = null;
  }
}

function playLoop() {
  if (!currentConnection) {
    log('[MKVCBot] playLoop: No active voice connection.');
    return;
  }

  stopCurrentStream();

  log('[MKVCBot] ▶ Starting Native Infinite Audio Stream (-stream_loop -1)...');
  try {
    currentFFmpeg = spawn(ffmpegBinary, [
      '-stream_loop', '-1', // Infinite seamless audio loop
      '-i', audioPath,
      '-f', 's16le', // Raw 16-bit PCM
      '-ar', '48000', // 48kHz
      '-ac', '2', // Stereo
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    currentFFmpeg.on('error', err => {
      log(`[MKVCBot] FFmpeg process error: ${err.message}`);
    });

    currentFFmpeg.on('exit', (code, signal) => {
      log(`[MKVCBot] FFmpeg process exited (code: ${code}, signal: ${signal}).`);
    });

    const resource = createAudioResource(currentFFmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });

    if (resource.volume) {
      resource.volume.setVolume(1.8); // Loud & clear
    }

    player.play(resource);
  } catch (err) {
    log(`[MKVCBot] Failed to start infinite audio stream: ${err.message}`);
    setTimeout(() => playLoop(), 2000);
  }
}

player.on(AudioPlayerStatus.Playing, () => {
  log('[MKVCBot] 🔊 Audio is actively STREAMING in continuous infinite loop!');
});

player.on(AudioPlayerStatus.Idle, () => {
  if (currentConnection && !isIntentionalDisconnect) {
    log('[MKVCBot] Audio player became idle. Re-launching infinite stream in 500ms...');
    setTimeout(() => playLoop(), 500);
  }
});

player.on('error', error => {
  log(`[MKVCBot] ⚠ Audio player error: ${error.message}`);
  setTimeout(() => playLoop(), 2000);
});

function triggerReconnectSchedule(reason) {
  if (isIntentionalDisconnect || isConnecting) {
    return;
  }

  stopCurrentStream();

  if (currentConnection) {
    try {
      currentConnection.destroy();
    } catch (e) {}
    currentConnection = null;
  }

  // Find channel name for notification
  const ch = client.channels.cache.get(TARGET_CHANNEL_ID);
  const chName = ch ? ch.name : TARGET_CHANNEL_ID;

  // Single debounced alert to Telegram
  notifyDisconnect(chName).catch(() => {});

  if (reconnectTimer) {
    return; // Already waiting for the reconnect timer
  }

  log(`[MKVCBot] ⚠ Disconnected (${reason}). Auto-reconnecting in ${FAST_RECONNECT_DELAY_MS / 1000}s to channel: ${TARGET_CHANNEL_ID}...`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    log(`[MKVCBot] ⏱ Auto-reconnecting to channel ${TARGET_CHANNEL_ID} now...`);
    await performJoin(TARGET_CHANNEL_ID, true);
  }, FAST_RECONNECT_DELAY_MS);
}

async function performJoin(targetId = TARGET_CHANNEL_ID, isAuto = false) {
  clearReconnectTimer();

  if (isConnecting) {
    log('[MKVCBot] performJoin already in progress, skipping duplicate.');
    return { success: false, message: 'Join already in progress' };
  }
  isConnecting = true;
  isIntentionalDisconnect = false;

  TARGET_CHANNEL_ID = targetId;
  saveChannel(targetId);

  try {
    log(`[MKVCBot] 🔄 Fetching target voice channel (${targetId})...`);
    const channel = await client.channels.fetch(targetId).catch(() => null);

    if (!channel) {
      log(`[MKVCBot] ❌ Channel ${targetId} not found. Retrying in 10s...`);
      isConnecting = false;
      triggerReconnectSchedule('Channel fetch returned null');
      return { success: false, message: 'Target channel not found' };
    }

    log(`[MKVCBot] 🔄 Connecting to Voice Channel: "${channel.name}" (Guild: "${channel.guild.name}")...`);

    // Clean up any lingering voice connection on this guild
    const stale = getVoiceConnection(channel.guild.id);
    if (stale) {
      try { stale.destroy(); } catch (_) {}
    }
    currentConnection = null;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    currentConnection = connection;
    connection.subscribe(player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      log('[MKVCBot] ⚠ VoiceConnectionStatus transitioned to Disconnected!');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 3000),
          entersState(connection, VoiceConnectionStatus.Connecting, 3000),
        ]);
        log('[MKVCBot] Connection automatically recovered to signalling/connecting.');
      } catch (e) {
        log('[MKVCBot] Connection dropped. Triggering auto-reconnect...');
        triggerReconnectSchedule('Voice connection dropped');
      }
    });

    log('[MKVCBot] Negotiating DAVE MLS handshake with Discord voice server...');
    await entersState(connection, VoiceConnectionStatus.Ready, 25000);
    log('[MKVCBot] ✅ DAVE MLS Handshake SUCCESSFUL! Connection READY!');
    isConnecting = false;
    clearReconnectTimer();

    // If channel is a Stage channel, automatically become speaker
    if (channel.type === ChannelType.GuildStageVoice) {
      try {
        await channel.guild.members.me?.voice?.setSuppressed(false);
        log('[MKVCBot] Stage Channel: Set speaker state (suppression = false).');
      } catch (err) {
        log(`[MKVCBot] Stage speaker setup notice: ${err.message}`);
      }
    }

    // Start playing native infinite audio loop
    playLoop();

    if (isAuto) {
      notifyReconnect(channel.name).catch(() => {});
    }

    return { success: true, channelName: channel.name };

  } catch (err) {
    log(`[MKVCBot] ❌ Connection or handshake failed: ${err.message}`);
    isConnecting = false;
    triggerReconnectSchedule('Connection exception/timeout');
    return { success: false, message: err.message };
  }
}

async function getVoiceChannels() {
  const list = [];
  for (const guild of client.guilds.cache.values()) {
    try {
      const channels = await guild.channels.fetch();
      channels.forEach(ch => {
        if (ch && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)) {
          list.push({
            id: ch.id,
            name: ch.name,
            guildName: guild.name,
            type: ch.type === ChannelType.GuildStageVoice ? 'Stage' : 'Voice',
            isCurrent: ch.id === TARGET_CHANNEL_ID
          });
        }
      });
    } catch (e) {
      log(`[MKVCBot] Error fetching guild channels: ${e.message}`);
    }
  }
  return list;
}

function getBotStatus() {
  let channel = client.channels.cache.get(TARGET_CHANNEL_ID);
  let channelName = channel?.name;
  let inVoice = false;

  for (const guild of client.guilds.cache.values()) {
    if (!channel) {
      const ch = guild.channels.cache.get(TARGET_CHANNEL_ID);
      if (ch) {
        channel = ch;
        channelName = ch.name;
      }
    }
    const me = guild.members.me;
    if (me?.voice?.channelId === TARGET_CHANNEL_ID) {
      inVoice = true;
    }
    const conn = getVoiceConnection(guild.id);
    if (conn && conn.state.status === VoiceConnectionStatus.Ready) {
      inVoice = true;
    }
  }

  return {
    clientReady: client.isReady(),
    inVoice,
    channelName: channelName || '📊 LIVE TRADING VC | FREE',
    channelId: TARGET_CHANNEL_ID,
    streaming: inVoice && player.state.status === AudioPlayerStatus.Playing,
    reconnecting: Boolean(reconnectTimer || isConnecting)
  };
}

// 24/7 Watchdog: runs every 15 seconds
setInterval(async () => {
  if (isIntentionalDisconnect || isConnecting || reconnectTimer) return;

  let isInTargetVC = false;
  for (const guild of client.guilds.cache.values()) {
    const me = guild.members.me;
    if (me?.voice?.channelId === TARGET_CHANNEL_ID) {
      isInTargetVC = true;
      break;
    }
    const conn = getVoiceConnection(guild.id);
    if (conn && (conn.state.status === VoiceConnectionStatus.Ready || conn.state.status === VoiceConnectionStatus.Signalling || conn.state.status === VoiceConnectionStatus.Connecting)) {
      isInTargetVC = true;
      break;
    }
  }

  if (!isInTargetVC) {
    log(`[MKVCBot] 🔍 Watchdog: Bot detected absent from channel ${TARGET_CHANNEL_ID}. Triggering auto-reconnect.`);
    triggerReconnectSchedule('Watchdog detected absent from VC');
  } else if (isInTargetVC && currentConnection && currentConnection.state.status === VoiceConnectionStatus.Ready) {
    if (player.state.status !== AudioPlayerStatus.Playing && player.state.status !== AudioPlayerStatus.Buffering) {
      log(`[MKVCBot] 🔍 Watchdog: Bot in VC but player status is "${player.state.status}". Resuming infinite audio stream...`);
      playLoop();
    }
  }
}, 15000);

client.on('ready', async () => {
  log(`==========================================`);
  log(`MKVCBOT IS ONLINE! Logged in as: ${client.user.tag}`);
  log(`Target Channel: ${TARGET_CHANNEL_ID}`);
  log(`Telegram Bot Link: ENABLED (@discordwakerbot)`);
  log(`Auto-reconnect on Disconnect: ENABLED (Fast 5s auto-reconnect)`);
  log(`Native Infinite Stream: ENABLED (-stream_loop -1)`);
  log(`DAVE E2EE Native Encryption: ENABLED`);
  log(`24/7/365 Persistent Voice Loop: ENABLED`);
  log(`==========================================`);

  // Start Telegram bot listener immediately
  startPolling({
    onWake: async (chatId) => {
      log(`[Telegram] /wake command received from chat ${chatId}!`);
      isIntentionalDisconnect = false;
      clearReconnectTimer();
      return await performJoin(TARGET_CHANNEL_ID);
    },
    onSelectChannel: async (newChannelId) => {
      log(`[Telegram] Channel selected via /channel: ${newChannelId}`);
      isIntentionalDisconnect = false;
      clearReconnectTimer();
      return await performJoin(newChannelId);
    },
    getVoiceChannels: async () => {
      return await getVoiceChannels();
    },
    onDisconnect: async () => {
      log('[Telegram] /disconnect command received from Telegram.');
      isIntentionalDisconnect = true;
      clearReconnectTimer();
      stopCurrentStream();
      player.stop();
      if (currentConnection) {
        try { currentConnection.destroy(); } catch (_) {}
        currentConnection = null;
      }
    },
    getStatus: getBotStatus
  });

  log(`[MKVCBot] Automatic initial connection to channel ${TARGET_CHANNEL_ID}...`);
  performJoin(TARGET_CHANNEL_ID).catch(err => {
    log(`[MKVCBot] Initial connection error: ${err.message}`);
  });
});

// Voice state update event listener
client.on('voiceStateUpdate', (oldState, newState) => {
  if (newState.id === client.user.id) {
    if (!newState.channelId) {
      if (!isConnecting && !isIntentionalDisconnect) {
        log('[MKVCBot] ⚠ Bot was disconnected or moved out of the voice channel.');
        triggerReconnectSchedule('Bot left or was disconnected from voice channel');
      }
    } else if (oldState.channelId !== newState.channelId) {
      log(`[MKVCBot] Voice channel transitioned to ${newState.channelId}.`);
      if (newState.channelId === TARGET_CHANNEL_ID) {
        clearReconnectTimer();
      }
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.toLowerCase().trim();

  const botMember = message.guild.members.me;
  const isDirectMention = message.mentions.users.has(client.user.id);
  const isRoleMention = botMember && message.mentions.roles.some(r => botMember.roles.cache.has(r.id));
  const hasKeyword = content.includes('mktradez-vc') || content.includes(client.user.id) || content.includes('@bot');
  const isCommandPrefix = content.startsWith('!start') || content.startsWith('!disconnect') || content.startsWith('!play') || content.startsWith('!stop') || content.startsWith('!wake');

  if (!isDirectMention && !isRoleMention && !hasKeyword && !isCommandPrefix) {
    return;
  }

  // Admin Check
  const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator) || 
                  message.author.id === message.guild.ownerId;
  if (!isAdmin) {
    return;
  }

  log(`[MKVCBot] Received admin Discord command from ${message.author.tag}: "${message.content}"`);

  if (content.includes('start') || content.includes('play') || content.includes('wake')) {
    isIntentionalDisconnect = false;
    clearReconnectTimer();
    log('[MKVCBot] Admin requested start/wake. Joining target channel...');
    await performJoin(TARGET_CHANNEL_ID);

  } else if (content.includes('disconnect') || content.includes('diconnect') || content.includes('stop')) {
    log('[MKVCBot] Admin explicitly requested disconnect. Pausing auto-reconnect.');
    isIntentionalDisconnect = true;
    clearReconnectTimer();
    stopCurrentStream();
    player.stop();
    if (currentConnection) {
      try { currentConnection.destroy(); } catch (_) {}
      currentConnection = null;
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
