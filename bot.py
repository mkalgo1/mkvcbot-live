"""
MKVCBot - Discord Voice Bot for MKTRADEZ
- Speaks high-impact Order Flow / Option Flow audio message in VC.
- Loops continuously as long as human members are present in the channel.
- Goes silent when alone in the VC; automatically resumes when someone joins.
- Tagged commands: @bot start, @bot disconnect (or @bot diconnect).
- Strictly admin-only (Administrator or Guild Owner required).
- Completely silent in text (sends zero text messages).
"""

import os
import sys
import shutil
import asyncio
import logging
import glob
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

# Optional TTS engines
try:
    import edge_tts
    HAS_EDGE_TTS = True
except ImportError:
    HAS_EDGE_TTS = False

try:
    from gtts import gTTS
    HAS_GTTS = True
except ImportError:
    HAS_GTTS = False

# Load environment variables
load_dotenv()
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
TTS_VOICE = os.getenv("TTS_VOICE", "en-US-ChristopherNeural")
AUDIO_FILE_MP3 = "mktradez_speech.mp3"
AUDIO_FILE_WAV = "mktradez_speech.wav"

# Script to read
SPEECH_TEXT = (
    "MKTRADEZ. "
    "Your ultimate edge in the modern markets. "
    "If you are tired of relying on lagging retail indicators that leave you guessing, "
    "you are in the right place. Our community is built entirely around Order Flow and Option Flow — "
    "the exact mechanics used by institutional algorithms and market makers to move price."
)

intents = discord.Intents.default()
intents.message_content = True  # Required to read tag commands
intents.voice_states = True     # Required to monitor who joins/leaves VC
intents.guilds = True

bot = commands.Bot(command_prefix="", intents=intents)

# Per-guild loop state
guild_loops = {}


