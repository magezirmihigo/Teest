// server.js — EFOOTBALL ARENA Full Automation Server Logic
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Production State (Can be swapped to PostgreSQL/Prisma)
let state = {
  systemFrozen: false,
  tournaments: [],
  disputes: [],
  logs: []
};

function addLog(engine, message) {
  const log = { id: Date.now(), time: new Date().toLocaleTimeString(), engine, message };
  state.logs.unshift(log);
  if (state.logs.length > 50) state.logs.pop();
  io.emit('log_updated', log);
}

// -------------------------------------------------------------
// AUTOMATION ENGINES
// -------------------------------------------------------------

// Engine 01: Tournament Setup & Bracket Engine
app.post('/api/tournaments', (req, res) => {
  if (state.systemFrozen) return res.status(503).json({ error: 'System is paused by Admin' });

  const { title, platform, entryFee, slots } = req.body;
  const numSlots = parseInt(slots) || 4;

  const players = Array.from({ length: numSlots }, (_, i) => ({
    id: `usr_${i + 1}`,
    name: i === 0 ? 'Capitan (You)' : `Player_${i + 1}`,
    gameId: `EF-${1000 + i}`,
    platform: platform || 'Mobile'
  }));

  // Generate Quarterfinals / Semifinals Matches
  const matches = [];
  let matchIdCounter = 1;

  for (let i = 0; i < numSlots; i += 2) {
    matches.push({
      id: `m_${matchIdCounter++}`,
      round: numSlots === 8 ? 'Quarterfinal' : 'Semifinal',
      playerA: players[i],
      playerB: players[i + 1],
      roomCode: null,
      scoreA: null,
      scoreB: null,
      submittedA: null,
      submittedB: null,
      status: 'AWAITING_CODE', // AWAITING_CODE, IN_PROGRESS, CONFIRMED, DISPUTED
      winner: null
    });
  }

  // Create Final Match Placeholder
  matches.push({
    id: `m_${matchIdCounter++}`,
    round: 'Final',
    playerA: { id: null, name: 'TBD' },
    playerB: { id: null, name: 'TBD' },
    roomCode: null,
    scoreA: null,
    scoreB: null,
    status: 'LOCKED',
    winner: null
  });

  const newTournament = {
    id: `trn_${Date.now().toString().slice(-4)}`,
    title,
    platform,
    entryFee: entryFee || 'Free',
    status: 'LIVE',
    matches
  };

  state.tournaments.unshift(newTournament);
  addLog('REGISTRATION & BRACKET', `Created tournament "${title}" (${numSlots} Players)`);
  
  io.emit('state_updated', state);
  res.json({ success: true, tournament: newTournament });
});

// Engine 04: Match Room & Room Code Relay Engine
app.post('/api/matches/room-code', (req, res) => {
  const { tournamentId, matchId, roomCode } = req.body;
  const trn = state.tournaments.find(t => t.id === tournamentId);
  if (!trn) return res.status(404).json({ error: 'Tournament not found' });

  const match = trn.matches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  match.roomCode = roomCode;
  match.status = 'IN_PROGRESS';

  addLog('MATCH ENGINE', `Match ${match.id}: Room Code set to [${roomCode}]. Opponent notified.`);
  io.emit('state_updated', state);
  res.json({ success: true, match });
});

// Engine 05: Verification & Dispute Engine (Dual-Confirmation Protocol)
app.post('/api/matches/submit-score', (req, res) => {
  const { tournamentId, matchId, playerId, scoreA, scoreB, screenshot } = req.body;
  const trn = state.tournaments.find(t => t.id === tournamentId);
  if (!trn) return res.status(404).json({ error: 'Tournament not found' });

  const match = trn.matches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const isPlayerA = match.playerA.id === playerId;
  const scoreObj = { scoreA: parseInt(scoreA), scoreB: parseInt(scoreB), screenshot };

  if (isPlayerA) {
    match.submittedA = scoreObj;
  } else {
    match.submittedB = scoreObj;
  }

  addLog('VERIFICATION', `Match ${match.id}: Score reported by ${isPlayerA ? match.playerA.name : match.playerB.name}`);

  // Dual Confirmation Evaluation Logic
  if (match.submittedA && match.submittedB) {
    const aMatch = match.submittedA.scoreA === match.submittedB.scoreA;
    const bMatch = match.submittedA.scoreB === match.submittedB.scoreB;

    if (aMatch && bMatch) {
      // MATCH CONFIRMED
      match.scoreA = match.submittedA.scoreA;
      match.scoreB = match.submittedA.scoreB;
      match.status = 'CONFIRMED';
      match.winner = match.scoreA > match.scoreB ? match.playerA : match.playerB;

      addLog('VERIFICATION', `Match ${match.id} AUTO-VERIFIED! Winner: ${match.winner.name} (${match.scoreA}-${match.scoreB})`);
      
      // Auto Advance to Final
      advanceBracket(trn, match);
    } else {
      // DISPUTE CONFLICT
      match.status = 'DISPUTED';
      const dispute = {
        id: `dsp_${Date.now().toString().slice(-4)}`,
        tournamentId: trn.id,
        matchId: match.id,
        playerA: match.playerA,
        playerB: match.playerB,
        subA: match.submittedA,
        subB: match.submittedB,
        status: 'OPEN'
      };
      state.disputes.unshift(dispute);
      addLog('DISPUTE ENGINE', `CONFLICT DETECTED in Match ${match.id}! Escalated to Admin Dashboard.`);
    }
  }

  io.emit('state_updated', state);
  res.json({ success: true, match });
});

// Admin Resolution Overrides
app.post('/api/admin/resolve-dispute', (req, res) => {
  const { disputeId, winnerId, scoreA, scoreB } = req.body;
  const dispute = state.disputes.find(d => d.id === disputeId);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

  const trn = state.tournaments.find(t => t.id === dispute.tournamentId);
  const match = trn.matches.find(m => m.id === dispute.matchId);

  match.scoreA = parseInt(scoreA);
  match.scoreB = parseInt(scoreB);
  match.status = 'CONFIRMED';
  match.winner = winnerId === match.playerA.id ? match.playerA : match.playerB;
  dispute.status = 'RESOLVED';

  addLog('ADMIN OVERRIDE', `Dispute ${disputeId} resolved manually by Admin. Winner: ${match.winner.name}`);
  advanceBracket(trn, match);

  io.emit('state_updated', state);
  res.json({ success: true });
});

function advanceBracket(trn, completedMatch) {
  const finalMatch = trn.matches.find(m => m.round === 'Final');
  if (!finalMatch) return;

  if (!finalMatch.playerA.id) {
    finalMatch.playerA = completedMatch.winner;
  } else if (!finalMatch.playerB.id) {
    finalMatch.playerB = completedMatch.winner;
    finalMatch.status = 'AWAITING_CODE';
    addLog('BRACKET ENGINE', `Final Match unlocked: ${finalMatch.playerA.name} vs ${finalMatch.playerB.name}`);
  }
}

app.get('/api/state', (req, res) => res.json(state));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`EFOOTBALL ARENA Automation Server active on http://localhost:${PORT}`));
