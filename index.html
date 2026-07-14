const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const rooms = {};

// 💻 올바르게 작동하는 카드 섞기(셔플) 함수
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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
    
    // [버그 수정 2번] 변수명을 확실하게 통일하여 인원별 수리검/목숨 세팅 오류 해결
    let maxLvl = 12, startLives = 2, startShurikens = 1;
    if (pCount === 3) { maxLvl = 10; startLives = 3; startShurikens = 1; }
    if (pCount >= 4) { maxLvl = 8; startLives = 4; startShurikens = 1; }

    room.gameState = {
      level: 1, maxLevel: maxLvl, lives: startLives, shurikens: startShurikens, playedCards: [],
      focusPlayers: [], 
      readyPlayers: []  
    };

    startFocusPhase(room, roomCode);
  });

  socket.on('focus_hand_down', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState || room.gameState.isFocusComplete) return;

    if (!room.gameState.focusPlayers.includes(socket.id)) {
      room.gameState.focusPlayers.push(socket.id);
      io.to(roomCode).emit('update_focus_status', room.gameState.focusPlayers);
      
      if (room.gameState.focusPlayers.length === room.players.length) {
        room.gameState.isFocusComplete = true;
        io.to(roomCode).emit('focus_success_countdown');
        
        setTimeout(() => {
          if(room && room.gameState) {
            dealCards(room);
            room.gameState.focusPlayers = [];
            room.gameState.isFocusComplete = false;
          }
        }, 2000);
      }
    }
  });

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

    // 1. 현재 전 서버 통틀어 가장 낮은 카드가 무엇인지 탐색
    let lowestCard = 101;
    room.players.forEach(p => {
      if (p.hand && p.hand.length > 0 && p.hand[0] < lowestCard) {
        lowestCard = p.hand[0];
      }
    });

    const playingPlayer = room.players.find(p => p.id === socket.id);
    if (!playingPlayer) return;

    // 2. 오름차순 원칙 검사
    if (cardNumber === lowestCard) {
      // 정답인 경우: 낸 사람의 손패 맨 앞장 제거
      playingPlayer.hand.shift();
      room.gameState.playedCards.push({ val: cardNumber, isMistake: false });
      
      if (!checkLevelComplete(room, roomCode)) {
        sendGameState(room);
      }
    } else {
      // [버그 수정 5번] 오답인 경우 원작 규칙 적용:
      // 낸 카드(cardNumber)보다 낮거나 같은 카드를 들고 있던 '모든 플레이어'의 카드를 강제로 다 공개하고 버립니다.
      room.gameState.lives--;
      
      room.players.forEach(p => {
        if (p.hand && p.hand.length > 0) {
          // 낸 카드보다 작은 카드가 손패에 있다면 전부 추출해서 버림 처리
          while (p.hand.length > 0 && p.hand[0] < cardNumber) {
            const lowCard = p.hand.shift();
            room.gameState.playedCards.push({ val: lowCard, isMistake: true });
          }
        }
      });

      // 방금 낸 카드 자체도 손패에서 지우고 바닥에 깔아줍니다.
      playingPlayer.hand.shift();
      room.gameState.playedCards.push({ val: cardNumber, isMistake: true });
      
      // 버려진 카드들을 숫자 순서대로 이쁘게 정렬해서 히스토리에 반영
      room.gameState.playedCards.sort((a, b) => a.val - b.val);

      io.to(roomCode).emit('mistake_animation', { 
        lowestCard: cardNumber, // 낸 카드를 기준으로 애니메이션 작동
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

  socket.on('next_level_ready', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    if (!room.gameState.readyPlayers.includes(socket.id)) {
      room.gameState.readyPlayers.push(socket.id);
    }

    if (room.gameState.readyPlayers.length === room.players.length) {
      room.gameState.readyPlayers = []; 
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
            p.hand.sort((a, b) => a - b);
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
      room.players.splice(index, 1);
      
      // [버그 수정 1번] 게임 도중 누군가 탈주하면 남은 사람들을 메인 화면으로 강제 이동시킵니다.
      if (room.players.length === 0) {
        delete rooms[currentRoom];
      } else {
        io.to(currentRoom).emit('game_over_trigger', "🚨 플레이어가 퇴장하여 게임을 더 이상 진행할 수 없습니다. 방이 폭파됩니다.");
        delete rooms[currentRoom];
      }
    }
  });

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
