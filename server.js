const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3001;

// Game state
let users = {};           // socketId => username
let scores = {};          // username => points
let currentDrawer = null;
let currentWord = null;
let gameActive = false;
let roundTimer = null;
let roundStartTime = null;
let roundEndTime = null;
let sessionStartTime = null;
let sessionTimer = null;
let countdownTimer = null;

const wordList = [
  "apple", "banana", "cat", "dog", "car", "house", "tree", "sun", 
  "moon", "star", "computer", "phone", "book", "chair", "table",
  "guitar", "pizza", "camera", "clock", "flower", "mountain", "ocean",
  "pencil", "bottle", "lamp", "door", "window", "bird", "fish", "rocket",
  "bicycle", "umbrella", "butterfly", "rainbow", "cloud", "beach", "forest"
];

const ROUND_DURATION = 120000; // 2 minutes per round
const SESSION_DURATION = 600000; // 10 minutes total session
const COUNTDOWN_DURATION = 20000; // 20 seconds countdown before start

// Helper functions
function broadcastUserList() {
  const list = Object.values(users);
  io.emit("userList", list);
}

function broadcastScores() {
  io.emit("scoreUpdate", { scores });
}

function broadcastGameState() {
  const drawerName = currentDrawer ? users[currentDrawer] : null;
  const timeRemaining = roundEndTime ? Math.max(0, roundEndTime - Date.now()) : 0;
  const sessionTimeRemaining = sessionStartTime ? Math.max(0, SESSION_DURATION - (Date.now() - sessionStartTime)) : 0;
  
  io.emit("gameState", {
    gameActive,
    currentDrawer: drawerName,
    hasWord: !!currentWord,
    timeRemaining: Math.floor(timeRemaining / 1000),
    sessionTimeRemaining: Math.floor(sessionTimeRemaining / 1000)
  });
}

function selectRandomWord() {
  return wordList[Math.floor(Math.random() * wordList.length)];
}

function getNextDrawer() {
  const socketIds = Object.keys(users);
  if (socketIds.length === 0) return null;
  
  const currentIndex = socketIds.indexOf(currentDrawer);
  const nextIndex = (currentIndex + 1) % socketIds.length;
  return socketIds[nextIndex];
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  
  let countdown = 20;
  io.emit("countdown", { seconds: countdown });
  
  countdownTimer = setInterval(() => {
    countdown--;
    io.emit("countdown", { seconds: countdown });
    
    if (countdown <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      startSession();
    }
  }, 1000);
}

function startSession() {
  sessionStartTime = Date.now();
  gameActive = true;
  
  console.log("=".repeat(60));
  console.log("🎮 SESSION STARTED!");
  console.log(`   Duration: ${SESSION_DURATION / 60000} minutes`);
  console.log(`   Players: ${Object.keys(users).length}`);
  console.log("=".repeat(60));
  
  io.emit("chatMessage", { 
    from: "System", 
    text: "🎮 Game session started! You have 10 minutes to play!" 
  });
  
  // Start first round
  startNewRound();
  
  // Set session end timer
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    endSession();
  }, SESSION_DURATION);
}

function startNewRound() {
  currentDrawer = getNextDrawer();
  
  if (!currentDrawer) {
    console.log("⚠️  No players available to draw");
    return;
  }

  currentWord = selectRandomWord();
  roundStartTime = Date.now();
  roundEndTime = roundStartTime + ROUND_DURATION;

  const drawerName = users[currentDrawer];
  console.log("=".repeat(60));
  console.log(`🎨 NEW ROUND STARTED!`);
  console.log(`   Drawer: ${drawerName}`);
  console.log(`   Word: "${currentWord}"`);
  console.log(`   Duration: ${ROUND_DURATION / 1000}s`);
  console.log("=".repeat(60));

  io.emit("clearBoard");

  io.emit("chatMessage", { 
    from: "System", 
    text: `🎨 ${drawerName} is now drawing! You have 2 minutes to guess!` 
  });

  io.to(currentDrawer).emit("yourWord", { word: currentWord });

  broadcastGameState();

  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(() => {
    endRound(false);
  }, ROUND_DURATION);

  // Update game state every second
  const timerInterval = setInterval(() => {
    if (!gameActive || !currentWord) {
      clearInterval(timerInterval);
      return;
    }
    broadcastGameState();
  }, 1000);
}

