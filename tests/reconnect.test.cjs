const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const plain = value => JSON.parse(JSON.stringify(value));

// Real message dispatch, box management, modes, LEDs and timers. Only browser,
// network and persistence boundaries are replaced; no hardware is contacted.
function fixture() {
  const sent = [], cache = new Map(), fields = new Map(), timeouts = [];
  let now = 1000;
  const noop = () => {};
  class Clock extends Date { static now() { return now; } }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send(json) { sent.push(JSON.parse(json)); }
  }
  const render = () => { load('src/timers.ts').updateTurnTimers(); load('src/leds.ts').syncLeds(); };
  const stubs = {
    'src/render.ts': { render, scheduleRender: render, renderBoxes: noop, renderTableLabel: noop },
    'src/logger.ts': { log: noop, setStatus: noop },
    'src/persist.ts': { applyPendingPersistedBox: noop, updateResumeBtnState: noop, persistState: noop },
    'src/graphs.ts': { prevGameStats: null },
    'src/expansions.ts': { renderExpansionUI: noop },
    'src/github-config.ts': { loadGitHubConfig: () => null },
    'src/guided-phase.ts': { isGuidedPhaseActive: () => false },
  };
  const real = new Set(['state', 'boxes', 'websockets', 'leds', 'timers', 'countdown', 'currentGame', 'game',
    'modes/ti', 'modes/eclipse', 'modes/helpers'].map(name => `src/${name}.ts`));
  function load(filename) {
    if (stubs[filename]) return stubs[filename];
    if (cache.has(filename)) return cache.get(filename);
    if (!real.has(filename)) return new Proxy({}, { get: () => noop });
    const exports = {};
    cache.set(filename, exports);
    const context = {
      exports, Date: Clock, WebSocket: Socket, setTimeout: fn => timeouts.push(fn), clearTimeout: noop,
      localStorage: { getItem: () => null },
      document: { getElementById: id => {
        if (!fields.has(id)) fields.set(id, { value: id === 'hub-address' ? 'dummy:8765' : 'p0',
          checked: false, style: {}, querySelectorAll: () => [] });
        return fields.get(id);
      } },
      require: name => load(path.posix.normalize(path.posix.join(path.posix.dirname(filename), name)) + '.ts'),
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, context, { filename });
    return exports;
  }
  const state = load('src/state.ts').state;
  state.factions = JSON.parse(fs.readFileSync('public/factions.json', 'utf8'));
  state.gameActive = true;
  state.gameMode = 'ti';
  state.hubHwid = 'p0';
  state.boxOrder = ['p0', 'p1', 'p2'];
  state.boxOrder.forEach((id, i) => {
    state.boxes[id] = { hwid: id, isVirtual: false, factionId: ['firmament', 'ralnelconsortium', 'lastbastion'][i], status: 'idle' };
  });
  const ws = load('src/websockets.ts');
  ws.connect();
  const mode = new (load('src/modes/ti.ts').TwilightImperiumMode)();
  load('src/currentGame.ts').setCurrentGame(mode);
  mode.start();
  state.boxOrder.forEach((id, i) => {
    state.ti.players[id].strategyCards = [{ id: ['leadership', 'trade', 'politics'][i], label: 'Strategy', color: '#123456', initiative: i + 1, used: false }];
  });
  mode.startActionPhase();
  render();
  sent.length = 0;
  const reconnect = (id = 'p0', version = '3.5.0') => ws.handleMessage({ type: 'connected', hwid: id, version });
  const commands = id => sent.filter(msg => msg.hwid === id);
  return { state, mode, ws, load, sent, reconnect, commands, render, advance: ms => { now += ms; },
    runTimeouts: () => { for (const fn of timeouts.splice(0)) fn(); } };
}

test('agenda speaker sends blue/white alternating LEDs within the ESP-NOW packet limit', () => {
  const f = fixture();
  f.mode.startAgendaPhase();
  f.reconnect('p0');
  const cmd = f.commands('p0').findLast(msg => msg.type.startsWith('led_') && msg.type !== 'led_brightness');
  assert.equal(cmd.type, 'led_alternate_pair');
  assert.deepEqual([cmd.a, cmd.b], ['#4444ff', '#ffffff']);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...cmd, hwid: 'AA:BB:CC:DD:EE:FF' })) <= 250);
  assert.deepEqual(plain(f.load('src/leds.ts').ledCommandToArray(cmd)),
    Array.from({ length: 24 }, (_, i) => i % 4 < 2 ? '#4444ff' : '#ffffff'));
});

