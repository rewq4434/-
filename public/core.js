// 오목 방/게임 규칙 — Node 서버와 브라우저(P2P 방장) 양쪽에서 같이 사용
// 연결(conn)은 { send(msgObject) } 만 있으면 됨
(function (root) {
  const SIZE = 15;

  function createGame(opts = {}) {
    const rooms = new Map();

    const newBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    const genCode = () => {
      let c;
      do { c = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (c.length < 5 || rooms.has(c));
      return c;
    };
    const send = (c, msg) => { if (c) try { c.send(msg); } catch (e) {} };
    const everyone = room => [...room.players.filter(Boolean), ...room.spectators];
    const broadcast = (room, msg) => everyone(room).forEach(c => send(c, msg));
    const cleanName = n => String(n || '익명').slice(0, 12);

    function createRoom(code) {
      const room = {
        code, board: newBoard(), players: [null, null], spectators: new Set(),
        turn: 1, winner: 0, winLine: null, moves: [], rematch: new Set(), started: false, undoReq: 0,
      };
      rooms.set(code, room);
      return room;
    }

    function sync(room) {
      const base = {
        type: 'state', code: room.code, board: room.board, turn: room.turn,
        winner: room.winner, winLine: room.winLine, last: room.moves[room.moves.length - 1] || null,
        started: room.started, players: room.players.map(p => (p ? p.name : null)),
        spectators: room.spectators.size, rematch: [...room.rematch],
      };
      everyone(room).forEach(c => send(c, { ...base, you: c.color }));
    }

    function checkWin(b, x, y, col) {
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const line = [[x, y]];
        for (const s of [1, -1]) {
          let nx = x + dx * s, ny = y + dy * s;
          while (nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE && b[ny][nx] === col) {
            line.push([nx, ny]); nx += dx * s; ny += dy * s;
          }
        }
        if (line.length >= 5) return line;
      }
      return null;
    }

    function resetGame(room) {
      room.board = newBoard(); room.turn = 1; room.winner = 0; room.winLine = null;
      room.moves = []; room.rematch.clear(); room.started = true; room.undoReq = 0;
    }

    function leave(c) {
      const room = c.room;
      if (!room) return;
      c.room = null;
      if (c.color === 1 || c.color === 2) {
        room.players[c.color - 1] = null;
        room.rematch.clear();
        if (room.started && !room.winner) {
          room.winner = 3 - c.color;
          broadcast(room, { type: 'info', text: `${c.name} 님이 나가서 기권 처리되었습니다.` });
        } else broadcast(room, { type: 'info', text: `${c.name} 님이 나갔습니다.` });
      } else room.spectators.delete(c);
      c.color = 0;
      if (everyone(room).length === 0) rooms.delete(room.code);
      else sync(room);
    }

    function join(c, room) {
      leave(c);
      c.room = room;
      const empty = room.players.findIndex(p => p === null);
      if (empty !== -1 && !(room.started && !room.winner)) { room.players[empty] = c; c.color = empty + 1; }
      else { room.spectators.add(c); c.color = 0; }
      if (room.players[0] && room.players[1] && (!room.started || room.winner)) resetGame(room);
      send(c, { type: 'joined', code: room.code, color: c.color });
      broadcast(room, { type: 'info', text: `${c.name} 님이 ${c.color ? (c.color === 1 ? '흑' : '백') + '으로' : '관전자로'} 입장했습니다.` });
      sync(room);
    }

    function connect(c) { c.name = '익명'; c.room = null; c.color = 0; }

    function message(c, m) {
      if (!m || typeof m !== 'object') return;
      const room = c.room;
      switch (m.type) {
        case 'create': {
          c.name = cleanName(m.name);
          const code = opts.allowCode && m.code ? String(m.code) : genCode();
          join(c, rooms.get(code) || createRoom(code));
          break;
        }
        case 'join': {
          c.name = cleanName(m.name);
          const r = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!r) return send(c, { type: 'error', text: '존재하지 않는 방 코드입니다.' });
          join(c, r);
          break;
        }
        case 'quick': {
          c.name = cleanName(m.name);
          const r = [...rooms.values()].find(r => !r.started && r.players.filter(Boolean).length === 1);
          join(c, r || createRoom(genCode()));
          break;
        }
        case 'move': {
          if (!room || !room.started || room.winner) return;
          if (c.color !== room.turn) return send(c, { type: 'error', text: '당신의 차례가 아닙니다.' });
          const x = m.x | 0, y = m.y | 0;
          if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || room.board[y][x]) return;
          room.board[y][x] = c.color;
          room.moves.push({ x, y, c: c.color });
          room.undoReq = 0;
          const line = checkWin(room.board, x, y, c.color);
          if (line) { room.winner = c.color; room.winLine = line; }
          else if (room.moves.length === SIZE * SIZE) room.winner = -1;
          else room.turn = 3 - room.turn;
          sync(room);
          break;
        }
        case 'undo': {
          if (!room || !c.color || room.winner || !room.moves.length) return;
          if (room.moves[room.moves.length - 1].c !== c.color)
            return send(c, { type: 'error', text: '자신이 둔 직후에만 무르기를 요청할 수 있습니다.' });
          room.undoReq = c.color;
          send(room.players[2 - c.color], { type: 'undoReq', from: c.name });
          send(c, { type: 'info', text: '무르기를 요청했습니다.' });
          break;
        }
        case 'undoReply': {
          if (!room || !c.color || room.undoReq !== 3 - c.color) return;
          room.undoReq = 0;
          if (m.accept && !room.winner) {
            const last = room.moves.pop();
            if (last) { room.board[last.y][last.x] = 0; room.turn = last.c; }
            broadcast(room, { type: 'info', text: '무르기가 수락되었습니다.' });
            sync(room);
          } else send(room.players[2 - c.color], { type: 'info', text: '상대가 무르기를 거절했습니다.' });
          break;
        }
        case 'resign': {
          if (!room || !c.color || !room.started || room.winner) return;
          room.winner = 3 - c.color;
          broadcast(room, { type: 'info', text: `${c.name} 님이 기권했습니다.` });
          sync(room);
          break;
        }
        case 'rematch': {
          if (!room || !c.color || !room.winner) return;
          room.rematch.add(c.color);
          if (room.players[0] && room.players[1] && room.rematch.size === 2) {
            room.players.reverse();
            room.players.forEach((p, i) => { p.color = i + 1; });
            resetGame(room);
            broadcast(room, { type: 'info', text: '새 게임 시작! 흑백이 교체되었습니다.' });
          }
          sync(room);
          break;
        }
        case 'chat': {
          if (!room) return;
          const text = String(m.text || '').slice(0, 200).trim();
          if (text) broadcast(room, { type: 'chat', name: c.name, color: c.color, text });
          break;
        }
        case 'leave': leave(c); send(c, { type: 'left' }); break;
      }
    }

    return { connect, message, close: leave, rooms };
  }

  const api = { createGame, SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmokCore = api;
})(typeof window !== 'undefined' ? window : this);
