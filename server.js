const express = require('express');
const { createServer } = require('http');
const io = require('socket.io');
const cors = require('cors');
const config = require('./config');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);

// 使用动态配置的 Socket.IO 设置
const ioServer = io(httpServer, {
    cors: {
        origin: config.getCorsOrigin(),
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["my-custom-header"]
    }
});

// 中间件 - 使用动态CORS配置
app.use(cors({
    origin: config.getCorsOrigin(),
    credentials: true
}));
app.use(express.json());

// 添加健康检查和环境信息API
app.get('/', (req, res) => {
    res.json({
        message: 'IncrediPool Server is running!',
        environment: config.getEnvironmentInfo(),
        status: 'healthy'
    });
});

// API端点：获取环境信息
app.get('/api/config', (req, res) => {
    res.json(config.getEnvironmentInfo());
});

// 游戏状态
const gameState = {
    players: new Map(),
    currentPlayer: null,
    ballsState: {},
    isSimulating: false,
    chatHistory: [], // 聊天记录，最多保存100条
    simulationTimer: null,
    shotPlayerId: null,
    playerScores: new Map() // 玩家进球记录
};

// 游戏配置
const GAME_CONFIG = {
    HEARTBEAT_INTERVAL: 30000, // 30秒心跳间隔
    PLAYER_TIMEOUT: 60000,     // 60秒玩家超时
    CUE_TIMEOUT: 120000,       // 120秒持杆超时
    MAX_CHAT_HISTORY: 100,     // 最大聊天记录数
    MAX_MESSAGE_LENGTH: 200,   // 最大消息长度
    CHAT_RATE_LIMIT: 5000      // 聊天频率限制（5秒一条）
};

// 辅助函数：调试日志
function debugLog(message, data = null) {
    if (config.shouldDebug()) {
        console.log(`[DEBUG] ${message}`, data || '');
    }
}

// 辅助函数：创建系统消息
function createSystemMessage(content, type = 'system') {
    return {
        id: Date.now() + Math.random(),
        type: type, // 'system', 'error', 'info'
        sender: 'System',
        content: content,
        timestamp: new Date().toISOString()
    };
}

// 辅助函数：创建玩家消息
function createPlayerMessage(playerId, content) {
    return {
        id: Date.now() + Math.random(),
        type: 'player',
        sender: playerId,
        content: content,
        timestamp: new Date().toISOString()
    };
}

// 辅助函数：添加消息到历史记录
function addMessageToHistory(message) {
    gameState.chatHistory.push(message);
    
    // 保持历史记录在限制范围内
    if (gameState.chatHistory.length > GAME_CONFIG.MAX_CHAT_HISTORY) {
        gameState.chatHistory = gameState.chatHistory.slice(-GAME_CONFIG.MAX_CHAT_HISTORY);
    }
}

// 辅助函数：广播聊天消息
function broadcastChatMessage(message) {
    addMessageToHistory(message);
    ioServer.emit('chatMessage', message);
    debugLog('广播聊天消息', { sender: message.sender, content: message.content });
}

// 辅助函数：发送系统消息
function sendSystemMessage(content, type = 'system') {
    const message = createSystemMessage(content, type);
    broadcastChatMessage(message);
}

// 辅助函数：验证消息内容
function validateMessage(content) {
    if (!content || typeof content !== 'string') {
        return { valid: false, reason: '消息内容不能为空' };
    }
    
    const trimmed = content.trim();
    if (trimmed.length === 0) {
        return { valid: false, reason: '消息内容不能为空' };
    }
    
    if (trimmed.length > GAME_CONFIG.MAX_MESSAGE_LENGTH) {
        return { valid: false, reason: `消息长度不能超过${GAME_CONFIG.MAX_MESSAGE_LENGTH}个字符` };
    }
    
    // 简单的内容过滤（可以根据需要扩展）
    const forbiddenWords = ['fuck', 'shit', 'bitch', '傻逼', '白痴', '垃圾'];
    const lowerContent = trimmed.toLowerCase();
    for (const word of forbiddenWords) {
        if (lowerContent.includes(word)) {
            return { valid: false, reason: '消息包含不当内容' };
        }
    }
    
    return { valid: true, content: trimmed };
}

