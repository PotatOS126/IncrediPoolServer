const path = require('path');

class ServerConfig {
    constructor() {
        // 检测当前环境
        this.environment = this.detectEnvironment();
        
        // 配置不同环境的设置
        this.config = {
            development: {
                port: process.env.PORT || 3000,
                frontendUrls: [
                    'http://localhost:5173',  // Vite 默认端口
                    'http://127.0.0.1:5173',
                    'http://localhost:3000',  // 如果前端也用3000端口
                    'http://127.0.0.1:3000'
                ],
                corsOrigin: true, // 开发环境允许所有来源
                debug: true
            },
            production: {
                port: process.env.PORT || 3000,
                frontendUrls: [
                    process.env.FRONTEND_URL || 'https://potatos126.github.io',
                    'https://potatos126.github.io', // GitHub Pages
                    'https://incredipoolfrontend.netlify.app', // Netlify (如果使用)
                    'https://incredipoolfront.vercel.app' // Vercel (如果使用)
                ],
                corsOrigin: process.env.FRONTEND_URL || 'https://potatos126.github.io',
                debug: false
            }
        };
        
        // 输出当前环境信息
        this.logEnvironmentInfo();
    }

    detectEnvironment() {
        // 1. 检查 NODE_ENV 环境变量
        if (process.env.NODE_ENV === 'production') {
            return 'production';
        }
        
        if (process.env.NODE_ENV === 'development') {
            return 'development';
        }
        
        // 2. 检查是否在已知的生产环境平台
        if (process.env.RENDER || 
            process.env.HEROKU || 
            process.env.VERCEL || 
            process.env.NETLIFY) {
            return 'production';
        }
        
        // 3. 检查端口 (生产环境通常使用动态端口)
        const port = process.env.PORT;
        if (port && port !== '3000' && port !== '5173') {
            return 'production';
        }
        
        // 默认为开发环境
        return 'development';
    }

    getPort() {
        return this.config[this.environment].port;
    }

    getFrontendUrls() {
        return this.config[this.environment].frontendUrls;
    }

    getCorsOrigin() {
        const envConfig = this.config[this.environment];
        
        if (this.environment === 'development') {
            // 开发环境返回函数，动态检查来源
            return (origin, callback) => {
                // 允许没有origin的请求（比如移动端app、Postman等）
                if (!origin) return callback(null, true);
                
                // 检查是否是本地开发地址
                if (origin.includes('localhost') || 
                    origin.includes('127.0.0.1') ||
                    origin.includes('192.168.') ||
                    envConfig.frontendUrls.includes(origin)) {
                    return callback(null, true);
                }
                
                callback(new Error('CORS: 不允许的来源'), false);
            };
        }
        
        // 生产环境返回具体的URL列表
        return envConfig.frontendUrls;
    }

    isProduction() {
        return this.environment === 'production';
    }

    isDevelopment() {
        return this.environment === 'development';
    }

    shouldDebug() {
        return this.config[this.environment].debug;
    }

    logEnvironmentInfo() {
        console.log('🚀 服务器配置信息:');
        console.log(`   环境: ${this.environment}`);
        console.log(`   端口: ${this.getPort()}`);
        console.log(`   前端URL: ${JSON.stringify(this.getFrontendUrls())}`);
        console.log(`   调试模式: ${this.shouldDebug()}`);
        console.log(`   NODE_ENV: ${process.env.NODE_ENV || '未设置'}`);
    }

    // 获取环境信息用于API返回
    getEnvironmentInfo() {
        return {
            environment: this.environment,
            port: this.getPort(),
            frontendUrls: this.getFrontendUrls(),
            nodeEnv: process.env.NODE_ENV,
            platform: this.detectPlatform(),
            timestamp: new Date().toISOString()
        };
    }

    detectPlatform() {
        if (process.env.RENDER) return 'Render';
        if (process.env.HEROKU) return 'Heroku';
        if (process.env.VERCEL) return 'Vercel';
        if (process.env.NETLIFY) return 'Netlify';
        return 'Local';
    }
}

module.exports = new ServerConfig(); 