for (const version of ['3.5.1', '3.6.0', '4.0.0']) test(`agenda speaker uses compact 3:1 sectors on firmware ${version}`, () => {
  const f = fixture();
  f.mode.startAgendaPhase(); f.reconnect('p0', version);
  const cmd = f.commands('p0').findLast(msg => msg.type.startsWith('led_') && msg.type !== 'led_brightness');
  assert.equal(cmd.type, 'led_sectors');
  assert.equal(cmd.repeat, true);
  assert.deepEqual(plain(cmd.sectors), [{ color: '#ffffff', count: 1 }, { color: '#4444ff', count: 3 }]);
  assert.equal(Buffer.byteLength(JSON.stringify({ ...cmd, hwid: 'AA:BB:CC:DD:EE:FF' })), 135);
  assert.deepEqual(plain(f.load('src/leds.ts').ledCommandToArray(cmd)),
    Array.from({ length: 24 }, (_, i) => i % 4 === 0 ? '#ffffff' : '#4444ff'));
});

test('mixed firmware versions select speaker patterns per box and keep scan flashes compact', () => {
  const f = fixture();
  f.reconnect('p0', '3.5.0'); f.reconnect('p1', '3.5.1');
  const leds = f.load('src/leds.ts');
  for (const [id, type] of [['p0', 'led_alternate_pair'], ['p1', 'led_sectors']]) {
    f.mode.activatePlayer(id); f.render(); f.sent.length = 0;
    f.mode.onRfid(id, 'ti', 'token', 'speaker');
    const flash = f.commands(id).find(msg => msg.type === type);
    assert.ok(flash, `expected ${type} for ${id}`);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...flash, hwid: 'AA:BB:CC:DD:EE:FF' })) <= 250);
    assert.ok(leds.ledCommandToArray(flash).includes('#ff0000'));
    if (type === 'led_sectors') {
      assert.deepEqual(plain(leds.ledCommandToArray(flash)),
        Array.from({ length: 24 }, (_, i) => i % 4 === 0 ? '#ffffff' : '#ff0000'));
    }
  }
});

test('reconnect uses announced firmware before restoring LEDs after an upgrade or downgrade', () => {
  const f = fixture();
  f.mode.startAgendaPhase();
  for (const [version, expected] of [['3.5.1', 'led_sectors'], ['3.5.0', 'led_alternate_pair']]) {
    f.sent.length = 0; f.reconnect('p0', version);
    const commands = f.commands('p0').filter(msg => msg.type.startsWith('led_') && msg.type !== 'led_brightness');
    assert.ok(commands.length > 0);
    assert.ok(commands.every(msg => msg.type === expected));
  }
});

test('unknown, development, prerelease and old firmware use the existing command format', () => {
  const f = fixture();
  const supports = f.load('src/leds.ts').supportsRepeatingLedSectors;
  for (const version of [undefined, null, '', 'unknown', 'dev', '3.4.99', '3.5.0', '3.5.1-rc.1', 'garbage']) {
    assert.equal(supports(version), false, `unsupported firmware ${version}`);
    f.state.boxes.p0.version = version;
    assert.equal(f.mode.getLedForStatus('agenda_speaker', f.state.boxes.p0, 'p0').type, 'led_alternate_pair');
  }
  const virtual = { ...f.state.boxes.p0, isVirtual: true };
  assert.equal(f.mode.getLedForStatus('agenda_speaker', virtual, 'virtual-0').repeat, true);
});

test('sector previews repeat arbitrary patterns, clip at the end and terminate for empty patterns', () => {
  const f = fixture();
  const { ledSectors } = f.load('src/leds.ts');
  const sectors = [{ color: '#112233', count: 2 }, { color: '#445566', count: 1 }, { color: '#778899', count: 3 }];
  const cycle = ['#112233', '#112233', '#445566', '#778899', '#778899', '#778899'];
  assert.deepEqual(plain(ledSectors(25, sectors, true)), Array.from({ length: 25 }, (_, i) => cycle[i % 6]));
  assert.deepEqual(plain(ledSectors(8, sectors)), [...cycle, '#000000', '#000000']);
  assert.deepEqual(plain(ledSectors(24, [], true)), Array(24).fill('#000000'));
  assert.deepEqual(plain(ledSectors(24, [{ color: '#ffffff', count: 0 }, { color: '#ff0000', count: -1 }], true)),
    Array(24).fill('#000000'));
  assert.deepEqual(plain(ledSectors(24, [{ color: '#ffffff', count: Number.MAX_SAFE_INTEGER }], true)),
    Array(24).fill('#ffffff'));
});