// 广播游戏状态
function broadcastGameState() {
    const state = {
        currentPlayer: gameState.currentPlayer,
        ballsState: gameState.ballsState
    };
    ioServer.emit('gameState', state);
    debugLog('广播游戏状态', state);
}

// 广播玩家列表
function broadcastPlayerList() {
    const playerList = Array.from(gameState.players.values()).map(player => ({
        id: player.id,
        isHoldingCue: player.isHoldingCue,
        isOnline: Date.now() - player.lastHeartbeat < GAME_CONFIG.PLAYER_TIMEOUT
    }));
    ioServer.emit('playerList', playerList);
    debugLog('广播玩家列表', playerList);
}

// 清理断开连接的玩家
function removePlayer(playerId, reason = '断开连接') {
    const player = gameState.players.get(playerId);
    if (player) {
        console.log(`🚪 移除玩家: ${playerId} (${reason})`);
        
        // 发送系统消息通知玩家离开
        sendSystemMessage(`${playerId} 离开了游戏`, 'info');
        
        // 如果这个玩家正在持杆，清空持杆状态
        if (gameState.currentPlayer === playerId) {
            gameState.currentPlayer = null;
            console.log(`🎱 清空持杆状态 (玩家 ${playerId} ${reason})`);
            ioServer.emit('cueStateChanged', { playerId, isHolding: false });
            ioServer.emit('gameState', { currentPlayer: null });
            sendSystemMessage(`${playerId} 的球杆已被释放`, 'info');
        }
        
        // 清除该玩家的得分记录
        if (gameState.playerScores.has(playerId)) {
            gameState.playerScores.delete(playerId);
            console.log(`🧹 清除玩家 ${playerId} 的得分记录`);
            
            // 广播得分清除事件（如果有其他玩家在线）
            if (gameState.players.size > 1) {
                ioServer.emit('playerScoreRemoved', {
                    playerId: playerId,
                    reason: reason,
                    timestamp: Date.now()
                });
            }
        }
        
        // 从玩家列表中移除
        gameState.players.delete(playerId);
        broadcastPlayerList();
        broadcastGameState();
        
        return true;
    }
    return false;
}

// 检查和清理超时玩家
function checkPlayerTimeouts() {
    const now = Date.now();
    const playersToRemove = [];
    
    for (const [playerId, player] of gameState.players.entries()) {
        const timeSinceLastHeartbeat = now - player.lastHeartbeat;
        
        // 检查玩家是否超时
        if (timeSinceLastHeartbeat > GAME_CONFIG.PLAYER_TIMEOUT) {
            playersToRemove.push(playerId);
        }
        // 检查持杆是否超时
        else if (player.isHoldingCue && gameState.currentPlayer === playerId) {
            if (timeSinceLastHeartbeat > GAME_CONFIG.CUE_TIMEOUT) {
                console.log(`⏰ 玩家 ${playerId} 持杆超时，自动释放球杆`);
                player.isHoldingCue = false;
                gameState.currentPlayer = null;
                
                // 通知该玩家和其他玩家
                if (player.socket && player.socket.connected) {
                    player.socket.emit('forceReleaseCue', { reason: '持杆超时' });
                }
                ioServer.emit('cueStateChanged', { playerId, isHolding: false });
                ioServer.emit('gameState', { currentPlayer: null });
                broadcastPlayerList();
            }
        }
    }
    
    // 移除超时玩家
    playersToRemove.forEach(playerId => {
        removePlayer(playerId, '超时断开');
    });
}

// 定时检查超时玩家
setInterval(checkPlayerTimeouts, GAME_CONFIG.HEARTBEAT_INTERVAL);

