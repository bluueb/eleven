const express = require("express")
const http = require("http")
const { Server } = require("socket.io")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.static("public"))

let rooms = {}

function safeEmit(socket, event, data) {
  try {
    socket.emit(event, data)
  } catch (err) {
    console.error("Emit error:", err.message)
  }
}

function broadcast(code) {
  if (!rooms[code]) return
  // Never send _deleteTimer to clients
  const { _deleteTimer, ...roomData } = rooms[code]
  io.to(code).emit("updateRoom", roomData)
}

function isValidInt(val, min, max) {
  const n = Number(val)
  return Number.isInteger(n) && n >= min && n <= max
}

// Eliminates whoever is at currentPlayerIndex right now
function eliminateCurrentPlayer(code) {
  const room = rooms[code]
  if (!room || !room.started) return

  const idx = room.currentPlayerIndex
  const eliminated = room.players[idx]
  if (!eliminated) return

  room.players.splice(idx, 1)
  room.eliminated.push(eliminated)
  room.currentNumber = 0

  console.log(`[${code}] Eliminated: ${eliminated} | Remaining: ${room.players.length}`)
  io.to(code).emit("playerEliminated", { name: eliminated })

  if (room.players.length <= 1) {
    room.started = false
    const winner = room.players[0] || null
    io.to(code).emit("gameOver", { winner })
    console.log(`[${code}] Game over. Winner: ${winner}`)
    return
  }

  // After splice, idx now points to the next player automatically.
  // If it's out of bounds, wrap to 0.
  if (room.currentPlayerIndex >= room.players.length) {
    room.currentPlayerIndex = 0
  }

  broadcast(code)
}

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`)

  socket.on("createRoom", (payload = {}) => {
    try {
      let { name, rows, cols } = payload

      if (!name || typeof name !== "string" || name.trim() === "") {
        return safeEmit(socket, "errorMessage", "Geçersiz isim")
      }
      name = name.trim()

      if (!isValidInt(rows, 1, 20) || !isValidInt(cols, 1, 20)) {
        return safeEmit(socket, "errorMessage", "Geçersiz sınıf boyutu")
      }

      rows = Number(rows)
      cols = Number(cols)

      const code = Math.random().toString(36).substring(2, 7).toUpperCase()

      rooms[code] = {
        players: [name],
        eliminated: [],
        currentNumber: 0,
        currentPlayerIndex: 0,
        started: false,
        host: name,
        rows,
        cols,
        _deleteTimer: null,
      }

      socket.join(code)
      socket.roomCode = code
      socket.playerName = name

      console.log(`[${code}] Created by ${name}`)
      safeEmit(socket, "roomCreated", code)
      broadcast(code)
    } catch (err) {
      console.error("createRoom error:", err)
    }
  })

  socket.on("joinRoom", (payload = {}) => {
    try {
      let { name, code } = payload

      if (!name || typeof name !== "string" || name.trim() === "") {
        return safeEmit(socket, "errorMessage", "Geçersiz isim")
      }
      if (!code || typeof code !== "string") {
        return safeEmit(socket, "errorMessage", "Geçersiz kod")
      }

      code = code.trim().toUpperCase()
      name = name.trim()

      if (!rooms[code]) {
        return safeEmit(socket, "errorMessage", "Oda bulunamadı")
      }

      const room = rooms[code]

      // Cancel grace-period deletion if host is rejoining after navigation
      if (room._deleteTimer) {
        clearTimeout(room._deleteTimer)
        room._deleteTimer = null
        console.log(`[${code}] Deletion cancelled — player rejoined`)
      }

      // Don't allow new players into a started game
      if (room.started && !room.players.includes(name) && !room.eliminated.includes(name)) {
        return safeEmit(socket, "errorMessage", "Oyun zaten başladı")
      }

      // Reject duplicate names from different sockets
      if (room.players.includes(name) && socket.playerName !== name) {
        // Allow rejoin (same name, e.g. page refresh)
      } else if (!room.players.includes(name)) {
        const maxPlayers = room.rows * room.cols
        if (room.players.length >= maxPlayers) {
          return safeEmit(socket, "errorMessage", "Oda dolu")
        }
        room.players.push(name)
      }

      socket.join(code)
      socket.roomCode = code
      socket.playerName = name

      console.log(`[${code}] ${name} joined`)
      broadcast(code)
    } catch (err) {
      console.error("joinRoom error:", err)
    }
  })

  socket.on("startGame", () => {
    try {
      const code = socket.roomCode
      if (!code || !rooms[code]) {
        return safeEmit(socket, "errorMessage", "Oda bulunamadı")
      }

      const room = rooms[code]

      if (socket.playerName !== room.host) {
        return safeEmit(socket, "errorMessage", "Sadece host başlatabilir")
      }
      if (room.players.length < 2) {
        return safeEmit(socket, "errorMessage", "En az 2 oyuncu gerekli")
      }

      room.started = true
      room.eliminated = []
      room.currentNumber = 0
      room.currentPlayerIndex = 0

      console.log(`[${code}] Game started with ${room.players.length} players`)
      broadcast(code)
    } catch (err) {
      console.error("startGame error:", err)
    }
  })

  socket.on("move", (numbers) => {
    try {
      const code = socket.roomCode
      if (!code || !rooms[code]) return

      const room = rooms[code]
      if (!room.started) return

      // Only allow the current player to move
      if (room.players[room.currentPlayerIndex] !== socket.playerName) return

      // Validate input
      if (!Array.isArray(numbers)) return
      if (numbers.length === 0 || numbers.length > 3) return

      const current = room.currentNumber

      // Validate consecutive sequence — reject anything with 11
      for (let i = 0; i < numbers.length; i++) {
        if (typeof numbers[i] !== "number" || !Number.isInteger(numbers[i])) return
        if (numbers[i] !== current + i + 1) return
        if (numbers[i] >= 11) return // 11 is never allowed to be said
      }

      const last = numbers[numbers.length - 1]
      room.currentNumber = last

      if (last === 10) {
        // Advance to next player and eliminate them — they would have to say 11
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length
        console.log(`[${code}] ${socket.playerName} said 10 — ${room.players[room.currentPlayerIndex]} is forced out`)
        eliminateCurrentPlayer(code)
      } else {
        // Normal move — advance turn
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length
        broadcast(code)
      }
    } catch (err) {
      console.error("move error:", err)
    }
  })

  socket.on("disconnect", () => {
    try {
      const code = socket.roomCode
      const name = socket.playerName

      // CRITICAL: if name is undefined, do nothing — don't touch the room
      if (!code || !name || !rooms[code]) {
        console.log(`[-] Disconnected (no room): ${socket.id}`)
        return
      }

      const room = rooms[code]

      // Only remove if this player is actually in the room
      if (!room.players.includes(name)) {
        console.log(`[-] Disconnected (not in players): ${socket.id} ${name}`)
        return
      }

      room.players = room.players.filter((p) => p !== name)
      console.log(`[-] Disconnected: ${name} | Room: ${code} | Left: ${room.players.length}`)

      if (room.players.length === 0) {
        // Grace period in case host is just navigating pages
        room._deleteTimer = setTimeout(() => {
          if (rooms[code] && rooms[code].players.length === 0) {
            delete rooms[code]
            console.log(`[${code}] Room deleted after grace period`)
          }
        }, 8000)
      } else {
        // Reassign host if needed
        if (room.host === name) {
          room.host = room.players[0]
          console.log(`[${code}] New host: ${room.host}`)
        }

        // Fix index if it's now out of bounds
        if (room.currentPlayerIndex >= room.players.length) {
          room.currentPlayerIndex = 0
        }

        if (room.started && room.players.length < 2) {
          room.started = false
          room.currentNumber = 0
          room.currentPlayerIndex = 0
          io.to(code).emit("gameOver", { winner: room.players[0] || null, reason: "opponent_left" })
        } else {
          broadcast(code)
        }
      }
    } catch (err) {
      console.error("disconnect error:", err)
    }
  })
})

server.listen(3000, () => {
  console.log("Server running on port 3000")
})