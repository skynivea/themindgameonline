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
      hasMistakeInLevel: false 
    };

    startFocusPhase(room, roomCode);
  });

// 합심(포커스) 손 내리기 (정상 작동 + 강제 시작 대응)
  socket.on('focus_hand_down', (data) => {
    // 클라이언트가 단순 문자열(roomCode)을 보냈는지, 객체를 보냈는지 하이브리드 대응
    const roomCode = typeof data === 'object' ? data.roomCode : data;
    const isForce = typeof data === 'object' ? data.isForce : false;

    const room = rooms[roomCode];
    if (!room || !room.gameState || room.gameState.isFocusComplete) return;

    if (isForce) {
      // 💡 [치트키 발동] 스페이스바를 누른 경우: 즉시 전원 성공 처리
      room.players.forEach(p => {
        if (!room.gameState.focusPlayers.includes(p.id)) {
          room.gameState.focusPlayers.push(p.id);
        }
      });
    } else {
      // [정상 작동] 마우스로 직접 누른 경우: 누른 사람만 추가
      if (!room.gameState.focusPlayers.includes(socket.id)) {
        room.gameState.focusPlayers.push(socket.id);
      }
    }

    io.to(roomCode).emit('update_focus_status', room.gameState.focusPlayers);
    
    // 만약 전원이 다 눌렀거나, 치트키가 발동했다면 성공 처리
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

// 카드 플레이 메인 로직 (형님이 지적하신 진짜 깍두기 룰 반영)
  socket.on('play_card', (data) => {
    const { roomCode, cardNumber } = data;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    const playingPlayer = room.players.find(p => p.id === socket.id);
    if (!playingPlayer) return;

    if (!playingPlayer.hand || !playingPlayer.hand.includes(cardNumber)) {
      return; 
    }

    // 💡 나보다 작은 카드가 다른 사람의 손에 남아있는지 검사
    let hiddenLowerCardExists = false;

    room.players.forEach(p => {
      if (p.hand && p.hand.length > 0) {
        p.hand.forEach(card => {
          // 지금 내가 낸 카드 자체는 비교 대상에서 제외
          if (p.id === playingPlayer.id && card === cardNumber) return;
          
          if (card < cardNumber) {
            hiddenLowerCardExists = true;
          }
        });
      }
    });

    // 1) 정답 처리 (이 카드가 낼 수 있는 가장 작은 카드가 맞음)
    if (!hiddenLowerCardExists) {
      const cardIndex = playingPlayer.hand.indexOf(cardNumber);
      if (cardIndex !== -1) {
        playingPlayer.hand.splice(cardIndex, 1);
      } 
      
      const cardObj = { val: cardNumber, isMistake: false };
      cardObj.toString = function() { return String(this.val); };
      
      room.gameState.playedCards.push(cardObj);
      
      if (!checkLevelComplete(room, roomCode)) {
        sendGameState(room);
      }
    } 
    // 2) 오답 처리 (더 작은 카드가 남아있는데 먼저 내버림)
    else {
      room.gameState.lives--;
      room.gameState.hasMistakeInLevel = true; 
      
      let cardsToDiscard = [];

      // 오답 처리 시점: 낸 카드보다 작은 카드를 전부 털어버립니다.
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

      // 내가 낸 카드도 손패에서 제거
      const cardIndex = playingPlayer.hand.indexOf(cardNumber);
      if (cardIndex !== -1) {
        playingPlayer.hand.splice(cardIndex, 1);
      }
      
      // 💡 [수정 완료] 선언 에러(ReferenceError)를 발생시키던 삼항 연산자를 안전하게 제거했습니다!
      const wrongCardInfo = {
        playerId: playingPlayer.id,
        playerName: playingPlayer.name,
        val: cardNumber,
        isTriggerCard: true 
      };

      cardsToDiscard.sort((a, b) => a.val - b.val);
      cardsToDiscard.push(wrongCardInfo);

      cardsToDiscard.forEach(item => {
        const errCardObj = { val: item.val, isMistake: true };
        errCardObj.toString = function() { return String(this.val); };
        room.gameState.playedCards.push(errCardObj);
      });

      const cleanSequence = cardsToDiscard.map(item => {
        const o = { ...item };
        o.toString = function() { return String(this.val); };
        return o;
      });

      io.to(roomCode).emit('mistake_animation', { 
        message: `🚨 ${playingPlayer.name}님이 타이밍을 놓치고 ${cardNumber}번 카드를 내버렸습니다!`,
        lives: room.gameState.lives,
        sequence: cleanSequence
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
              
              // 💡 [디버깅 포인트] 객체 형태와 순수 숫자 하이브리드 바인딩
              const itemObj = { playerId: p.id, playerName: p.name, val: minCard };
              itemObj.toString = function() { return String(this.val); };
              discardedCards.push(itemObj);
            }
          }
        });
        
        // 데이터가 클라이언트 단에서 꼬이지 않도록 이중 안전 장치 처리된 데이터 전송
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

// 연결 끊김 예외 처리 및 방 안전 폭파/초기화
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index !== -1) {
      room.players.splice(index, 1);
      
      if (room.players.length === 0) {
        delete rooms[currentRoom];
      } else {
        // 남은 플레이어들에게 알림을 보내고 게임판 상태만 날려 대기실 전단계로 안전 복구
        io.to(currentRoom).emit('game_over_trigger', "🚨 플레이어가 퇴장하여 게임을 계속할 수 없습니다. 대기실로 돌아갑니다.");
        if (room.gameState) {
          delete room.gameState; 
        }
        // 첫 번째 남은 사람을 방장으로 위임해 방 폭파 방지
        room.players[0].isHost = true;
        io.to(currentRoom).emit('update_players', room.players);
      }
    }
  });

