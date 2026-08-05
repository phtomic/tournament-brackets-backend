const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const DB_PATH = path.join(__dirname, 'data', 'database.json');

// Ensure database directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Database Helpers
function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { status: 'NOT_STARTED', players: [], matches: {} };
    }
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database:', error);
    return { status: 'NOT_STARTED', players: [], matches: {} };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    // Propagate changes via WebSockets
    io.emit('tournament_update', data);
  } catch (error) {
    console.error('Error writing database:', error);
  }
}

// Bracket Generation Logic
function generateBracket(players) {
  if (!players || players.length < 2) {
    throw new Error('Tournament requires at least 2 players.');
  }

  const N = players.length;
  const R = Math.ceil(Math.log2(N));
  const P = Math.pow(2, R); // Bracket size
  const M1 = P / 2; // Matches in Round 1

  const matches = {};

  // 1. Generate all match slots for all rounds
  for (let r = 1; r <= R; r++) {
    const roundMatches = Math.pow(2, R - r);
    for (let m = 0; m < roundMatches; m++) {
      const matchId = `R${r}_M${m}`;
      
      const nextMatchId = r < R ? `R${r + 1}_M${Math.floor(m / 2)}` : null;
      const nextMatchPosition = r < R ? (m % 2 === 0 ? 'A' : 'B') : null;
      
      const prevMatchAId = r > 1 ? `R${r - 1}_M${2 * m}` : null;
      const prevMatchBId = r > 1 ? `R${r - 1}_M${2 * m + 1}` : null;

      matches[matchId] = {
        id: matchId,
        round: r,
        matchIndex: m,
        playerA: null,
        playerB: null,
        scoreA: null,
        scoreB: null,
        winner: null,
        status: 'PENDING',
        nextMatchId,
        nextMatchPosition,
        prevMatchAId,
        prevMatchBId
      };
    }
  }

  // 2. Distribute players in Round 1
  // We have M1 matches in Round 1.
  // x = N - M1 matches will have 2 players.
  // y = M1 - x = P - N matches will have 1 player and 1 BYE.
  for (let i = 0; i < M1; i++) {
    const matchId = `R1_M${i}`;
    const match = matches[matchId];

    match.playerA = players[i];

    if (i < N - M1) {
      // Normal match: 2 players
      match.playerB = players[M1 + i];
    } else {
      // BYE match: 1 player, 1 BYE
      match.playerB = { id: 'BYE', name: 'BYE', isBye: true };
      match.status = 'COMPLETED';
      match.winner = match.playerA;
    }
  }

  // 3. Propagate the winners of the BYE matches to Round 2
  propagateWinners(matches);

  return matches;
}

function generateBracketWithSeeding(customSeeding) {
  if (!customSeeding || !Array.isArray(customSeeding) || customSeeding.length < 2) {
    throw new Error('Tournament requires at least 2 seeded slots.');
  }

  const N = customSeeding.length; // Always a power of 2, e.g. 8
  const R = Math.log2(N);
  const M1 = N / 2;

  const matches = {};

  // 1. Generate all match slots for all rounds
  for (let r = 1; r <= R; r++) {
    const roundMatches = Math.pow(2, R - r);
    for (let m = 0; m < roundMatches; m++) {
      const matchId = `R${r}_M${m}`;
      
      const nextMatchId = r < R ? `R${r + 1}_M${Math.floor(m / 2)}` : null;
      const nextMatchPosition = r < R ? (m % 2 === 0 ? 'A' : 'B') : null;
      
      const prevMatchAId = r > 1 ? `R${r - 1}_M${2 * m}` : null;
      const prevMatchBId = r > 1 ? `R${r - 1}_M${2 * m + 1}` : null;

      matches[matchId] = {
        id: matchId,
        round: r,
        matchIndex: m,
        playerA: null,
        playerB: null,
        scoreA: null,
        scoreB: null,
        winner: null,
        status: 'PENDING',
        nextMatchId,
        nextMatchPosition,
        prevMatchAId,
        prevMatchBId
      };
    }
  }

  // 2. Populate Round 1 with customSeeding
  for (let i = 0; i < M1; i++) {
    const matchId = `R1_M${i}`;
    const match = matches[matchId];

    match.playerA = customSeeding[2 * i] || null;
    match.playerB = customSeeding[2 * i + 1] || null;

    // Lógica de definição de vencedores por BYE
    if (match.playerA && match.playerB) {
      if (match.playerA.isBye && match.playerB.isBye) {
        // Se ambos são BYE, o segundo BYE (playerB) vence
        match.status = 'COMPLETED';
        match.winner = match.playerB;
      } else if (match.playerA.isBye) {
        // Se apenas playerA é BYE, playerB vence
        match.status = 'COMPLETED';
        match.winner = match.playerB;
      } else if (match.playerB.isBye) {
        // Se apenas playerB é BYE, playerA vence
        match.status = 'COMPLETED';
        match.winner = match.playerA;
      }
    }
  }

  // 3. Propagate winners to subsequent rounds
  propagateWinners(matches);

  return matches;
}