for (const action of ['handleEndTurn', 'handlePass']) test(`${action} cancels the outgoing player's countdown before setting its idle LEDs`, () => {
  const f = fixture();
  f.state.ti.players.p0.strategyCards.forEach(card => { card.used = true; });
  f.load('src/countdown.ts').sendCountdown('p0', 60000);
  f.sent.length = 0;
  f.load('src/game.ts')[action]('p0');
  assert.equal(f.state.activeBoxId, 'p1');
  assert.equal(f.state.boxes.p0.countdownActive, false);
  assert.equal(f.state.boxes.p0.countdownEndMs, undefined);
  const commands = f.commands('p0');
  const stop = commands.findIndex(msg => msg.type === 'countdown' && msg.durationMs === 0);
  const off = commands.findIndex(msg => msg.type === 'led_off');
  assert.ok(stop >= 0 && off > stop, 'stop the firmware timer before restoring status LEDs');
  f.sent.length = 0;
  f.advance(10000); f.reconnect('p0');
  assert.ok(!f.commands('p0').some(msg => msg.type === 'countdown' && msg.durationMs > 0));
});

test('reconnect does not replay a turn countdown after the active player changes', () => {
  const f = fixture();
  f.load('src/countdown.ts').sendCountdown('p0', 60000);
  // Reconnect can restore effects before the next full render runs.
  f.state.activeBoxId = 'p1'; f.state.boxes.p0.status = 'idle';
  f.sent.length = 0; f.reconnect('p0');
  assert.ok(f.commands('p0').some(msg => msg.type === 'countdown' && msg.durationMs === 0));
  assert.ok(!f.commands('p0').some(msg => msg.type === 'countdown' && msg.durationMs > 0));
});

test('a manually started idle-box countdown survives another player ending their turn', () => {
  const f = fixture();
  f.load('src/countdown.ts').sendCountdown('p2', 60000);
  f.sent.length = 0;
  f.load('src/game.ts').handleEndTurn('p0');
  assert.equal(f.state.boxes.p2.countdownActive, true);
  assert.ok(!f.commands('p2').some(msg => msg.type === 'countdown' && msg.durationMs === 0));
  f.advance(5000); f.sent.length = 0; f.reconnect('p2');
  assert.equal(f.state.boxes.p2.status, 'idle');
  assert.ok(f.commands('p2').some(msg => msg.type === 'countdown' && msg.durationMs === 55000));
});

test('cancelling the last turn countdown preserves the next phase animation', () => {
  const f = fixture();
  f.load('src/countdown.ts').sendCountdown('p0', 60000);
  const eclipse = new (f.load('src/modes/eclipse.ts').EclipseMode)();
  f.load('src/currentGame.ts').setCurrentGame(eclipse);
  f.state.gameMode = 'eclipse';
  f.state.activeBoxId = null;
  f.sent.length = 0; eclipse.startUpkeep(); f.render();
  const commands = f.commands('p0');
  const stop = commands.findIndex(msg => msg.type === 'countdown' && msg.durationMs === 0);
  assert.ok(stop >= 0);
  assert.ok(commands.slice(stop + 1).some(msg => msg.type === 'led_anim_upkeep'));
});