// Socket.IO 连接处理
ioServer.on('connection', (socket) => {
    const clientAddress = socket.handshake.address;
    const origin = socket.handshake.headers.origin;
    
    console.log(`👤 用户连接 - Socket ID: ${socket.id}, IP: ${clientAddress}, Origin: ${origin}`);
    debugLog('Socket连接详情', {
        id: socket.id,
        address: clientAddress,
        origin: origin,
        headers: socket.handshake.headers
    });

    // 玩家加入游戏
    socket.on('joinGame', (data) => {
        const { playerId } = data;
        
        // 验证玩家ID
        if (!playerId || playerId.trim().length === 0) {
            socket.emit('joinGameResponse', {
                success: false,
                message: '玩家ID不能为空'
            });
            return;
        }
        
        if (playerId.length > 20) {
            socket.emit('joinGameResponse', {
                success: false,
                message: '玩家ID不能超过20个字符'
            });
            return;
        }
        
        // 检查ID是否已存在
        if (gameState.players.has(playerId)) {
            console.log(`❌ 玩家ID "${playerId}" 已存在，拒绝加入`);
            socket.emit('joinGameResponse', {
                success: false,
                message: `玩家ID "${playerId}" 已被使用，请换一个ID`
            });
            return;
        }
        
        // 添加新玩家
        const newPlayer = {
            id: playerId,
            socketId: socket.id,
            isHoldingCue: false,
            lastHeartbeat: Date.now(),
            lastChatTime: 0, // 用于聊天频率限制
            socket: socket
        };
        
        gameState.players.set(playerId, newPlayer);
        
        console.log(`✅ 玩家 "${playerId}" 成功加入游戏`);
        
        // 发送成功响应
        socket.emit('joinGameResponse', {
            success: true,
            message: `欢迎 ${playerId} 加入游戏！`,
            playerId: playerId
        });
        
        // 发送聊天历史记录给新玩家
        socket.emit('chatHistory', gameState.chatHistory);
        
        // 广播玩家列表更新
        broadcastPlayerList();
        
        // 发送当前游戏状态给新玩家
        socket.emit('gameState', {
            currentPlayer: gameState.currentPlayer,
            ballsState: gameState.ballsState
        });
        
        // 发送系统消息通知玩家加入
        sendSystemMessage(`${playerId} 加入了游戏`, 'info');
        
        debugLog('新玩家加入', { playerId, socketId: socket.id });
    });

    // 聊天消息处理
    socket.on('chatMessage', (data) => {
        const { playerId, content } = data;
        const player = gameState.players.get(playerId);
        
        // 验证玩家身份
        if (!player || player.socketId !== socket.id) {
            socket.emit('chatError', { message: '身份验证失败' });
            return;
        }
        
        // 检查频率限制
        const now = Date.now();
        if (now - player.lastChatTime < GAME_CONFIG.CHAT_RATE_LIMIT) {
            const remainingTime = Math.ceil((GAME_CONFIG.CHAT_RATE_LIMIT - (now - player.lastChatTime)) / 1000);
            socket.emit('chatError', { 
                message: `发送消息过于频繁，请等待 ${remainingTime} 秒` 
            });
            return;
        }
        
        // 验证消息内容
        const validation = validateMessage(content);
        if (!validation.valid) {
            socket.emit('chatError', { message: validation.reason });
            return;
        }
        
        // 更新玩家聊天时间和心跳
        player.lastChatTime = now;
        player.lastHeartbeat = now;
        
        // 创建并广播玩家消息
        const message = createPlayerMessage(playerId, validation.content);
        broadcastChatMessage(message);
        
        console.log(`💬 ${playerId}: ${validation.content}`);
    });

    // 心跳检测
    socket.on('heartbeat', (data) => {
        const { playerId } = data;
        const player = gameState.players.get(playerId);
        if (player && player.socketId === socket.id) {
            player.lastHeartbeat = Date.now();
            socket.emit('heartbeatResponse', { timestamp: player.lastHeartbeat });
            debugLog('收到心跳', { playerId, timestamp: player.lastHeartbeat });
        }
    });

    // 🌐 延迟测量处理
    socket.on('ping', (data) => {
        // 直接返回相同的时间戳
        socket.emit('pong', data);
    });

    // 玩家拿起球杆
    socket.on('takeCue', (data) => {
        const { playerId } = data;
        const player = gameState.players.get(playerId);
        
        if (!player || player.socketId !== socket.id) {
            socket.emit('error', { message: '玩家验证失败' });
            return;
        }
        
        if (!gameState.currentPlayer) {
            gameState.currentPlayer = playerId;
            player.isHoldingCue = true;
            player.lastHeartbeat = Date.now(); // 更新心跳
            
            console.log(`🎱 玩家 ${playerId} 拿起球杆`);
            sendSystemMessage(`${playerId} 拿起了球杆`, 'info');
            broadcastPlayerList();
            ioServer.emit('cueStateChanged', { playerId, isHolding: true });
            ioServer.emit('gameState', { currentPlayer: gameState.currentPlayer });
        } else {
            socket.emit('error', { message: '已有其他玩家持杆中' });
        }
    });

    // 玩家放下球杆
    socket.on('releaseCue', (data) => {
        const { playerId } = data;
        const player = gameState.players.get(playerId);
        
        if (!player || player.socketId !== socket.id) {
            socket.emit('error', { message: '玩家验证失败' });
            return;
        }
        
        if (gameState.currentPlayer === playerId) {
            gameState.currentPlayer = null;
            player.isHoldingCue = false;
            player.lastHeartbeat = Date.now(); // 更新心跳
            
            console.log(`🎱 玩家 ${playerId} 放下球杆`);
            sendSystemMessage(`${playerId} 放下了球杆`, 'info');
            broadcastPlayerList();
            ioServer.emit('cueStateChanged', { playerId, isHolding: false });
            ioServer.emit('gameState', { currentPlayer: null });
        }
    });

    // 🚀 新的击球开始事件处理
    socket.on('shotStart', (data) => {
        const { playerId, ballsState, shotData } = data;
        const player = gameState.players.get(playerId);
        
        if (!player || player.socketId !== socket.id || gameState.currentPlayer !== playerId) {
            socket.emit('error', { message: '无效的击球请求' });
            return;
        }
        
        console.log(`🎱 处理 ${playerId} 的击球开始`);
        
        // 更新游戏状态
        gameState.isSimulating = true;
        gameState.ballsState = ballsState;
        gameState.shotPlayerId = playerId; // 记录击球玩家
        player.lastHeartbeat = Date.now();
        
        // 添加统一的开始时间戳
        const startTime = Date.now() + 100; // 100ms延迟确保所有客户端同步
        
        // 广播给所有玩家（包括击球者）
        ioServer.emit('shotStart', {
            playerId,
            ballsState,
            shotData,
            startTime
        });
        
        // 🎯 启动服务端模拟监控 - 等待固定时间后检查模拟状态
        if (gameState.simulationTimer) {
            clearTimeout(gameState.simulationTimer);
        }
        
        gameState.simulationTimer = setTimeout(() => {
            // 6秒后自动结束模拟，给球更多时间完全停止
            if (gameState.isSimulating && gameState.shotPlayerId === playerId) {
                console.log(`⏰ 服务端统一结束物理模拟 (${playerId}) - 6秒超时`);
                
                gameState.isSimulating = false;
                gameState.shotPlayerId = null;
                
                // 统一广播模拟结束事件
                ioServer.emit('simulationEnd', {
                    playerId,
                    message: '物理模拟已结束，可以继续游戏'
                });
                
                sendSystemMessage(`${playerId} 的击球模拟完成`, 'info');
            }
        }, 6000); // 从3秒延长到6秒
        
        // 发送聊天消息
        sendSystemMessage(`${playerId} 击球了！`, 'info');
        
        console.log(`🚀 广播击球开始事件给所有玩家`);
    });

    // 接收球的状态更新（保留作为备用）
    socket.on('ballsState', (data) => {
        const { playerId, state } = data;
        const player = gameState.players.get(playerId);
        
        if (player && player.socketId === socket.id) {
            gameState.ballsState = state;
            player.lastHeartbeat = Date.now(); // 更新心跳
            // 广播给其他玩家
            socket.broadcast.emit('ballsUpdate', { playerId, state });
        }
    });

    // 接收击球事件（保留作为备用）
    socket.on('ballHit', (data) => {
        const { playerId } = data;
        const player = gameState.players.get(playerId);
        
        if (player && player.socketId === socket.id && gameState.currentPlayer === playerId) {
            gameState.isSimulating = true;
            player.lastHeartbeat = Date.now(); // 更新心跳
            // 广播给其他玩家
            socket.broadcast.emit('ballHit', data);
            sendSystemMessage(`${playerId} 击球了！`, 'info');
            console.log(`🎯 玩家 ${playerId} 击球`);
        }
    });

    // 🔄 更新的模拟完成事件处理
    socket.on('simulationComplete', (data) => {
        const { playerId, finalState } = data;
        const player = gameState.players.get(playerId);
        
        if (!player || player.socketId !== socket.id) {
            return;
        }
        
        console.log(`🎯 ${playerId} 完成物理模拟`);
        
        // 更新游戏状态
        gameState.isSimulating = false;
        gameState.ballsState = finalState;
        player.lastHeartbeat = Date.now();
        
        // 发送同步确认给所有玩家
        ioServer.emit('syncConfirm', {
            playerId,
            authoritativeState: finalState
        });
        
        // 广播模拟完成事件（保持兼容性）
        socket.broadcast.emit('simulationComplete', data);
        
        console.log(`🔄 发送同步确认给所有玩家`);
    });

    // 重置台球桌
    socket.on('resetTable', (data) => {
        const { playerId } = data;
        const player = gameState.players.get(playerId);
        
        // 🔒 权限验证：只有持杆玩家才能重置球台
        if (!player || player.socketId !== socket.id) {
            socket.emit('error', { message: '玩家验证失败' });
            return;
        }
        
        if (gameState.currentPlayer !== playerId) {
            socket.emit('error', { message: '只有持杆者才能重置球台' });
            return;
        }
        
        console.log(`🔄 玩家 ${playerId} 重置台球桌`);
        
        // 🛑 停止当前的模拟
        if (gameState.simulationTimer) {
            clearTimeout(gameState.simulationTimer);
            gameState.simulationTimer = null;
        }
        
        // 🔄 重置游戏状态
        gameState.ballsState = {};
        gameState.isSimulating = false;
        gameState.shotPlayerId = null;
        player.lastHeartbeat = Date.now(); // 更新心跳
        
        // 🧹 清除所有得分记录
        gameState.playerScores.clear();
        console.log(`🧹 重置台球桌时清除所有得分记录`);
        
        // 📡 广播重置事件给所有玩家
        ioServer.emit('resetTable', {
            playerId: playerId,
            resetBy: playerId
        });
        
        // 🧹 广播得分清除事件
        ioServer.emit('scoresCleared', {
            clearedBy: playerId,
            reason: '台球桌重置',
            timestamp: Date.now()
        });
        
        // 💬 发送系统消息
        sendSystemMessage(`${playerId} 重置了台球桌`, 'info');
        
        // 🎯 重置后自动进入击球状态（保持持杆状态）
        setTimeout(() => {
            // 确保持杆状态保持，并通知所有客户端可以继续游戏
            ioServer.emit('gameState', { 
                currentPlayer: gameState.currentPlayer,
                isReset: true,
                readyForShot: true
            });
            
            sendSystemMessage(`台球桌重置完成，${playerId} 可以继续击球`, 'info');
            console.log(`🎯 台球桌重置完成，${playerId} 保持持杆状态`);
        }, 100); // 短暂延迟确保重置完成
    });

    // 🎱 处理客户端报告的进球事件
    socket.on('ballsPocketed', (data) => {
        const { playerId, pocketedBalls } = data;
        const player = gameState.players.get(playerId);
        
        // 验证玩家身份和权限
        if (!player || player.socketId !== socket.id) {
            socket.emit('error', { message: '玩家验证失败' });
            return;
        }
        
        // 只有当前持杆玩家或模拟中的玩家可以报告进球
        if (gameState.currentPlayer !== playerId && gameState.shotPlayerId !== playerId) {
            console.log(`⚠️ 无效的进球报告: ${playerId} 不是当前持杆/击球玩家`);
            return;
        }
        
        console.log(`🎯 收到进球报告: ${playerId}`, pocketedBalls);
        
        // 处理每个进球
        pocketedBalls.forEach(pocketInfo => {
            const { ballNumber, pocketType } = pocketInfo;
            
            // 跳过白球（0号球），白球进洞不算得分
            if (ballNumber === 0) {
                console.log(`🎱 白球进洞，不记录得分`);
                return;
            }
            
            // 验证球号有效性（1-15号球）
            if (ballNumber < 1 || ballNumber > 15) {
                console.log(`⚠️ 无效球号: ${ballNumber}`);
                return;
            }
            
            // 记录该玩家的得分
            if (!gameState.playerScores.has(playerId)) {
                gameState.playerScores.set(playerId, []);
            }
            
            const playerScore = gameState.playerScores.get(playerId);
            
            // 检查球是否已经被进过（防止重复记录）
            if (!playerScore.includes(ballNumber)) {
                playerScore.push(ballNumber);
                
                console.log(`🎯 玩家 ${playerId} 打进球 ${ballNumber} (${pocketType}洞)`);
                
                // 广播进球事件给所有玩家
                ioServer.emit('playerScored', {
                    playerId: playerId,
                    ballNumber: ballNumber,
                    pocketType: pocketType,
                    timestamp: Date.now()
                });
                
                // 发送系统消息
                sendSystemMessage(`🎯 ${playerId} 打进了 ${ballNumber} 号球！`, 'info');
                
                debugLog('进球记录', {
                    playerId,
                    ballNumber,
                    pocketType,
                    currentScore: playerScore
                });
            } else {
                console.log(`⚠️ 球 ${ballNumber} 已被 ${playerId} 进过，跳过重复记录`);
            }
        });
        
        // 更新玩家心跳
        player.lastHeartbeat = Date.now();
    });

    // 🧹 处理清除所有得分的请求
    socket.on('clearScores', (data) => {
        const { playerId } = data;
        const player = gameState.players.get(playerId);
        
        // 验证玩家身份
        if (!player || player.socketId !== socket.id) {
            socket.emit('error', { message: '玩家验证失败' });
            return;
        }
        
        // 可以添加权限检查，比如只有持杆玩家可以清除得分
        if (gameState.currentPlayer !== playerId) {
            socket.emit('error', { message: '只有持杆者才能清除得分记录' });
            return;
        }
        
        console.log(`🧹 玩家 ${playerId} 请求清除所有得分记录`);
        
        // 清除所有玩家的得分记录
        gameState.playerScores.clear();
        
        // 广播清除事件给所有玩家
        ioServer.emit('scoresCleared', {
            clearedBy: playerId,
            timestamp: Date.now()
        });
        
        // 发送系统消息
        sendSystemMessage(`🧹 ${playerId} 清除了所有得分记录`, 'info');
        
        // 更新玩家心跳
        player.lastHeartbeat = Date.now();
        
        debugLog('得分记录已清除', { clearedBy: playerId });
    });

    // 📊 获取当前得分排行榜
    socket.on('getScores', (data) => {
        const { playerId } = data;
        const player = gameState.players.get(playerId);
        
        if (!player || player.socketId !== socket.id) {
            return;
        }
        
        // 构建得分排行榜
        const scoreboard = Array.from(gameState.playerScores.entries()).map(([pid, scores]) => ({
            playerId: pid,
            balls: scores,
            totalScore: scores.length
        })).sort((a, b) => b.totalScore - a.totalScore);
        
        socket.emit('scoreboard', {
            scores: scoreboard,
            timestamp: Date.now()
        });
        
        debugLog('发送得分排行榜', { requestedBy: playerId, scoreboard });
    });

    // 断开连接处理
    socket.on('disconnect', () => {
        console.log(`❌ Socket断开连接 - Socket ID: ${socket.id}`);
        
        // 找到对应的玩家并移除
        for (const [playerId, player] of gameState.players.entries()) {
            if (player.socketId === socket.id) {
                removePlayer(playerId, '断开连接');
                break;
            }
        }
    });
});

// 启动服务器
const PORT = config.getPort();
httpServer.listen(PORT, () => {
    console.log(`\n🎮 IncrediPool Server 启动成功!`);
    console.log(`📍 服务器地址: http://localhost:${PORT}`);
    console.log(`🌍 环境: ${config.isProduction() ? '生产环境' : '开发环境'}`);
    console.log(`🔧 调试模式: ${config.shouldDebug() ? '开启' : '关闭'}`);
    console.log(`⚡ 支持的前端地址:`);
    config.getFrontendUrls().forEach(url => {
        console.log(`   - ${url}`);
    });
    console.log(`⏰ 游戏配置:`);
    console.log(`   - 心跳间隔: ${GAME_CONFIG.HEARTBEAT_INTERVAL / 1000}秒`);
    console.log(`   - 玩家超时: ${GAME_CONFIG.PLAYER_TIMEOUT / 1000}秒`);
    console.log(`   - 持杆超时: ${GAME_CONFIG.CUE_TIMEOUT / 1000}秒`);
    console.log(`\n✅ 服务器准备就绪，等待连接...\n`);
}); 