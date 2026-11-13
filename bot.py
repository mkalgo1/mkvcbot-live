"""
MKVCBot - Discord Voice Bot for MKTRADEZ
- Speaks high-impact Order Flow / Option Flow audio message in VC.
- Loops continuously as long as human members are present in the channel.
- Goes silent when alone in the VC; automatically resumes when someone joins.
- Tagged commands: @bot start, @bot disconnect (or @bot diconnect).
- Strictly admin-only (Administrator permission required).
- Completely silent in text (sends zero text messages).
"""

import os
import asyncio
import logging
from typing import Optional
import discord
from discord.ext import commands
from dotenv import load_dotenv

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

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("MKVCBot")

# Load environment variables
load_dotenv()
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
TTS_VOICE = os.getenv("TTS_VOICE", "en-US-ChristopherNeural")
AUDIO_FILE = os.getenv("AUDIO_FILE", "mktradez_speech.mp3")

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


async def generate_speech_file():
    """Generates the speech audio file if it doesn't already exist."""
    if os.path.exists(AUDIO_FILE):
        logger.info(f"Audio file '{AUDIO_FILE}' already exists. Using cached audio.")
        return

    logger.info(f"Generating TTS audio file '{AUDIO_FILE}'...")
    if HAS_EDGE_TTS:
        try:
            communicate = edge_tts.Communicate(SPEECH_TEXT, TTS_VOICE)
            await communicate.save(AUDIO_FILE)
            logger.info("Generated high-quality Edge TTS audio successfully.")
            return
        except Exception as e:
            logger.warning(f"Edge TTS failed ({e}), attempting gTTS fallback...")

    if HAS_GTTS:
        try:
            tts = gTTS(text=SPEECH_TEXT, lang='en', slow=False)
            tts.save(AUDIO_FILE)
            logger.info("Generated gTTS audio fallback successfully.")
            return
        except Exception as e:
            logger.error(f"gTTS also failed: {e}")

    logger.warning("No TTS engine available or generation failed. Ensure audio file exists or install edge-tts/gTTS.")


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
                    if os.path.exists(AUDIO_FILE):
                        done_event = asyncio.Event()

                        def after_playback(error):
                            if error:
                                logger.error(f"Playback error: {error}")
                            bot.loop.call_soon_threadsafe(done_event.set)

                        try:
                            source = discord.FFmpegPCMAudio(
                                AUDIO_FILE,
                                options='-filter:a "volume=1.0"'
                            )
                            vc.play(source, after=after_playback)
                            await done_event.wait()
                        except Exception as e:
                            logger.error(f"Error during audio play: {e}")
                            await asyncio.sleep(2)

                        # Small pause between loops to sound natural
                        await asyncio.sleep(2)
                    else:
                        logger.warning(f"Audio file '{AUDIO_FILE}' missing. Regenerating...")
                        await generate_speech_file()
                        await asyncio.sleep(3)
                else:
                    await asyncio.sleep(1)
            else:
                # Bot is alone in VC: stop playback and wait silently
                if vc.is_playing():
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
    logger.info(f"Bot connected successfully as {bot.user} (ID: {bot.user.id})")
    await generate_speech_file()


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
    Strictly Administrator-only.
    Zero text response sent (voice-only bot).
    """
    if message.author.bot or not message.guild:
        return

    # Check if the bot was mentioned
    if bot.user not in message.mentions:
        return

    # STRICT SECURITY CHECK: Must have Administrator permission
    if not message.author.guild_permissions.administrator:
        # Non-admin: silently ignore to prevent unauthorized use
        return

    content_clean = message.content.lower().replace(f"<@{bot.user.id}>", "").replace(f"<@!{bot.user.id}>", "").strip()

    # Command: start
    if "start" in content_clean:
        if message.author.voice and message.author.voice.channel:
            target_channel = message.author.voice.channel
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

    # Command: disconnect / diconnect
    elif "disconnect" in content_clean or "diconnect" in content_clean:
        vc: Optional[discord.VoiceClient] = message.guild.voice_client
        if vc and vc.is_connected():
            task = guild_loops.pop(message.guild.id, None)
            if task and not task.done():
                task.cancel()
            if vc.is_playing():
                vc.stop()
            await vc.disconnect()


if __name__ == "__main__":
    if not BOT_TOKEN:
        logger.error("DISCORD_BOT_TOKEN environment variable is missing! Check .env file.")
        exit(1)

    try:
        bot.run(BOT_TOKEN)
    except Exception as e:
        logger.critical(f"Failed to start bot: {e}")
