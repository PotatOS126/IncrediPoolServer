// 测试服务器功能的脚本
const io = require('socket.io-client');

class TestClient {
    constructor(playerId, serverUrl = 'http://localhost:3000') {
        this.playerId = playerId;
        this.serverUrl = serverUrl;
        this.socket = null;
    }

    connect() {
        console.log(`🔌 ${this.playerId} 连接到服务器...`);
        this.socket = io(this.serverUrl, {
            transports: ['websocket']
        });

        this.socket.on('connect', () => {
            console.log(`✅ ${this.playerId} 已连接`);
        });

        this.socket.on('joinGameResponse', (response) => {
            if (response.success) {
                console.log(`✅ ${this.playerId} 加入成功: ${response.message}`);
            } else {
                console.log(`❌ ${this.playerId} 加入失败: ${response.message}`);
            }
        });

        this.socket.on('playerList', (players) => {
            console.log(`📋 当前玩家列表: ${players.map(p => `${p.id}(${p.isOnline ? '在线' : '离线'})`).join(', ')}`);
        });

        this.socket.on('error', (error) => {
            console.log(`⚠️ ${this.playerId} 收到错误: ${error.message}`);
        });

        this.socket.on('disconnect', () => {
            console.log(`❌ ${this.playerId} 断开连接`);
        });

        this.socket.on('chatMessage', (message) => {
            console.log(`💬 [${this.playerId}] 收到消息: ${message.sender}: ${message.content}`);
        });

        this.socket.on('chatError', (error) => {
            console.log(`⚠️ ${this.playerId} 聊天错误: ${error.message}`);
        });
    }

    joinGame() {
        if (this.socket) {
            this.socket.emit('joinGame', { playerId: this.playerId });
        }
    }

    takeCue() {
        if (this.socket) {
            this.socket.emit('takeCue', { playerId: this.playerId });
        }
    }

    sendHeartbeat() {
        if (this.socket) {
            this.socket.emit('heartbeat', { playerId: this.playerId });
        }
    }

    sendChatMessage(content) {
        if (this.socket) {
            this.socket.emit('chatMessage', { 
                playerId: this.playerId,
                content: content
            });
        }
    }

    disconnect() {
        if (this.socket) {
            console.log(`🔌 ${this.playerId} 主动断开连接`);
            this.socket.disconnect();
        }
    }
}

// 测试场景
async function runTests() {
    console.log('🧪 开始服务器功能测试...\n');

    // 测试1: 正常加入游戏
    console.log('📝 测试1: 正常加入游戏');
    const client1 = new TestClient('Player1');
    client1.connect();
    await sleep(1000);
    client1.joinGame();
    await sleep(2000);

    // 测试2: 重复ID加入
    console.log('\n📝 测试2: 重复ID加入');
    const client2 = new TestClient('Player1'); // 同样的ID
    client2.connect();
    await sleep(1000);
    client2.joinGame();
    await sleep(2000);

    // 测试3: 正常第二个玩家加入
    console.log('\n📝 测试3: 正常第二个玩家加入');
    const client3 = new TestClient('Player2');
    client3.connect();
    await sleep(1000);
    client3.joinGame();
    await sleep(2000);

    // 测试4: 聊天功能测试
    console.log('\n📝 测试4: 聊天功能测试');
    client1.sendChatMessage('大家好！');
    await sleep(1000);
    client3.sendChatMessage('你好，Player1！');
    await sleep(2000);

    // 测试5: 拿球杆
    console.log('\n📝 测试5: Player1拿球杆');
    client1.takeCue();
    await sleep(2000);

    // 测试6: 第二个玩家尝试拿球杆（应该失败）
    console.log('\n📝 测试6: Player2尝试拿球杆（应该失败）');
    client3.takeCue();
    await sleep(2000);

    // 测试7: 模拟断开连接
    console.log('\n📝 测试7: Player1突然断开连接（模拟关闭页面）');
    client1.disconnect();
    await sleep(3000);

    // 测试8: Player2现在应该可以拿球杆了
    console.log('\n📝 测试8: Player2现在应该可以拿球杆了');
    client3.takeCue();
    await sleep(2000);

    // 清理
    console.log('\n🧹 清理测试连接...');
    client2.disconnect();
    client3.disconnect();
    
    console.log('\n✅ 测试完成！');
    process.exit(0);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 运行测试
if (require.main === module) {
    runTests().catch(console.error);
}