function propagateWinners(matches) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const matchId in matches) {
      const match = matches[matchId];

      // 1. Propagate completed match winners to the next match slot
      if (match.status === 'COMPLETED' && match.winner && match.nextMatchId) {
        const nextMatch = matches[match.nextMatchId];
        if (nextMatch) {
          const targetSlot = match.nextMatchPosition === 'A' ? 'playerA' : 'playerB';
          if (!nextMatch[targetSlot] || nextMatch[targetSlot].id !== match.winner.id) {
            nextMatch[targetSlot] = match.winner;
            changed = true;
          }
        }
      }

      // 2. Auto-complete any PENDING match that has a BYE player (in ANY round)
      if (match.status === 'PENDING' && match.playerA && match.playerB) {
        const aIsBye = match.playerA.isBye;
        const bIsBye = match.playerB.isBye;

        if (aIsBye && bIsBye) {
          // Both are BYE: mark completed with a BYE winner to keep propagating
          match.status = 'COMPLETED';
          match.winner = match.playerB; // arbitrary, both are BYE
          changed = true;
        } else if (aIsBye) {
          match.status = 'COMPLETED';
          match.winner = match.playerB;
          changed = true;
        } else if (bIsBye) {
          match.status = 'COMPLETED';
          match.winner = match.playerA;
          changed = true;
        }
      }
    }
  }
}

// Rollback Logic
function rollbackMatch(matchId, matches) {
  const match = matches[matchId];
  if (!match || match.status === 'PENDING') return;

  // Clear current match results
  match.winner = null;
  match.scoreA = null;
  match.scoreB = null;
  match.status = 'PENDING';

  // If this match propagates to a next match, clear its slot and recursively rollback
  if (match.nextMatchId) {
    const nextMatch = matches[match.nextMatchId];
    if (nextMatch) {
      const targetSlot = match.nextMatchPosition === 'A' ? 'playerA' : 'playerB';
      nextMatch[targetSlot] = null;
      // Recursively rollback the next match since its players have changed
      rollbackMatch(match.nextMatchId, matches);
    }
  }
}

// REST API Endpoints

// Get current state
app.get('/api/tournament', (req, res) => {
  res.json(readDB());
});

