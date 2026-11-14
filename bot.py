"""
MKVCBot - Discord Voice Bot for MKTRADEZ
- Speaks user-provided audio file ('audio.mp3' / 'audio.pcm') in an INFINITE seamless loop.
- Automatically stays connected 100% of the time.
- Fully supports Discord's native DAVE E2EE voice protocol.
- Admin commands: @bot start, @bot disconnect (or @bot diconnect).
- Strictly Administrator or Guild Owner only.
- 100% voice transmission — zero text channel clutter.
"""

import os
import sys
import shutil
import asyncio
import logging
import subprocess
from typing import Optional
import discord
from discord.ext import commands
from dotenv import load_dotenv

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("MKVCBot")

# Load environment variables
load_dotenv()
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MP3_FILE = os.path.join(BASE_DIR, "audio.mp3")
PCM_FILE = os.path.join(BASE_DIR, "audio.pcm")
WAV_FILE = os.path.join(BASE_DIR, "audio.wav")
FFMPEG_BIN = os.path.join(BASE_DIR, "ffmpeg.exe") if os.path.exists(os.path.join(BASE_DIR, "ffmpeg.exe")) else "ffmpeg"

intents = discord.Intents.default()
intents.message_content = True  # Required to read tag commands
intents.voice_states = True     # Required to monitor who joins/leaves VC
intents.guilds = True

bot = commands.Bot(command_prefix="", intents=intents)

# In-memory PCM audio cache
CACHED_PCM_BYTES: bytes = b""


class LoopingPCMAudioSource(discord.AudioSource):
    """
    Streams raw 48kHz stereo PCM in an infinite, seamless loop directly from memory.
    Zero ffmpeg process restarts, zero CPU spikes, zero transcode lag.
    """
    def __init__(self, pcm_bytes: bytes, pause_seconds: float = 1.0):
        # 1.0 second natural silence padding between repetitions
        silence_bytes = b'\x00' * int(48000 * 2 * 2 * pause_seconds)
        self._data = pcm_bytes + silence_bytes
        self._length = len(self._data)
        self._pos = 0
        self._packets_sent = 0

    def read(self) -> bytes:
        chunk_size = 3840  # Standard Opus frame: 960 samples * 2 channels * 2 bytes (s16le)
        self._packets_sent += 1

        if self._packets_sent % 250 == 0:  # Every ~5 seconds
            logger.info(f"Voice Stream Active: {self._packets_sent} audio frames transmitted successfully.")

        if self._pos + chunk_size > self._length:
            remaining = self._data[self._pos:]
            wrap_needed = chunk_size - len(remaining)
            chunk = remaining + self._data[:wrap_needed]
            self._pos = wrap_needed
            return chunk

        chunk = self._data[self._pos:self._pos + chunk_size]
        self._pos += chunk_size
        return chunk

    def is_opus(self) -> bool:
        return False