def find_ffmpeg() -> str:
    """Finds ffmpeg executable on Windows or Linux."""
    if os.path.exists("ffmpeg.exe"):
        return os.path.abspath("ffmpeg.exe")

    ffmpeg_cmd = shutil.which("ffmpeg")
    if ffmpeg_cmd:
        return ffmpeg_cmd

    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        winget_pattern = os.path.join(local_app_data, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin", "ffmpeg.exe")
        matches = glob.glob(winget_pattern)
        if matches:
            return matches[0]

    return "ffmpeg"


FFMPEG_EXECUTABLE = find_ffmpeg()


async def prepare_audio():
    """Generates the speech audio file and pre-encodes to 48kHz stereo WAV for Discord."""
    # 1. Generate MP3 if missing
    if not os.path.exists(AUDIO_FILE_MP3):
        logger.info(f"Generating TTS audio file '{AUDIO_FILE_MP3}'...")
        if HAS_EDGE_TTS:
            try:
                communicate = edge_tts.Communicate(SPEECH_TEXT, TTS_VOICE)
                await communicate.save(AUDIO_FILE_MP3)
                logger.info("Generated high-quality Edge TTS audio successfully.")
            except Exception as e:
                logger.warning(f"Edge TTS failed ({e}), attempting gTTS fallback...")

        if not os.path.exists(AUDIO_FILE_MP3) and HAS_GTTS:
            try:
                tts = gTTS(text=SPEECH_TEXT, lang='en', slow=False)
                tts.save(AUDIO_FILE_MP3)
                logger.info("Generated gTTS audio fallback successfully.")
            except Exception as e:
                logger.error(f"gTTS failed: {e}")

    # 2. Pre-encode to 48kHz stereo 16-bit WAV with volume boost for crystal clear Discord transmission
    try:
        cmd = [
            FFMPEG_EXECUTABLE,
            "-y",
            "-i", AUDIO_FILE_MP3,
            "-ar", "48000",
            "-ac", "2",
            "-filter:a", "volume=2.2",
            AUDIO_FILE_WAV
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        logger.info(f"Pre-encoded audio to 48kHz stereo WAV '{AUDIO_FILE_WAV}' with +120% volume boost.")
    except Exception as e:
        logger.warning(f"Could not pre-encode to WAV ({e}), will use MP3 directly.")


def get_active_audio_path() -> str:
    if os.path.exists(AUDIO_FILE_WAV):
        return os.path.abspath(AUDIO_FILE_WAV)
    return os.path.abspath(AUDIO_FILE_MP3)


def has_humans(vc: discord.VoiceClient) -> bool:
    """Checks if there are non-bot users in the voice channel."""
    if not vc or not vc.channel:
        return False
    return any(not member.bot for member in vc.channel.members)


async def voice_playback_loop(guild_id: int):
    """
    Continuous background loop:
    - If humans in VC: plays speech in a loop.
    - If alone: waits silently until someone joins.
    """
    logger.info(f"Started voice playback loop for guild {guild_id}")
    try:
        while True:
            guild = bot.get_guild(guild_id)
            if not guild:
                break

            vc: Optional[discord.VoiceClient] = guild.voice_client
            if not vc or not vc.is_connected():
                logger.info(f"Voice client disconnected in guild {guild_id}. Ending loop.")
                break

            if has_humans(vc):
                if not vc.is_playing() and not vc.is_paused():
                    audio_path = get_active_audio_path()
                    if os.path.exists(audio_path):
                        done_event = asyncio.Event()

                        def after_playback(error):
                            if error:
                                logger.error(f"Playback error: {error}")
                            bot.loop.call_soon_threadsafe(done_event.set)

                        try:
                            source = discord.FFmpegPCMAudio(
                                audio_path,
                                executable=FFMPEG_EXECUTABLE
                            )
                            logger.info(f"Speaking text in VC '{vc.channel.name}'...")
                            vc.play(source, after=after_playback)

                            # Wait for audio to finish, with a 35s safety timeout
                            try:
                                await asyncio.wait_for(done_event.wait(), timeout=35.0)
                            except asyncio.TimeoutError:
                                logger.warning("Playback timeout reached, cycling loop.")

                        except Exception as e:
                            logger.error(f"Error starting audio play: {e}")
                            await asyncio.sleep(2)

                        # Natural pause between speech loops
                        await asyncio.sleep(2)
                    else:
                        logger.warning(f"Audio file '{audio_path}' missing. Regenerating...")
                        await prepare_audio()
                        await asyncio.sleep(3)
                else:
                    await asyncio.sleep(1)
            else:
                # Bot is alone in VC: stop playback and wait silently
                if vc.is_playing():
                    logger.info("Bot is alone in VC. Pausing audio until a member joins.")
                    vc.stop()
                await asyncio.sleep(2)

    except asyncio.CancelledError:
        logger.info(f"Voice loop cancelled for guild {guild_id}")
    except Exception as e:
        logger.error(f"Unexpected error in voice loop: {e}", exc_info=True)


def ensure_voice_loop(guild_id: int):
    """Ensures an active loop exists for the given guild."""
    current_task = guild_loops.get(guild_id)
    if current_task is None or current_task.done():
        guild_loops[guild_id] = asyncio.create_task(voice_playback_loop(guild_id))


@bot.event
async def on_ready():
    logger.info(f"====== MKVCBOT IS ONLINE ======")
    logger.info(f"Logged in as: {bot.user.name}#{bot.user.discriminator} (ID: {bot.user.id})")
    logger.info(f"Connected to {len(bot.guilds)} server(s): {[g.name for g in bot.guilds]}")
    logger.info(f"FFmpeg executable: {FFMPEG_EXECUTABLE}")
    await prepare_audio()
    logger.info("Ready to receive '@bot start' command from Server Admins.")


@bot.event
async def on_voice_state_update(member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
    """
    Monitors user movement in voice channels to start or pause speech automatically.
    """
    guild = member.guild
    vc: Optional[discord.VoiceClient] = guild.voice_client
    if not vc or not vc.channel:
        return

    # Check if this change happened in the bot's channel
    if before.channel == vc.channel or after.channel == vc.channel:
        if has_humans(vc):
            ensure_voice_loop(guild.id)
        else:
            if vc.is_playing():
                vc.stop()


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
        logger.warning(f"Ignored non-admin mention from {message.author.name}")
        return

    content_clean = message.content.lower().replace(f"<@{bot.user.id}>", "").replace(f"<@!{bot.user.id}>", "").strip()
    logger.info(f"Admin command received from {message.author.name}: '{content_clean}'")

    # Command: start
    if "start" in content_clean:
        if message.author.voice and message.author.voice.channel:
            target_channel = message.author.voice.channel
            logger.info(f"Joining voice channel: '{target_channel.name}'")
            vc: Optional[discord.VoiceClient] = message.guild.voice_client

            if vc and vc.is_connected():
                if vc.channel != target_channel:
                    await vc.move_to(target_channel)
            else:
                try:
                    vc = await target_channel.connect(reconnect=True, timeout=20.0)
                except Exception as e:
                    logger.error(f"Failed to connect to voice channel: {e}")
                    return

            ensure_voice_loop(message.guild.id)
        else:
            logger.warning(f"Admin {message.author.name} issued start but is not currently in a voice channel.")

    # Command: disconnect / diconnect
    elif "disconnect" in content_clean or "diconnect" in content_clean:
        vc: Optional[discord.VoiceClient] = message.guild.voice_client
        if vc and vc.is_connected():
            logger.info("Disconnecting from voice channel...")
            task = guild_loops.pop(message.guild.id, None)
            if task and not task.done():
                task.cancel()
            if vc.is_playing():
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