// Start tournament
app.post('/api/tournament/start', (req, res) => {
  const { players, customSeeding } = req.body;

  // Prioritize Custom Seeding if provided
  if (customSeeding && Array.isArray(customSeeding) && customSeeding.length >= 2) {
    try {
      const matches = generateBracketWithSeeding(customSeeding);
      const state = {
        status: 'ACTIVE',
        players: customSeeding.filter(p => p && !p.isBye),
        matches,
        activeMatchId: null
      };
      writeDB(state);
      return res.json(state);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (!players || !Array.isArray(players) || players.length < 2) {
    return res.status(400).json({ error: 'Please provide at least 2 players.' });
  }

  // Map string names to player objects
  const playerObjects = players.map((name, index) => ({
    id: `P_${index + 1}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    name: name.trim()
  })).filter(p => p.name.length > 0);

  if (playerObjects.length < 2) {
    return res.status(400).json({ error: 'Please provide at least 2 non-empty player names.' });
  }

  try {
    const matches = generateBracket(playerObjects);
    const state = {
      status: 'ACTIVE',
      players: playerObjects,
      matches,
      activeMatchId: null
    };
    writeDB(state);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset tournament
app.post('/api/tournament/reset', (req, res) => {
  const state = { status: 'NOT_STARTED', players: [], matches: {}, activeMatchId: null };
  writeDB(state);
  res.json(state);
});

// Record score and update match
app.post('/api/tournament/match/:id/score', (req, res) => {
  const { id } = req.params;
  const { scoreA, scoreB } = req.body;

  const db = readDB();
  const match = db.matches[id];

  if (!match) {
    return res.status(404).json({ error: 'Match not found.' });
  }

  match.scoreA = parseInt(scoreA, 10);
  match.scoreB = parseInt(scoreB, 10);
  match.status = 'IN_PROGRESS';

  writeDB(db);
  res.json(db);
});

// Record win and advance winner
app.post('/api/tournament/match/:id/win', (req, res) => {
  const { id } = req.params;
  const { winnerSide, scoreA, scoreB } = req.body; // winnerSide is 'A' or 'B'

  const db = readDB();
  const match = db.matches[id];

  if (!match) {
    return res.status(404).json({ error: 'Match not found.' });
  }

  if (winnerSide === 'A') {
    match.winner = match.playerA;
  } else if (winnerSide === 'B') {
    match.winner = match.playerB;
  } else {
    return res.status(400).json({ error: "Invalid winner. Must be 'A' or 'B'." });
  }

  match.scoreA = scoreA !== undefined && scoreA !== null ? parseInt(scoreA, 10) : null;
  match.scoreB = scoreB !== undefined && scoreB !== null ? parseInt(scoreB, 10) : null;
  match.status = 'COMPLETED';

  // Propagate winner
  propagateWinners(db.matches);

  // Check if tournament is completed (i.e. final match completed)
  const allMatchIds = Object.keys(db.matches);
  const finalMatch = allMatchIds.find(mId => !db.matches[mId].nextMatchId);
  if (finalMatch && db.matches[finalMatch].status === 'COMPLETED') {
    db.status = 'COMPLETED';
  }

  writeDB(db);
  res.json(db);
});

// Rollback match
app.post('/api/tournament/match/:id/rollback', (req, res) => {
  const { id } = req.params;

  const db = readDB();
  const match = db.matches[id];

  if (!match) {
    return res.status(404).json({ error: 'Match not found.' });
  }

  rollbackMatch(id, db.matches);

  // If tournament was marked completed, but we rolled back the final (or any match), reset status to ACTIVE
  if (db.status === 'COMPLETED') {
    db.status = 'ACTIVE';
  }

  writeDB(db);
  res.json(db);
});

// Focus / Highlight a match on stream
app.post('/api/tournament/match/:id/focus', (req, res) => {
  const { id } = req.params;

  const db = readDB();
  const match = db.matches[id];

  if (!match) {
    return res.status(404).json({ error: 'Match not found.' });
  }

  if (db.activeMatchId === id) {
    db.activeMatchId = null; // Toggle focus off
  } else {
    db.activeMatchId = id; // Toggle focus on
  }

  writeDB(db);
  res.json(db);
});

// Swap players between two matches in the same round (manual bracket formation)
app.post('/api/tournament/round/:round/swap', (req, res) => {
  const round = parseInt(req.params.round, 10);
  const { matchIdA, slotA, matchIdB, slotB } = req.body;
  // slotA/slotB are 'playerA' or 'playerB'

  const db = readDB();

  const matchA = db.matches[matchIdA];
  const matchB = db.matches[matchIdB];

  if (!matchA || !matchB) {
    return res.status(404).json({ error: 'One or both matches not found.' });
  }

  if (matchA.round !== round || matchB.round !== round) {
    return res.status(400).json({ error: 'Both matches must be in the specified round.' });
  }

  // Only allow swaps on PENDING matches
  if (matchA.status !== 'PENDING' || matchB.status !== 'PENDING') {
    return res.status(400).json({ error: 'Can only swap players in PENDING matches.' });
  }

  // Perform the swap
  const temp = matchA[slotA];
  matchA[slotA] = matchB[slotB];
  matchB[slotB] = temp;

  // Re-check for BYE auto-completion after swap
  propagateWinners(db.matches);

  // Check if tournament is completed
  const allMatchIds = Object.keys(db.matches);
  const finalMatch = allMatchIds.find(mId => !db.matches[mId].nextMatchId);
  if (finalMatch && db.matches[finalMatch].status === 'COMPLETED') {
    db.status = 'COMPLETED';
  }

  writeDB(db);
  res.json(db);
});

// Manually assign a player to a specific match slot
app.post('/api/tournament/match/:id/assign', (req, res) => {
  const { id } = req.params;
  const { slot, player } = req.body; // slot is 'playerA' or 'playerB', player is a player object or null

  const db = readDB();
  const match = db.matches[id];

  if (!match) {
    return res.status(404).json({ error: 'Match not found.' });
  }

  if (match.status !== 'PENDING') {
    return res.status(400).json({ error: 'Can only assign players to PENDING matches.' });
  }

  if (slot !== 'playerA' && slot !== 'playerB') {
    return res.status(400).json({ error: "Slot must be 'playerA' or 'playerB'." });
  }

  match[slot] = player;

  // Re-check for BYE auto-completion
  propagateWinners(db.matches);

  writeDB(db);
  res.json(db);
});

// WebSockets logic
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  // Send current state immediately on connection
  socket.emit('tournament_update', readDB());

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