function endRound(someoneGuessed = false) {
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }

  if (!currentWord) return;

  console.log("🏁 ROUND ENDED - Someone guessed:", someoneGuessed);

  if (someoneGuessed) {
    io.emit("chatMessage", { 
      from: "System", 
      text: `✅ Round ended! The word was "${currentWord}"` 
    });
  } else {
    io.emit("chatMessage", { 
      from: "System", 
      text: `⏰ Time's up! The word was "${currentWord}"` 
    });
  }

  currentWord = null;
  roundStartTime = null;
  roundEndTime = null;
  
  // Check if session is still active
  if (!gameActive || !sessionStartTime) return;
  
  const sessionTimeRemaining = SESSION_DURATION - (Date.now() - sessionStartTime);
  
  if (sessionTimeRemaining <= 0) {
    endSession();
    return;
  }
  
  // Start next round after 5 seconds
  setTimeout(() => {
    const playerCount = Object.keys(users).length;
    if (playerCount >= 1 && gameActive) {
      startNewRound();
    } else if (playerCount < 1) {
      endSession();
    }
  }, 5000);
}

function endSession() {
  if (roundTimer) clearTimeout(roundTimer);
  if (sessionTimer) clearTimeout(sessionTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  
  roundTimer = null;
  sessionTimer = null;
  countdownTimer = null;
  
  gameActive = false;
  currentDrawer = null;
  currentWord = null;
  roundStartTime = null;
  roundEndTime = null;
  sessionStartTime = null;

  console.log("=".repeat(60));
  console.log("🏆 SESSION ENDED!");
  console.log("   Final Scores:", scores);
  console.log("=".repeat(60));

  // Calculate winner
  const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  
  if (sortedScores.length > 0) {
    const [winner, winnerScore] = sortedScores[0];
    
    io.emit("sessionEnded", {
      winner,
      finalScores: scores,
      leaderboard: sortedScores
    });
    
    io.emit("chatMessage", { 
      from: "System", 
      text: `🏆 GAME OVER! Winner: ${winner} with ${winnerScore} points!` 
    });
    
    // Show top 3
    const top3 = sortedScores.slice(0, 3);
    top3.forEach(([name, score], index) => {
      const medal = ["🥇", "🥈", "🥉"][index];
      io.emit("chatMessage", { 
        from: "System", 
        text: `${medal} ${index + 1}. ${name}: ${score} points` 
      });
    });
  } else {
    io.emit("sessionEnded", {
      winner: null,
      finalScores: {},
      leaderboard: []
    });
  }

  io.emit("clearBoard");
  broadcastGameState();
  
  // Reset scores for next session
  setTimeout(() => {
    scores = {};
    broadcastScores();
  }, 10000); // Reset after 10 seconds
}

io.on("connection", (socket) => {
  console.log("=".repeat(60));
  console.log("✅ NEW CLIENT CONNECTED!");
  console.log("   Socket ID:", socket.id);
  console.log("   Time:", new Date().toLocaleTimeString());
  console.log("=".repeat(60));

  socket.emit("scoreUpdate", { scores });
  socket.emit("userList", Object.values(users));
  broadcastGameState();

  socket.on("join", (name) => {
    const n = String(name).trim() || `Player_${socket.id.slice(0, 4)}`;
    users[socket.id] = n;
    
    if (!scores[n]) scores[n] = 0;
    
    console.log("👤 USER JOINED:", n, `(${socket.id})`);
    
    broadcastUserList();
    broadcastScores();
    
    socket.emit("chatMessage", { from: "System", text: `Welcome ${n}! 👋` });
    socket.broadcast.emit("chatMessage", { from: "System", text: `${n} joined the game` });

    const playerCount = Object.keys(users).length;
    console.log(`   Total players: ${playerCount}`);
    
    // Start countdown when 2 players join and game is not active
    if (playerCount === 2 && !gameActive && !sessionStartTime && !countdownTimer) {
      console.log("🚀 2 players joined! Starting countdown...");
      io.emit("chatMessage", { 
        from: "System", 
        text: "🎮 2 players joined! Game starting in 20 seconds..." 
      });
      startCountdown();
    }
  });

  // Leave game
  socket.on("leaveGame", () => {
    const name = users[socket.id];
    if (name) {
      console.log("👋", name, "left the game (voluntary)");
      
      io.emit("chatMessage", { from: "System", text: `${name} left the game` });
      
      // If drawer left, start new round
      if (socket.id === currentDrawer && gameActive) {
        io.emit("chatMessage", { 
          from: "System", 
          text: `${name} (the drawer) left. Starting new round...` 
        });
        endRound(false);
      }
      
      delete users[socket.id];
      broadcastUserList();
      
      // Check if enough players remain
      if (Object.keys(users).length < 1 && gameActive) {
        io.emit("chatMessage", { 
          from: "System", 
          text: "Not enough players. Ending session..." 
        });
        endSession();
      }
    }
    
    socket.disconnect();
  });

  socket.on("stroke", (stroke) => {
    if (socket.id !== currentDrawer) return;
    if (stroke && stroke.from && stroke.to) {
      socket.broadcast.emit("remoteStroke", stroke);
    }
  });

  socket.on("clear", () => {
    if (socket.id !== currentDrawer) return;
    io.emit("clearBoard");
  });

  socket.on("chat", ({ from, text }) => {
    const player = from || users[socket.id] || `Player_${socket.id.slice(0, 4)}`;
    io.emit("chatMessage", { from: player, text });
  });

  socket.on("guess", ({ from, text }) => {
    const guessText = String(text || "").trim();
    const player = from || users[socket.id] || `Player_${socket.id.slice(0, 4)}`;
    
    if (!guessText) return;

    if (socket.id === currentDrawer) {
      io.emit("chatMessage", { from: player, text: guessText });
      return;
    }

    console.log(`🎯 [${player}] guessed: "${guessText}"`);
    io.emit("chatMessage", { from: player, text: guessText });

    if (!gameActive || !currentWord) return;

    const guessLower = guessText.toLowerCase();
    const targetLower = currentWord.toLowerCase();

    if (guessLower === targetLower) {
      scores[player] = (scores[player] || 0) + 10;
      
      const drawerName = users[currentDrawer];
      if (drawerName) {
        scores[drawerName] = (scores[drawerName] || 0) + 5;
      }
      
      console.log(`   ✅ CORRECT! ${player}: +10, ${drawerName}: +5`);
      
      io.emit("chatMessage", { 
        from: "System", 
        text: `🎉 ${player} guessed correctly! +10 points. ${drawerName} gets +5 points!` 
      });
      
      broadcastScores();
      endRound(true);
    }
  });

  socket.on("disconnect", () => {
    const name = users[socket.id];
    if (name) {
      console.log("❌ USER DISCONNECTED:", name);
      
      if (socket.id === currentDrawer && gameActive) {
        io.emit("chatMessage", { 
          from: "System", 
          text: `${name} (the drawer) disconnected. Starting new round...` 
        });
        endRound(false);
      } else {
        io.emit("chatMessage", { from: "System", text: `${name} disconnected` });
      }
      
      delete users[socket.id];
      broadcastUserList();
      
      if (Object.keys(users).length < 1 && gameActive) {
        endSession();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("🚀 SCRIBBLE GAME SERVER STARTED!");
  console.log(`   Port: ${PORT}`);
  console.log(`   Time: ${new Date().toLocaleString()}`);
  console.log(`   Session Duration: ${SESSION_DURATION / 60000} minutes`);
  console.log(`   Round Duration: ${ROUND_DURATION / 1000} seconds`);
  console.log(`   Word pool: ${wordList.length} words`);
  console.log("=".repeat(60));
});