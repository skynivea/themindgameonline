const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const rooms = {};

// 💻 피셔-예이츠 셔플 알고리즘
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

  // 방 만들기
  socket.on('create_room', (nickname) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    socket.join(roomCode);
    rooms[roomCode] = { 
      players: [{ id: socket.id, name: nickname, isHost: true }] 
    };
    currentRoom = roomCode;
    socket.emit('room_created', roomCode);
    io.to(roomCode).emit('update_players', rooms[roomCode].players);
  });

  // 방 참가하기
  socket.on('join_room', (data) => {
    const { code, nickname } = data;
    if (rooms[code] && rooms[code].players.length < 4) {
      socket.join(code);
      rooms[code].players.push({ id: socket.id, name: nickname, isHost: false });
      currentRoom = code;
      socket.emit('room_joined', code);
      io.to(code).emit('update_players', rooms[code].players);
    } else {
      socket.emit('error_msg', '방이 없거나 가득 찼습니다.');
    }
  });

  // 게임 시작 세팅
  socket.on('start_game', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    const pCount = room.players.length;
    
    let maxLvl = 12, startLives = 2, startShurikens = 1;
    if (pCount === 3) { maxLvl = 10; startLives = 3; startShurikens = 1; }
    if (pCount >= 4) { maxLvl = 8; startLives = 4; startShurikens = 1; }

    room.gameState = {
      level: 1, 
      maxLevel: maxLvl, 
      lives: startLives, 
      shurikens: startShurikens, 
      playedCards: [],
      focusPlayers: [], 
      readyPlayers: [],
      hasMistakeInLevel: false // 라운드 동안 실수 발생 기록 여부
    };

    startFocusPhase(room, roomCode);
  });

  // 합심(포커스) 손 내리기
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
          if (room && room.gameState) {
            dealCards(room);
            room.gameState.focusPlayers = [];
            room.gameState.isFocusComplete = false;
          }
        }, 2000);
      }
    }
  });

  // 합심(포커스) 손 떼기
  socket.on('focus_hand_up', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState || room.gameState.isFocusComplete) return;

    const idx = room.gameState.focusPlayers.indexOf(socket.id);
    if (idx !== -1) {
      room.gameState.focusPlayers.splice(idx, 1);
      io.to(roomCode).emit('update_focus_status', room.gameState.focusPlayers);
    }
  });

  // 카드 플레이 메인 로직
  socket.on('play_card', (data) => {
    const { roomCode, cardNumber } = data;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    const playingPlayer = room.players.find(p => p.id === socket.id);
    if (!playingPlayer) return;

    // 예외 처리: 유저가 쥐고 있지 않은 카드를 렉/연타로 중복 제출하려는 경우 방어
    if (!playingPlayer.hand || !playingPlayer.hand.includes(cardNumber)) {
      return; 
    }

    // 현재 모든 플레이어가 쥐고 있는 패 중 진짜 최저값 구하기
    let lowestCard = 101;
    room.players.forEach(p => {
      if (p.hand && p.hand.length > 0 && p.hand[0] < lowestCard) {
        lowestCard = p.hand[0];
      }
    });

    // 1) 정답 처리
    if (cardNumber === lowestCard) {
      playingPlayer.hand.shift(); // 정답 카드는 내 패에서 삭제
      room.gameState.playedCards.push({ val: cardNumber, isMistake: false });
      
      if (!checkLevelComplete(room, roomCode)) {
        sendGameState(room);
      }
    } 
    // 2) 오답 처리 (누군가 더 낮은 카드를 들고 있었는데 먼저 낸 경우)
    else {
      room.gameState.lives--;
      room.gameState.hasMistakeInLevel = true; // 실수 발생 기록! (클리어 문구 제어용)
      
      let cardsToDiscard = [];

      // 잘못 제출된 카드보다 작거나 같은 카드를 갖고 있던 사람들의 손패를 강제로 모조리 공개 및 탈탈 털기
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

      // 낸 사람 본인의 손패에서도 해당 카드 소거
      const cardIndex = playingPlayer.hand.indexOf(cardNumber);
      if (cardIndex !== -1) {
        playingPlayer.hand.splice(cardIndex, 1);
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

      // 애니메이션 연출을 위해 전송 (즉시 업데이트된 하트 수 전송으로 선반영 보장)
      io.to(roomCode).emit('mistake_animation', { 
        message: `🚨 ${playingPlayer.name}님이 타이밍을 놓치고 ${cardNumber}번 카드를 내버렸습니다!`,
        lives: room.gameState.lives,
        sequence: cardsToDiscard 
      });

      const totalAnimationTime = 1500 + (cardsToDiscard.length * 1000); 

      // 오답 애니메이션 연출이 끝난 다음에 라이프 0 판정 및 다음 스텝 이동
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

  // 다음 레벨 대기 준비
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

  // 수리검 제안
  socket.on('propose_shuriken', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState || room.gameState.shurikens <= 0 || room.gameState.shurikenVote) return;
    
    room.gameState.shurikenVote = { yes: 0, no: 0, total: room.players.length, voters: [] };
    io.to(roomCode).emit('start_shuriken_vote', { total: room.players.length });
  });

  // 수리검 투표 반영
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

    // 모두 투표했을 때
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
              p.shurikenCards.push(minCard); // 수리검으로 폐기된 히스토리에 누적 추가
              discardedCards.push({ playerId: p.id, playerName: p.name, val: minCard });
            }
          }
        });
        
        io.to(roomCode).emit('shuriken_success_trigger', discardedCards);
        delete room.gameState.shurikenVote;
        
        setTimeout(() => {
          if (!checkLevelComplete(room, roomCode)) {
            sendGameState(room);
          }
        }, 2500); 
      } else {
        io.to(roomCode).emit('shuriken_cancelled_trigger');
        delete room.gameState.shurikenVote;
        sendGameState(room);
      }
    }
  });

  // 이모티콘 전송
  socket.on('send_emoticon', (data) => {
    const { roomCode, emoticon } = data;
    io.to(roomCode).emit('show_emoticon', { playerId: socket.id, emoticon: emoticon });
  });

  // 연결 끊김 예외 처리 및 방 폭파
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index !== -1) {
      room.players.splice(index, 1);
      
      // 누군가 퇴장하면 방 폭파하고 남은 유저들에게 퇴장 트리거를 뿌립니다.
      if (room.players.length === 0) {
        delete rooms[currentRoom];
      } else {
        io.to(currentRoom).emit('game_over_trigger', "🚨 플레이어가 퇴장하여 게임을 계속할 수 없습니다. 대기실로 돌아갑니다.");
        delete rooms[currentRoom];
      }
    }
  });

  // 집중 단계 초기화 알림
  function startFocusPhase(room, roomCode) {
    const playerInfos = room.players.map(p => ({ id: p.id, name: p.name }));
    io.to(roomCode).emit('trigger_focus_phase', {
      level: room.gameState.level,
      lives: room.gameState.lives,
      shurikens: room.gameState.shurikens,
      allPlayers: playerInfos
    });
  }

  // 패 돌리기
  function dealCards(room) {
    let deck = Array.from({length: 100}, (_, i) => i + 1);
    shuffle(deck);
    room.gameState.playedCards = [];
    room.gameState.hasMistakeInLevel = false; // 새 라운드 시작 시 다시 깨끗한 무결성 상태로 리셋!

    room.players.forEach(player => {
      player.hand = [];
      player.shurikenCards = []; // 누적된 수리검 폐기 카드 리셋
      for (let i = 0; i < room.gameState.level; i++) {
        player.hand.push(deck.pop());
      }
      player.hand.sort((a, b) => a - b);
    });
    sendGameState(room);
  }

  // 레벨 클리어 판정
  function checkLevelComplete(room, roomCode) {
    const remaining = room.players.reduce((acc, p) => acc + (p.hand ? p.hand.length : 0), 0);
    if (remaining === 0) {
      if (room.gameState.level === room.gameState.maxLevel) {
        io.to(roomCode).emit('game_over_trigger', "🎉 축하합니다! 모든 장벽을 무너뜨리고 합심하여 완벽하게 승리했습니다!");
      } else {
        const clearedLvl = room.gameState.level;
        room.gameState.level++;
        
        // 특정 레벨별 보상 지급
        if (clearedLvl === 2) room.gameState.shurikens++;
        if (clearedLvl === 3) room.gameState.lives++;
        if (clearedLvl === 5) room.gameState.shurikens++;
        if (clearedLvl === 6) room.gameState.lives++;
        if (clearedLvl === 8) room.gameState.shurikens++;
        if (clearedLvl === 9) room.gameState.lives++;

        io.to(roomCode).emit('level_clear_trigger', {
          cleared: clearedLvl,
          next: room.gameState.level,
          perfect: !room.gameState.hasMistakeInLevel // 하트 소모 내역 여부만으로 판단
        });
      }
      return true;
    }
    return false;
  }

  // 데이터 통합 동기화 패킷 전송
  function sendGameState(room) {
    const playerInfos = room.players.map(p => ({ 
      id: p.id, 
      name: p.name, 
      cardCount: p.hand ? p.hand.length : 0,
      shurikenCards: p.shurikenCards || [] // 👈 수리검 카드가 계속 그려지도록 객체에 담음
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
