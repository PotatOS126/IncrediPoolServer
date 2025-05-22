const express = require('express');
const { createServer } = require('http');
const io = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);
const ioServer = io(httpServer, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// 中间件
app.use(cors());
app.use(express.json());

// 游戏状态
const gameState = {
    currentPlayer: null,
    players: new Map(),
    ballsState: {},
    isSimulating: false
};

// 广播游戏状态
function broadcastGameState() {
    ioServer.emit('gameState', {
        currentPlayer: gameState.currentPlayer,
        ballsState: gameState.ballsState
    });
}

// 广播玩家列表
function broadcastPlayerList() {
    const playerList = Array.from(gameState.players.values()).map(player => ({
        id: player.id,
        isHoldingCue: player.isHoldingCue
    }));
    ioServer.emit('playerList', playerList);
}

// Socket.IO 连接处理
ioServer.on('connection', (socket) => {
    console.log('A user connected');

    // 玩家加入游戏
    socket.on('joinGame', (data) => {
        const { playerId } = data;
        gameState.players.set(playerId, { id: playerId, isHoldingCue: false });
        
        // 广播玩家列表更新
        broadcastPlayerList();
        
        // 发送当前游戏状态给新玩家
        socket.emit('gameState', {
            currentPlayer: gameState.currentPlayer,
            ballsState: gameState.ballsState
        });
    });

    // 玩家拿起球杆
    socket.on('takeCue', (data) => {
        const { playerId } = data;
        if (!gameState.currentPlayer) {
            gameState.currentPlayer = playerId;
            const player = gameState.players.get(playerId);
            if (player) {
                player.isHoldingCue = true;
                broadcastPlayerList();
                ioServer.emit('cueStateChanged', { playerId, isHolding: true });
                ioServer.emit('gameState', { currentPlayer: gameState.currentPlayer });
            }
        }
    });

    // 玩家放下球杆
    socket.on('releaseCue', (data) => {
        const { playerId } = data;
        if (gameState.currentPlayer === playerId) {
            gameState.currentPlayer = null;
            const player = gameState.players.get(playerId);
            if (player) {
                player.isHoldingCue = false;
                broadcastPlayerList();
                ioServer.emit('cueStateChanged', { playerId, isHolding: false });
                ioServer.emit('gameState', { currentPlayer: null });
            }
        }
    });

    // 接收球的状态更新
    socket.on('ballsState', (data) => {
        const { playerId, state } = data;
        gameState.ballsState = state;
        // 广播给其他玩家
        socket.broadcast.emit('ballsUpdate', { playerId, state });
    });

    // 接收击球事件
    socket.on('ballHit', (data) => {
        gameState.isSimulating = true;
        // 广播给其他玩家
        socket.broadcast.emit('ballHit', data);
    });

    // 接收模拟完成事件
    socket.on('simulationComplete', (data) => {
        gameState.isSimulating = false;
        gameState.ballsState = data.finalState;
        // 广播给其他玩家
        socket.broadcast.emit('simulationComplete', data);
    });

    // 重置台球桌
    socket.on('resetTable', (data) => {
        gameState.ballsState = {};
        gameState.isSimulating = false;
        ioServer.emit('resetTable');
    });

    // 断开连接处理
    socket.on('disconnect', () => {
        console.log('User disconnected');
        // 找到断开连接的玩家
        for (const [playerId, player] of gameState.players.entries()) {
            if (player.socket === socket) {
                gameState.players.delete(playerId);
                if (gameState.currentPlayer === playerId) {
                    gameState.currentPlayer = null;
                }
                break;
            }
        }
        broadcastPlayerList();
    });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 