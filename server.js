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

const wordList = [
  "apple", "banana", "cat", "dog", "car", "house", "tree", "sun", 
  "moon", "star", "computer", "phone", "book", "chair", "table",
  "guitar", "pizza", "camera", "clock", "flower", "mountain", "ocean",
  "pencil", "bottle", "lamp", "door", "window", "bird", "fish", "rocket"
];

const ROUND_DURATION = 60000; // 60 seconds per round

// Helper functions
function broadcastUserList() {
  const list = Object.values(users);
  console.log("📋 Broadcasting user list:", list);
  io.emit("userList", list);
}

function broadcastScores() {
  console.log("🏆 Broadcasting scores:", scores);
  io.emit("scoreUpdate", { scores });
}

function broadcastGameState() {
  const drawerName = currentDrawer ? users[currentDrawer] : null;
  const timeRemaining = roundEndTime ? Math.max(0, roundEndTime - Date.now()) : 0;
  
  console.log("🎮 Broadcasting game state - Drawer:", drawerName, "Active:", gameActive);
  
  io.emit("gameState", {
    gameActive,
    currentDrawer: drawerName,
    hasWord: !!currentWord,
    timeRemaining: Math.floor(timeRemaining / 1000) // in seconds
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

function startNewRound() {
  currentDrawer = getNextDrawer();
  
  if (!currentDrawer) {
    console.log("⚠️  No players available to draw");
    gameActive = false;
    return;
  }

  currentWord = selectRandomWord();
  gameActive = true;
  roundStartTime = Date.now();
  roundEndTime = roundStartTime + ROUND_DURATION;

  const drawerName = users[currentDrawer];
  console.log("=".repeat(60));
  console.log(`🎨 NEW ROUND STARTED!`);
  console.log(`   Drawer: ${drawerName}`);
  console.log(`   Word: "${currentWord}"`);
  console.log(`   Duration: ${ROUND_DURATION / 1000}s`);
  console.log(`   Players: ${Object.keys(users).length}`);
  console.log("=".repeat(60));

  // Clear the board
  io.emit("clearBoard");

  // Announce new round
  io.emit("chatMessage", { 
    from: "System", 
    text: `🎨 ${drawerName} is now drawing! You have 60 seconds to guess!` 
  });

  // Send word only to drawer
  io.to(currentDrawer).emit("yourWord", { word: currentWord });
  console.log(`📤 Sent word "${currentWord}" to ${drawerName}`);

  // Broadcast game state
  broadcastGameState();

  // Set round timer
  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(() => {
    endRound(false);
  }, ROUND_DURATION);

  // Timer updates every second
  const timerInterval = setInterval(() => {
    if (!gameActive) {
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

  if (!gameActive) return;

  gameActive = false;
  roundStartTime = null;
  roundEndTime = null;

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
  broadcastGameState();
  
  // Start next round after 5 seconds
  setTimeout(() => {
    const playerCount = Object.keys(users).length;
    console.log(`⏳ Starting next round in 5s... (${playerCount} players)`);
    if (playerCount >= 1) {
      startNewRound();
    } else {
      console.log("⚠️  Not enough players to start new round");
    }
  }, 5000);
}

function stopGame() {
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }

  gameActive = false;
  currentDrawer = null;
  currentWord = null;
  roundStartTime = null;
  roundEndTime = null;

  console.log("🛑 GAME STOPPED");

  io.emit("chatMessage", { 
    from: "System", 
    text: "🛑 Game stopped by host!" 
  });

  io.emit("clearBoard");
  broadcastGameState();
}

io.on("connection", (socket) => {
  console.log("=".repeat(60));
  console.log("✅ NEW CLIENT CONNECTED!");
  console.log("   Socket ID:", socket.id);
  console.log("   Time:", new Date().toLocaleTimeString());
  console.log("   Transport:", socket.conn.transport.name);
  console.log("=".repeat(60));

  // Send current state
  socket.emit("scoreUpdate", { scores });
  socket.emit("userList", Object.values(users));
  broadcastGameState();

  // Join game
  socket.on("join", (name) => {
    const n = String(name).trim() || `Player_${socket.id.slice(0, 4)}`;
    users[socket.id] = n;
    
    if (!scores[n]) scores[n] = 0;
    
    console.log("👤 USER JOINED:", n, `(${socket.id})`);
    
    broadcastUserList();
    broadcastScores();
    
    socket.emit("chatMessage", { from: "System", text: `Welcome ${n}! 👋` });
    socket.broadcast.emit("chatMessage", { from: "System", text: `${n} joined the game` });

    console.log(`   Total players: ${Object.keys(users).length}`);
  });

  // Start game (any player can start)
  socket.on("startGame", () => {
    const playerCount = Object.keys(users).length;
    const playerName = users[socket.id] || "Unknown";
    
    console.log(`🎮 ${playerName} requested to start game`);
    
    if (gameActive) {
      socket.emit("chatMessage", { from: "System", text: "Game is already running!" });
      return;
    }

    if (playerCount < 1) {
      socket.emit("chatMessage", { from: "System", text: "Need at least 1 player to start!" });
      return;
    }

    io.emit("chatMessage", { 
      from: "System", 
      text: `🎮 ${playerName} started the game! Get ready!` 
    });

    setTimeout(() => startNewRound(), 2000);
  });

  // Stop game (any player can stop)
  socket.on("stopGame", () => {
    const playerName = users[socket.id] || "Unknown";
    console.log(`🛑 ${playerName} requested to stop game`);
    
    if (!gameActive) {
      socket.emit("chatMessage", { from: "System", text: "No game is running!" });
      return;
    }

    stopGame();
  });

  // Handle drawing strokes
  socket.on("stroke", (stroke) => {
    if (socket.id !== currentDrawer) {
      console.log("⚠️  Non-drawer tried to draw:", users[socket.id]);
      return;
    }

    if (stroke && stroke.from && stroke.to) {
      socket.broadcast.emit("remoteStroke", stroke);
    }
  });

  // Handle clear board
  socket.on("clear", () => {
    if (socket.id !== currentDrawer) {
      console.log("⚠️  Non-drawer tried to clear:", users[socket.id]);
      return;
    }
    
    console.log("🗑️  Board cleared by", users[socket.id]);
    io.emit("clearBoard");
  });

  // Handle chat messages
  socket.on("chat", ({ from, text }) => {
    const player = from || users[socket.id] || `Player_${socket.id.slice(0, 4)}`;
    console.log(`💬 [${player}]: ${text}`);
    io.emit("chatMessage", { from: player, text });
  });

  // Handle guess attempts
  socket.on("guess", ({ from, text }) => {
    const guessText = String(text || "").trim();
    const player = from || users[socket.id] || `Player_${socket.id.slice(0, 4)}`;
    
    if (!guessText) return;

    // Drawer's messages are just chat
    if (socket.id === currentDrawer) {
      console.log(`💬 [${player} - DRAWER]: ${guessText}`);
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

  // Handle disconnect
  socket.on("disconnect", () => {
    const name = users[socket.id];
    if (name) {
      console.log("=".repeat(60));
      console.log("❌ USER DISCONNECTED:", name, `(${socket.id})`);
      console.log("=".repeat(60));
      
      if (socket.id === currentDrawer) {
        io.emit("chatMessage", { 
          from: "System", 
          text: `${name} (the drawer) left. Starting new round...` 
        });
        endRound(false);
      } else {
        io.emit("chatMessage", { from: "System", text: `${name} left the game` });
      }
      
      delete users[socket.id];
      broadcastUserList();
      
      const remainingPlayers = Object.keys(users).length;
      console.log(`   Remaining players: ${remainingPlayers}`);
      
      if (remainingPlayers < 1 && gameActive) {
        stopGame();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("🚀 SCRIBBLE GAME SERVER STARTED!");
  console.log(`   Port: ${PORT}`);
  console.log(`   Time: ${new Date().toLocaleString()}`);
  console.log(`   Word pool: ${wordList.length} words`);
  console.log("=".repeat(60));
});