# MKVCBot (MKTRADEZ Discord Voice Automation)

High-performance, secure Discord Voice Bot & Keep-Alive Ping Service tailored for **MKTRADEZ**.

---

## 🔒 Critical Security Notice
- **Never commit your `.env` or Discord Bot Token to any repository!**
- The `.gitignore` is pre-configured to block token leakage.
- Commands (`@bot start`, `@bot disconnect`) are restricted exclusively to server administrators (`administrator` permission). Non-admin attempts are completely ignored.
- **Token Rotation**: If your bot token was ever entered in an insecure chat or public channel, immediately visit the [Discord Developer Portal](https://discord.com/developers/applications) and click **Reset Token**.

---

## 🎙️ Features
1. **Intelligent VC Presence**:
   - Loops the MKTRADEZ speech continuously as long as at least 1 human is in the voice channel.
   - Automatically pauses/goes silent when all humans leave the VC.
   - Automatically resumes speech when someone joins the voice channel.
2. **Zero Text Clutter**:
   - Sends **no text messages** anywhere — 100% voice audio only.
3. **Admin Tag Commands**:
   - `@bot start`: Bot joins the voice channel of the administrator and starts the speech loop.
   - `@bot disconnect` (or `@bot diconnect`): Bot stops audio and leaves the voice channel.
4. **Vercel Keep-Alive Ping**:
   - Deployed on Vercel with a `/ping` endpoint for external monitoring.

---

## ⚙️ Discord Developer Portal Configuration
Ensure these settings are configured in your application:
1. Navigate to **Bot** -> **Privileged Gateway Intents**:
   - ✅ **Message Content Intent** (REQUIRED for tag commands)
   - ✅ **Server Members Intent**
2. In **OAuth2** -> **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions:
     - Connect
     - Speak
     - Use Voice Activity
     - Read Messages/View Channels
     - Send Messages (for gateway verification, though the bot sends no text)

---

## 🚀 Running the Bot 24/7

> **Important Architecture Note**: Vercel is a serverless platform designed for HTTP requests, not continuous UDP voice packet streaming. The Vercel deployment provides the `/ping` keep-alive endpoint. To keep the Discord bot connected to voice 24/7, run the bot container on a VPS, Railway, Render, or a local server.

### Option A: Running with Docker (Recommended)
```bash
# 1. Clone repository
git clone https://github.com/mkalgo1/mkvcbot.git
cd mkvcbot

# 2. Configure .env
cp .env.example .env
nano .env  # Add your DISCORD_BOT_TOKEN

# 3. Start with Docker Compose
docker compose up -d --build
```

### Option B: Running with Python Locally / VPS
```bash
# 1. Install FFmpeg
# On Ubuntu/Debian:
sudo apt install ffmpeg -y
# On Windows (via winget or choco):
winget install Gyan.FFmpeg

# 2. Install Python dependencies
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt

# 3. Start bot
python bot.py
```

---

## 🌐 Keep-Alive Ping URL
Ping your deployed Vercel URL with any monitoring service (UptimeRobot, Cron-Job.org):
- `GET https://<your-vercel-domain>/ping`
- `GET https://<your-vercel-domain>/api/index.py`
