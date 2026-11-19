const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '9262415683:AAFUlsT0qeg0yfbbSpN5k6IG-AOzd-runOU';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const chatsFilePath = path.join(__dirname, 'telegram_chats.json');

let registeredChats = new Set(['2140565223']);
let isPolling = false;
let lastDisconnectAlert = 0;
let lastReconnectAlert = 0;

function loadChats() {
  try {
    if (fs.existsSync(chatsFilePath)) {
      const data = JSON.parse(fs.readFileSync(chatsFilePath, 'utf8'));
      if (Array.isArray(data)) {
        data.forEach(id => registeredChats.add(String(id)));
      }
    }
  } catch (e) {
    console.error('[Telegram] Error reading chats file:', e.message);
  }
}

function saveChats() {
  try {
    fs.writeFileSync(chatsFilePath, JSON.stringify([...registeredChats], null, 2), 'utf8');
  } catch (e) {
    console.error('[Telegram] Error saving chats file:', e.message);
  }
}

loadChats();
saveChats();

async function sendMessage(chatId, text, extra = {}) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...extra
      })
    });
    const data = await res.json();
    if (!data.ok) {
      // Fallback to plain text if HTML tags cause parse error
      const fallbackRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/<[^>]*>/g, ''),
          ...extra
        })
      });
      return await fallbackRes.json();
    }
    return data;
  } catch (err) {
    console.error(`[Telegram] Failed to send message to ${chatId}:`, err.message);
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text
      })
    });
  } catch (err) {}
}

// Single debounced notification to avoid spamming
async function notifyDisconnect(channelName) {
  const now = Date.now();
  if (now - lastDisconnectAlert < 60000) {
    return; // Throttle to max 1 alert per minute
  }
  lastDisconnectAlert = now;

  const msg = `⚠️ <b>MKVCBot Disconnected!</b>\n\n` +
    `• <b>Channel:</b> ${channelName}\n` +
    `🔄 <i>Auto-reconnecting now... (or send /wake)</i>`;

  for (const chatId of registeredChats) {
    await sendMessage(chatId, msg);
  }
}

async function notifyReconnect(channelName) {
  const now = Date.now();
  if (now - lastReconnectAlert < 30000) {
    return;
  }
  lastReconnectAlert = now;

  const msg = `✅ <b>MKVCBot Auto-Reconnected!</b>\n\n` +
    `Now live and streaming audio in <b>${channelName}</b>!`;

  for (const chatId of registeredChats) {
    await sendMessage(chatId, msg);
  }
}

function registerChat(chatId) {
  const strId = String(chatId);
  if (!registeredChats.has(strId)) {
    registeredChats.add(strId);
    saveChats();
    console.log(`[Telegram] Registered new chat ID: ${strId}`);
  }
}