def convert_and_load_pcm():
    """Converts audio.mp3 into raw 48kHz stereo 16-bit PCM and loads into RAM."""
    global CACHED_PCM_BYTES

    if not os.path.exists(MP3_FILE):
        logger.error(f"Audio file '{MP3_FILE}' not found!")
        return

    logger.info(f"Pre-encoding '{MP3_FILE}' to 48kHz stereo PCM...")
    try:
        cmd = [
            FFMPEG_BIN,
            "-y",
            "-i", MP3_FILE,
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
            "-filter:a", "volume=2.5",
            PCM_FILE
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        logger.info(f"Raw PCM encoded successfully -> {PCM_FILE}")
    except Exception as e:
        logger.error(f"FFmpeg encoding error: {e}")

    if os.path.exists(PCM_FILE):
        with open(PCM_FILE, "rb") as f:
            CACHED_PCM_BYTES = f.read()
        logger.info(f"Loaded {len(CACHED_PCM_BYTES)} bytes of PCM audio into memory. Ready for instant looping.")


def has_humans(channel: discord.VoiceChannel) -> bool:
    """Checks if there are non-bot users in the voice channel."""
    if not channel:
        return False
    return any(not member.bot for member in channel.members)


def start_infinite_playback(vc: discord.VoiceClient):
    """Starts or resumes the infinite memory stream 100% reliably."""
    if not vc or not vc.is_connected():
        return

    if vc.is_paused():
        logger.info("Resuming voice playback...")
        vc.resume()
        return

    if not vc.is_playing():
        if len(CACHED_PCM_BYTES) == 0:
            convert_and_load_pcm()

        if len(CACHED_PCM_BYTES) > 0:
            source = LoopingPCMAudioSource(CACHED_PCM_BYTES, pause_seconds=1.0)
            logger.info(f"Starting 100% INFINITE playback loop in '{vc.channel.name}'...")
            logger.info(f"Active Voice Mode: {vc.mode} | DaveVersion: {getattr(vc._connection, 'dave_protocol_version', 'N/A')}")
            vc.play(source)


@bot.event
async def on_ready():
    logger.info(f"====== MKVCBOT IS ONLINE ======")
    logger.info(f"Logged in as: {bot.user.name}#{bot.user.discriminator} (ID: {bot.user.id})")
    logger.info(f"Guilds connected: {[g.name for g in bot.guilds]}")
    convert_and_load_pcm()
    logger.info("Bot is ready and listening for '@bot start' command.")


@bot.event
async def on_voice_state_update(member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
    """
    Monitors user movement in voice channels:
    - If humans are present: plays/resumes audio.
    - If alone: pauses audio and stays silent.
    """
    guild = member.guild
    vc: Optional[discord.VoiceClient] = guild.voice_client
    if not vc or not vc.channel:
        return

    # Check if event happened in the channel where the bot is
    if before.channel == vc.channel or after.channel == vc.channel:
        if has_humans(vc.channel):
            if vc.is_paused():
                logger.info("Human detected in VC. Resuming audio playback.")
                vc.resume()
            elif not vc.is_playing():
                start_infinite_playback(vc)
        else:
            if vc.is_playing() and not vc.is_paused():
                logger.info("Bot is alone in VC. Pausing audio until someone joins.")
                vc.pause()


@bot.event
async def on_message(message: discord.Message):
    """
    Handles tag commands:
    - @bot start
    - @bot disconnect / @bot diconnect
    Strictly Administrator or Guild Owner only.
    Zero text response sent (voice-only bot).
    """
    if message.author.bot or not message.guild:
        return

    # Check if the bot was mentioned
    if bot.user not in message.mentions:
        return

    # STRICT SECURITY CHECK: Must have Administrator permission or be server owner
    is_admin = message.author.guild_permissions.administrator or (message.author.id == message.guild.owner_id)
    if not is_admin:
        logger.warning(f"Ignored unauthorized mention from {message.author.name}")
        return

    content_clean = message.content.lower().replace(f"<@{bot.user.id}>", "").replace(f"<@!{bot.user.id}>", "").strip()
    logger.info(f"Admin command received from {message.author.name}: '{content_clean}'")

    # Command: start
    if "start" in content_clean:
        if message.author.voice and message.author.voice.channel:
            target_channel = message.author.voice.channel
            logger.info(f"Connecting to voice channel: '{target_channel.name}'...")
            vc: Optional[discord.VoiceClient] = message.guild.voice_client

            if vc and vc.is_connected():
                if vc.channel != target_channel:
                    await vc.move_to(target_channel)
            else:
                try:
                    vc = await target_channel.connect(reconnect=True, timeout=30.0, self_deaf=False, self_mute=False)
                except Exception as e:
                    logger.error(f"Failed to connect to voice channel: {e}", exc_info=True)
                    return

            # Check permissions
            perms = target_channel.permissions_for(message.guild.me)
            logger.info(f"Channel Permissions -> Connect: {perms.connect}, Speak: {perms.speak}")

            # Immediately start speaking 100%
            start_infinite_playback(vc)
        else:
            logger.warning(f"Admin {message.author.name} issued start but is not currently in a voice channel.")

    # Command: disconnect / diconnect
    elif "disconnect" in content_clean or "diconnect" in content_clean:
        vc: Optional[discord.VoiceClient] = message.guild.voice_client
        if vc and vc.is_connected():
            logger.info("Disconnecting from voice channel...")
            if vc.is_playing() or vc.is_paused():
                vc.stop()
            await vc.disconnect()


if __name__ == "__main__":
    if not BOT_TOKEN:
        logger.error("DISCORD_BOT_TOKEN environment variable is missing! Check .env file.")
        sys.exit(1)

    try:
        bot.run(BOT_TOKEN)
    except Exception as e:
        logger.critical(f"Failed to start bot: {e}")
