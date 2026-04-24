/**
 * Test: create game, join, start, then cancel mid-game.
 */
import WebSocket from 'ws';

const HTTP_ENDPOINT = 'https://agijjkkqb5fzjgkszjuuitjmi4.appsync-api.us-west-2.amazonaws.com/event';
const REALTIME_ENDPOINT = 'wss://agijjkkqb5fzjgkszjuuitjmi4.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime';
const API_KEY = 'da2-ziregpigtjeshizbrljommh35i';
const HTTP_HOST = new URL(HTTP_ENDPOINT).host;
const CATEGORY_ID = '01KQ0DA0K95M6WXKYQ6BRJWP5Q';

function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function parseEvent(event) {
  if (typeof event === 'string') try { event = JSON.parse(event); } catch {}
  if (typeof event === 'string') try { event = JSON.parse(event); } catch {}
  return event;
}

const authProtocol = `header-${base64UrlEncode(JSON.stringify({ host: HTTP_HOST, 'x-api-key': API_KEY }))}`;

function createWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(REALTIME_ENDPOINT, [authProtocol, 'aws-appsync-event-ws']);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connection_ack') resolve(ws);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
}

function sub(ws, channel) {
  return new Promise((resolve) => {
    const id = `sub-${Math.random().toString(36).slice(2)}`;
    const callbacks = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe_success' && msg.id === id) resolve({ id, on: (cb) => callbacks.push(cb) });
      if (msg.type === 'data' && msg.id === id) {
        const event = parseEvent(msg.event);
        for (const cb of callbacks) cb(event);
      }
    });
    ws.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: { 'x-api-key': API_KEY, host: HTTP_HOST } }));
  });
}

async function pub(channel, events) {
  const res = await fetch(HTTP_ENDPOINT, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, events: events.map(e => JSON.stringify(e)) }),
  });
  return res.json();
}

function waitForEvent(events, type, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const check = () => {
      const found = events.find(e => e.type === type);
      if (found) { clearTimeout(timeout); resolve(found); }
      else setTimeout(check, 200);
    };
    check();
  });
}

async function main() {
  const testMode = process.argv[2] || 'cancel'; // 'cancel' or 'timeout'
  console.log(`\n=== TEST: ${testMode.toUpperCase()} ===\n`);

  // Create game (1 min timed)
  const ws = await createWS();
  const adminSub = await sub(ws, '/admin/default');
  const adminEvents = [];
  adminSub.on(e => adminEvents.push(e));

  await pub('/admin/default', [{ action: 'create', categoryId: CATEGORY_ID, mode: 'timed', timeLimitMinutes: 1 }]);
  const ack = await waitForEvent(adminEvents, 'ack');
  const sessionId = ack.sessionId;
  console.log(`Session: ${sessionId}`);

  await new Promise(r => setTimeout(r, 3000));

  // Join
  const playerWs = await createWS();
  const joinSub = await sub(playerWs, `/player/${sessionId}/join`);
  const joinEvents = [];
  joinSub.on(e => joinEvents.push(e));

  await pub(`/player/${sessionId}/join`, [{ action: 'join', displayName: 'CancelBot' }]);
  const joined = await waitForEvent(joinEvents, 'joined');
  const pid = joined.participantId;
  console.log(`Joined as: ${pid}`);

  const playerSub = await sub(playerWs, `/player/${sessionId}/${pid}`);
  const gameSub = await sub(playerWs, `/game/${sessionId}`);
  const playerEvents = [];
  const gameEvents = [];
  playerSub.on(e => { console.log(`  [player] ${e.type}`); playerEvents.push(e); });
  gameSub.on(e => { console.log(`  [game] ${e.type}`); gameEvents.push(e); });

  // Wait for join_ack
  try { await waitForEvent(playerEvents, 'join_ack', 10000); } catch { console.log('  (missed join_ack)'); }

  // Start game
  console.log('\nStarting game...');
  await pub(`/admin/${sessionId}`, [{ action: 'start' }]);

  // Wait for game_starting
  const gs = await waitForEvent(playerEvents, 'game_starting', 30000);
  console.log(`Game starting at: ${gs.startTime}`);

  // Wait for countdown
  const waitMs = Math.max(0, new Date(gs.startTime).getTime() - Date.now()) + 1000;
  await new Promise(r => setTimeout(r, waitMs));

  // Send ready
  await pub(`/player/${sessionId}/${pid}`, [{ action: 'ready', callbackToken: gs.callbackToken }]);
  console.log('Sent ready');

  // Wait for first question
  await waitForEvent(playerEvents, 'question', 15000);
  console.log('Got first question');

  if (testMode === 'cancel') {
    // Cancel after 5 seconds
    console.log('\nWaiting 5s then cancelling...');
    await new Promise(r => setTimeout(r, 5000));

    console.log('Sending cancel...');
    const cancelResult = await pub(`/admin/${sessionId}`, [{ action: 'cancel' }]);
    console.log('Cancel publish result:', JSON.stringify(cancelResult));

    // Wait for game_cancelled on game channel
    try {
      const cancelled = await waitForEvent(gameEvents, 'game_cancelled', 15000);
      console.log('\n✅ CANCEL WORKS! Got game_cancelled:', JSON.stringify(cancelled));
    } catch {
      console.log('\n❌ No game_cancelled received');
      console.log('Game events:', gameEvents.map(e => e.type));
    }
  } else {
    // Timeout mode — wait for times_up (1 minute)
    console.log('\nWaiting for times_up (up to 90s)...');
    try {
      const timesUp = await waitForEvent(gameEvents, 'times_up', 90000);
      console.log('\n✅ TIMEOUT WORKS! Got times_up:', JSON.stringify(timesUp));
    } catch {
      console.log('\n❌ No times_up received');
      console.log('Game events:', gameEvents.map(e => e.type));
    }
  }

  ws.close();
  playerWs.close();
  process.exit(0);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