async function startPolling(callbacks = {}) {
  if (isPolling) return;
  isPolling = true;

  console.log('[Telegram] Starting Telegram bot listener...');
  let offset = 0;

  while (isPolling) {
    try {
      const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${offset}&timeout=20`);
      const data = await res.json();

      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          // 1. Handle Inline Button Clicks (1 single clean response)
          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message?.chat?.id;
            const dataAction = cb.data;

            if (chatId) registerChat(chatId);

            if (dataAction && dataAction.startsWith('join_')) {
              const targetChannelId = dataAction.replace('join_', '');
              await answerCallbackQuery(cb.id, 'Connecting...');

              if (callbacks.onSelectChannel) {
                try {
                  const result = await callbacks.onSelectChannel(targetChannelId);
                  if (result && result.success) {
                    await sendMessage(chatId, `✅ <b>Joined!</b> MKVCBot switched to <b>${result.channelName}</b> and is streaming audio!`);
                  } else {
                    await sendMessage(chatId, `❌ Could not join: ${result?.message || 'Error connecting'}`);
                  }
                } catch (e) {
                  await sendMessage(chatId, `❌ Error: ${e.message}`);
                }
              }
            } else {
              await answerCallbackQuery(cb.id);
            }
            continue;
          }

          // 2. Handle Text Messages
          const msg = update.message;
          if (!msg || !msg.text) continue;

          const chatId = msg.chat.id;
          registerChat(chatId);

          const text = msg.text.trim();
          const lower = text.toLowerCase();

          // Command: /start or /help
          if (lower.startsWith('/start') || lower.startsWith('/help')) {
            const welcome = `👋 <b>Welcome to Discord Waker Bot!</b>\n\n` +
              `This bot manages the <b>MKTRADEZ Discord Voice Bot</b>.\n\n` +
              `<b>Available Commands:</b>\n` +
              `▶ <b>/wake</b> — Force Discord bot to re-join the active voice channel and stream audio loop.\n` +
              `📋 <b>/channel</b> — List all voice channels in the server and select which one to join.\n` +
              `📊 <b>/status</b> — Check live voice and stream status.\n` +
              `⏹ <b>/disconnect</b> — Order Discord bot to leave voice channel.\n\n` +
              `🔔 <i>You will receive an alert if the bot disconnects.</i>`;
            await sendMessage(chatId, welcome);

          // Command: /channel or /channels
          } else if (lower.startsWith('/channel') || lower.startsWith('/channels')) {
            const parts = text.split(/\s+/);
            
            if (parts.length > 1 && /^\d+$/.test(parts[1])) {
              const explicitChannelId = parts[1];
              if (callbacks.onSelectChannel) {
                const result = await callbacks.onSelectChannel(explicitChannelId);
                if (result && result.success) {
                  await sendMessage(chatId, `✅ <b>Joined!</b> Streaming in <b>${result.channelName}</b>!`);
                } else {
                  await sendMessage(chatId, `❌ Failed to join channel: ${result?.message || 'Not found'}`);
                }
              }
              continue;
            }

            if (callbacks.getVoiceChannels) {
              try {
                const channels = await callbacks.getVoiceChannels();
                if (!channels || channels.length === 0) {
                  await sendMessage(chatId, `⚠️ No voice channels found.`);
                  continue;
                }

                const keyboard = channels.map(c => {
                  const prefix = c.isCurrent ? '🟢 ' : (c.type === 'Stage' ? '🎭 ' : '🔊 ');
                  return [
                    {
                      text: `${prefix}${c.name}`,
                      callback_data: `join_${c.id}`
                    }
                  ];
                });

                const menuText = `📋 <b>Select a Discord Voice Channel:</b>\n` +
                  `Tap below to switch channel instantly (🟢 = active):`;

                await sendMessage(chatId, menuText, {
                  reply_markup: {
                    inline_keyboard: keyboard
                  }
                });
              } catch (e) {
                await sendMessage(chatId, `❌ Error fetching channels: ${e.message}`);
              }
            }

          // Command: /wake (1 single response)
          } else if (lower.startsWith('/wake')) {
            if (callbacks.onWake) {
              try {
                const result = await callbacks.onWake(chatId);
                if (result && result.success) {
                  await sendMessage(chatId, `✅ <b>Success!</b> Discord bot is connected and streaming in <b>${result.channelName || 'the VC'}</b>!`);
                } else {
                  await sendMessage(chatId, `⚠️ Reconnect initiated: ${result?.message || 'Handshake in progress...'}`);
                }
              } catch (e) {
                await sendMessage(chatId, `❌ Error: ${e.message}`);
              }
            }

          // Command: /status or /statu (1 single response)
          } else if (lower.startsWith('/status') || lower.startsWith('/statu')) {
            let statusText = '🔍 Checking status...';
            try {
              if (callbacks.getStatus) {
                const s = callbacks.getStatus();
                statusText = `📊 <b>MKVCBot Status Report:</b>\n\n` +
                  `• <b>Discord Client:</b> ${s.clientReady ? '🟢 Online' : '🔴 Offline'}\n` +
                  `• <b>Voice Connection:</b> ${s.inVoice ? '🟢 Connected' : '🔴 Disconnected'}\n` +
                  `• <b>Active Channel:</b> <code>${s.channelName || s.channelId || 'None'}</code>\n` +
                  `• <b>Audio Stream:</b> ${s.streaming ? '🔊 Active (Infinite Loop)' : '⏹ Idle / Inactive'}\n` +
                  (s.reconnecting ? `• <b>Auto-Reconnect:</b> ⏳ Reconnecting now...\n` : '');
              }
            } catch (e) {
              statusText = `❌ Error checking status: ${e.message}`;
            }
            await sendMessage(chatId, statusText);

          // Command: /disconnect (1 single response)
          } else if (lower.startsWith('/disconnect')) {
            try {
              if (callbacks.onDisconnect) {
                await callbacks.onDisconnect();
              }
              await sendMessage(chatId, `⏹ <b>Discord bot disconnected.</b>\nSend <b>/wake</b> whenever you want the bot back in.`);
            } catch (e) {
              await sendMessage(chatId, `❌ Error: ${e.message}`);
            }

          // Fallback
          } else {
            await sendMessage(chatId, `Unknown command: <code>${text}</code>\n\nAvailable commands:\n▶ <b>/wake</b> — Rejoin active VC\n📋 <b>/channel</b> — List & choose voice channel\n📊 <b>/status</b> — Check bot status\n⏹ <b>/disconnect</b> — Leave voice channel`);
          }
        }
      }
    } catch (err) {
      console.error('[Telegram] Polling error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

module.exports = {
  notifyDisconnect,
  notifyReconnect,
  sendMessage,
  startPolling,
  registeredChats
};
