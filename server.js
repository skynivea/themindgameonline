const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const rooms = {};

// 💻 [수정본] 올바르게 작동하는 카드 섞기(셔플) 함수
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // 이 부분의 세미콜론(;) 누락과 문법을 확실하게 수정했습니다.
    let temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', (nickname) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    socket.join(roomCode);
    rooms[roomCode] = { players: [{ id: socket.id, name: nickname, isHost: true }] };
    currentRoom = roomCode;
    socket.emit('room_created', roomCode);
    io.to(roomCode).emit('update_players', rooms[roomCode].players);
  });

  socket.on('join_room', (data) => {
    const { code, nickname } = data;
    if (rooms[code] && rooms[code].players.length < 4) {
      socket.join(code);
      rooms[code].players.push({ id: socket.id, name: nickname, isHost: false });
      currentRoom = code;
      socket.emit('room_joined', code);
      io.to(code).emit('update_players', rooms[code].players);
    } else {
      socket.emit('error_msg', '방이 없거나 꽉 찼습니다.');
    }
  });

  socket.on('start_game', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    const pCount = room.players.length;
    
    let maxLvl = 12, startLives = 2, startShuri = 1;
    if (pCount === 3) { maxLvl = 10; startLives = 3; }
    if (pCount >= 4) { maxLvl = 8; startLives = 4; }

    room.gameState = {
      level: 1, maxLevel: maxLvl, lives: startLives, shurikens: startShuri, playedCards: [],
      focusPlayers: [], // 현재 정신 집중 중인 플레이어 ID 목록
      readyPlayers: []  // 다음 레벨 준비 완료를 누른 플레이어 ID 목록
    };

    // 게임 시작 시 카드를 바로 섞지 않고, '정신 집중' 단계를 먼저 시작합니다.
    startFocusPhase(room, roomCode);
  });

  // ★ 정신 집중: 마우스 클릭 유지(KeyDown/MouseDown)
  socket.on('focus_hand_down', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState || room.gameState.isFocusComplete) return;

    if (!room.gameState.focusPlayers.includes(socket.id)) {
      room.gameState.focusPlayers.push(socket.id);
      io.to(roomCode).emit('update_focus_status', room.gameState.focusPlayers);
      
      // 모든 인원이 손을 모았는지 확인
      if (room.gameState.focusPlayers.length === room.players.length) {
        room.gameState.isFocusComplete = true;
        io.to(roomCode).emit('focus_success_countdown');
        
        // 2초 뒤에 실제로 카드를 배분하고 본격 게임 레이아웃을 쏩니다.
        setTimeout(() => {
          if(room && room.gameState) {
            dealCards(room);
            // 정신집중 완료 후 플래그 초기화
            room.gameState.focusPlayers = [];
            room.gameState.isFocusComplete = false;
          }
        }, 2000);
      }
    }
  });

  // ★ 정신 집중: 마우스 뗌(KeyUp/MouseUp) -> 손 뗌 처리
  socket.on('focus_hand_up', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState || room.gameState.isFocusComplete) return;

    const idx = room.gameState.focusPlayers.indexOf(socket.id);
    if (idx !== -1) {
      room.gameState.focusPlayers.splice(idx, 1);
      io.to(roomCode).emit('update_focus_status', room.gameState.focusPlayers);
    }
  });

 socket.on('play_card', (data) => {
    const { roomCode, cardNumber } = data;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    let lowestCard = 101;
    let lowestPlayer = null;
    room.players.forEach(p => {
      if (p.hand && p.hand.length > 0 && p.hand[0] < lowestCard) {
        lowestCard = p.hand[0];
        lowestPlayer = p;
      }
    });

    const playingPlayer = room.players.find(p => p.id === socket.id);
    if (!playingPlayer) return;

    if (cardNumber === lowestCard) {
      // [수정] 내 손패에서 카드를 확실하게 먼저 제거합니다.
      playingPlayer.hand.shift();
      room.gameState.playedCards.push({ val: cardNumber, isMistake: false });
      
      // [수정] 카드가 완전히 지워진 것을 확인한 '후'에 레벨 클리어를 체크합니다!
      if (!checkLevelComplete(room, roomCode)) {
        sendGameState(room);
      }
    } else {
      room.gameState.lives--;
      lowestPlayer.hand.shift();
      room.gameState.playedCards.push({ val: lowestCard, isMistake: true });
      
      io.to(roomCode).emit('mistake_animation', { 
        lowestCard: lowestCard, 
        lives: room.gameState.lives 
      });

      if (room.gameState.lives <= 0) {
        setTimeout(() => {
          io.to(roomCode).emit('game_over_trigger', "💀 목숨을 모두 잃었습니다. 게임 오버!");
        }, 2500);
      } else {
        setTimeout(() => {
          if (!checkLevelComplete(room, roomCode)) sendGameState(room);
        }, 2500);
      }
    }
  });

  // ★ 버그 2번 해결: 타인이 클릭했을 때 카드가 중복 리프레시되는 버그 차단
  socket.on('next_level_ready', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    if (!room.gameState.readyPlayers.includes(socket.id)) {
      room.gameState.readyPlayers.push(socket.id);
    }

    // 모든 인원이 클릭해서 합의했을 때만 딱 한 번 다음 레벨 정신 집중 페이즈로 이동
    if (room.gameState.readyPlayers.length === room.players.length) {
      room.gameState.readyPlayers = []; // 초기화
      startFocusPhase(room, roomCode);
    }
  });

  socket.on('propose_shuriken', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState || room.gameState.shurikens <= 0 || room.gameState.shurikenVote) return;
    
    room.gameState.shurikenVote = { yes: 0, no: 0, total: room.players.length, voters: [] };
    io.to(roomCode).emit('start_shuriken_vote', { total: room.players.length });
  });

  socket.on('vote_shuriken', (data) => {
    const { roomCode, vote } = data;
    const room = rooms[roomCode];
    if (!room || !room.gameState || !room.gameState.shurikenVote) return;
    
    if (room.gameState.shurikenVote.voters.includes(socket.id)) return;
    
    room.gameState.shurikenVote.voters.push(socket.id);
    if (vote === 'yes') room.gameState.shurikenVote.yes++;
    else room.gameState.shurikenVote.no++;
    
    io.to(roomCode).emit('update_shuriken_vote', {
      yes: room.gameState.shurikenVote.yes,
      no: room.gameState.shurikenVote.no,
      total: room.players.length
    });

    if (room.gameState.shurikenVote.voters.length === room.players.length) {
      if (room.gameState.shurikenVote.yes === room.players.length) {
        room.gameState.shurikens--;
        let discardedCards = [];
        
        room.players.forEach(p => {
          if (p.hand && p.hand.length > 0) {
            const card = p.hand.shift();
            discardedCards.push(card);
          }
        });
        
        discardedCards.sort((a, b) => a - b);
        discardedCards.forEach(card => {
          room.gameState.playedCards.push({ val: card, isMistake: false });
        });
        
        io.to(roomCode).emit('shuriken_success_trigger', discardedCards);
        delete room.gameState.shurikenVote;
        
        setTimeout(() => {
          if (!checkLevelComplete(room, roomCode)) sendGameState(room);
        }, 1000);
      } else {
        io.to(roomCode).emit('shuriken_cancelled_trigger');
        delete room.gameState.shurikenVote;
        sendGameState(room);
      }
    }
  });

  socket.on('send_emoticon', (data) => {
    const { roomCode, emoticon } = data;
    io.to(roomCode).emit('show_emoticon', { playerId: socket.id, emoticon: emoticon });
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index !== -1) {
      const wasHost = room.players[index].isHost;
      room.players.splice(index, 1);
      
      if (room.players.length === 0) {
        delete rooms[currentRoom];
        return;
      }

      if (wasHost && room.players.length > 0) {
        room.players[0].isHost = true;
      }

      if (room.gameState) {
        if (room.gameState.shurikenVote) delete room.gameState.shurikenVote;
        
        // 정신집중 인원 보정
        const fIdx = room.gameState.focusPlayers.indexOf(socket.id);
        if (fIdx !== -1) room.gameState.focusPlayers.splice(fIdx, 1);

        // 레벨 준비 인원 보정
        const rIdx = room.gameState.readyPlayers.indexOf(socket.id);
        if (rIdx !== -1) room.gameState.readyPlayers.splice(rIdx, 1);

        io.to(currentRoom).emit('shuriken_cancelled_trigger');
      }

      io.to(currentRoom).emit('update_players', room.players);
      
      if (room.gameState) {
        if (!checkLevelComplete(room, currentRoom)) sendGameState(room);
      }
    }
  });

  // ★ 정신 집중 전용 화면 트리거 함수
  function startFocusPhase(room, roomCode) {
    const playerInfos = room.players.map(p => ({ id: p.id, name: p.name }));
    io.to(roomCode).emit('trigger_focus_phase', {
      level: room.gameState.level,
      lives: room.gameState.lives,
      shurikens: room.gameState.shurikens,
      allPlayers: playerInfos
    });
  }