// 집중 단계 초기화 알림 (다음 레벨 갈 때 포커스 완료 플래그 완벽 초기화)
  function startFocusPhase(room, roomCode) {
    if (room.gameState) {
      room.gameState.focusPlayers = [];
      room.gameState.isFocusComplete = false; // ★ 다음 레벨 진행을 위해 반드시 false 리셋
    }
    const playerInfos = room.players.map(p => ({ id: p.id, name: p.name }));
    io.to(roomCode).emit('trigger_focus_phase', {
      level: room.gameState.level,
      lives: room.gameState.lives,
      shurikens: room.gameState.shurikens,
      allPlayers: playerInfos
    });
  }

  // 패 돌리기 (최초 진입 시 undefined 에러 원천 차단)
  function dealCards(room) {
    let deck = Array.from({length: 100}, (_, i) => i + 1);
    shuffle(deck);
    room.gameState.playedCards = [];
    room.gameState.hasMistakeInLevel = false; 

    room.players.forEach(player => {
      player.hand = [];
      player.shurikenCards = []; // ★ 이제 처음 방에 들어온 상태에서도 안전하게 빈 배열로 선언됨
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
        
        if (clearedLvl === 2) room.gameState.shurikens++;
        if (clearedLvl === 3) room.gameState.lives++;
        if (clearedLvl === 5) room.gameState.shurikens++;
        if (clearedLvl === 6) room.gameState.lives++;
        if (clearedLvl === 8) room.gameState.shurikens++;
        if (clearedLvl === 9) room.gameState.lives++;

        io.to(roomCode).emit('level_clear_trigger', {
          cleared: clearedLvl,
          next: room.gameState.level,
          perfect: !room.gameState.hasMistakeInLevel 
        });
      }
      return true;
    }
    return false;
  }

  // 데이터 통합 동기화 패킷 전송
  function sendGameState(room) {
    const playerInfos = room.players.map(p => {
      // 클라이언트가 수리검 폐기 카드를 그릴 수 있도록 숫자를 안전하게 문자열/숫자 하이브리드 매핑
      const sCards = (p.shurikenCards || []).map(num => {
        const nObj = { val: num };
        nObj.toString = function() { return String(this.val); };
        return nObj;
      });

      return { 
        id: p.id, 
        name: p.name, 
        cardCount: p.hand ? p.hand.length : 0,
        shurikenCards: sCards,
        // 혹시 기존 index.html이 다른 이름의 필드를 요구할 때를 대비한 하위 호환 필드들 탑재
        shurikenCard: sCards[sCards.length - 1] || "", 
        discarded: sCards
      };
    });

    room.players.forEach(player => {
      // 💡 [디버깅 포인트] 클라이언트의 playedCards 렌더러가 [object Object]를 뿜지 않게 최종 플랫화
      const flatPlayedCards = room.gameState.playedCards.map(c => {
        const item = { val: c.val, isMistake: c.isMistake };
        item.toString = function() { return String(this.val); };
        return item;
      });

      io.to(player.id).emit('update_game_state', {
        level: room.gameState.level,
        lives: room.gameState.lives,
        shurikens: room.gameState.shurikens,
        playedCards: flatPlayedCards,
        myHand: player.hand || [],
        allPlayers: playerInfos
      });
    });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 오픈! 포트: ${PORT}`));
