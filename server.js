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

    // 1. 현재 게임에 남은 카드 중 가장 낮은 카드 탐색
    let lowestCard = 101;
    room.players.forEach(p => {
      if (p.hand && p.hand.length > 0 && p.hand[0] < lowestCard) {
        lowestCard = p.hand[0];
      }
    });

    const playingPlayer = room.players.find(p => p.id === socket.id);
    if (!playingPlayer) return;

    // --- [A] 정답인 경우 ---
    if (cardNumber === lowestCard) {
      playingPlayer.hand.shift();
      room.gameState.playedCards.push({ val: cardNumber, isMistake: false });
      
      if (!checkLevelComplete(room, roomCode)) {
        sendGameState(room);
      }
    } 
    // --- [B] 오답(실수)인 경우 ---
    else {
      room.gameState.lives--;
      
      // 누적해서 떨어뜨려야 할(버려져야 할) 카드들의 상세 정보를 담을 배열
      // 예: [{ playerId: 'abc', playerName: '철수', val: 12 }, { playerId: 'def', playerName: '영희', val: 24 }]
      let cardsToDiscard = [];

      // 1. 낸 카드보다 작은 카드를 들고 있는 플레이어들의 정보를 수집합니다.
      room.players.forEach(p => {
        if (p.hand && p.hand.length > 0) {
          // 낸 카드보다 작거나 같은 카드가 있다면 전부 추출하여 목록에 추가
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

      // 2. 방금 본인이 잘못 낸 카드 자체도 손패에서 지우고 목록 맨 뒤에 추가해 줍니다.
      const playingPlayerCardIdx = playingPlayer.hand.indexOf(cardNumber);
      if (playingPlayerCardIdx !== -1) {
        playingPlayer.hand.splice(playingPlayerCardIdx, 1);
      }
      
      // 방금 잘못 낸 카드의 정보도 저장
      const wrongCardInfo = {
        playerId: playingPlayer.id,
        playerName: playingPlayer.name,
        val: cardNumber,
        isTriggerCard: true // 이 카드가 실수를 유발한 카드임을 표시
      };

      // 3. 수집된 버릴 카드들(cardsToDiscard)을 오름차순 정렬합니다.
      // (프론트엔드가 이 순서대로 하이라이트를 주며 천천히 떨어뜨리는 연출을 할 수 있도록 보장합니다)
      cardsToDiscard.sort((a, b) => a.val - b.val);
      
      // 정렬된 리스트의 맨 마지막에 '잘못 낸 기준 카드'를 덧붙여 줍니다.
      cardsToDiscard.push(wrongCardInfo);

      // 4. 서버의 playedCards 기록 데이터에도 순서대로 넣어줍니다.
      cardsToDiscard.forEach(item => {
        room.gameState.playedCards.push({ val: item.val, isMistake: true });
      });

      // 5. 프론트엔드로 연출용 데이터를 전송합니다.
      // 알림 메시지 문구와 순차적으로 떨어져야 할 카드 리스트를 함께 내려줍니다.
      io.to(roomCode).emit('mistake_animation', { 
        message: `🚨 ${playingPlayer.name}님이 순서를 어기고 ${cardNumber}번 카드를 잘못 냈습니다!`,
        lives: room.gameState.lives,
        sequence: cardsToDiscard // 프론트에서 순서대로 애니메이션 처리할 배열 데이터
      });

      // 6. 패배 여부 확인 및 다음 상태 전송 딜레이 설정
      // 카드가 떨어지는 연출 시간을 벌기 위해 넉넉히 딜레이(예: 카드당 1초씩 걸리므로 유동적으로 조절)를 줍니다.
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
          if (!p.shurikenCards) p.shurikenCards = []; // 안전망 코드

          if (p.hand && p.hand.length > 0) {
            // 가장 안전하게 최솟값 찾기
            const minCard = Math.min(...p.hand);
            const cardIdx = p.hand.indexOf(minCard);
            
            if (cardIdx !== -1) {
              p.hand.splice(cardIdx, 1); // 손패에서 제거
              
              // [수정] 공용 패에 넣지 않고, 이 플레이어의 '개인 공개 공간'에 추가합니다.
              p.shurikenCards.push(minCard); 
              
              // 클라이언트 애니메이션이나 알림용 임시 배열에도 정보 저장
              discardedCards.push({ playerId: p.id, playerName: p.name, card: minCard });
            }
          }
        });
        
        // 프론트엔드에서 수리검 연출을 띄울 수 있도록 이벤트를 보냅니다.
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
      player.shurikenCards = []; // [수정] 이번 레벨에서 수리검으로 공개한 카드를 담을 배열 생성
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
    // [수정] 각 플레이어의 남은 카드 장수뿐만 아니라, 수리검으로 공개한 카드 목록(shurikenCards)도 함께 전송합니다.
    const playerInfos = room.players.map(p => ({ 
      id: p.id, 
      name: p.name, 
      cardCount: p.hand ? p.hand.length : 0,
      shurikenCards: p.shurikenCards || [] // 프론트가 프로필 밑에 그려줄 데이터
    }));

    room.players.forEach(player => {
      io.to(player.id).emit('update_game_state', {
        level: room.gameState.level,
        lives: room.gameState.lives,
        shurikens: room.gameState.shurikens,
        playedCards: room.gameState.playedCards, // 중앙에 제출된 일반 카드 더미
        myHand: player.hand || [],
        allPlayers: playerInfos
      });
    });
  }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 오픈! 포트: ${PORT}`));
