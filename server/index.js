import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import argon2 from 'argon2';
import { Chess } from 'chess.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || true } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));
app.use(express.static(path.join(__dirname, '../public')));

const games = new Map();

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cleanUsername(v) {
  return String(v || '').trim().toLowerCase();
}

async function createGame() {
  const chess = new Chess();
  const { rows } = await pool.query(
    `INSERT INTO games(fen,pgn,status) VALUES($1,$2,'waiting') RETURNING id`,
    [chess.fen(), chess.pgn()]
  );
  const id = rows[0].id;
  games.set(String(id), { chess, players: { white: null, black: null } });
  return id;
}

app.post('/api/auth/register', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const email = cleanUsername(req.body.email);
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || username).trim().slice(0, 64);

  if (!/^[a-z0-9_]{3,32}$/.test(username) || !email.includes('@') || password.length < 10) {
    return res.status(400).json({ error: 'Invalid registration data.' });
  }

  try {
    const hash = await argon2.hash(password);
    const { rows } = await pool.query(
      `INSERT INTO users(username,email,password_hash,display_name)
       VALUES($1,$2,$3,$4)
       RETURNING id,username,email,display_name,rating`,
      [username, email, hash, displayName]
    );
    res.status(201).json({ user: rows[0] });
  } catch {
    res.status(409).json({ error: 'Username or email already exists.' });
  }
});

app.post('/api/games', async (_req, res) => {
  const id = await createGame();
  res.status(201).json({ gameId: id, url: `/game/${id}` });
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,status,fen,pgn,white_user_id,black_user_id FROM games WHERE id=$1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Game not found.' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Database error.' });
  }
});

io.on('connection', socket => {
  socket.on('game:join', async ({ gameId, userId, name }) => {
    const id = String(gameId);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return socket.emit('game:error', { message: 'Invalid game.' });

    let game = games.get(id);
    if (!game) {
      const { rows } = await pool.query(`SELECT fen,pgn,white_user_id,black_user_id FROM games WHERE id=$1`, [id]);
      if (!rows[0]) return socket.emit('game:error', { message: 'Game not found.' });
      const chess = new Chess(rows[0].fen);
      if (rows[0].pgn) try { chess.loadPgn(rows[0].pgn); } catch {}
      game = { chess, players: { white: rows[0].white_user_id, black: rows[0].black_user_id } };
      games.set(id, game);
    }

    socket.join(id);
    let color = null;
    if (!game.players.white) { game.players.white = userId || socket.id; color = 'w'; }
    else if (!game.players.black && game.players.white !== (userId || socket.id)) { game.players.black = userId || socket.id; color = 'b'; }

    socket.data.gameId = id;
    socket.data.color = color;
    socket.data.userId = userId || null;

    await pool.query(
      `UPDATE games SET white_user_id=$1,black_user_id=$2,status=$3,updated_at=now() WHERE id=$4`,
      [typeof game.players.white === 'string' && game.players.white.length === 36 ? game.players.white : null,
       typeof game.players.black === 'string' && game.players.black.length === 36 ? game.players.black : null,
       game.players.black ? 'active' : 'waiting', id]
    ).catch(() => {});

    socket.emit('game:state', {
      fen: game.chess.fen(),
      pgn: game.chess.pgn(),
      color,
      players: game.players,
      name: name || 'Player'
    });
  });

  socket.on('game:move', async ({ gameId, from, to, promotion }) => {
    const id = String(gameId);
    const game = games.get(id);
    if (!game || !socket.data.color || game.chess.turn() !== socket.data.color) return;

    try {
      const move = game.chess.move({ from, to, promotion: promotion || 'q' });
      const ply = game.chess.history().length;
      await pool.query(
        `UPDATE games SET fen=$1,pgn=$2,status=$3,updated_at=now() WHERE id=$4`,
        [game.chess.fen(), game.chess.pgn(), game.chess.isGameOver() ? 'finished' : 'active', id]
      );
      await pool.query(
        `INSERT INTO moves(game_id,ply,uci,san,fen_after) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(game_id,ply) DO NOTHING`,
        [id, ply, `${move.from}${move.to}${move.promotion || ''}`, move.san, game.chess.fen()]
      );

      io.to(id).emit('game:move', {
        move,
        fen: game.chess.fen(),
        pgn: game.chess.pgn(),
        over: game.chess.isGameOver()
      });
    } catch {
      socket.emit('game:error', { message: 'Illegal move.' });
    }
  });

  socket.on('chat:send', ({ gameId, message }) => {
    const text = String(message || '').trim().slice(0, 2000);
    if (!text || !socket.data.gameId || socket.data.gameId !== String(gameId)) return;
    // Replace this plaintext relay with an audited client-side E2EE protocol.
    io.to(String(gameId)).emit('chat:message', {
      id: randomToken(), sender: socket.id, message: text, timestamp: Date.now()
    });
  });

  socket.on('chat:typing', ({ gameId, typing }) => {
    if (socket.data.gameId === String(gameId))
      socket.to(String(gameId)).emit('chat:typing', { sender: socket.id, typing: !!typing });
  });

  socket.on('call:offer', ({ target, offer }) => io.to(target).emit('call:offer', { from: socket.id, offer }));
  socket.on('call:answer', ({ target, answer }) => io.to(target).emit('call:answer', { from: socket.id, answer }));
  socket.on('call:ice', ({ target, candidate }) => io.to(target).emit('call:ice', { from: socket.id, candidate }));
  socket.on('call:end', ({ target }) => io.to(target).emit('call:end', { from: socket.id }));
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Supernova Chess: http://localhost:${port}`));
