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
    methods: ["GET", "POST"]
  }
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
  "guitar", "pizza", "camera", "clock", "flower", "mountain", "ocean"
];

const ROUND_DURATION = 60000; // 60 seconds per round

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
  io.emit("gameState", {
    gameActive,
    currentDrawer: drawerName,
    // Don't send the actual word to clients (they have to guess!)
    hasWord: !!currentWord
  });
}

function selectRandomWord() {
  return wordList[Math.floor(Math.random() * wordList.length)];
}

function getNextDrawer() {
  const socketIds = Object.keys(users);
  if (socketIds.length === 0) return null;
  
  // Find current drawer index
  const currentIndex = socketIds.indexOf(currentDrawer);
  
  // Get next drawer (rotate through players)
  const nextIndex = (currentIndex + 1) % socketIds.length;
  return socketIds[nextIndex];
}

function startNewRound() {
  // Select next drawer
  currentDrawer = getNextDrawer();
  
  if (!currentDrawer) {
    console.log("No players available to draw");
    gameActive = false;
    return;
  }

  // Select random word
  currentWord = selectRandomWord();
  gameActive = true;

  const drawerName = users[currentDrawer];
  console.log(`New round! Drawer: ${drawerName}, Word: "${currentWord}"`);

  // Clear the board for new round
  io.emit("clearBoard");

  // Tell everyone who's drawing (but not the word)
  io.emit("chatMessage", { 
    from: "System", 
    text: `${drawerName} is now drawing! Guess the word!` 
  });

  // Send the word ONLY to the drawer
  io.to(currentDrawer).emit("yourWord", { word: currentWord });

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

  if (someoneGuessed) {
    io.emit("chatMessage", { 
      from: "System", 
      text: `Round ended! The word was "${currentWord}"` 
    });
  } else {
    io.emit("chatMessage", { 
      from: "System", 
      text: `Time's up! The word was "${currentWord}"` 
    });
  }

  currentWord = null;
  
  // Start next round after 5 seconds
  setTimeout(() => {
    if (Object.keys(users).length >= 1) {
      startNewRound();
    }
  }, 5000);
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Send current state to newly connected client
  socket.emit("scoreUpdate", { scores });
  socket.emit("userList", Object.values(users));
  broadcastGameState();

  // Assign username when client joins
  socket.on("join", (name) => {
    const n = String(name).trim() || `Player_${socket.id.slice(0, 4)}`;
    users[socket.id] = n;
    
    // Initialize score if new user
    if (!scores[n]) scores[n] = 0;
    
    console.log(`${n} joined (${socket.id})`);
    
    // Broadcast updates
    broadcastUserList();
    broadcastScores();
    
    // Welcome messages
    socket.emit("chatMessage", { from: "System", text: `Welcome ${n}!` });
    socket.broadcast.emit("chatMessage", { from: "System", text: `${n} joined the game` });

    // If this is the first or second player and no game is active, start a round
    const playerCount = Object.keys(users).length;
    if (playerCount >= 2 && !gameActive && !currentDrawer) {
      setTimeout(() => startNewRound(), 2000);
    }
  });

  // Handle drawing strokes
  socket.on("stroke", (stroke) => {
    // Only allow the current drawer to draw
    if (socket.id !== currentDrawer) {
      return; // Ignore strokes from non-drawers
    }

    // Validate stroke data
    if (stroke && stroke.from && stroke.to) {
      // Broadcast to all OTHER clients
      socket.broadcast.emit("remoteStroke", stroke);
    }
  });

  // Handle clear board (only drawer can clear)
  socket.on("clear", () => {
    if (socket.id !== currentDrawer) {
      return; // Only drawer can clear
    }
    
    console.log("Board cleared by", users[socket.id]);
    io.emit("clearBoard");
  });

  // Handle chat messages (not guesses)
  socket.on("chat", ({ from, text }) => {
    const player = from || users[socket.id] || `Player_${socket.id.slice(0, 4)}`;
    console.log(`${player}: ${text}`);
    io.emit("chatMessage", { from: player, text });
  });

  // Handle guess attempts
  socket.on("guess", ({ from, text }) => {
    const guessText = String(text || "").trim();
    const player = from || users[socket.id] || `Player_${socket.id.slice(0, 4)}`;
    
    if (!guessText) return;

    // Don't let the drawer guess their own word
    if (socket.id === currentDrawer) {
      io.emit("chatMessage", { from: player, text: guessText });
      return;
    }

    console.log(`${player} guessed: "${guessText}"`);

    // Broadcast the guess as a chat message
    io.emit("chatMessage", { from: player, text: guessText });

    // Check if it's correct (only if game is active)
    if (!gameActive || !currentWord) return;

    const guessLower = guessText.toLowerCase();
    const targetLower = currentWord.toLowerCase();

    if (guessLower === targetLower) {
      // Award points to guesser
      scores[player] = (scores[player] || 0) + 10;
      
      // Award points to drawer for having their drawing guessed
      const drawerName = users[currentDrawer];
      if (drawerName) {
        scores[drawerName] = (scores[drawerName] || 0) + 5;
      }
      
      console.log(`${player} guessed correctly!`);
      
      // Broadcast success
      io.emit("chatMessage", { 
        from: "System", 
        text: `${player} guessed correctly! +10 points. ${drawerName} gets +5 points!` 
      });
      
      // Broadcast updated scores
      broadcastScores();
      
      // End round
      endRound(true);
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const name = users[socket.id];
    if (name) {
      console.log(`${name} disconnected (${socket.id})`);
      
      // If the drawer left, end the round
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
      
      // If not enough players, pause game
      if (Object.keys(users).length < 2 && gameActive) {
        endRound(false);
        io.emit("chatMessage", { 
          from: "System", 
          text: "Not enough players. Waiting for more players..." 
        });
      }
    } else {
      console.log("Client disconnected:", socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Word pool: ${wordList.length} words`);
});