function dealCards(room) {
    let deck = Array.from({length: 100}, (_, i) => i + 1);
    shuffle(deck);
    room.gameState.playedCards = [];

    room.players.forEach(player => {
      player.hand = [];
      for (let i = 0; i < room.gameState.level; i++) player.hand.push(deck.pop());
      
      // [수정] 자바스크립트 오름차순 숫자 정렬 오류를 완벽하게 해결 (a - b 추가)
      player.hand.sort((a, b) => a - b);
    });
    sendGameState(room);
  }
  function checkLevelComplete(room, roomCode) {
    const remaining = room.players.reduce((acc, p) => acc + (p.hand ? p.hand.length : 0), 0);
    if (remaining === 0) {
      if (room.gameState.level === room.gameState.maxLevel) {
        io.to(roomCode).emit('game_over_trigger', "🎉 축하합니다! 모든 레벨을 클리어했습니다! 게임 승리!");
      } else {
        const clearedLvl = room.gameState.level;
        room.gameState.level++;
        
        if (clearedLvl === 2) room.gameState.shurikens++;
        if (clearedLvl === 3) room.gameState.lives++;
        if (clearedLvl === 5) room.gameState.shurikens++;
        if (clearedLvl === 6) room.gameState.lives++;
        if (clearedLvl === 8) room.gameState.shurikens++;
        if (clearedLvl === 9) room.gameState.lives++;

        io.to(roomCode).emit('level_clear_trigger', {
          cleared: clearedLvl,
          next: room.gameState.level
        });
      }
      return true;
    }
    return false;
  }

  function sendGameState(room) {
    const playerInfos = room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand ? p.hand.length : 0 }));
    room.players.forEach(player => {
      io.to(player.id).emit('update_game_state', {
        level: room.gameState.level,
        lives: room.gameState.lives,
        shurikens: room.gameState.shurikens,
        playedCards: room.gameState.playedCards,
        myHand: player.hand || [],
        allPlayers: playerInfos
      });
    });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 오픈! 포트: ${PORT}`));
