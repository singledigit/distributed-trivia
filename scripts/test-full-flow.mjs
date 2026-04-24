/**
 * Full end-to-end test: create game, join, start, receive questions.
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
    setTimeout(() => reject(new Error('WS connect timeout')), 10000);
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
    ws.send(JSON.stringify({
      type: 'subscribe', id, channel,
      authorization: { 'x-api-key': API_KEY, host: HTTP_HOST },
    }));
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
    const timeout = setTimeout(() => {
      console.log('  Events so far:', events.map(e => e.type));
      reject(new Error(`Timeout waiting for ${type}`));
    }, timeoutMs);
    const check = () => {
      const found = events.find(e => e.type === type);
      if (found) { clearTimeout(timeout); resolve(found); }
      else setTimeout(check, 200);
    };
    check();
  });
}

async function main() {
  console.log('=== STEP 1: Create game ===');
  const ws = await createWS();
  const adminSub = await sub(ws, '/admin/default');
  
  let sessionId;
  const ackPromise = new Promise(resolve => {
    adminSub.on(event => {
      if (event.type === 'ack' && event.sessionId) {
        sessionId = event.sessionId;
        resolve(event);
      }
    });
  });

  await pub('/admin/default', [{ action: 'create', categoryId: CATEGORY_ID, mode: 'timed', timeLimitMinutes: 1 }]);
  await ackPromise;
  console.log(`✅ Session: ${sessionId}`);

  console.log('Waiting 3s for ODF to set up...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n=== STEP 2: Join ===');
  const playerWs = await createWS();
  
  // Subscribe to join channel AND game channel first
  const joinSub = await sub(playerWs, `/player/${sessionId}/join`);
  const gameSub = await sub(playerWs, `/game/${sessionId}`);
  
  const allPlayerEvents = [];
  const allGameEvents = [];
  gameSub.on(event => { console.log('[game]', event.type); allGameEvents.push(event); });

  let participantId;
  const joinPromise = new Promise(resolve => {
    joinSub.on(event => {
      if (event.type === 'joined') {
        participantId = event.participantId;
        resolve(event);
      }
    });
  });

  await pub(`/player/${sessionId}/join`, [{ action: 'join', displayName: 'TestBot' }]);
  await joinPromise;
  console.log(`✅ Joined as: ${participantId}`);

  // NOW subscribe to player-specific channel
  const playerSub = await sub(playerWs, `/player/${sessionId}/${participantId}`);
  playerSub.on(event => { console.log('[player]', event.type, JSON.stringify(event).substring(0, 100)); allPlayerEvents.push(event); });

  // Wait for join_ack (may have already been published — give it 10s)
  console.log('Waiting for join_ack (10s max)...');
  try {
    await waitForEvent(allPlayerEvents, 'join_ack', 10000);
    console.log('✅ Got join_ack');
  } catch {
    console.log('⚠️ Missed join_ack (POD was faster than our subscribe). Proceeding anyway.');
  }

  console.log('\n=== STEP 3: Start game ===');
  await pub(`/admin/${sessionId}`, [{ action: 'start' }]);

  // Wait for game_starting on player channel
  console.log('Waiting for game_starting (30s max)...');
  const gs = await waitForEvent(allPlayerEvents, 'game_starting', 30000);
  console.log('✅ game_starting:', JSON.stringify(gs));
  console.log('  startTime:', gs.startTime, '(type:', typeof gs.startTime, ')');
  console.log('  callbackToken:', gs.callbackToken ? 'present' : 'MISSING');
  console.log('  Date.parse:', new Date(gs.startTime).getTime());

  // Wait for countdown
  const startMs = new Date(gs.startTime).getTime();
  const waitMs = Math.max(0, startMs - Date.now()) + 1000;
  console.log(`Waiting ${Math.round(waitMs/1000)}s for countdown...`);
  await new Promise(r => setTimeout(r, waitMs));

  console.log('\n=== STEP 4: Send ready ===');
  await pub(`/player/${sessionId}/${participantId}`, [{ action: 'ready', callbackToken: gs.callbackToken }]);

  // Wait for first question
  console.log('Waiting for question (15s max)...');
  const q = await waitForEvent(allPlayerEvents, 'question', 15000);
  console.log('\n🎉 QUESTION:', q.questionText);
  console.log('  Options:', q.options);
  console.log('  Difficulty:', q.difficulty, 'Points:', q.points);

  console.log('\n✅ FULL FLOW WORKS!');
  ws.close();
  playerWs.close();
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ FAILED:', err.message);
  process.exit(1);
});
