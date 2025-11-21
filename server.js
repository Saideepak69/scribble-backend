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
  transports: ["websocket", "polling"], // Support both transport methods
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3001;

// Game state (single session - all players play together)
let users = {};           // socketId => username
let scores = {};          // username => points
let currentDrawer = null; // socketId of current drawer
let currentWord = null;   // word being drawn
let gameActive = false;   // is a round active?
let roundTimer = null;    // timer for current round

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
  console.log("🎮 Broadcasting game state - Drawer:", drawerName, "Active:", gameActive);
  io.emit("gameState", {
    gameActive,
    currentDrawer: drawerName,
    hasWord: !!currentWord
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

  const drawerName = users[currentDrawer];
  console.log("=".repeat(60));
  console.log(`🎨 NEW ROUND STARTED!`);
  console.log(`   Drawer: ${drawerName}`);
  console.log(`   Word: "${currentWord}"`);
  console.log(`   Players: ${Object.keys(users).length}`);
  console.log("=".repeat(60));

  // Clear the board for new round
  io.emit("clearBoard");

  // Tell everyone who's drawing (but not the word)
  io.emit("chatMessage", { 
    from: "System", 
    text: `🎨 ${drawerName} is now drawing! Guess the word!` 
  });

  // Send the word ONLY to the drawer
  io.to(currentDrawer).emit("yourWord", { word: currentWord });
  console.log(`📤 Sent word "${currentWord}" to ${drawerName}`);

  // Broadcast game state
  broadcastGameState();

  // Set round timer
  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = setTimeout(() => {
    endRound(false);
  }, ROUND_DURATION);
}

function endRound(someoneGuessed = false) {
  if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }

  if (!gameActive) return;

  gameActive = false;

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
  
  // Start next round after 5 seconds
  setTimeout(() => {
    const playerCount = Object.keys(users).length;
    console.log(`⏳ Starting next round in 5s... (${playerCount} players)`);
    if (playerCount >= 1) {  // Changed to 1 for solo testing
      startNewRound();
    } else {
      console.log("⚠️  Not enough players to start new round");
    }
  }, 5000);
}

io.on("connection", (socket) => {
  console.log("=".repeat(60));
  console.log("✅ NEW CLIENT CONNECTED!");
  console.log("   Socket ID:", socket.id);
  console.log("   Time:", new Date().toLocaleTimeString());
  console.log("   Transport:", socket.conn.transport.name);
  console.log("=".repeat(60));

  // Send current state to newly connected client
  socket.emit("scoreUpdate", { scores });
  socket.emit("userList", Object.values(users));
  broadcastGameState();

  // Assign username when client joins
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
    
    if (playerCount >= 2 && !gameActive && !currentDrawer) {
      console.log("🚀 Enough players! Starting game in 2 seconds...");
      setTimeout(() => startNewRound(), 2000);
    }
  });

  // Handle drawing strokes
  socket.on("stroke", (stroke) => {
    if (socket.id !== currentDrawer) {
      console.log("⚠️  Non-drawer tried to draw:", users[socket.id]);
      return;
    }

    if (stroke && stroke.from && stroke.to) {
      console.log("🖊️  Stroke from", users[socket.id]);
      socket.broadcast.emit("remoteStroke", stroke);
    }
  });

  // Handle clear board (only drawer can clear)
  socket.on("clear", () => {
    if (socket.id !== currentDrawer) {
      console.log("⚠️  Non-drawer tried to clear:", users[socket.id]);
      return;
    }
    
    console.log("🗑️  Board cleared by", users[socket.id]);
    io.emit("clearBoard");
  });

  // Handle chat messages (not guesses)
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

    // Don't let the drawer guess their own word
    if (socket.id === currentDrawer) {
      console.log(`💬 [${player} - DRAWER]: ${guessText}`);
      io.emit("chatMessage", { from: player, text: guessText });
      return;
    }

    console.log(`🎯 [${player}] guessed: "${guessText}"`);

    // Broadcast the guess as a chat message
    io.emit("chatMessage", { from: player, text: guessText });

    // Check if it's correct (only if game is active)
    if (!gameActive || !currentWord) {
      console.log("   ⚠️  No active game or word");
      return;
    }

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
    } else {
      console.log(`   ❌ Wrong guess`);
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
      
      if (remainingPlayers < 2 && gameActive) {
        endRound(false);
        io.emit("chatMessage", { 
          from: "System", 
          text: "⏸️  Not enough players. Waiting for more players..." 
        });
      }
    } else {
      console.log("❌ Unknown client disconnected:", socket.id);
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