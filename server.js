const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const rooms = {};

// 💻 카드 섞기(셔플) 함수
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

  // 🛠️ 대폭 수정 및 보완된 play_card 이벤트
  socket.on('play_card', (data) => {
    const { roomCode, cardNumber } = data;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    let lowestCard = 101;
    room.players.forEach(p => {
      if (p.hand && p.hand.length > 0 && p.hand[0] < lowestCard) {
        lowestCard = p.hand[0];
      }
    });

    const playingPlayer = room.players.find(p => p.id === socket.id);
    if (!playingPlayer) return;

    if (cardNumber === lowestCard) {
      playingPlayer.hand.shift();
      room.gameState.playedCards.push({ val: cardNumber, isMistake: false });
      
      if (!checkLevelComplete(room, roomCode)) {
        sendGameState(room);
      }
    } else {
      room.gameState.lives--;
      let cardsToDiscard = [];

      room.players.forEach(p => {
        if (p.hand && p.hand.length > 0) {
          while (p.hand.length > 0 && p.hand[0] < cardNumber) {
            const lowCard = p.hand.shift();
            cardsToDiscard.push({
              playerId: p.id,
              playerName: p.name,
              val: lowCard
            });
          }
        }
      });

      const playingPlayerCardIdx = playingPlayer.hand.indexOf(cardNumber);
      if (playingPlayerCardIdx !== -1) {
        playingPlayer.hand.splice(playingPlayerCardIdx, 1);
      }
      
      const wrongCardInfo = {
        playerId: playingPlayer.id,
        playerName: playingPlayer.name,
        val: cardNumber,
        isTriggerCard: true 
      };

      cardsToDiscard.sort((a, b) => a.val - b.val);
      cardsToDiscard.push(wrongCardInfo);

      cardsToDiscard.forEach(item => {
        room.gameState.playedCards.push({ val: item.val, isMistake: true });
      });

      io.to(roomCode).emit('mistake_animation', { 
        message: `🚨 ${playingPlayer.name}님이 순서를 어기고 ${cardNumber}번 카드를 잘못 냈습니다!`,
        lives: room.gameState.lives,
        sequence: cardsToDiscard 
      });

      const totalAnimationTime = 1500 + (cardsToDiscard.length * 1000); 

      if (room.gameState.lives <= 0) {
        setTimeout(() => {
          io.to(roomCode).emit('game_over_trigger', "💀 목숨을 모두 잃었습니다. 게임 오버!");
        }, totalAnimationTime);
      } else {
        setTimeout(() => {
          if (!checkLevelComplete(room, roomCode)) {
            sendGameState(room);
          }
        }, totalAnimationTime);
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
          if (!p.shurikenCards) p.shurikenCards = []; 

          if (p.hand && p.hand.length > 0) {
            const minCard = Math.min(...p.hand);
            const cardIdx = p.hand.indexOf(minCard);
            
            if (cardIdx !== -1) {
              p.hand.splice(cardIdx, 1); 
              p.shurikenCards.push(minCard); 
              discardedCards.push({ playerId: p.id, playerName: p.name, card: minCard });
            }
          }
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
      player.shurikenCards = []; 
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
    const playerInfos = room.players.map(p => ({ 
      id: p.id, 
      name: p.name, 
      cardCount: p.hand ? p.hand.length : 0,
      shurikenCards: p.shurikenCards || []
    }));

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