test('a delayed auto-countdown cannot light the player whose turn already ended', async () => {
  const f = fixture();
  f.state.autoCountdownSecs = 60;
  f.load('src/game.ts').handleEndTurn('p0');
  f.load('src/game.ts').handleEndTurn('p1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.activeBoxId, 'p2');
  assert.ok(!f.commands('p1').some(msg => msg.type === 'countdown' && msg.durationMs > 0));
  assert.ok(f.commands('p2').some(msg => msg.type === 'countdown' && msg.durationMs === 60000));
});

for (const style of ['breathe', 'spinner']) for (const finish of ['cancel', 'expire']) {
  test(`${style} resumes when a countdown ${finish}s during the same turn`, () => {
    const f = fixture();
    f.state.activePlayerStyle.mode = style; f.render();
    f.load('src/countdown.ts').sendCountdown('p0', 10000);
    f.sent.length = 0;
    if (finish === 'cancel') f.load('src/countdown.ts').cancelCountdown('p0');
    else { f.advance(11000); f.runTimeouts(); }
    assert.equal(f.state.boxes.p0.countdownActive, false);
    assert.ok(f.commands('p0').some(msg => msg.type === `led_anim_${style}`));
  });
}

test('Last Bastion reconnect keeps its turn, reader, stats and brightness; End still advances', () => {
  const f = fixture();
  f.mode.activatePlayer('p2'); f.render();
  f.state.boxBrightness.p2 = 51;
  f.advance(10000);
  const before = plain({ ti: f.state.ti, box: f.state.boxes.p2 });
  f.sent.length = 0;
  f.reconnect('p2'); f.reconnect('p2');
  assert.equal(f.state.activeBoxId, 'p2');
  assert.deepEqual(plain(f.state.ti), before.ti);
  assert.equal(f.state.boxes.p2.status, 'active');
  assert.equal(f.state.boxes.p2.turnStartTime, before.box.turnStartTime);
  assert.deepEqual(plain(f.state.boxes.p2.turnHistory ?? []), before.box.turnHistory ?? []);
  assert.equal(f.commands('p2')[0].type, 'led_brightness');
  assert.equal(f.commands('p2')[0].value, 51);
  assert.ok(f.commands('p2').some(msg => msg.type === 'rfid_enable'));
  assert.ok(f.commands('p2').some(msg => msg.type === 'led_solid'));
  f.load('src/game.ts').handleEndTurn('p2');
  assert.equal(f.state.activeBoxId, 'p0');
  assert.equal(f.state.boxes.p2.turnHistory.length, 1);
});

test('reconnecting a passed player preserves the pass and keeps its reader disabled', () => {
  const f = fixture();
  f.state.ti.players.p0.strategyCards.forEach(card => { card.used = true; });
  f.mode.onPass('p0'); f.render();
  f.sent.length = 0;
  f.reconnect();
  assert.equal(f.state.boxes.p0.status, 'passed');
  assert.equal(f.state.ti.players.p0.passed, true);
  assert.equal(f.state.activeBoxId, 'p1');
  assert.ok(f.commands('p0').some(msg => msg.type === 'rfid_disable'));
  assert.ok(!f.commands('p0').some(msg => msg.type === 'rfid_enable'));
});

test('primary and secondary reconnects preserve pending confirmations and strategy colours', () => {
  const f = fixture();
  f.state.ti.secondaryMode = 'fastest';
  f.mode.useStrategyCard('p0', f.state.ti.players.p0.strategyCards[0]); f.render();
  const before = plain(f.state.ti.secondary);
  f.sent.length = 0;
  f.reconnect('p1'); f.reconnect('p0');
  assert.equal(f.state.boxes.p0.status, 'strategy');
  assert.equal(f.state.boxes.p1.status, 'secondary');
  assert.deepEqual(plain(f.state.ti.secondary), before);
  assert.ok(f.commands('p1').some(msg => msg.type === 'led_alternate' && msg.color === '#123456'));
  f.mode.onEndTurn('p0'); f.mode.onEndTurn('p1'); f.mode.onEndTurn('p2');
  assert.equal(f.state.activeBoxId, 'p1');
  assert.equal(f.state.ti.secondary, null);
});

test('agenda and secret ballot readiness survive player re-announcements', () => {
  const f = fixture();
  f.state.ti.hiddenAgenda = true;
  f.mode.startAgendaPhase();
  f.reconnect('p0');
  assert.equal(f.state.boxes.p0.status, 'agenda_speaker');
  const finish = () => { const phase = f.state.ti.phase; for (let i = 0; f.state.ti.phase === phase && i < 12; i++) f.mode.onEndTurn(f.state.activeBoxId); };
  f.mode.onEndTurn('p0'); finish(); finish();
  assert.equal(f.state.ti.phase, 'agenda_ballot');
  f.mode.onEndTurn('p1');
  const before = plain(f.state.ti);
  f.reconnect('p1'); f.reconnect('p2');
  assert.deepEqual(plain(f.state.ti), before);
  assert.equal(f.state.activeBoxId, null);
});

test('an explicit disconnect/reconnect restores the same role, including duplicate disconnect notices', () => {
  const f = fixture();
  f.ws.handleMessage({ type: 'disconnected', hwid: 'p0' });
  f.ws.handleMessage({ type: 'disconnected', hwid: 'p0' });
  assert.equal(f.state.boxes.p0.status, 'disconnected');
  f.reconnect();
  assert.equal(f.state.boxes.p0.status, 'active');
  assert.equal(f.state.activeBoxId, 'p0');
});

test('a reconnect cannot revive an old active role after the game has moved on', () => {
  const f = fixture();
  f.ws.handleMessage({ type: 'disconnected', hwid: 'p0' });
  f.state.activeBoxId = null;
  f.state.ti.actionTurnIndex = 1;
  f.mode.activateActionTurn(); f.render();
  f.sent.length = 0;
  f.reconnect();
  assert.equal(f.state.boxes.p0.status, 'idle');
  assert.equal(f.state.activeBoxId, 'p1');
  assert.ok(!f.commands('p0').some(msg => msg.type === 'rfid_enable'));
});

for (const style of ['breathe', 'spinner']) test(`reconnect restarts a cached ${style} animation`, () => {
  const f = fixture();
  f.state.activePlayerStyle.mode = style; f.render();
  f.sent.length = 0;
  f.reconnect();
  assert.equal(f.commands('p0').filter(msg => msg.type === `led_anim_${style}`).length, 1);
  assert.equal(f.state.boxes.p0.status, 'active');
});

test('strategy selection reconnect restarts its animation and RFID', () => {
  const f = fixture();
  f.mode.startStrategyPhase(); f.render();
  f.sent.length = 0;
  f.reconnect();
  assert.equal(f.state.boxes.p0.status, 'choosing');
  assert.ok(f.commands('p0').some(msg => msg.type === 'led_anim_choosing' && msg.colors.length === 8));
  assert.ok(f.commands('p0').some(msg => msg.type === 'rfid_enable'));
});

test('Eclipse upkeep reconnect restores simultaneous readers and the on-device animation', () => {
  const f = fixture();
  const eclipse = new (f.load('src/modes/eclipse.ts').EclipseMode)();
  f.load('src/currentGame.ts').setCurrentGame(eclipse);
  f.state.gameMode = 'eclipse'; f.state.eclipse.tapToPass = true;
  eclipse.startUpkeep(); f.render();
  f.sent.length = 0;
  f.reconnect('p2');
  assert.equal(f.state.boxes.p2.status, 'upkeep');
  assert.ok(f.commands('p2').some(msg => msg.type === 'led_anim_upkeep'));
  assert.ok(f.commands('p2').some(msg => msg.type === 'rfid_enable'));
});

test('reconnect resumes only the remaining countdown, without restarting the turn', () => {
  const f = fixture();
  f.state.boxes.p0.countdownActive = true; f.state.boxes.p0.countdownEndMs = 11000;
  f.advance(4000); f.reconnect();
  assert.equal(f.commands('p0').find(msg => msg.type === 'countdown').durationMs, 6000);
  f.advance(7000); f.reconnect();
  assert.equal(f.state.boxes.p0.countdownActive, false);
  assert.equal(f.state.boxes.p0.status, 'active');
});

test('paused reconnect leaves LEDs off and virtual reconnect sends no hardware commands', () => {
  const f = fixture();
  f.state.paused = true;
  f.reconnect();
  assert.equal(f.state.boxes.p0.status, 'active');
  assert.ok(f.commands('p0').filter(msg => msg.type.startsWith('led_') && msg.type !== 'led_brightness').every(msg => msg.type === 'led_off'));
  f.state.boxes['virtual-0'] = { hwid: 'virtual-0', isVirtual: true, factionId: null, status: 'passed' };
  f.state.boxOrder.push('virtual-0');
  f.reconnect('virtual-0');
  assert.equal(f.state.boxes['virtual-0'].status, 'passed');
  assert.deepEqual(f.commands('virtual-0'), []);
});
