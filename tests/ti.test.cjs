const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const factions = JSON.parse(fs.readFileSync('public/factions.json', 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

// Exercise the real mode and persistence code with DOM, transport and rendering
// boundaries stubbed. Browser checks cover those boundaries with virtual boxes.
function fixture(ids = ['sol', 'keleres', 'ralnelconsortium']) {
  let state;
  const logs = [], phases = [], controls = [], sends = [];
  let tick = 1000;
  class Clock extends Date { static now() { return tick += 100; } }
  const fields = { 'ti-speaker': { value: 'p0' }, 'ti-hidden-agenda': { checked: false } };
  const noop = () => {};
  function compile(path, deps) {
    const context = { exports: {}, localStorage: { getItem: () => null }, Date: Clock, setTimeout: noop,
      document: { getElementById: id => fields[id] ?? { style: {} } },
      require: name => deps[name] ?? new Proxy({}, { get: () => noop }) };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8').replaceAll('import.meta.env.BASE_URL', '"/"'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, context, { filename: path });
    return context.exports;
  }
  state = compile('src/state.ts', {}).state;
  state.factions = plain(factions);
  state.gameActive = true;
  state.gameMode = 'ti';
  state.boxOrder = ids.map((_, i) => `p${i}`);
  state.hubHwid = 'p0';
  state.boxOrder.forEach((hwid, i) => {
    state.boxes[hwid] = { hwid, isVirtual: true, factionId: ids[i], status: 'idle' };
  });
  const timers = compile('src/timers.ts', { './state': {state}, './render': {renderBoxes:noop,renderTableLabel:noop} });
  const render = () => timers.updateTurnTimers();
  const deps = {
    '../state': { state },
    '../logger': { log: (...args) => logs.push(args) },
    '../boxes': {
      getDisplayName: id => state.boxNames[id]?.name ?? id,
      getFactionForBox: id => state.factions.twilight_imperium.find(f => f.id === state.boxes[id]?.factionId),
      setBoxBadges: (id, badges) => { state.boxes[id].badges = badges; },
      setAutoName: (id, name) => { state.boxNames[id] = { name }; },
      buildPlayerSelectOptions: () => [],
    },
    '../render': { render, renderBoxes: noop, isManuallyRenamed: id => !!state.boxNames[id]?.manual },
    '../websockets': { disableAllRfid: noop, enableRfid: noop, sendToBox: (...args) => sends.push(args) },
    '../timers': { ...timers, startPhase: name => { phases.push(name); timers.startPhase(name); } },
    '../guided-phase': { isGuidedPhaseActive: () => false, clearGuidedPhase: noop, startGuidedPhase: noop },
    './helpers': compile('src/modes/helpers.ts', { '../state': {state} }),
    '../undo': { snapshotForUndo: noop },
    '../persist': { persistState: noop },
    '../leds': { LED_COUNT: 24, resetActiveAnim: noop, syncLeds: noop },
  };
  const mode = new (compile('src/modes/ti.ts', deps).TwilightImperiumMode)();
  mode.start();
  state.boxOrder.forEach((id, i) => {
    state.ti.players[id].strategyCards = [{ id: ['leadership','politics','imperial'][i] ?? 'trade', label: 'Strategy', color: '#123456', initiative: i + 1, used: true }];
  });
  mode.startActionPhase();
  render();
  function actions() { controls.length = 0; mode.renderControls([], controls); return controls; }
  function click(id) { const control = actions().find(c => c.id === id); assert.ok(control, `control ${id} must exist`); control.fn(); }
  function allPass() { for (let i = 0; i < ids.length; i++) mode.onPass(state.activeBoxId); }
  function finishWindow() { const phase = state.ti.phase; for (let i = 0; state.ti.phase === phase && i < 12; i++) mode.onEndTurn(state.activeBoxId); assert.notEqual(state.ti.phase, phase); }
  return { state, mode, logs, phases, fields, actions, click, allPass, finishWindow, compile, sends, timers, deps };
}

function strategyFixture(mode, ids) {
  const f = fixture(ids);
  f.state.ti.secondaryMode = mode;
  const card = f.state.ti.players.p0.strategyCards[0];
  card.used = false;
  f.mode.onRfid('p0', 'ti', 'strategy', card.id);
  return f;
}

function changeSecondaryMode(f, value) {
  f.actions().find(c => c.id === 'gc-secondary').fn({ target: { value } });
}

function assertSecondaries(f, expected) {
  assert.deepEqual(plain(f.state.boxOrder.filter(id => f.state.boxes[id].status === 'secondary')), expected);
  for (const id of expected) assert.equal(f.state.boxes[id].strategyColor, '#123456');
}

function finishSecondaries(f) {
  for (let i = 0; f.state.ti.secondary && i < f.state.boxOrder.length; i++) {
    const active = f.state.boxOrder.find(id => f.state.boxes[id].status === 'secondary');
    assert.ok(active, 'an outstanding secondary must be available to finish');
    f.mode.onEndTurn(active);
  }
  assert.equal(f.state.ti.secondary, null);
  assert.equal(f.state.activeBoxId, 'p1');
}

for (const from of ['standard', 'fast', 'fastest']) {
  for (const to of ['standard', 'fast', 'fastest']) {
    for (const primaryEnded of [false, true]) {
      test(`secondary mode ${from} -> ${to} ${primaryEnded ? 'after' : 'before'} primary completion`, () => {
        const f = strategyFixture(from);
        if (primaryEnded) f.mode.onEndTurn('p0');
        changeSecondaryMode(f, to);

        const simultaneous = from === 'fastest' || to === 'fastest' ||
          (primaryEnded && (from === 'fast' || to === 'fast'));
        assertSecondaries(f, simultaneous ? ['p1', 'p2'] : primaryEnded ? ['p1'] : []);
        assert.equal(f.state.activeBoxId, primaryEnded ? null : 'p0');
        assert.equal(f.state.boxes.p0.status, primaryEnded ? 'idle' : 'strategy');

        if (!primaryEnded) f.mode.onEndTurn('p0');
        assertSecondaries(f, simultaneous || to === 'fast' ? ['p1', 'p2'] : ['p1']);
        finishSecondaries(f);
      });
    }
  }
}

for (const to of ['standard', 'fast']) {
  test(`Fastest -> ${to} preserves a completed secondary when the primary ends`, () => {
    const f = strategyFixture('fastest');
    f.mode.onEndTurn('p1');
    changeSecondaryMode(f, to);
    assertSecondaries(f, ['p2']);
    f.mode.onEndTurn('p0');
    assertSecondaries(f, ['p2']);
    assert.equal(f.state.ti.players.p1.confirmedSecondary, true);
    finishSecondaries(f);
  });

  test(`Fastest -> ${to} still waits for the primary when all secondaries finish first`, () => {
    const f = strategyFixture('fastest');
    changeSecondaryMode(f, to);
    f.mode.onEndTurn('p2'); f.mode.onEndTurn('p1');
    assertSecondaries(f, []);
    assert.equal(f.state.activeBoxId, 'p0');
    assert.equal(f.state.boxes.p0.status, 'strategy');
    f.mode.onEndTurn('p0');
    assert.equal(f.state.activeBoxId, 'p1');
    assert.equal(f.state.ti.secondary, null);
  });
}

test('Standard -> Fast starts only unfinished secondaries after the primary', () => {
  const f = strategyFixture('standard', ['sol', 'keleres', 'ralnelconsortium', 'argent']);
  f.mode.onEndTurn('p0'); f.mode.onEndTurn('p1');
  assertSecondaries(f, ['p2']);
  changeSecondaryMode(f, 'fast');
  assertSecondaries(f, ['p2', 'p3']);
  assert.equal(f.state.ti.players.p1.confirmedSecondary, true);
  f.mode.onEndTurn('p3');
  assertSecondaries(f, ['p2']);
  finishSecondaries(f);
});

test('repeated mode changes preserve progress and do not restart active secondaries', () => {
  const f = strategyFixture('standard', ['sol', 'keleres', 'ralnelconsortium', 'argent']);
  f.mode.onEndTurn('p0'); f.mode.onEndTurn('p1');
  changeSecondaryMode(f, 'fastest');
  changeSecondaryMode(f, 'standard');
  assertSecondaries(f, ['p2', 'p3']);
  f.mode.onEndTurn('p3');
  assertSecondaries(f, ['p2']);
  changeSecondaryMode(f, 'fast'); changeSecondaryMode(f, 'standard');
  assertSecondaries(f, ['p2']);
  finishSecondaries(f);
});

test('waiting, completed and unknown players cannot confirm a secondary', () => {
  const f = strategyFixture('standard');
  f.mode.onEndTurn('p1'); f.mode.onPass('p2'); f.mode.onEndTurn('unknown');
  assert.equal(f.state.ti.players.p1.confirmedSecondary, false);
  assert.equal(f.state.ti.players.p2.confirmedSecondary, false);
  f.mode.onEndTurn('p0');
  f.mode.onEndTurn('p2'); assertSecondaries(f, ['p1']);
  f.mode.onPass('p1');
  f.mode.onEndTurn('p1'); f.mode.onEndTurn('p0');
  assertSecondaries(f, ['p2']);
  finishSecondaries(f);
});

test('mode changes skip disconnected players and still finish the action', () => {
  const f = strategyFixture('standard');
  f.state.boxes.p2.status = 'disconnected';
  changeSecondaryMode(f, 'fastest');
  assertSecondaries(f, ['p1']);
  assert.equal(f.state.boxes.p2.status, 'disconnected');
  f.mode.onEndTurn('p0');
  finishSecondaries(f);
});

test('primary completion advances in every mode when no secondaries remain connected', () => {
  for (const mode of ['standard', 'fast', 'fastest']) {
    const f = strategyFixture(mode);
    f.state.boxes.p1.status = 'disconnected'; f.state.boxes.p2.status = 'disconnected';
    f.mode.onEndTurn('p0');
    assert.equal(f.state.ti.secondary, null);
    assert.equal(f.state.activeBoxId, 'p0');
    assert.equal(f.state.boxes.p0.status, 'active');
  }
});

test('mode changes refresh and save immediately; undo restores partial secondary progress', () => {
  const f = strategyFixture('standard', ['sol', 'keleres', 'ralnelconsortium', 'argent']);
  const persist = f.compile('src/persist.ts', {
    './state': { state: f.state }, './render': { render: () => {} }, './leds': { syncLeds: () => {} },
  });
  const undo = f.compile('src/undo.ts', { './persist': persist });
  f.deps['../undo'].snapshotForUndo = undo.snapshotForUndo;
  const effects = [];
  let saved;
  f.deps['../render'].render = () => effects.push('render');
  f.deps['../persist'].persistState = () => { effects.push('save'); saved = plain(persist.extractPersistableState()); };
  f.mode.onEndTurn('p0'); f.mode.onEndTurn('p1');
  changeSecondaryMode(f, 'fastest');
  assert.deepEqual(effects, ['render', 'save']);
  assert.equal(saved.ti.secondaryMode, 'fastest');
  assert.equal(saved.ti.players.p1.confirmedSecondary, true);
  assert.equal(saved.boxes.p2.status, 'secondary');
  assert.equal(saved.boxes.p3.status, 'secondary');
  assert.equal(undo.canUndo(), true);
  undo.undo();
  assert.equal(f.state.ti.secondaryMode, 'standard');
  assert.equal(f.state.ti.players.p1.confirmedSecondary, true);
  assertSecondaries(f, ['p2']);

  // Resume into fresh boxes, rather than relying on colours left in memory.
  f.state.boxOrder.forEach(id => { f.state.boxes[id].strategyColor = null; });
  persist.restoreState(saved, true);
  assert.equal(f.state.ti.players.p1.confirmedSecondary, true);
  assertSecondaries(f, ['p2', 'p3']);
  finishSecondaries(f);
});

test('Firmament is a setup identity; Obsidian is only gained in play', () => {
  const firmament = factions.twilight_imperium.find(f => f.id === 'firmament');
  assert.ok(firmament); assert.equal(firmament.expansion, 'thundersedge');
  assert.equal(factions.twilight_imperium.find(f => f.id === 'obsidian').setup, false);
  const f = fixture(['firmament','sol','argent']);
  assert.equal(f.mode.getStartValidation().valid, true);
  f.click('gc-become-obsidian');
  assert.equal(f.state.boxes.p0.factionId, 'obsidian');
  assert.equal(f.state.boxNames.p0.name, 'Obsidian');
  assert.equal(f.state.activeBoxId, 'p0'); assert.equal(f.state.ti.phase, 'action');
  assert.equal(f.mode.getStartValidation().valid, false);
});

test('Firmament transformation preserves a manually chosen player name', () => {
  const f = fixture(['firmament','sol','argent']);
  f.state.boxNames.p0 = { name: 'Jake', manual: true };
  f.click('gc-become-obsidian');
  assert.equal(f.state.boxNames.p0.name, 'Jake');
});

test('new game reads Hidden Agenda setup and resets transient and hero state', () => {
  const f = fixture(); f.fields['ti-hidden-agenda'].checked = true;
  f.state.ti.ralNelHero = 'used'; f.state.ti.executiveOrderHwid = 'p1';
  f.mode.start();
  assert.equal(f.state.ti.hiddenAgenda, true); assert.equal(f.state.ti.ralNelHero, 'locked');
  assert.equal(f.state.ti.executiveOrderHwid, null);
});

test('Hidden Agenda retains ordered reveal windows, then accepts simultaneous ballots', () => {
  const f = fixture(['sol','keleres','argent','ralnelconsortium']);
  f.state.ti.hiddenAgenda = true; f.mode.startAgendaPhase();
  f.mode.onEndTurn('p0');
  assert.equal(f.state.ti.phase, 'when_agenda_revealed');
  assert.deepEqual(plain(f.state.ti.agendaTurnOrder), ['p0','p1','p2','p3']);
  f.finishWindow(); assert.equal(f.state.ti.phase, 'after_agenda_revealed');
  f.finishWindow(); assert.equal(f.state.ti.phase, 'agenda_argent'); assert.equal(f.state.activeBoxId, 'p2');
  f.mode.onEndTurn('p1'); assert.equal(f.state.ti.phase, 'agenda_argent');
  f.mode.onEndTurn('p2'); assert.equal(f.state.ti.phase, 'agenda_ballot'); assert.equal(f.state.activeBoxId, null);
  assert.deepEqual(plain(f.state.ti.agendaReadyHwids), ['p2']);
  f.mode.onEndTurn('p3'); f.mode.onEndTurn('p3');
  assert.deepEqual(plain(f.state.ti.agendaReadyHwids), ['p2','p3']);
  f.mode.onEndTurn('p0'); assert.equal(f.state.ti.phase, 'agenda_ballot');
  f.mode.onEndTurn('p1'); assert.equal(f.state.ti.phase, 'agenda_resolve'); assert.equal(f.state.activeBoxId, 'p0');
  f.mode.onEndTurn('p1'); assert.equal(f.state.ti.phase, 'agenda_resolve');
  f.click('gc-agenda-resolved'); assert.equal(f.state.ti.phase, 'agenda_reveal'); assert.equal(f.state.ti.agendaCount, 1);
  assert.deepEqual(plain(f.state.ti.agendaReadyHwids), []);
});

test('without Argent, secret ballots start immediately and wait for every participant', () => {
  const f = fixture(); f.state.ti.hiddenAgenda = true; f.mode.startAgendaPhase(); f.mode.startAgendaVote();
  assert.equal(f.state.ti.phase, 'agenda_ballot');
  f.mode.onLongPress('p0'); assert.equal(f.state.ti.phase, 'agenda_ballot');
  f.mode.onEndTurn('unknown'); assert.equal(f.state.ti.agendaReadyHwids.length, 0);
  f.state.boxOrder.forEach(id => f.mode.onEndTurn(id));
  assert.equal(f.state.ti.phase, 'agenda_resolve');
  f.state.ti.agendaCount = 1; f.click('gc-agenda-resolved'); assert.equal(f.state.ti.phase, 'status2');
});

test('ordinary agenda voting still follows Argent then clockwise with speaker last', () => {
  const f = fixture(['sol','keleres','argent']); f.mode.startAgendaPhase(); f.mode.startAgendaVote();
  assert.equal(f.state.ti.phase, 'agenda_vote');
  assert.deepEqual(plain(f.state.ti.agendaTurnOrder), ['p2','p1','p0']);
  f.finishWindow(); assert.equal(f.state.ti.phase, 'agenda_reveal'); assert.equal(f.state.ti.agendaCount, 1);
});

test('Executive Order uses one agenda and returns to the same action without changing speaker or passes', () => {
  const f = fixture(); f.state.ti.hiddenAgenda = true;
  f.state.activeBoxId = 'p1'; f.state.ti.actionTurnIndex = 1;
  f.state.ti.players.p0.passed = true; f.state.boxes.p0.status = 'passed';
  const before = plain(f.state.ti.players);
  f.click('gc-executive-order');
  assert.equal(f.state.ti.speakerHwid, 'p0'); assert.equal(f.state.ti.executiveOrderHwid, 'p1');
  assert.equal(f.state.activeBoxId, 'p1');
  f.mode.onEndTurn('p1'); f.finishWindow(); f.finishWindow();
  assert.equal(f.state.ti.phase, 'agenda_vote');
  assert.deepEqual(plain(f.state.ti.agendaTurnOrder), ['p2','p0','p1']);
  f.finishWindow(); assert.equal(f.state.ti.phase, 'agenda_resolve');
  f.click('gc-agenda-resolved');
  assert.equal(f.state.ti.phase, 'action'); assert.equal(f.state.activeBoxId, 'p1');
  assert.equal(f.state.ti.executiveOrderHwid, null); assert.equal(f.state.ti.speakerHwid, 'p0');
  assert.deepEqual(plain(f.state.ti.players), before); assert.equal(f.state.boxes.p0.status, 'passed');
  assert.ok(!f.phases.includes('status')); assert.ok(!f.phases.includes('agenda'));
  f.mode.onEndTurn('p1'); assert.equal(f.state.activeBoxId, 'p2');
  assert.equal(f.state.boxes.p1.status, 'idle');
});

test('Executive Order ability windows use action initiative, while votes use seating', () => {
  const f = fixture(); f.state.ti.turnOrder = ['p0','p2','p1']; f.state.activeBoxId = 'p1';
  f.click('gc-executive-order'); f.mode.onEndTurn('p1');
  assert.deepEqual(plain(f.state.ti.agendaTurnOrder), ['p1','p0','p2']);
});

test('Executive Order is unavailable to another faction or during a secondary', () => {
  const f = fixture(); assert.ok(!f.actions().some(c => c.id === 'gc-executive-order'));
  f.state.activeBoxId = 'p1'; f.state.ti.secondary = {};
  assert.ok(!f.actions().some(c => c.id === 'gc-executive-order'));
});

test('Ral Nel with locked hero and games without Ral Nel enter status normally', () => {
  for (const ids of [['sol','keleres','ralnelconsortium'], ['sol','keleres','argent']]) {
    const f = fixture(ids); f.allPass(); assert.equal(f.state.ti.phase, 'status');
  }
});

test('available Ral Nel hero holds before status, resumes real turns, and is consumed once', () => {
  const f = fixture(); f.state.ti.ralNelHero = 'available'; f.allPass();
  assert.equal(f.state.ti.phase, 'action_end'); assert.equal(f.state.activeBoxId, null);
  assert.equal(f.state.currentPhaseStart.name, 'action'); assert.ok(!f.phases.includes('status'));
  assert.ok(f.state.boxOrder.every(id => f.state.boxes[id].status === 'passed'));
  f.click('gc-ralnel-use');
  assert.equal(f.state.ti.phase, 'action'); assert.equal(f.state.activeBoxId, 'p2');
  assert.equal(f.state.ti.players.p2.passed, false); assert.equal(f.state.ti.players.p0.passed, true);
  assert.equal(f.state.ti.ralNelHero, 'used');
  f.mode.onEndTurn('p2'); assert.equal(f.state.activeBoxId, 'p2');
  f.mode.onPass('p2'); assert.equal(f.state.ti.phase, 'status');
});

test('Ral Nel can trigger the hero after its own final pass, or decline it and keep it available', () => {
  const f = fixture(); f.state.ti.ralNelHero = 'available'; f.allPass();
  f.mode.onEndTurn('p2'); assert.equal(f.state.ti.ralNelHero, 'used'); assert.equal(f.state.ti.phase, 'action');
  const g = fixture(); g.state.ti.ralNelHero = 'available'; g.allPass(); g.click('gc-begin-status');
  assert.equal(g.state.ti.phase, 'status'); assert.equal(g.state.ti.ralNelHero, 'available');
});

test('new phase references follow box substitution', () => {
  const f = fixture(); f.state.ti.executiveOrderHwid = 'p1'; f.state.ti.agendaReadyHwids = ['p1'];
  f.mode.onBoxSubstituted('p1','replacement');
  assert.equal(f.state.ti.executiveOrderHwid, 'replacement');
  assert.deepEqual(plain(f.state.ti.agendaReadyHwids), ['replacement']); assert.equal(f.state.ti.players.replacement.hwid, 'replacement');
});

test('removing a pending ballot participant can release the speaker resolution step', () => {
  const f = fixture(); f.state.ti.hiddenAgenda = true; f.mode.startAgendaPhase(); f.mode.startAgendaVote();
  f.mode.onEndTurn('p0'); f.mode.onEndTurn('p1');
  f.state.boxes.p2.status = 'disconnected'; f.mode.onPlayerRemoved('p2');
  assert.equal(f.state.ti.phase, 'agenda_resolve'); assert.equal(f.state.activeBoxId, 'p0');
});

test('removing Ral Nel while awaiting its hero enters status', () => {
  const f = fixture(); f.state.ti.ralNelHero = 'available'; f.allPass();
  f.state.boxes.p2.status = 'disconnected'; f.mode.onPlayerRemoved('p2'); assert.equal(f.state.ti.phase, 'status');
});

test('persisted new fields survive restore and hardware remapping; legacy saves get defaults', () => {
  const f = fixture();
  const persist = f.compile('src/persist.ts', {
    './state': { state: f.state }, './render': {render:()=>{}}, './boxes': {updateSetupUI:()=>{}}, './leds': {syncLeds:()=>{}},
  });
  f.state.ti.hiddenAgenda = true; f.state.ti.agendaReadyHwids = ['p1']; f.state.ti.executiveOrderHwid = 'p1';
  f.state.ti.agendaTurnOrder = ['p2','p0','p1']; f.state.ti.ralNelHero = 'used';
  const saved = plain(persist.extractPersistableState());
  f.state.boxOrder = ['n0','n1','n2']; f.state.boxOrder.forEach(id => { f.state.boxes[id] = {hwid:id,isVirtual:true,status:'idle'}; });
  persist.restoreState(saved, true);
  assert.deepEqual(plain(f.state.ti.agendaReadyHwids), ['n1']);
  assert.deepEqual(plain(f.state.ti.agendaTurnOrder), ['n2','n0','n1']);
  assert.equal(f.state.ti.executiveOrderHwid, 'n1'); assert.equal(f.state.ti.players.n1.hwid, 'n1');
  assert.equal(f.state.ti.hiddenAgenda, true); assert.equal(f.state.ti.ralNelHero, 'used');
  const legacy = plain(saved); delete legacy.ti.hiddenAgenda; delete legacy.ti.agendaReadyHwids;
  delete legacy.ti.executiveOrderHwid; delete legacy.ti.ralNelHero;
  legacy.factions.twilight_imperium = legacy.factions.twilight_imperium.filter(f => f.id !== 'firmament');
  delete legacy.factions.twilight_imperium.find(f => f.id === 'obsidian').setup;
  persist.restoreState(legacy, true);
  assert.equal(f.state.ti.hiddenAgenda, false); assert.deepEqual(plain(f.state.ti.agendaReadyHwids), []);
  assert.equal(f.state.ti.executiveOrderHwid, null); assert.equal(f.state.ti.ralNelHero, 'locked');
  assert.ok(f.state.factions.twilight_imperium.find(f => f.id === 'firmament'));
  assert.equal(f.state.factions.twilight_imperium.find(f => f.id === 'obsidian').setup, false);
});


test('each consecutive Ral Nel turn creates its own timer record', () => {
  const f = fixture(); f.state.ti.ralNelHero = 'available'; f.allPass(); f.timers.updateTurnTimers();
  f.click('gc-ralnel-use');
  const before = f.state.boxes.p2.turnHistory?.length ?? 0;
  f.mode.onEndTurn('p2'); f.timers.updateTurnTimers();
  assert.equal(f.state.boxes.p2.turnHistory.length, before + 1);
  f.mode.onEndTurn('p2'); f.timers.updateTurnTimers();
  assert.equal(f.state.boxes.p2.turnHistory.length, before + 2);
  f.mode.onPass('p2'); f.timers.updateTurnTimers();
  assert.equal(f.state.boxes.p2.turnHistory.length, before + 3);
});

test('removing the Executive Order actor returns to a surviving action player', () => {
  const f = fixture(); f.state.activeBoxId = 'p1'; f.state.ti.actionTurnIndex = 1;
  f.click('gc-executive-order'); f.state.boxes.p1.status = 'disconnected'; f.mode.onPlayerRemoved('p1');
  assert.equal(f.state.ti.phase, 'action'); assert.notEqual(f.state.activeBoxId, 'p1');
  assert.ok(!f.state.ti.turnOrder.includes('p1')); assert.equal(f.state.ti.executiveOrderHwid, null);
});


test('used Ral Nel hero stays consumed in the next round', () => {
  const f = fixture(); f.state.ti.ralNelHero = 'available'; f.allPass(); f.click('gc-ralnel-use');
  f.mode.onPass('p2'); f.mode.endRound();
  assert.equal(f.state.round, 2); assert.equal(f.state.ti.ralNelHero, 'used');
  assert.ok(!f.actions().some(a => a.id === 'gc-ralnel-available'));
});

test('paused game controls cannot trigger Executive Order, transformation, or Ral Nel hero', () => {
  const f = fixture(['firmament','keleres','ralnelconsortium']); f.state.paused = true;
  f.click('gc-become-obsidian'); assert.equal(f.state.boxes.p0.factionId, 'firmament');
  f.state.activeBoxId = 'p1'; f.click('gc-executive-order'); assert.equal(f.state.ti.phase, 'action');
  f.state.paused = false; f.state.activeBoxId = 'p0'; f.state.ti.ralNelHero = 'available'; f.allPass();
  f.state.paused = true; f.click('gc-ralnel-use'); assert.equal(f.state.ti.phase, 'action_end');
});

test('faction filters hide Obsidian in setup, allow it during play, and respect expansion choices', () => {
  const f = fixture();
  f.state.allTags = {ti:factions.twilight_imperium.map(x => ({id:`ti:faction:${x.id}`,display:x.name}))};
  const expansions = f.compile('src/expansions.ts', { './state': {state:f.state} });
  const tags = f.compile('src/tags.ts', { './state': {state:f.state}, './expansions':expansions });
  const visible = () => plain(tags.filterTags('ti', () => true)).map(x => x.id);
  f.state.gameActive = false;
  assert.ok(visible().includes('ti:faction:firmament')); assert.ok(!visible().includes('ti:faction:obsidian'));
  f.state.selectedExpansions.ti = ['pok','codex3']; assert.ok(!visible().includes('ti:faction:firmament'));
  f.state.selectedExpansions.ti = ['thundersedge']; assert.ok(visible().includes('ti:faction:firmament')); assert.ok(!visible().includes('ti:faction:keleres'));
  f.state.gameActive = true; assert.ok(visible().includes('ti:faction:obsidian'));
});

test('new box prompts work with secondary hints disabled and fit the hardware text width', () => {
  const f = fixture(['sol','argent','ralnelconsortium']);
  for (const phase of ['action_end','agenda_ballot','agenda_argent','agenda_resolve']) {
    f.state.ti.phase = phase; f.state.activeBoxId = 'p1';
    for (const id of f.state.boxOrder) {
      const display = f.mode.getBoxDisplay(id);
      assert.ok(display); assert.ok(display.name.length <= 21); assert.ok(display.status.length <= 21);
    }
  }
});
