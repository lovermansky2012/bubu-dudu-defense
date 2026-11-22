
const enc = new TextEncoder();

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'content-type': 'application/json' }
});

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

async function verify(initData, token) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const h = p.get('hash');
  if (!h) return null;
  p.delete('hash');

  const dcs = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const sk = await hmac(enc.encode('WebAppData'), token);

  if (hex(await hmac(sk, dcs)) !== h) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400 * 2) return null;

  try {
    return JSON.parse(p.get('user'));
  } catch {
    return null;
  }
}

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then((r) => r.json());

let ready = false;

async function init(db) {
  if (ready) return;

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS orders(
        nonce TEXT PRIMARY KEY,
        uid INTEGER,
        type TEXT,
        paid INTEGER DEFAULT 0,
        redeemed INTEGER DEFAULT 0,
        charge TEXT,
        ts INTEGER
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS scores(
        uid INTEGER,
        game TEXT,
        level INTEGER,
        name TEXT,
        score INTEGER,
        PRIMARY KEY(uid, game, level)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS users(
        uid INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        name TEXT,
        started_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        games_played INTEGER DEFAULT 0
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS broadcast_pending(
        admin_id INTEGER PRIMARY KEY,
        message_text TEXT,
        photo_file_id TEXT,
        created_at INTEGER NOT NULL
      )
    `)
  ]);

  ready = true;
}

const ADMIN_ID = 1087530024;

const PRODUCTS = {
  tower: {
    title: 'Extra Tower Slot',
    description: 'Place one more tower in this level'
  },
  revive: {
    title: 'Continue Playing',
    description: 'Come back with 3 lives'
  }
};

async function api(request, env, path) {
  await init(env.DB);

  if (path === '/api/webhook') {
    if (
      request.headers.get('x-telegram-bot-api-secret-token') !==
      env.WEBHOOK_SECRET
    ) {
      return json({ error: 'forbidden' }, 403);
    }

    const u = await request.json();

    if (u.pre_checkout_query) {
      const q = u.pre_checkout_query;
      const parts = String(q.invoice_payload || '').split(':');

      const row = await env.DB.prepare(
        'SELECT paid FROM orders WHERE nonce=?1 AND uid=?2'
      ).bind(parts[2], Number(parts[0])).first();

      const ok =
        !!row &&
        !row.paid &&
        q.currency === 'XTR' &&
        Number(parts[0]) === q.from.id;

      await tg(env, 'answerPreCheckoutQuery', ok
        ? { pre_checkout_query_id: q.id, ok: true }
        : {
            pre_checkout_query_id: q.id,
            ok: false,
            error_message: 'Order not found'
          });

    } else if (
      u.message &&
      u.message.chat &&
      u.message.from &&
      (u.message.text || u.message.photo)
    ) {
      const msg = u.message;
      const from = msg.from;
      const chatId = msg.chat.id;
      const isPrivate = msg.chat.type === 'private';
      const messageText = msg.text || '';
      const cmd = messageText.trim().split(/[\s@]/)[0].toLowerCase();
      const origin = new URL(request.url).origin;

      // Register private users only
      if (isPrivate) {
        const name = String(
          from.first_name || from.username || 'Player'
        ).slice(0, 50);

        const now = Date.now();

        await env.DB.prepare(`
          INSERT INTO users (uid, chat_id, name, started_at, last_seen)
          VALUES (?1, ?2, ?3, ?4, ?4)
          ON CONFLICT(uid) DO UPDATE SET
            chat_id = excluded.chat_id,
            name = excluded.name,
            last_seen = excluded.last_seen
        `).bind(from.id, chatId, name, now).run();
      }

      // Start and games commands
      if (cmd === '/start' || cmd === '/games') {
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: 'Welcome to Mocha Games! Tap Play to pick a game.',
          reply_markup: {
            inline_keyboard: [[
              { text: 'Play Games', web_app: { url: origin } }
            ]]
          }
        });

      // Top players
      } else if (cmd === '/top') {
        const rows = (
          await env.DB.prepare(`
            SELECT name, SUM(score) AS total
            FROM scores
            WHERE game='td'
            GROUP BY uid
            ORDER BY total DESC
            LIMIT 10
          `).all()
        ).results || [];

        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: rows.length
            ? 'Top players\n' + rows.map((r, i) =>
                `${i + 1}. ${r.name} - ${r.total}`
              ).join('\n')
            : 'No scores yet. Be the first!',
          reply_markup: {
            inline_keyboard: [[
              { text: 'Play Games', web_app: { url: origin } }
            ]]
          }
        });

      // Admin statistics
      } else if (cmd === '/stats') {
        if (from.id !== ADMIN_ID) {
          await tg(env, 'sendMessage', {
            chat_id: chatId,
            text: 'You are not authorized.'
          });
        } else {
          const totalUsers = await env.DB.prepare(
            'SELECT COUNT(*) AS total FROM users'
          ).first();

          const totalPlayers = await env.DB.prepare(
            'SELECT COUNT(DISTINCT uid) AS total FROM scores'
          ).first();

          const totalScores = await env.DB.prepare(
            'SELECT COUNT(*) AS total FROM scores'
          ).first();

          await tg(env, 'sendMessage', {
            chat_id: chatId,
            text:
              '📊 Mocha Games Statistics\n\n' +
              '👥 Total users: ' + totalUsers.total + '\n' +
              '🎮 Total players: ' + totalPlayers.total + '\n' +
              '🏆 Score records: ' + totalScores.total
          });
        }

      // Start broadcast preparation
      } else if (cmd === '/broadcast') {
        if (from.id !== ADMIN_ID) {
          await tg(env, 'sendMessage', {
            chat_id: chatId,
            text: 'You are not authorized.'
          });
        } else {
          await env.DB.prepare(`
            INSERT INTO broadcast_pending
              (admin_id, message_text, photo_file_id, created_at)
            VALUES (?1, NULL, NULL, ?2)
            ON CONFLICT(admin_id) DO UPDATE SET
              message_text = NULL,
              photo_file_id = NULL,
              created_at = excluded.created_at
          `).bind(ADMIN_ID, Date.now()).run();

          await tg(env, 'sendMessage', {
            chat_id: chatId,
            text:
              '📢 Broadcast mode started.\n\n' +
              'Now send me the message or photo you want to broadcast.\n\n' +
              'Use /cancel to cancel.'
          });
        }

      // Cancel broadcast
      } else if (cmd === '/cancel') {
        if (from.id !== ADMIN_ID) {
          await tg(env, 'sendMessage', {
            chat_id: chatId,
            text: 'You are not authorized.'
          });
        } else {
          const pending = await env.DB.prepare(
            'SELECT admin_id FROM broadcast_pending WHERE admin_id=?1'
          ).bind(ADMIN_ID).first();

          if (!pending) {
            await tg(env, 'sendMessage', {
              chat_id: chatId,
              text: 'There is no pending broadcast.'
            });
          } else {
            await env.DB.prepare(
              'DELETE FROM broadcast_pending WHERE admin_id=?1'
            ).bind(ADMIN_ID).run();

            await tg(env, 'sendMessage', {
              chat_id: chatId,
              text: '❌ Broadcast cancelled.'
            });
          }
        }

      // Confirm and send broadcast
      } else if (cmd === '/confirm') {
        if (from.id !== ADMIN_ID) {
          await tg(env, 'sendMessage', {
            chat_id: chatId,
            text: 'You are not authorized.'
          });
        } else {
          const pending = await env.DB.prepare(
            'SELECT * FROM broadcast_pending WHERE admin_id=?1'
          ).bind(ADMIN_ID).first();

          if (
            !pending ||
            (!pending.message_text && !pending.photo_file_id)
          ) {
            await tg(env, 'sendMessage', {
              chat_id: chatId,
              text: 'No broadcast message is ready. Use /broadcast first.'
            });
          } else {
            await tg(env, 'sendMessage', {
              chat_id: chatId,
              text: '📤 Broadcast started. Please wait...'
            });

            const recipients = (
              await env.DB.prepare(
                'SELECT uid, chat_id FROM users WHERE chat_id = uid'
              ).all()
            ).results || [];

            let sent = 0;
            let failed = 0;

            for (const recipient of recipients) {
              try {
                const result = pending.photo_file_id
                  ? await tg(env, 'sendPhoto', {
                      chat_id: recipient.chat_id,
                      photo: pending.photo_file_id,
                      caption: pending.message_text || undefined
                    })
                  : await tg(env, 'sendMessage', {
                      chat_id: recipient.chat_id,
                      text: pending.message_text
                    });

                if (result && result.ok) {
                  sent++;
                } else {
                  failed++;
                }
              } catch {
                failed++;
              }
            }

            await env.DB.prepare(
              'DELETE FROM broadcast_pending WHERE admin_id=?1'
            ).bind(ADMIN_ID).run();

            await tg(env, 'sendMessage', {
              chat_id: chatId,
              text:
                '✅ Broadcast finished!\n\n' +
                '👥 Total recipients: ' + recipients.length + '\n' +
                '✅ Successfully sent: ' + sent + '\n' +
                '❌ Failed: ' + failed
            });
          }
        }

      // Save broadcast draft
      } else if (isPrivate && from.id === ADMIN_ID) {
        const pending = await env.DB.prepare(
          'SELECT admin_id FROM broadcast_pending WHERE admin_id=?1'
        ).bind(ADMIN_ID).first();

        if (pending) {
          let text = null;
          let photoId = null;

          if (msg.photo && msg.photo.length) {
            photoId = msg.photo[msg.photo.length - 1].file_id;
            text = msg.caption || null;
          } else if (msg.text && !cmd.startsWith('/')) {
            text = msg.text;
          }

          if (text || photoId) {
            await env.DB.prepare(`
              UPDATE broadcast_pending
              SET message_text=?1, photo_file_id=?2, created_at=?3
              WHERE admin_id=?4
            `).bind(text, photoId, Date.now(), ADMIN_ID).run();

            await tg(env, 'sendMessage', {
              chat_id: chatId,
              text:
                '📝 Broadcast preview saved.\n\n' +
                (photoId ? '📷 Photo attached\n' : '') +
                (text ? 'Message:\n' + text + '\n\n' : '') +
                'To send to all registered users, type /confirm\n' +
                'To cancel, type /cancel'
            });
          } else {
            await tg(env, 'sendMessage', {
              chat_id: chatId,
              text: 'Please send a text message or a photo.'
            });
          }
        }
      }

    } else if (u.message && u.message.successful_payment) {
      const sp = u.message.successful_payment;
      const parts = String(sp.invoice_payload || '').split(':');

      if (Number(parts[0]) === u.message.from.id) {
        await env.DB.prepare(
          'UPDATE orders SET paid=1, charge=?1 WHERE nonce=?2 AND uid=?3 AND paid=0'
        ).bind(
          sp.telegram_payment_charge_id,
          parts[2],
          Number(parts[0])
        ).run();
      }
    }

    return json({ ok: true });
  }

  const body = await request.json().catch(() => ({}));
  const user = await verify(body.initData, env.BOT_TOKEN);

  if (!user) return json({ error: 'auth' }, 401);

  if (path === '/api/invoice') {
    const p = PRODUCTS[body.item];
    if (!p) return json({ error: 'item' }, 400);

    const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    const r = await tg(env, 'createInvoiceLink', {
      title: p.title,
      description: p.description,
      payload: `${user.id}:${body.item}:${nonce}`,
      currency: 'XTR',
      prices: [{ label: p.title, amount: 1 }]
    });

    if (!r.ok) {
      return json({ error: 'telegram', detail: r.description }, 502);
    }

    await env.DB.prepare(
      'INSERT INTO orders(nonce, uid, type, ts) VALUES(?1, ?2, ?3, ?4)'
    ).bind(nonce, user.id, body.item, Date.now()).run();

    return json({ link: r.result });
  }

  if (path === '/api/consume') {
    const r = await env.DB.prepare(`
      UPDATE orders
      SET redeemed=1
      WHERE nonce=(
        SELECT nonce FROM orders
        WHERE uid=?1 AND type=?2 AND paid=1 AND redeemed=0
        ORDER BY ts LIMIT 1
      )
    `).bind(user.id, String(body.item)).run();

    return json({ ok: (r.meta && r.meta.changes) === 1 });
  }

  if (path === '/api/score') {
    const level = Math.floor(body.level);
    const score = Math.floor(body.score);
    const game = String(body.game || 'td').slice(0, 20);

    if (
      !(level >= 1 && level <= 50) ||
      !(score >= 0 && score <= 200000)
    ) {
      return json({ error: 'range' }, 400);
    }

    const name = String(
      user.first_name || user.username || 'Player'
    ).slice(0, 24);

    await env.DB.prepare(`
      INSERT INTO scores(uid, game, level, name, score)
      VALUES(?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(uid, game, level)
      DO UPDATE SET
        score=MAX(score, excluded.score),
        name=excluded.name
    `).bind(user.id, game, level, name, score).run();

    return json({ ok: true });
  }

  if (path === '/api/leaderboard') {
    const game = String(body.game || 'td').slice(0, 20);

    const top = (
      await env.DB.prepare(`
        SELECT name, SUM(score) AS total
        FROM scores
        WHERE game=?1
        GROUP BY uid
        ORDER BY total DESC
        LIMIT 10
      `).bind(game).all()
    ).results || [];

    const mine = await env.DB.prepare(
      'SELECT SUM(score) AS t FROM scores WHERE uid=?1 AND game=?2'
    ).bind(user.id, game).first();

    const t = (mine && mine.t) || 0;

    const rk = await env.DB.prepare(`
      SELECT COUNT(*) AS c
      FROM (
        SELECT uid FROM scores
        WHERE game=?1
        GROUP BY uid
        HAVING SUM(score) > ?2
      )
    `).bind(game, t).first();

    return json({
      top: top.map((r) => ({ n: r.name, s: r.total })),
      me: t ? { rank: ((rk && rk.c) || 0) + 1, s: t } : null
    });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    if (path === '/api/setup') {
      const url = new URL(request.url);

      if (
        !env.WEBHOOK_SECRET ||
        url.searchParams.get('key') !== env.WEBHOOK_SECRET
      ) {
        return json({ error: 'wrong key' }, 403);
      }

      const out = {};

      out.webhook = await tg(env, 'setWebhook', {
        url: url.origin + '/api/webhook',
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'pre_checkout_query']
      });

      out.menu = await tg(env, 'setChatMenuButton', {
        menu_button: {
          type: 'web_app',
          text: 'Play',
          web_app: { url: url.origin }
        }
      });

      out.commands = await tg(env, 'setMyCommands', {
        commands: [
          { command: 'start', description: 'Open the games' },
          { command: 'games', description: 'Choose a game' },
          { command: 'top', description: 'Top players' },
          { command: 'stats', description: 'Admin statistics' },
          { command: 'broadcast', description: 'Prepare a broadcast' },
          { command: 'confirm', description: 'Confirm broadcast' },
          { command: 'cancel', description: 'Cancel broadcast' }
        ]
      });

      out.description = await tg(env, 'setMyDescription', {
        description: 'Cute games you can play right inside Telegram. Tap Start to play!'
      });

      return json(out);
    }

    if (path.startsWith('/api/')) {
      if (request.method !== 'POST') {
        return json({ error: 'method' }, 405);
      }

      try {
        return await api(request, env, path);
      } catch (e) {
        return json({
          error: 'server',
          detail: String(e).slice(0, 200)
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
