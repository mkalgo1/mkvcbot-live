const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus, 
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const path = require('path');
require('dotenv').config();

// Ensure ffmpeg path is set
if (process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = process.env.FFMPEG_PATH;
} else if (require('fs').existsSync(path.join(__dirname, 'ffmpeg.exe'))) {
  process.env.FFMPEG_PATH = path.join(__dirname, 'ffmpeg.exe');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const audioPath = path.join(__dirname, 'audio.mp3');
let player = createAudioPlayer();
let currentConnection = null;
let currentChannelId = null;

function hasHumans(channel) {
  if (!channel) return false;
  return channel.members.some(member => !member.user.bot);
}

function playLoop() {
  if (!player || !currentConnection) return;
  console.log('[MKVCBot] Streaming audio.mp3 with DAVE encryption...');
  const resource = createAudioResource(audioPath, { inlineVolume: true });
  if (resource.volume) {
    resource.volume.setVolume(2.0); // +100% volume boost
  }
  player.play(resource);
}

player.on(AudioPlayerStatus.Idle, () => {
  console.log('[MKVCBot] Audio track finished. Looping again...');
  if (currentConnection && currentChannelId) {
    const channel = client.channels.cache.get(currentChannelId);
    if (channel && hasHumans(channel)) {
      setTimeout(() => playLoop(), 1000);
    } else {
      console.log('[MKVCBot] Bot is alone in VC. Standing by silently.');
    }
  }
});

player.on('error', error => {
  console.error('[MKVCBot] Audio player error:', error.message);
  setTimeout(() => playLoop(), 2000);
});

client.on('ready', () => {
  console.log(`[MKVCBot] ====== MKVCBOT IS ONLINE (DAVE NATIVE) ======`);
  console.log(`[MKVCBot] Logged in as: ${client.user.tag}`);
  console.log(`[MKVCBot] Ready and listening for '@bot start' command.`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!currentChannelId || !currentConnection) return;
  if (oldState.channelId === currentChannelId || newState.channelId === currentChannelId) {
    const channel = client.channels.cache.get(currentChannelId);
    if (channel) {
      if (hasHumans(channel)) {
        if (player.state.status === AudioPlayerStatus.Idle || player.state.status === AudioPlayerStatus.Paused) {
          console.log('[MKVCBot] Human present in VC. Resuming loop...');
          playLoop();
        }
      } else {
        if (player.state.status === AudioPlayerStatus.Playing) {
          console.log('[MKVCBot] Bot is alone in VC. Pausing.');
          player.pause();
        }
      }
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.mentions.users.has(client.user.id)) return;

  // Admin Check
  const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator) || message.author.id === message.guild.ownerId;
  if (!isAdmin) return;

  const content = message.content.toLowerCase();

  if (content.includes('start')) {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) {
      console.log(`[MKVCBot] Admin ${message.author.tag} issued start but is not in VC.`);
      return;
    }

    console.log(`[MKVCBot] Connecting to Normal Voice Channel '${voiceChannel.name}' with native DAVE encryption...`);
    currentChannelId = voiceChannel.id;
    currentConnection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    currentConnection.subscribe(player);

    currentConnection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[MKVCBot] Connection READY! DAVE handshake established with Discord!`);
      playLoop();
    });

    currentConnection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(currentConnection, VoiceConnectionStatus.Signalling, 5000),
          entersState(currentConnection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch (e) {
        currentConnection.destroy();
        currentConnection = null;
        currentChannelId = null;
      }
    });

  } else if (content.includes('disconnect') || content.includes('diconnect')) {
    if (currentConnection) {
      console.log('[MKVCBot] Disconnecting from VC...');
      player.stop();
      currentConnection.destroy();
      currentConnection = null;
      currentChannelId = null;
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
